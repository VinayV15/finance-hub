"""Everything that talks to Plaid: link tokens, saving new logins, and pulling data."""
import json
import os
import threading
from datetime import datetime, timedelta, timezone

import certifi
import plaid
from plaid.api import plaid_api
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.investments_transactions_get_request import InvestmentsTransactionsGetRequest
from plaid.model.investments_transactions_get_request_options import InvestmentsTransactionsGetRequestOptions
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.transactions_sync_request import TransactionsSyncRequest

import classify
import db

ENV = os.environ.get("PLAID_ENV", "sandbox").lower()

# What to ask Plaid for, per kind of account the user is linking.
# "required" must be supported by the bank or it won't show up; "optional" is added when available.
LINK_KINDS = {
    "bank":       {"required": ["transactions"], "optional": ["liabilities", "investments"]},
    "investment": {"required": ["investments"],  "optional": ["transactions"]},
    "loan":       {"required": ["liabilities"],  "optional": ["transactions"]},
}


def _client():
    host = plaid.Environment.Production if ENV == "production" else plaid.Environment.Sandbox
    secret = os.environ["PLAID_SECRET_PRODUCTION" if ENV == "production" else "PLAID_SECRET_SANDBOX"]
    cfg = plaid.Configuration(host=host, api_key={"clientId": os.environ["PLAID_CLIENT_ID"], "secret": secret})
    cfg.ssl_ca_cert = certifi.where()  # python.org builds ship without CA certs
    return plaid_api.PlaidApi(plaid.ApiClient(cfg))


client = _client()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def plaid_error(e):
    """Pull Plaid's error code/message out of an ApiException."""
    try:
        body = json.loads(e.body)
        return body.get("error_code", "UNKNOWN"), body.get("error_message", str(e))
    except Exception:
        return "UNKNOWN", str(e)


# ---------- linking ----------

def create_link_token(kind="bank", item_id=None):
    """New login (kind=bank/investment/loan), or update mode for an existing item (fixes a broken
    login without using up one of the 10 free Trial links)."""
    args = dict(
        client_name="Finance Hub",
        language="en",
        country_codes=[CountryCode("US")],
        user=LinkTokenCreateRequestUser(client_user_id="owner"),
    )
    if item_id:
        with db.conn() as c:
            row = c.execute("SELECT access_token FROM items WHERE item_id=?", (item_id,)).fetchone()
        args["access_token"] = row["access_token"]
    else:
        spec = LINK_KINDS[kind]
        args["products"] = [Products(p) for p in spec["required"]]
        args["optional_products"] = [Products(p) for p in spec["optional"]]
        if "transactions" in spec["required"] + spec["optional"]:
            args["transactions"] = LinkTokenTransactions(days_requested=730)
    return client.link_token_create(LinkTokenCreateRequest(**args)).link_token


def save_public_token(public_token, institution_name=None):
    resp = client.item_public_token_exchange(ItemPublicTokenExchangeRequest(public_token=public_token))
    with db.conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO items(item_id, access_token, institution, env) VALUES (?,?,?,?)",
            (resp.item_id, resp.access_token, institution_name, ENV),
        )
    sync_item(resp.item_id)
    # Plaid prepares the transaction history a few minutes after linking; re-pull so it shows up today.
    for delay in (60, 300, 900):
        t = threading.Timer(delay, sync_item, args=(resp.item_id,))
        t.daemon = True  # don't block Ctrl+C
        t.start()
    return resp.item_id


def mark_item_fixed(item_id):
    with db.conn() as c:
        c.execute("UPDATE items SET status='ok', error=NULL WHERE item_id=?", (item_id,))
    sync_item(item_id)


# ---------- syncing ----------

def sync_all():
    with db.conn() as c:
        ids = [r["item_id"] for r in c.execute("SELECT item_id FROM items WHERE env=?", (ENV,))]
    results = {i: sync_item(i) for i in ids}
    db.snapshot_balances()
    db.set_meta("last_sync", _now())
    return results


def sync_item(item_id):
    with db.conn() as c:
        item = dict(c.execute("SELECT * FROM items WHERE item_id=?", (item_id,)).fetchone())
    token = item["access_token"]
    try:
        acct_resp = client.accounts_get(AccountsGetRequest(access_token=token)).to_dict()
        products = [str(p) for p in acct_resp["item"].get("products", [])]
        institution = item["institution"] or _institution_name(acct_resp["item"].get("institution_id"))
        _save_accounts(item_id, institution, acct_resp["accounts"])
        if "transactions" in products:
            _sync_transactions(item_id, token, item["cursor"])
        if "investments" in products:
            _sync_holdings(token)
            try:
                _sync_investment_txns(token)
            except plaid.ApiException as e:
                if plaid_error(e)[0] not in ("PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS"):
                    raise
        if "liabilities" in products:
            _sync_liabilities(token)
        with db.conn() as c:
            c.execute(
                "UPDATE items SET status='ok', error=NULL, institution=?, products=?, last_synced=? WHERE item_id=?",
                (institution, ",".join(products), _now(), item_id),
            )
        classify.run()
        return "ok"
    except plaid.ApiException as e:
        code, msg = plaid_error(e)
        with db.conn() as c:
            c.execute("UPDATE items SET status=?, error=? WHERE item_id=?", (code, msg, item_id))
        return code


def _institution_name(inst_id):
    if not inst_id:
        return None
    try:
        req = InstitutionsGetByIdRequest(institution_id=inst_id, country_codes=[CountryCode("US")])
        return client.institutions_get_by_id(req).institution.name
    except plaid.ApiException:
        return inst_id


def _save_accounts(item_id, institution, accounts):
    with db.conn() as c:
        for a in accounts:
            bal = a["balances"]
            c.execute(
                """INSERT OR REPLACE INTO accounts
                   (account_id, item_id, source, institution, name, mask, type, subtype, balance, available, currency, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (a["account_id"], item_id, "plaid", institution, a.get("official_name") or a["name"], a.get("mask"),
                 str(a["type"]), str(a.get("subtype") or ""), bal.get("current"), bal.get("available"),
                 bal.get("iso_currency_code") or "USD", _now()),
            )


def _sync_transactions(item_id, token, cursor):
    has_more = True
    while has_more:
        args = {"access_token": token, "count": 500}
        if cursor:
            args["cursor"] = cursor
        r = client.transactions_sync(TransactionsSyncRequest(**args)).to_dict()
        with db.conn() as c:
            for t in r["added"] + r["modified"]:
                pfc = t.get("personal_finance_category") or {}
                primary = pfc.get("primary") or ""
                counterparties = t.get("counterparties") or []
                db.upsert_txn(
                    c, txn_id=t["transaction_id"], account_id=t["account_id"], date=str(t["date"]),
                    name=t.get("merchant_name") or t["name"], amount=t["amount"],
                    category=primary.replace("_", " ").title(), pending=int(bool(t.get("pending"))),
                    detailed=pfc.get("detailed"), raw_primary=primary, source="plaid",
                    txn_type=str(t.get("payment_channel") or ""),
                    counterparty=counterparties[0].get("name") if counterparties else None,
                )
            for t in r["removed"]:
                c.execute("DELETE FROM transactions WHERE txn_id=?", (t["transaction_id"],))
        cursor, has_more = r["next_cursor"], r["has_more"]
    with db.conn() as c:
        c.execute("UPDATE items SET cursor=? WHERE item_id=?", (cursor, item_id))


# Investment-account cash movements we keep as transactions (buys/sells stay inside the account).
_INV_CASH_SUBTYPES = {"deposit", "withdrawal", "contribution", "transfer", "dividend", "interest",
                      "qualified dividend", "non-qualified dividend", "fee", "account fee", "management fee",
                      "distribution", "tax withheld", "rebalance"}


def _sync_investment_txns(token, days=730):
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    offset, total = 0, None
    with db.conn() as c:
        while total is None or offset < total:
            req = InvestmentsTransactionsGetRequest(
                access_token=token, start_date=start, end_date=end,
                options=InvestmentsTransactionsGetRequestOptions(count=500, offset=offset))
            r = client.investments_transactions_get(req).to_dict()
            total = r["total_investment_transactions"]
            batch = r["investment_transactions"]
            for t in batch:
                subtype = str(t.get("subtype") or "")
                if str(t.get("type")) not in ("cash", "fee", "transfer") and subtype not in _INV_CASH_SUBTYPES:
                    continue
                db.upsert_txn(
                    c, txn_id=f"inv-{t['investment_transaction_id']}", account_id=t["account_id"],
                    date=str(t["date"]), name=t.get("name") or subtype.title(), amount=t["amount"],
                    category=subtype.title(), pending=0, detailed=f"INVESTMENT_{subtype.upper().replace(' ', '_')}",
                    raw_primary="INVESTMENT", source="plaid_inv", txn_type=subtype,
                )
            if not batch:
                break
            offset += len(batch)


def resync_all_history():
    """Re-pull every transaction from scratch (used once to backfill new detail fields)."""
    with db.conn() as c:
        c.execute("UPDATE items SET cursor=NULL WHERE env=?", (ENV,))
    return sync_all()


def _sync_holdings(token):
    r = client.investments_holdings_get(InvestmentsHoldingsGetRequest(access_token=token)).to_dict()
    secs = {s["security_id"]: s for s in r["securities"]}
    account_ids = {h["account_id"] for h in r["holdings"]} | {a["account_id"] for a in r["accounts"]}
    with db.conn() as c:
        for aid in account_ids:
            c.execute("DELETE FROM holdings WHERE account_id=?", (aid,))
        for h in r["holdings"]:
            s = secs.get(h["security_id"], {})
            c.execute(
                "INSERT OR REPLACE INTO holdings VALUES (?,?,?,?,?,?,?,?)",
                (h["account_id"], h["security_id"], s.get("ticker_symbol"), s.get("name"), h["quantity"],
                 h.get("institution_price"), h.get("institution_value"), h.get("cost_basis")),
            )


def _sync_liabilities(token):
    r = client.liabilities_get(LiabilitiesGetRequest(access_token=token)).to_dict()["liabilities"]
    with db.conn() as c:
        for cr in r.get("credit") or []:
            aprs = [a["apr_percentage"] for a in cr.get("aprs") or [] if a.get("apr_type") == "purchase_apr"]
            c.execute(
                "INSERT OR REPLACE INTO liabilities VALUES (?,?,?,?,?,?,?)",
                (cr["account_id"], "credit", aprs[0] if aprs else None, cr.get("minimum_payment_amount"),
                 str(cr.get("next_payment_due_date") or ""), cr.get("last_statement_balance"), None),
            )
        for m in r.get("mortgage") or []:
            extra = {
                "escrow": m.get("escrow_balance"),
                "maturity": str(m.get("maturity_date") or ""),
                "ytd_principal": m.get("ytd_principal_paid"),
                "ytd_interest": m.get("ytd_interest_paid"),
            }
            c.execute(
                "INSERT OR REPLACE INTO liabilities VALUES (?,?,?,?,?,?,?)",
                (m["account_id"], "mortgage", (m.get("interest_rate") or {}).get("percentage"),
                 m.get("next_monthly_payment"), str(m.get("next_payment_due_date") or ""),
                 m.get("last_payment_amount"), json.dumps(extra, default=str)),
            )

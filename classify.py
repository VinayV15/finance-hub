"""Decide what every transaction really is, so money moving between your own accounts is never
counted as spending or income.

Each transaction gets a *flow*:
  spend     money that left you for good (purchases, bills, mortgage, money sent to people)
  income    money that arrived from outside (paychecks, interest, tax refunds, money from people)
  refund    money back (merchant refunds, friends paying you back, work reimbursements) — reduces spending
  transfer  money moving between your own accounts (card payments, Robinhood contributions, Venmo funding)
  growth    dividends/interest earned inside an investment account (not spendable income)

Priority: your per-transaction fix > your rules > automatic detection.
Rebuilt from scratch on every sync/import; results live in the txn_class table.
"""
import re
from collections import defaultdict
from datetime import date

import db

PAIR_WINDOW_DAYS = 5

# Plaid primary category -> friendly category name.
CATEGORY_NAMES = {
    "FOOD_AND_DRINK": "Food & Drink",
    "GENERAL_MERCHANDISE": "Shopping",
    "TRANSPORTATION": "Transportation",
    "TRAVEL": "Travel",
    "RENT_AND_UTILITIES": "Bills & Utilities",
    "ENTERTAINMENT": "Entertainment",
    "PERSONAL_CARE": "Personal Care",
    "MEDICAL": "Health",
    "GENERAL_SERVICES": "Services",
    "HOME_IMPROVEMENT": "Home",
    "LOAN_PAYMENTS": "Loan Payments",
    "BANK_FEES": "Fees",
    "GOVERNMENT_AND_NON_PROFIT": "Taxes & Donations",
    "INCOME": "Income",
    "TRANSFER_IN": "Transfer",
    "TRANSFER_OUT": "Transfer",
    "OTHER": "Other",
}

# Names that mean "one of my own accounts". Extended at runtime with linked institution names.
OWN_ALIASES = {
    "Robinhood": ["robinhood"],
    "Wealthfront": ["wealthfront"],
    "Wells Fargo": ["wells fargo", "wf bank"],
    "American Express": ["american express", "amex"],
    "Venmo": ["venmo"],
    "Empower": ["empower"],
}

PAYROLL_RE = re.compile(r"payroll|direct dep|salary|\bpayrl\b|\bach credit\b.*payroll", re.I)
P2P_RE = re.compile(r"\bzelle\b|money transfer authorized .* apple|apple cash|cash app|\bpaypal\b", re.I)
MORTGAGE_RE = re.compile(r"servicer|servicer|loancare|mortgage", re.I)
ATM_OUT_RE = re.compile(r"atm withdrawal|non-wf atm withdrawal", re.I)


def _d(s):
    return date.fromisoformat(s[:10])


def _load():
    with db.conn() as c:
        txns = [dict(r) for r in c.execute("""
            SELECT t.*, a.type AS acct_type, a.institution AS acct_inst
            FROM transactions t LEFT JOIN accounts a ON a.account_id = t.account_id""")]
        overrides = {r["txn_id"]: dict(r) for r in c.execute("SELECT * FROM txn_overrides")}
        rules = [dict(r) for r in c.execute("SELECT * FROM rules ORDER BY id DESC")]
        institutions = {r["institution"] for r in c.execute("SELECT DISTINCT institution FROM accounts") if r["institution"]}
    return txns, overrides, rules, institutions


def _own_patterns(institutions):
    pats = {k: list(v) for k, v in OWN_ALIASES.items()}
    for inst in institutions:
        pats.setdefault(inst, []).append(inst.lower())
    return pats


def _mentions_own(t, own):
    """Which of my own institutions this transaction's name/counterparty points at (not its own)."""
    text = f"{t['name'] or ''} {t['counterparty'] or ''}".lower()
    for inst, words in own.items():
        if inst == t["acct_inst"]:
            continue
        if any(w in text for w in words):
            return inst
    return None


def _transfer_like(t):
    return (t["raw_primary"] or "") in ("TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS") or \
        t["source"] == "plaid_inv" and (t["txn_type"] or "") in ("deposit", "withdrawal", "contribution", "transfer") or \
        t["source"] == "venmo" and "transfer" in (t["txn_type"] or "").lower()


def _base_category(t):
    if t["source"] == "venmo":
        return "Venmo"
    return CATEGORY_NAMES.get(t["raw_primary"] or "", t["category"] or "Other")


def _auto(t, own):
    """Classify one transaction on its own (before pairing). Returns (flow, kind, category, review, reason)."""
    out = t["amount"] > 0
    name = t["name"] or ""
    detailed = t["detailed"] or ""
    primary = t["raw_primary"] or ""
    cat = _base_category(t)

    # Investment-account cash movements
    if t["source"] == "plaid_inv":
        st = t["txn_type"] or ""
        if st in ("deposit", "contribution", "withdrawal", "transfer", "distribution"):
            return "transfer", "invest_contribution" if not out else "invest_withdrawal", "Investing", 0, "investment cash move"
        if "dividend" in st or st == "interest":
            return "growth", st.replace(" ", "_"), "Investment growth", 0, "earned inside account"
        if "fee" in st or st == "tax withheld":
            return "spend", "invest_fee", "Fees", 0, "investment fee"
        return "transfer", "invest_other", "Investing", 1, f"unrecognized investment type '{st}'"

    # Venmo rows
    if t["source"] == "venmo":
        vt = (t["txn_type"] or "").lower()
        if "transfer" in vt:
            return "transfer", "venmo_cashout" if out else "venmo_topup", "Transfer", 0, "Venmo ↔ bank"
        if out:
            return "spend", "p2p" if vt == "payment" else "purchase", "Sent to people" if vt == "payment" else "Shopping", 0, "Venmo"
        return "refund", "p2p", "Paybacks from people", 0, "Venmo payment received — counted as a payback"

    # Card payments / transfers to my own accounts
    target = _mentions_own(t, own) if primary in ("TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS") else None
    if detailed == "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" or (t["acct_type"] == "credit" and primary == "LOAN_PAYMENTS" and not out):
        return "transfer", "card_payment", "Credit card payment", 0, "credit card payment"
    if target == "Venmo" and out:
        # Real spending happened in Venmo; this bank side becomes a transfer once matched to the Venmo CSV row.
        return "spend", "venmo_unmatched", "Venmo", 1, "Venmo charge — import that month's Venmo CSV to see what it was"
    if target:
        kind = "invest_contribution" if target in ("Robinhood", "Empower") and out else "internal"
        if target in ("Robinhood", "Empower") and not out:
            kind = "invest_withdrawal"
        return "transfer", kind, "Investing" if kind.startswith("invest") else "Transfer", 0, f"to/from your {target} account"

    # Mortgage
    if detailed == "LOAN_PAYMENTS_MORTGAGE_PAYMENT" or (primary == "LOAN_PAYMENTS" and MORTGAGE_RE.search(name)):
        return "spend", "mortgage", "Housing", 0, "mortgage payment"
    if primary == "LOAN_PAYMENTS" and out:
        return "spend", "loan_payment", "Loan Payments", 0, "loan payment"

    # Income
    if primary == "INCOME" or (not out and PAYROLL_RE.search(name)):
        if detailed == "INCOME_WAGES" or PAYROLL_RE.search(name):
            return "income", "paycheck", "Paycheck", 0, "payroll deposit"
        if detailed == "INCOME_INTEREST_EARNED" or "interest" in name.lower():
            return "income", "interest", "Interest", 0, "interest"
        if "tax ref" in name.lower() or "irs treas" in name.lower():
            return "income", "tax_refund", "Tax refund", 0, "tax refund"
        if t["acct_type"] == "credit":
            return "refund", "refund", "Refund", 0, "credit on card"
        return "income", "other_income", "Other income", 1, "one-off deposit — is this income?"

    # People-to-people
    if P2P_RE.search(name):
        if out:
            return "spend", "p2p", "Sent to people", 0, "Zelle / Apple Cash"
        return "refund", "p2p", "Paybacks from people", 0, "Zelle / Apple Cash received — counted as a payback"

    # Cash
    if out and ATM_OUT_RE.search(name):
        return "spend", "cash", "Cash", 0, "ATM withdrawal"

    # Other transfers Plaid flagged, not to a known account of mine
    if primary in ("TRANSFER_IN", "TRANSFER_OUT"):
        if out:
            return "spend", "external_transfer", "Transfers out", 1, "transfer to an account the app doesn't know"
        return "income", "external_transfer", "Deposits", 1, "deposit from an account the app doesn't know"

    # Everything else: purchases, bills, refunds
    if out:
        return "spend", "purchase", cat, 0, "purchase"
    return "refund", "refund", cat, 0, "money back"


def _rule_match(t, rules):
    text = f"{t['name'] or ''} {t['counterparty'] or ''}".lower()
    for r in rules:
        if r["pattern"].lower() not in text:
            continue
        if r["account_id"] and r["account_id"] != t["account_id"]:
            continue
        if r["direction"] == "out" and t["amount"] <= 0 or r["direction"] == "in" and t["amount"] >= 0:
            continue
        return r
    return None


def _pair_transfers(txns, cls):
    """Match both halves of the same money move (A −$X, B +$X within a few days). Both become transfers."""
    by_amt = defaultdict(list)
    for t in txns:
        c = cls[t["txn_id"]]
        if c["locked"] and c["flow"] != "transfer":
            continue
        if c["kind"] in ("p2p", "cash", "paycheck", "mortgage"):  # money to/from people is never my own transfer
            continue
        if t["amount"] and _transfer_like(t) or c["flow"] == "transfer":
            by_amt[round(abs(t["amount"]), 2)].append(t)
    used = set()
    for group in by_amt.values():
        outs = [t for t in group if t["amount"] > 0]
        ins = [t for t in group if t["amount"] < 0]
        candidates = sorted(
            ((abs((_d(o["date"]) - _d(i["date"])).days), o, i) for o in outs for i in ins
             if o["account_id"] != i["account_id"]),
            key=lambda x: x[0])
        for gap, o, i in candidates:
            if gap > PAIR_WINDOW_DAYS or o["txn_id"] in used or i["txn_id"] in used:
                continue
            used.update((o["txn_id"], i["txn_id"]))
            oc, ic = cls[o["txn_id"]], cls[i["txn_id"]]
            if "card_payment" in (oc["kind"], ic["kind"]) or i["acct_type"] == "credit":
                kind = "card_payment"
            elif i["acct_type"] == "investment":
                kind = "invest_contribution"
            elif o["acct_type"] == "investment":
                kind = "invest_withdrawal"
            else:
                kind = "internal"
            for t, other in ((o, i), (i, o)):
                c = cls[t["txn_id"]]
                if c["locked"]:
                    continue
                c.update(flow="transfer", kind=kind, pair_id=other["txn_id"], review=0,
                         category="Credit card payment" if kind == "card_payment" else
                         "Investing" if kind.startswith("invest") else "Transfer",
                         reason=f"matched with {other['acct_inst'] or 'another account'} on {other['date']}")


def _pair_venmo_funding(txns, cls):
    """A Venmo payment paid from a bank shows up twice: in Venmo (what it was) and at the bank ('Venmo' −$X).
    Keep the Venmo row as the spend and turn the bank row into a transfer."""
    bank = [t for t in txns if cls[t["txn_id"]]["kind"] == "venmo_unmatched" and not cls[t["txn_id"]]["locked"]]
    venmo = [t for t in txns if t["source"] == "venmo" and t["amount"] > 0
             and "venmo balance" not in (t["funding_source"] or "venmo balance").lower()]
    used = set()
    for b in bank:
        best = None
        for v in venmo:
            if v["txn_id"] in used or round(v["amount"], 2) != round(b["amount"], 2):
                continue
            gap = abs((_d(v["date"]) - _d(b["date"])).days)
            if gap <= PAIR_WINDOW_DAYS and (best is None or gap < best[0]):
                best = (gap, v)
        if best:
            used.add(best[1]["txn_id"])
            cls[b["txn_id"]].update(flow="transfer", kind="venmo_funding", category="Transfer", review=0,
                                    pair_id=best[1]["txn_id"], reason="paid for a Venmo payment (counted in Venmo)")


def _check_pay_schedule(txns, cls):
    """Paychecks land every 1-2 weeks on a fixed schedule. A payroll deposit with no other paycheck
    7 or 14 days before/after it is off-schedule (reimbursement, bonus...). Tiny ones are bank test deposits."""
    from analytics import _employer_key  # local import: analytics imports db only
    pay = [t for t in txns if cls[t["txn_id"]]["kind"] == "paycheck" and not cls[t["txn_id"]]["locked"]]
    for t in pay:
        if -t["amount"] < 5:
            cls[t["txn_id"]].update(flow="transfer", kind="test_deposit", category="Transfer", review=0,
                                    reason="tiny test deposit from payroll setup — not counted")
    dates = defaultdict(set)
    for t in pay:
        if cls[t["txn_id"]]["kind"] == "paycheck":
            dates[_employer_key(t["name"])].add(_d(t["date"]))
    for t in pay:
        c = cls[t["txn_id"]]
        if c["kind"] != "paycheck":
            continue
        own = dates[_employer_key(t["name"])]
        d = _d(t["date"])
        if len(own) < 3:
            continue  # not enough history to know the schedule
        on_schedule = any(abs((d - o).days - gap) <= 2 or abs((o - d).days - gap) <= 2
                          for o in own if o != d for gap in (7, 14))
        if not on_schedule:
            c.update(flow="refund", kind="reimbursement", category="Reimbursements", review=1,
                     reason="off-schedule deposit from your employer — reimbursement or bonus?")


def run():
    txns, overrides, rules, institutions = _load()
    own = _own_patterns(institutions)
    cls = {}
    for t in txns:
        ov = overrides.get(t["txn_id"])
        rule = _rule_match(t, rules)
        flow, kind, cat, review, reason = _auto(t, own)
        locked = False
        if rule:
            flow = rule["set_flow"] or flow
            cat = rule["set_category"] or cat
            kind, review, reason, locked = "rule", 0, f"your rule: '{rule['pattern']}'", bool(rule["set_flow"])
        if ov:
            flow = ov["flow"] or flow
            cat = ov["category"] or cat
            kind, review, reason, locked = "manual", 0, "you set this", bool(ov["flow"])
        cls[t["txn_id"]] = dict(flow=flow, kind=kind, category=cat, pair_id=None, review=review,
                                reason=reason, locked=locked)
    _pair_transfers(txns, cls)
    _pair_venmo_funding(txns, cls)
    _check_pay_schedule(txns, cls)
    with db.conn() as c:
        c.execute("DELETE FROM txn_class")
        c.executemany(
            "INSERT INTO txn_class(txn_id, flow, kind, category, pair_id, review, reason) VALUES (?,?,?,?,?,?,?)",
            [(tid, v["flow"], v["kind"], v["category"], v["pair_id"], v["review"], v["reason"]) for tid, v in cls.items()])
    return len(cls)

"""Accounts Plaid can't reach: Venmo (statement CSV import) and manual balances (e.g. mortgage)."""
import csv
import hashlib
import io
import re
import uuid
from datetime import datetime, timezone

import classify
import db

VENMO_ACCOUNT_ID = "venmo"


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _money(s):
    """'- $1,234.50' -> -1234.5 ; '' -> None"""
    s = (s or "").strip()
    if not s:
        return None
    neg = s.startswith("-") or s.startswith("(")
    num = re.sub(r"[^0-9.]", "", s)
    if not num:
        return None
    return -float(num) if neg else float(num)


def import_venmo_csv(raw_bytes):
    """Venmo > Me > Settings > Statements > Download CSV. Returns count of transactions imported.

    Venmo's CSV has a few junk rows above the real header; find the header by its 'Datetime' column.
    """
    text = raw_bytes.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = next((i for i, r in enumerate(rows) if "Datetime" in r and "Amount (total)" in r), None)
    if header_idx is None:
        raise ValueError("That doesn't look like a Venmo statement CSV (no 'Datetime' / 'Amount (total)' columns).")
    header = rows[header_idx]
    col = {name: header.index(name) for name in header if name}

    def get(r, name):
        i = col.get(name)
        return r[i] if i is not None and i < len(r) else ""

    count, ending_balance = 0, None
    with db.conn() as c:
        for r in rows[header_idx + 1:]:
            end = _money(get(r, "Ending Balance"))
            if end is not None:
                ending_balance = end
            txn_id, when = get(r, "ID").strip(), get(r, "Datetime").strip()
            amount = _money(get(r, "Amount (total)"))
            if not when or amount is None:
                continue
            if not txn_id:
                txn_id = hashlib.sha1("|".join(r).encode()).hexdigest()[:16]
            who = (get(r, "To") if amount < 0 else get(r, "From")).strip()
            note = get(r, "Note").strip()
            vtype = get(r, "Type").strip()
            name = f"{who} — {note}" if who and note else who or note or vtype
            db.upsert_txn(
                c, txn_id=f"venmo-{txn_id}", account_id=VENMO_ACCOUNT_ID, date=when[:10], name=name,
                # Venmo: +money in. Store in Plaid convention: positive = money out.
                amount=-amount, category=vtype, pending=0, detailed=None, raw_primary=None, source="venmo",
                txn_type=vtype, funding_source=(get(r, "Funding Source") or get(r, "Destination")).strip() or None,
                counterparty=who or None,
            )
            count += 1
        if ending_balance is not None or count:
            existing = c.execute("SELECT balance FROM accounts WHERE account_id=?", (VENMO_ACCOUNT_ID,)).fetchone()
            balance = ending_balance if ending_balance is not None else (existing["balance"] if existing else 0)
            c.execute(
                """INSERT OR REPLACE INTO accounts
                   (account_id, item_id, source, institution, name, mask, type, subtype, balance, available, currency, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (VENMO_ACCOUNT_ID, None, "venmo", "Venmo", "Venmo balance", None, "depository", "venmo",
                 balance, balance, "USD", _now()),
            )
    classify.run()
    return count


def upsert_manual(name, institution, acct_type, balance, account_id=None):
    """Add or update a hand-entered account. acct_type: depository | investment | credit | loan | other."""
    account_id = account_id or f"manual-{uuid.uuid4().hex[:10]}"
    with db.conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO accounts
               (account_id, item_id, source, institution, name, mask, type, subtype, balance, available, currency, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (account_id, None, "manual", institution, name, None, acct_type, "manual", balance, None, "USD", _now()),
        )
    return account_id


def delete_manual(account_id):
    with db.conn() as c:
        c.execute("DELETE FROM accounts WHERE account_id=? AND source IN ('manual','venmo')", (account_id,))
        c.execute("DELETE FROM transactions WHERE account_id=?", (account_id,))

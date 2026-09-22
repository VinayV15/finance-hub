"""Import Wealthfront Cash Account monthly statement PDFs (history from before Plaid was linked).

Each statement has three sections we care about:
  Deposits/Credits to Wealthfront Brokerage      -> money in
  Withdrawals/Debits from Wealthfront Brokerage  -> money out
  INTEREST                                       -> monthly interest
"Transfer between Wealthfront and Program Banks" is Wealthfront moving your cash between its partner
banks behind the scenes — ignored. Rows Plaid already has (same account, same amount, within 3 days)
are skipped, and re-importing the same statement never duplicates anything.
"""
import hashlib
import io
import re
from collections import Counter
from datetime import date, datetime

from pypdf import PdfReader

import classify
import db

ROW_RE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s{2,}(.*?)\s{2,}(-?)\$([\d,]+\.\d{2})\s*$")
PERIOD_RE = re.compile(r"Monthly Statement for (\w+) \d+ - \d+, (\d{4})")
SECTIONS = [
    ("Deposits/Credits to Wealthfront", "in"),
    ("Withdrawals/Debits from Wealthfront", "out"),
    ("Transfer between Wealthfront and Program Banks", None),
    ("INTEREST", "interest"),
    ("Balance and Interest Rate Details", None),
    ("Disclosures", None),
]

# Who the money went to/came from -> (display name, Plaid-style primary, detailed). First match wins.
KNOWN = [
    (r"acme|payroll", ("ACME Payroll Deposit", "INCOME", "INCOME_WAGES")),
    (r"amex|american express", ("Amex payment", "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT")),
    (r"servicer|servicer|loancare", ("Servicer mortgage", "LOAN_PAYMENTS", "LOAN_PAYMENTS_MORTGAGE_PAYMENT")),
    (r"robinhood", ("Robinhood", "TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS")),
    (r"venmo", ("Venmo", None, None)),  # direction decides TRANSFER_IN / TRANSFER_OUT
    (r"wells fargo", ("Wells Fargo", None, None)),
    (r"city water", ("City Water Utilities", "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_WATER")),
    (r"cable co", ("Cable Co", "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE")),
    (r"powerco|powerco", ("Power Co", "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY")),
    (r"planetgym", ("Planet Gym", "PERSONAL_CARE", "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS")),
]


def _pdf_text(raw_bytes):
    reader = PdfReader(io.BytesIO(raw_bytes))
    return "\n".join(p.extract_text(extraction_mode="layout") for p in reader.pages)


def _describe(section, middle):
    """-> (name, raw_primary, detailed, category, counterparty)"""
    if section == "interest":
        return f"Interest ({middle.strip()})", "INCOME", "INCOME_INTEREST_EARNED", "Income", "Wealthfront"
    parts = [p.strip() for p in re.split(r"\s{2,}", middle) if p.strip()]
    method = parts[0] if parts else ""
    initiator = parts[-1] if len(parts) >= 3 and parts[-1] != "--" else ""
    for pat, (name, primary, detailed) in KNOWN:
        if re.search(pat, initiator, re.I):
            if primary is None:
                primary = "TRANSFER_IN" if section == "in" else "TRANSFER_OUT"
                detailed = f"{primary}_ACCOUNT_TRANSFER"
            return name, primary, detailed, classify.CATEGORY_NAMES.get(primary, "Other"), initiator
    if not initiator:  # an ACH pull/push you started to/from one of your linked banks
        primary = "TRANSFER_IN" if section == "in" else "TRANSFER_OUT"
        return f"ACH transfer {'in' if section == 'in' else 'out'}", primary, f"{primary}_ACCOUNT_TRANSFER", "Transfer", None
    primary = "INCOME" if section == "in" else "GENERAL_SERVICES"
    return initiator.title(), primary, None, classify.CATEGORY_NAMES[primary], initiator


def parse_statement(text):
    """Returns (period_label, rows). Each row: date, amount (Plaid sign: + = money out), name, primary, ..."""
    m = PERIOD_RE.search(text)
    period = f"{m.group(1)} {m.group(2)}" if m else "unknown period"
    section, rows = None, []
    for line in text.splitlines():
        stripped = line.strip()
        for heading, sec in SECTIONS:
            if stripped.startswith(heading):
                section = sec
                break
        if section is None:
            continue
        r = ROW_RE.match(line)
        if not r:
            continue
        mo, dy, yr, middle, neg, amt = r.groups()
        amount = float(amt.replace(",", ""))
        if section == "out" or neg:
            amount = abs(amount)      # money out -> positive (Plaid convention)
        else:
            amount = -abs(amount)     # money in -> negative
        name, primary, detailed, category, counterparty = _describe(section, middle)
        rows.append(dict(date=date(int(yr), int(mo), int(dy)).isoformat(), amount=round(amount, 2), name=name,
                         raw_primary=primary, detailed=detailed, category=category, counterparty=counterparty,
                         section=section, raw=re.sub(r"\s{2,}", " | ", middle.strip())))
    return period, rows


def _wealthfront_account(c):
    row = c.execute("""SELECT account_id FROM accounts WHERE institution='Wealthfront' AND type='depository'
                       ORDER BY source='plaid' DESC LIMIT 1""").fetchone()
    if row:
        return row["account_id"]
    # Not linked through Plaid: keep history in a stand-alone Wealthfront Cash account.
    c.execute("""INSERT OR IGNORE INTO accounts(account_id, source, institution, name, type, subtype, balance, updated_at)
                 VALUES ('wealthfront-import', 'manual', 'Wealthfront', 'Cash Account', 'depository', 'cash', 0, ?)""",
              (datetime.now().isoformat(timespec="seconds"),))
    return "wealthfront-import"


def import_wealthfront_pdfs(files):
    """files: list of (filename, bytes). Returns a per-file report."""
    report = []
    with db.conn() as c:
        acct = _wealthfront_account(c)
        plaid_rows = [dict(r) for r in c.execute(
            "SELECT date, amount FROM transactions WHERE account_id=? AND source='plaid'", (acct,))]
        for fname, raw in files:
            try:
                period, rows = parse_statement(_pdf_text(raw))
            except Exception as e:  # not a PDF / unreadable
                report.append({"file": fname, "error": f"Couldn't read this file ({e.__class__.__name__})."})
                continue
            if not rows and "Wealthfront" not in fname:
                report.append({"file": fname, "period": period, "imported": 0, "skipped_plaid": 0,
                               "note": "No Wealthfront Cash transactions in this file."})
                continue
            seen, imported, skipped = Counter(), 0, 0
            for r in rows:
                # Same statement can list two identical rows (e.g. two $100 Robinhood moves on one day).
                key = f"{r['date']}|{r['section']}|{r['raw']}|{r['amount']}"
                seen[key] += 1
                txn_id = "wfstmt-" + hashlib.sha1(f"{key}|{seen[key]}".encode()).hexdigest()[:16]
                d = date.fromisoformat(r["date"])
                if any(abs(p["amount"] - r["amount"]) < 0.005 and abs((date.fromisoformat(p["date"]) - d).days) <= 3
                       for p in plaid_rows):
                    skipped += 1
                    continue
                db.upsert_txn(c, txn_id=txn_id, account_id=acct, date=r["date"], name=r["name"], amount=r["amount"],
                              category=r["category"], pending=0, detailed=r["detailed"], raw_primary=r["raw_primary"],
                              source="import", txn_type=r["section"], counterparty=r["counterparty"])
                imported += 1
            report.append({"file": fname, "period": period, "imported": imported, "skipped_plaid": skipped})
    classify.run()
    return report

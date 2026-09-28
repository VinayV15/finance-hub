"""Mortgage model: the lender's original schedule, what you've actually paid, and where that leaves you.

How a temporary buydown works: the note rate (e.g. 5.75%) sets the real schedule. During the buydown years
you pay less (P&I figured at the lower rate) and a subsidy fund set up at closing pays the lender the
difference, so the balance still falls exactly as the note-rate schedule says.

Extra money: each payment first covers any scheduled payment that's due (or due within DUE_WINDOW days);
whatever is left over is counted as extra principal. That's how most servicers apply overpayments, but
yours might differ — so you can pin the model to the real balance from a Servicer statement
("checkpoints"), and everything after that date starts from the real number.
"""
import json
import re
from datetime import date, timedelta

import db
import home

DUE_WINDOW = 25  # days before a due date that a payment counts toward it


def _add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def _pmt(principal, annual_rate, months):
    r = annual_rate / 1200
    return principal / months if r == 0 else principal * r / (1 - (1 + r) ** -months)


def get_config():
    return db.get_json("mortgage", None)


def save_config(cfg):
    db.set_json("mortgage", cfg)


def _borrower_rate(cfg, n):
    """Rate your payment is figured at for payment #n (1-based): buydown years first, then the note rate."""
    year = (n - 1) // 12
    buydown = cfg.get("buydown_rates") or []
    return buydown[year] if year < len(buydown) else cfg["note_rate"]


def original_schedule(cfg):
    """The lender's schedule with no extra payments."""
    P, rate, term = cfg["original_amount"], cfg["note_rate"], cfg["term_months"]
    first = date.fromisoformat(cfg["first_payment"])
    note_pi = round(_pmt(P, rate, term), 2)
    bal, rows = P, []
    for n in range(1, term + 1):
        interest = round(bal * rate / 1200, 2)
        principal = bal if n == term else round(note_pi - interest, 2)
        bal = round(bal - principal, 2)
        your_pi = round(_pmt(P, _borrower_rate(cfg, n), term), 2)
        rows.append({"n": n, "date": _add_months(first, n - 1).isoformat(), "rate": _borrower_rate(cfg, n),
                     "your_pi": your_pi, "subsidy": round(note_pi - your_pi, 2), "principal": round(principal, 2),
                     "interest": interest, "balance": max(bal, 0.0)})
    return rows


def scheduled_due(cfg, n):
    """What you owe for payment #n: your P&I (buydown-adjusted) + escrow."""
    return round(_pmt(cfg["original_amount"], _borrower_rate(cfg, n), cfg["term_months"]) + (cfg.get("escrow_monthly") or 0), 2)


def actual_payments(cfg):
    """Mortgage payments found in your accounts (+ any you entered by hand), oldest first."""
    pat = cfg.get("match_pattern") or "servicer|servicer"
    with db.conn() as c:
        rows = [dict(r) for r in c.execute("""SELECT t.txn_id, t.date, t.amount, a.institution FROM transactions t
            JOIN txn_class k USING(txn_id) LEFT JOIN accounts a ON a.account_id=t.account_id
            WHERE t.amount > 0 AND k.flow != 'ignore' ORDER BY t.date""")]
    found = [r for r in rows if re.search(pat, _name(r["txn_id"]), re.I)]
    manual = [{"txn_id": None, "date": m["date"], "amount": m["amount"], "institution": m.get("note") or "entered by hand"}
              for m in cfg.get("manual_payments") or []]
    return sorted(found + manual, key=lambda p: p["date"])


_names = {}


def _name(txn_id):
    if not _names:
        with db.conn() as c:
            _names.update({r["txn_id"]: f"{r['name']} {r['counterparty'] or ''}" for r in c.execute(
                "SELECT txn_id, name, counterparty FROM transactions")})
    return _names.get(txn_id, "")


def allocate(cfg, payments):
    """Split each payment into 'scheduled' (covers a due payment) and 'extra' (goes to principal)."""
    first = date.fromisoformat(cfg["first_payment"])
    owed = {}  # due # -> amount still owed
    next_n = 1
    out = []
    for p in payments:
        pay_day = date.fromisoformat(p["date"])
        left, sched = p["amount"], 0.0
        while left > 0.004:
            # Open the next due payment if it's past due or coming up within the window.
            while next_n <= cfg["term_months"] and (_add_months(first, next_n - 1) - pay_day).days <= DUE_WINDOW:
                owed.setdefault(next_n, scheduled_due(cfg, next_n))
                next_n += 1
            open_dues = [n for n in sorted(owed) if owed[n] > 0.004]
            if not open_dues:
                break
            n = open_dues[0]
            take = min(left, owed[n])
            owed[n] = round(owed[n] - take, 2)
            left = round(left - take, 2)
            sched += take
        out.append({**p, "scheduled": round(sched, 2), "extra": round(max(left, 0), 2)})
    out = _apply_checkpoint_gaps(cfg, out)
    # Paid through = last due fully covered by the regular portions of your payments.
    covered, paid_through = sum(a["scheduled"] for a in out), 0
    while paid_through < cfg["term_months"] and covered >= scheduled_due(cfg, paid_through + 1) - 0.004:
        covered -= scheduled_due(cfg, paid_through + 1)
        paid_through += 1
    return out, paid_through


def _extra_key(d):
    """Extra principal paid on day d lowers the balance before the next due date's interest (the 1st)."""
    return _add_months(date(d.year, d.month, 1), 1 if d.day > 1 else 0)


def _run(cfg, alloc, planned_extra_monthly=0.0, pin=True, today=None):
    """Month-by-month balance. With pin=True, a statement checkpoint replaces the balance as of its date:
    every payment on or before that date is already inside the statement number."""
    P, rate, term = cfg["original_amount"], cfg["note_rate"], cfg["term_months"]
    note_pi = round(_pmt(P, rate, term), 2)
    first = date.fromisoformat(cfg["first_payment"])
    today = today or date.today()
    extras = [(date.fromisoformat(a["date"]), a["extra"]) for a in alloc if a["extra"] > 0]
    checkpoints = sorted((date.fromisoformat(c["date"]), c["balance"]) for c in (cfg.get("checkpoints") or [])) if pin else []
    pinned_through = date.min
    bal, rows, n = P, [], 0
    while bal > 0.004 and n < term:
        n += 1
        due = _add_months(first, n - 1)
        future = due > today
        extra = planned_extra_monthly if future else sum(
            amt for d, amt in extras if _extra_key(d) == due and d > pinned_through)
        bal = round(bal - extra, 2)
        interest = round(bal * rate / 1200, 2)
        principal = min(bal, round(note_pi - interest, 2))
        bal = round(bal - principal, 2)
        nxt = _add_months(first, n)
        for cd, cb in checkpoints:
            if due <= cd < nxt:  # statement falls in this payment cycle
                bal, pinned_through = cb, cd
        rows.append({"n": n, "date": due.isoformat(), "principal": round(principal, 2), "interest": interest,
                     "extra": round(extra, 2), "balance": max(bal, 0.0), "projected": future})
    return rows


def _model_balance_on(cfg, alloc, day):
    """Balance the model expects on `day` from payments alone (ignoring statements)."""
    rows = _run(cfg, alloc, pin=False, today=day)
    past = [r for r in rows if date.fromisoformat(r["date"]) <= day]
    bal = past[-1]["balance"] if past else cfg["original_amount"]
    last_due = date.fromisoformat(past[-1]["date"]) if past else date.min
    # extra paid after the last due date (and by `day`) hasn't been applied in the monthly rows yet
    return round(bal - sum(a["extra"] for a in alloc
                           if a["extra"] > 0 and date.fromisoformat(a["date"]) <= day
                           and _extra_key(date.fromisoformat(a["date"])) > last_due), 2)


def _apply_checkpoint_gaps(cfg, alloc):
    """If a statement shows less principal than the model expects, the servicer counted more of your money
    as extra principal. Reassign that gap to the newest payments on or before the statement date."""
    for cp in sorted(cfg.get("checkpoints") or [], key=lambda c: c["date"]):
        day = date.fromisoformat(cp["date"])
        gap = round(_model_balance_on(cfg, alloc, day) - cp["balance"], 2)
        for a in sorted((a for a in alloc if date.fromisoformat(a["date"]) <= day), key=lambda a: a["date"], reverse=True):
            if gap <= 0.004:
                break
            move = min(gap, a["scheduled"])
            a["scheduled"] = round(a["scheduled"] - move, 2)
            a["extra"] = round(a["extra"] + move, 2)
            a["from_statement"] = True
            gap = round(gap - move, 2)
    return alloc


def actual_schedule(cfg, planned_extra_monthly=0.0):
    """Real history up to today (pinned to any statement balances), then a projection.
    Interest accrues at the note rate on the real balance."""
    alloc, paid_through = allocate(cfg, actual_payments(cfg))
    return _run(cfg, alloc, planned_extra_monthly), alloc, paid_through


def summary(planned_extra_monthly=0.0):
    cfg = get_config()
    if not cfg:
        return None
    orig = original_schedule(cfg)
    rows, alloc, paid_through = actual_schedule(cfg, planned_extra_monthly)
    today = date.today().isoformat()
    past = [r for r in rows if not r["projected"]]
    cur_bal = past[-1]["balance"] if past else cfg["original_amount"]
    orig_now = next((r["balance"] for r in reversed(orig) if r["date"] <= today), cfg["original_amount"])
    value = cfg.get("original_value") or cfg["original_amount"]
    pmi_request, pmi_auto = round(0.80 * value, 2), round(0.78 * value, 2)

    def first_below(sched, limit):
        return next((r["date"] for r in sched if r["balance"] <= limit), None)

    total_interest_orig = round(sum(r["interest"] for r in orig), 2)
    total_interest_now = round(sum(r["interest"] for r in rows), 2)
    extra_total = round(sum(a["extra"] for a in alloc), 2)
    est = home.estimate(cfg)  # your number if entered, else purchase price moved with the area index
    home_value = est["value"] if est else (cfg.get("current_value") or cfg.get("appraised_value") or value)
    # Yearly principal vs interest (history + projection) for the chart.
    years = {}
    for r in rows:
        y = r["date"][:4]
        e = years.setdefault(y, {"year": y, "principal": 0.0, "interest": 0.0, "extra": 0.0, "end_balance": 0.0})
        e["principal"] += r["principal"]; e["interest"] += r["interest"]; e["extra"] += r["extra"]
        e["end_balance"] = r["balance"]
    return {
        "config": cfg,
        "balance": cur_bal,
        "original_balance_now": orig_now,
        "ahead_by": round(orig_now - cur_bal, 2),
        "paid_off_pct": round(1 - cur_bal / cfg["original_amount"], 4),
        "principal_paid": round(cfg["original_amount"] - cur_bal, 2),
        "interest_paid": round(sum(r["interest"] for r in past), 2),
        "extra_principal": extra_total,
        "total_paid": round(sum(a["amount"] for a in alloc), 2),
        "paid_through_payment": paid_through,
        "paid_through_date": orig[paid_through - 1]["date"] if paid_through else None,
        "payoff_original": orig[-1]["date"],
        "payoff_projected": rows[-1]["date"] if rows else None,
        "months_saved": len(orig) - len(rows),
        "interest_original": total_interest_orig,
        "interest_projected": total_interest_now,
        "interest_saved": round(total_interest_orig - total_interest_now, 2),
        "note_pi": round(_pmt(cfg["original_amount"], cfg["note_rate"], cfg["term_months"]), 2),
        "current_due": scheduled_due(cfg, max(1, min(len(orig), sum(1 for r in orig if r["date"] <= today) + 1))),
        "rate_now": _borrower_rate(cfg, max(1, sum(1 for r in orig if r["date"] <= today))),
        "home_value": home_value,
        "equity": round(home_value - cur_bal, 2),
        "ltv": round(cur_bal / value, 4),
        "pmi": {"request_at_balance": pmi_request, "auto_at_balance": pmi_auto,
                "request_date_projected": first_below(rows, pmi_request),
                "auto_date_projected": first_below(rows, pmi_auto),
                "request_date_original": first_below(orig, pmi_request),
                "monthly": cfg.get("pmi_monthly")},
        "payments": list(reversed(alloc)),
        "original": orig,
        "actual": rows,
        "years": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in y.items()} for y in years.values()],
    }


def extra_by_txn():
    """txn_id -> extra principal in that payment (so analytics can count it as saving, not spending)."""
    cfg = get_config()
    if not cfg:
        return {}
    _names.clear()
    alloc, _ = allocate(cfg, actual_payments(cfg))
    return {a["txn_id"]: a["extra"] for a in alloc if a["txn_id"] and a["extra"] > 0}


def refresh_allocations():
    """Store each mortgage payment's extra-principal portion for the dashboards."""
    extra = extra_by_txn()
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS mortgage_alloc (txn_id TEXT PRIMARY KEY, extra REAL)")
        c.execute("DELETE FROM mortgage_alloc")
        c.executemany("INSERT INTO mortgage_alloc(txn_id, extra) VALUES (?, ?)", list(extra.items()))
    return extra


def dumps(x):
    return json.dumps(x, default=str)

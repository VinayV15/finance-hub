"""Numbers for the dashboards. Everything here reads classified transactions (see classify.py),
so transfers between your own accounts never show up as spending or income."""
import re
import statistics
from collections import defaultdict
from datetime import date, timedelta

import db

PERIODS = {
    "day": "t.date",
    "week": "date(t.date, 'weekday 0', '-6 days')",  # week starting Monday
    "month": "substr(t.date, 1, 7)",
    "quarter": "substr(t.date,1,4) || '-Q' || ((cast(substr(t.date,6,2) as integer) + 2) / 3)",
    "year": "substr(t.date, 1, 4)",
}


def _where(start=None, end=None, accounts=None, extra=""):
    sql, args = ["1=1"], []
    if start:
        sql.append("t.date >= ?"); args.append(start)
    if end:
        sql.append("t.date <= ?"); args.append(end)
    if accounts:
        sql.append(f"t.account_id IN ({','.join('?' * len(accounts))})"); args.extend(accounts)
    if extra:
        sql.append(extra)
    return " AND ".join(sql), args


# Money into an investment account = invested. Count it once: the bank side if we have it, otherwise
# the investment-account side when its bank half is missing.
_INVESTED = """CASE
    WHEN k.kind='invest_contribution' AND a.type!='investment' AND t.amount>0 THEN t.amount
    WHEN k.kind='invest_contribution' AND a.type='investment' AND t.amount<0 AND k.pair_id IS NULL THEN -t.amount
    WHEN k.kind='invest_withdrawal' AND a.type!='investment' AND t.amount<0 THEN t.amount
    WHEN k.kind='invest_withdrawal' AND a.type='investment' AND t.amount>0 AND k.pair_id IS NULL THEN -t.amount
    ELSE 0 END"""

_SELECT_TOTALS = f"""
    ROUND(SUM(CASE WHEN k.flow='income' THEN -t.amount ELSE 0 END), 2) AS income,
    ROUND(SUM(CASE WHEN k.flow='spend' THEN t.amount - COALESCE(m.extra, 0) ELSE 0 END), 2) AS spend_gross,
    ROUND(SUM(CASE WHEN k.flow='refund' THEN -t.amount ELSE 0 END), 2) AS refunds,
    ROUND(SUM({_INVESTED}), 2) AS invested,
    ROUND(SUM(COALESCE(m.extra, 0)), 2) AS extra_principal,
    ROUND(SUM(CASE WHEN k.flow='growth' THEN -t.amount ELSE 0 END), 2) AS growth,
    ROUND(SUM(CASE WHEN k.kind IN ('paycheck','paycheck_bonus') THEN -t.amount ELSE 0 END), 2) AS paychecks"""

_FROM = """FROM transactions t JOIN txn_class k USING(txn_id) LEFT JOIN accounts a ON a.account_id=t.account_id
    LEFT JOIN mortgage_alloc m ON m.txn_id=t.txn_id"""

# Spending amount of a row: extra mortgage principal is saving (it becomes equity), not spending.
_SPEND_AMT = "(t.amount - COALESCE(m.extra, 0))"


def _finish(row):
    r = dict(row)
    r["spend"] = round((r["spend_gross"] or 0) - (r["refunds"] or 0), 2)
    r["saved"] = round((r["income"] or 0) - r["spend"], 2)
    r["savings_rate"] = round(r["saved"] / r["income"], 4) if r["income"] else None
    return r


def cashflow(start=None, end=None, group="month", accounts=None):
    where, args = _where(start, end, accounts)
    with db.conn() as c:
        rows = c.execute(f"SELECT {PERIODS[group]} AS period, {_SELECT_TOTALS} {_FROM} WHERE {where} "
                         f"GROUP BY period ORDER BY period", args).fetchall()
        total = c.execute(f"SELECT {_SELECT_TOTALS} {_FROM} WHERE {where}", args).fetchone()
    periods = [_finish(r) for r in rows]
    # 401(k) never hits a bank account, so it's estimated from paychecks (only when viewing all accounts).
    ret = retirement_by_period(start, end, group) if not accounts else {}
    for p in periods:
        p["retirement"] = ret.get(p["period"], 0)
    total = _finish(total)
    total["retirement"] = round(sum(ret.values()), 2)
    return {"periods": periods, "total": total}


def by_category(start=None, end=None, accounts=None, flow="spend"):
    """Net spend per category (refunds subtract), or income per category."""
    flows = ("spend", "refund") if flow == "spend" else ("income",)
    where, args = _where(start, end, accounts, f"k.flow IN ({','.join('?' * len(flows))})")
    args += list(flows)
    expr = _SPEND_AMT if flow == "spend" else "-t.amount"
    with db.conn() as c:
        rows = c.execute(f"""SELECT k.category, ROUND(SUM({expr}), 2) AS amount, COUNT(*) AS n
            {_FROM} WHERE {where} GROUP BY k.category HAVING amount != 0 ORDER BY amount DESC""", args).fetchall()
    return [dict(r) for r in rows]


def by_account(start=None, end=None):
    """Per account: what came in, what was spent from it, and what moved to/from your other accounts."""
    where, args = _where(start, end)
    with db.conn() as c:
        rows = c.execute(f"""SELECT a.account_id, a.institution, a.name, a.type, {_SELECT_TOTALS},
            ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount<0 THEN -t.amount ELSE 0 END), 2) AS transfers_in,
            ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount>0 THEN t.amount ELSE 0 END), 2) AS transfers_out,
            COUNT(*) AS n
            {_FROM} WHERE {where} GROUP BY a.account_id ORDER BY a.institution, a.name""", args).fetchall()
    return [_finish(r) for r in rows]


def top_merchants(start=None, end=None, accounts=None, limit=15):
    where, args = _where(start, end, accounts, "k.flow IN ('spend','refund')")
    with db.conn() as c:
        rows = c.execute(f"""SELECT t.name, ROUND(SUM({_SPEND_AMT}),2) AS amount, COUNT(*) AS n
            {_FROM} WHERE {where} GROUP BY lower(t.name) HAVING amount > 0 ORDER BY amount DESC LIMIT ?""",
                         args + [limit]).fetchall()
    return [dict(r) for r in rows]


def data_coverage():
    """First/last transaction date per account, so the UI can warn when a range has gaps."""
    with db.conn() as c:
        rows = c.execute("""SELECT a.account_id, a.institution, a.name, MIN(t.date) AS first, MAX(t.date) AS last,
            COUNT(t.txn_id) AS n FROM accounts a LEFT JOIN transactions t ON t.account_id=a.account_id
            GROUP BY a.account_id ORDER BY first""").fetchall()
    return [dict(r) for r in rows]


# ---------- income ----------

def _employer_key(name):
    """'ACME PAYROLL 0YAVDY… JANE' / 'Acme - Payroll Deposit' -> 'ACME';
    'GLOBEX CORP, L Payroll 010325' -> 'GLOBEX CORP'. Leading words up to the first payroll-ish word."""
    stop = {"PAYROLL", "DEPOSIT", "DIRECT", "DEP", "ACH", "PAYMENTS", "PMT", "-"}
    out = []
    for w in (name or "").upper().split(",")[0].split():
        if w in stop or any(ch.isdigit() for ch in w) or w in ("INSTANT", "FROM") and not out:
            if out:
                break
            continue
        out.append(w)
        if len(out) == 4:
            break
    return " ".join(out) or "Unknown"


def _frequency(gaps):
    if not gaps:
        return None, None
    g = statistics.median(gaps)
    for label, days, per_year in (("weekly", 7, 52), ("biweekly", 14, 26), ("semimonthly", 15.2, 24),
                                  ("monthly", 30.4, 12)):
        if abs(g - days) <= 2.5:
            return label, per_year
    return f"every ~{round(g)} days", round(365 / g, 1)


def detected_income():
    """Group paycheck deposits by employer. A paycheck split across accounts (same day) counts once."""
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(f"""SELECT t.date, t.name, -t.amount AS amount, a.institution, k.kind
            {_FROM} WHERE k.flow='income' AND k.kind IN ('paycheck','paycheck_bonus')
            ORDER BY t.date""")]
    by_emp = defaultdict(lambda: defaultdict(float))
    split = defaultdict(set)
    bonus_days = defaultdict(set)
    for r in rows:
        k = _employer_key(r["name"])
        by_emp[k][r["date"]] += r["amount"]
        split[k].add(r["institution"])
        if r["kind"] == "paycheck_bonus":
            bonus_days[k].add(r["date"])
    today = date.today()
    out = []
    for emp, days in by_emp.items():
        dates = sorted(days)
        amounts = [days[d] for d in dates]
        gaps = [(date.fromisoformat(b) - date.fromisoformat(a)).days for a, b in zip(dates, dates[1:])]
        freq, per_year = _frequency(gaps[-8:])
        regular = [days[d] for d in dates if d not in bonus_days[emp]]
        recent = (regular or amounts)[-6:]
        last_date = date.fromisoformat(dates[-1])
        out.append({
            "employer": emp,
            "deposits": len(dates),
            "first": dates[0], "last": dates[-1],
            "active": (today - last_date).days <= 45,
            "frequency": freq,
            "typical_paycheck": round(statistics.median(recent), 2),
            "annualized": round(statistics.median(recent) * per_year, 2) if per_year else None,
            "last_12_months": round(sum(v for d, v in days.items() if date.fromisoformat(d) >= today - timedelta(days=365)), 2),
            "accounts": sorted(i for i in split[emp] if i),
            "history": [{"date": d, "amount": round(days[d], 2)} for d in dates],
            "bonuses": [{"date": d, "total": round(days[d], 2),
                         "bonus": round(days[d] - statistics.median(
                             [days[x] for x in dates if x not in bonus_days[emp]][-6:] or [0]), 2)}
                        for d in sorted(bonus_days[emp])],
        })
    out.sort(key=lambda e: e["last"], reverse=True)
    return out


PERIODS_PER_YEAR = {"weekly": 52, "biweekly": 26, "semimonthly": 24, "monthly": 12}


def pay_breakdown(cfg=None):
    """One paycheck, top to bottom: gross -> your 401(k) -> taxes & other deductions -> take-home.
    Plus the employer match, which never touches a bank account but is still money saved for you."""
    cfg = cfg if cfg is not None else (db.get_json("income", {}) or {})
    n = PERIODS_PER_YEAR.get(cfg.get("pay_frequency") or "biweekly", 26)
    gross_annual, net = cfg.get("gross_annual"), cfg.get("net_per_paycheck")
    if not gross_annual or not net:
        return None
    gross = gross_annual / n
    k401 = gross * (cfg.get("retirement_pct") or 0) / 100
    match = gross * (cfg.get("employer_match_pct") or 0) / 100
    return {
        "periods_per_year": n,
        "per_paycheck": {"gross": round(gross, 2), "retirement": round(k401, 2),
                         "taxes_and_other": round(gross - k401 - net, 2), "take_home": round(net, 2),
                         "employer_match": round(match, 2)},
        "per_year": {"gross": round(gross_annual, 2), "retirement": round(k401 * n, 2),
                     "taxes_and_other": round((gross - k401 - net) * n, 2), "take_home": round(net * n, 2),
                     "employer_match": round(match * n, 2)},
        "effective_tax_rate": round((gross - k401 - net) / gross, 4) if gross else None,
    }


def pay_history():
    """Pay settings over time, oldest first. Each entry applies from its `effective` date until the next.
    The current settings (the Income form) are the newest entry."""
    cfg = db.get_json("income", {}) or {}
    past = sorted(cfg.get("history") or [], key=lambda h: h["effective"])
    current = {k: cfg.get(k) for k in ("gross_annual", "net_per_paycheck", "retirement_pct", "employer_match_pct",
                                       "pay_frequency")}
    current["effective"] = cfg.get("effective") or (past[-1]["effective"] if past else "0000-01-01")
    return past + [current] if cfg.get("gross_annual") else past


def settings_on(day, history=None):
    """The pay settings in effect on a given date (ISO string)."""
    history = history if history is not None else pay_history()
    active = [h for h in history if h["effective"] <= day]
    return active[-1] if active else None


def paycheck_dates(start=None, end=None):
    """Distinct paycheck days (a paycheck split across accounts is one day)."""
    where, args = _where(start, end, None, "k.kind IN ('paycheck','paycheck_bonus')")
    with db.conn() as c:
        return [r[0] for r in c.execute(f"SELECT DISTINCT t.date {_FROM} WHERE {where} ORDER BY t.date", args)]


def retirement_by_period(start=None, end=None, group="month"):
    """Estimated 401(k) money (yours + match) per period, using the pay settings in effect on each payday."""
    history = pay_history()
    if not history:
        return {}
    where, args = _where(start, end, None, "k.kind IN ('paycheck','paycheck_bonus')")
    with db.conn() as c:
        rows = c.execute(f"SELECT DISTINCT {PERIODS[group]} AS period, t.date {_FROM} WHERE {where}", args).fetchall()
    out = defaultdict(float)
    for r in rows:
        h = settings_on(r["date"], history)
        b = pay_breakdown(h) if h else None
        if b:
            out[r["period"]] += b["per_paycheck"]["retirement"] + b["per_paycheck"]["employer_match"]
    return {k: round(v, 2) for k, v in out.items()}


def income_check():
    """Your pay settings, what that works out to, and what has actually arrived."""
    cfg = db.get_json("income", {}) or {}
    b = pay_breakdown(cfg)
    year_start = date.today().replace(month=1, day=1).isoformat()
    ytd_dates = paycheck_dates(start=year_start)
    with db.conn() as c:
        ytd_take_home = c.execute(f"SELECT COALESCE(SUM(-t.amount),0) {_FROM} WHERE k.kind IN ('paycheck','paycheck_bonus') AND t.date>=?",
                                  (year_start,)).fetchone()[0]
    n = len(ytd_dates)
    ytd = {"paychecks": n, "take_home": round(ytd_take_home, 2)}
    warning = None
    if b:
        ytd.update(expected_take_home=round(n * b["per_paycheck"]["take_home"], 2),
                   gross=round(n * b["per_paycheck"]["gross"], 2),
                   retirement=round(n * b["per_paycheck"]["retirement"], 2),
                   employer_match=round(n * b["per_paycheck"]["employer_match"], 2))
        gap = ytd["take_home"] - ytd["expected_take_home"]
        if n and abs(gap) > b["per_paycheck"]["take_home"] * 0.05:
            warning = (f"This year's paychecks add up to ${abs(gap):,.2f} {'more' if gap > 0 else 'less'} than "
                       f"{n} × your take-home per paycheck.")
    return {"settings": cfg, "breakdown": b, "ytd": ytd, "detected": detected_income(), "warning": warning,
            "history": pay_history()}

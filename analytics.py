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


def history_start():
    """Earliest date shown anywhere (older data is kept for transfer matching but hidden)."""
    return db.get_meta("history_start")


def _where(start=None, end=None, accounts=None, extra=""):
    sql, args = ["1=1"], []
    floor = history_start()
    if floor and (not start or start < floor):
        start = floor
    if start:
        sql.append("t.date >= ?"); args.append(start)
    if end:
        sql.append("t.date <= ?"); args.append(end)
    if accounts:
        sql.append(f"t.account_id IN ({','.join('?' * len(accounts))})"); args.extend(accounts)
    if extra:
        sql.append(extra)
    return " AND ".join(sql), args


# Money into an investment account = invested. Counted once, on the investment account's side (every
# deposit into Robinhood shows up there), and moves between two of your investment accounts (e.g.
# brokerage -> Roth) don't count as new investing. Bank-side rows only count when no investment account
# received them (an investment account that isn't linked).
_INV_EXTERNAL = "COALESCE(ap.type, '') != 'investment'"
_INVESTED = f"""CASE
    WHEN k.kind='invest_contribution' AND a.type='investment' AND t.amount<0 AND {_INV_EXTERNAL} THEN -t.amount
    WHEN k.kind='invest_withdrawal' AND a.type='investment' AND t.amount>0 AND {_INV_EXTERNAL} THEN -t.amount
    WHEN k.kind='invest_contribution' AND a.type!='investment' AND t.amount>0 AND k.pair_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.type='investment') THEN t.amount
    ELSE 0 END"""
# Roth contributions count every deposit into the Roth, including moves from your own brokerage account.
_INVESTED_ROTH = """CASE WHEN lower(COALESCE(a.subtype,'')) LIKE '%roth%' AND k.kind='invest_contribution'
    AND t.amount<0 THEN -t.amount ELSE 0 END"""

_SELECT_TOTALS = f"""
    ROUND(SUM(CASE WHEN k.flow='income' THEN -t.amount ELSE 0 END), 2) AS income,
    ROUND(SUM(CASE WHEN k.flow='spend' THEN t.amount - COALESCE(m.extra, 0) ELSE 0 END), 2) AS spend_gross,
    ROUND(SUM(CASE WHEN k.flow='refund' THEN -t.amount ELSE 0 END), 2) AS refunds,
    ROUND(SUM({_INVESTED}), 2) AS invested,
    ROUND(SUM({_INVESTED_ROTH}), 2) AS invested_roth,
    ROUND(SUM(CASE WHEN lower(COALESCE(a.subtype,'')) LIKE '%roth%' THEN 0 ELSE {_INVESTED} END), 2) AS invested_other,
    ROUND(SUM(COALESCE(m.extra, 0)), 2) AS extra_principal,
    ROUND(SUM(CASE WHEN k.flow='growth' THEN -t.amount ELSE 0 END), 2) AS growth,
    ROUND(SUM(CASE WHEN k.kind IN ('paycheck','paycheck_bonus') THEN -t.amount ELSE 0 END), 2) AS paychecks"""

_FROM = """FROM transactions t JOIN txn_class k USING(txn_id) LEFT JOIN accounts a ON a.account_id=t.account_id
    LEFT JOIN mortgage_alloc m ON m.txn_id=t.txn_id
    LEFT JOIN transactions tp ON tp.txn_id=k.pair_id LEFT JOIN accounts ap ON ap.account_id=tp.account_id"""

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
    with db.conn() as c:  # months with any activity, for per-month averages
        total["months"] = c.execute(f"SELECT COUNT(DISTINCT substr(t.date,1,7)) {_FROM} WHERE {where}", args).fetchone()[0]
    return {"periods": periods, "total": total}


# ---------- your home ----------

def home_position():
    """Home value and what's left on the mortgage (Mortgage page settings), so net worth includes them.
    If a linked loan account already is the mortgage, its balance is counted there instead."""
    import mortgage
    try:
        m = mortgage.summary()
    except Exception:
        return None
    if not m:
        return None
    with db.conn() as c:
        linked = c.execute("SELECT 1 FROM accounts WHERE type='loan' AND lower(COALESCE(subtype,''))='mortgage'").fetchone()
    cfg = m["config"]
    return {"home_value": m["home_value"], "mortgage": 0 if linked else m["balance"], "mortgage_linked": bool(linked),
            "equity": m["equity"], "closing_date": cfg.get("closing_date"), "original_amount": cfg["original_amount"],
            "schedule": [(r["date"], r["balance"]) for r in m["actual"] if not r["projected"]]}


def _mortgage_on(home, day):
    if not home or not home["closing_date"] or day < home["closing_date"]:
        return None
    past = [b for d, b in home["schedule"] if d <= day]
    return past[-1] if past else home["original_amount"]


# ---------- net worth over time ----------

def networth_history(weeks=52):
    """Weekly net worth (same definition as the Overview card: account balances, assets minus debts),
    rebuilt backward from today's balances: a balance last week = today's balance minus what moved since.
    Investment accounts use recorded daily balances where they exist; before that, only deposits,
    withdrawals and dividends are known, so market moves are missing (flagged as estimated)."""
    today = date.today()
    floor = history_start()
    days = [today - timedelta(weeks=w) for w in range(weeks, 0, -1)] + [today]
    days = [d.isoformat() for d in days if not floor or d.isoformat() >= floor]
    with db.conn() as c:
        accts = [dict(r) for r in c.execute("SELECT account_id, type, balance FROM accounts WHERE balance IS NOT NULL")]
        txns = defaultdict(list)
        for r in c.execute("SELECT account_id, date, amount FROM transactions WHERE pending=0 ORDER BY date"):
            txns[r["account_id"]].append((r["date"], r["amount"]))
        snaps = defaultdict(list)
        for r in c.execute("SELECT account_id, date, balance FROM balance_snapshots ORDER BY date"):
            snaps[r["account_id"]].append((r["date"], r["balance"]))
    first_snap = min((v[0][0] for v in snaps.values() if v), default=None)
    home = home_position()
    out = []
    for d in days:
        cash = invested = debts = 0.0
        for a in accts:
            moved_after = sum(amt for dt, amt in txns[a["account_id"]] if dt > d)  # Plaid sign: + = money out
            if a["type"] in ("credit", "loan"):
                debts += a["balance"] - moved_after  # owed grows with charges
                continue
            if a["type"] == "investment":
                s = [b for dt, b in snaps[a["account_id"]] if dt <= d]
                invested += s[-1] if s else a["balance"] + moved_after
                continue
            cash += a["balance"] + moved_after
        owed = _mortgage_on(home, d)
        equity = 0.0
        if owed is not None:  # home value is today's estimate throughout; the mortgage follows its schedule
            equity = home["home_value"] - (owed if not home["mortgage_linked"] else 0)
        out.append({"date": d, "cash": round(cash, 2), "invested": round(invested, 2), "debts": round(debts, 2),
                    "home_equity": round(equity, 2),
                    "net_worth": round(cash + invested - debts + equity, 2), "estimated": not first_snap or d < first_snap})
    return {"points": out, "exact_from": first_snap}


# ---------- investments ----------

def _snapshot_on(c, account_id, day):
    """Latest recorded balance on or before a day, as (date, balance)."""
    r = c.execute("SELECT date, balance FROM balance_snapshots WHERE account_id=? AND date<=? ORDER BY date DESC LIMIT 1",
                  (account_id, day)).fetchone()
    return (r["date"], r["balance"]) if r else (None, None)


def investments(start=None, end=None, accounts=None):
    """Each investment account: what it's worth now, what you put in during the range, and what it earned.

    Earnings over a range = value at the end - value at the start - money you moved in (moves between your
    own accounts count, e.g. brokerage -> Roth is money into the Roth). That needs a recorded balance at the
    start of the range; balances are recorded daily from the first time this runs. Until then, the gain on
    what you hold now (value - what you paid) is the honest all-time number."""
    today = date.today().isoformat()
    where, args = _where(start, end, None, "a.type='investment'")
    with db.conn() as c:
        accts = [dict(r) for r in c.execute("""SELECT a.account_id, a.institution, a.name, a.subtype, a.balance AS value,
                (SELECT SUM(h.cost_basis) FROM holdings h WHERE h.account_id=a.account_id) AS cost_basis
            FROM accounts a WHERE a.type='investment' ORDER BY a.balance DESC""")]
        if accounts:
            accts = [a for a in accts if a["account_id"] in accounts]
        flows = {r["account_id"]: dict(r) for r in c.execute(f"""SELECT t.account_id,
                ROUND(SUM({_INVESTED}), 2) AS put_in,
                ROUND(SUM(CASE WHEN k.flow='growth' THEN -t.amount ELSE 0 END), 2) AS dividends,
                ROUND(SUM(CASE WHEN k.kind='invest_fee' THEN t.amount ELSE 0 END), 2) AS fees
            {_FROM} WHERE {where} GROUP BY t.account_id""", args)}
        first_snap = c.execute("SELECT MIN(date) FROM balance_snapshots").fetchone()[0]
        for a in accts:
            f = flows.get(a["account_id"], {})
            a["put_in"] = f.get("put_in") or 0
            a["dividends"] = f.get("dividends") or 0
            a["fees"] = f.get("fees") or 0
            a["kind"] = "roth" if "roth" in (a["subtype"] or "").lower() else \
                "401k" if "401" in (a["subtype"] or "") else \
                "ira" if "ira" in (a["subtype"] or "").lower() else "brokerage"
            a["gain_all_time"] = round(a["value"] - a["cost_basis"], 2) if a["cost_basis"] else None
            a["gain_all_time_pct"] = round(a["gain_all_time"] / a["cost_basis"], 4) if a["cost_basis"] else None
            # Range earnings, when a balance was recorded at (or before) the start of the range.
            a["gain_range"] = None
            if start:
                s_day, s_val = _snapshot_on(c, a["account_id"], start)
                e_day, e_val = (today, a["value"]) if not end or end >= today else _snapshot_on(c, a["account_id"], end)
                if s_day and e_day and e_val is not None:
                    moved = c.execute("""SELECT COALESCE(SUM(-t.amount), 0) FROM transactions t JOIN txn_class k USING(txn_id)
                        WHERE t.account_id=? AND k.kind IN ('invest_contribution','invest_withdrawal')
                        AND t.date > ? AND t.date <= ?""", (a["account_id"], s_day, e_day)).fetchone()[0]
                    a["gain_range"] = round(e_val - s_val - moved, 2)
    # 401(k) isn't linked yet: estimate from paychecks (all accounts view only), contributions with no market gains.
    est = None
    if not accounts and not has_linked_401k():
        all_time = sum(retirement_by_period(None, None, "year").values())
        in_range = sum(retirement_by_period(start, end, "year").values())
        if all_time:
            est = {"value": round(all_time, 2), "put_in": round(in_range, 2)}
    have_range = all(a["gain_range"] is not None for a in accts) and bool(accts)
    tot = lambda k: round(sum(a[k] or 0 for a in accts), 2)
    return {
        "accounts": accts,
        "retirement_estimate": est,
        "total": {
            "value": round(tot("value") + (est["value"] if est else 0), 2),
            "put_in": round(tot("put_in") + (est["put_in"] if est else 0), 2),
            "dividends": tot("dividends"), "fees": tot("fees"),
            "gain_all_time": tot("gain_all_time"),
            "cost_basis": tot("cost_basis"),
            "gain_range": tot("gain_range") if have_range else None,
        },
        "tracking_since": first_snap,
    }


def by_category(start=None, end=None, accounts=None, flow="spend"):
    """Net spend per category (refunds subtract), or income per category."""
    flows = ("spend", "refund") if flow == "spend" else ("income",)
    where, args = _where(start, end, accounts, f"k.flow IN ({','.join('?' * len(flows))})")
    args += list(flows)
    expr = _SPEND_AMT if flow == "spend" else "-t.amount"
    with db.conn() as c:
        rows = c.execute(f"""SELECT k.category, ROUND(SUM({expr}), 2) AS amount, COUNT(*) AS n
            {_FROM} WHERE {where} GROUP BY k.category HAVING SUM({expr}) != 0 ORDER BY 2 DESC""", args).fetchall()
    return [dict(r) for r in rows]


def by_account(start=None, end=None):
    """Per account: what came in, what was spent from it, and what moved to/from your other accounts."""
    where, args = _where(start, end)
    with db.conn() as c:
        rows = c.execute(f"""SELECT a.account_id, a.institution, a.name, a.type, {_SELECT_TOTALS},
            ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount<0 THEN -t.amount ELSE 0 END), 2) AS transfers_in,
            ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount>0 THEN t.amount ELSE 0 END), 2) AS transfers_out,
            ROUND(SUM(-t.amount), 2) AS net_change,  -- everything in minus everything out = how the balance moved
            a.balance, COUNT(*) AS n
            {_FROM} WHERE {where} GROUP BY a.account_id ORDER BY a.institution, a.name""", args).fetchall()
    return [_finish(r) for r in rows]


def top_merchants(start=None, end=None, accounts=None, limit=15):
    where, args = _where(start, end, accounts, "k.flow IN ('spend','refund')")
    with db.conn() as c:
        rows = c.execute(f"""SELECT t.name, ROUND(SUM({_SPEND_AMT}),2) AS amount, COUNT(*) AS n,
            ROUND(SUM(t.amount),2) AS paid, ROUND(SUM(COALESCE(m.extra,0)),2) AS extra_principal
            {_FROM} WHERE {where} GROUP BY lower(t.name) HAVING SUM({_SPEND_AMT}) > 0 ORDER BY 2 DESC LIMIT ?""",
                         args + [limit]).fetchall()
    return [dict(r) for r in rows]


def data_coverage():
    """First/last transaction date per account, so the UI can warn when a range has gaps."""
    with db.conn() as c:
        rows = c.execute("""SELECT a.account_id, a.institution, a.name, MIN(t.date) AS first, MAX(t.date) AS last,
            COUNT(t.txn_id) AS n FROM accounts a LEFT JOIN transactions t ON t.account_id=a.account_id
            GROUP BY a.account_id ORDER BY first""").fetchall()  # true first date, so hidden history isn't a "gap"
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
            {_FROM} WHERE k.flow='income' AND k.kind IN ('paycheck','paycheck_bonus') AND t.date >= ?
            ORDER BY t.date""", (history_start() or "",))]
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


def has_linked_401k():
    with db.conn() as c:
        return c.execute("SELECT 1 FROM accounts WHERE type='investment' AND lower(COALESCE(subtype,'')) LIKE '%401%'"
                         ).fetchone() is not None


def retirement_by_period(start=None, end=None, group="month"):
    """Estimated 401(k) money (yours + match) per period, using the pay settings in effect on each payday.
    Once a real 401(k) account is linked its own transactions count instead, so this returns nothing."""
    history = pay_history()
    if not history or has_linked_401k():
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

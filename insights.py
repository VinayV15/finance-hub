"""Phase 4: things that look ahead. Recurring bills, a cash forecast, tax-year limits, and alerts.
Everything is derived from classified transactions (classify.py) and the pay settings (analytics.py)."""
import re
import statistics
from collections import defaultdict
from datetime import date, timedelta

import analytics
import db
import planning

CADENCES = [  # label, days between charges, allowed wobble (days), per-month factor
    ("weekly", 7, 1.5, 52 / 12),
    ("every 2 weeks", 14, 2.5, 26 / 12),
    ("monthly", 30.4, 4, 1),
    ("every 3 months", 91, 10, 1 / 3),
    ("every 6 months", 182, 15, 1 / 6),
    ("yearly", 365, 20, 1 / 12),
]


# Places you go often but don't have a bill with; only exact repeating charges here count as recurring.
HABIT_CATEGORIES = {"Food & Drink", "Transportation", "Shopping", "Travel", "Entertainment", "Personal Care"}


def _merchant_key(name):
    """'AMERICAN EXPRESS ACH PMT 260818 A0896' -> 'american express ach pmt'; 'Planet Gym' -> 'planetgym fitness'."""
    s = (name or "").lower()
    s = re.sub(r"\b(on|ref|id|conf|web id|ppd|ccd)\b.*$", "", s)
    s = re.sub(r"[#*].*$", "", s)
    s = re.sub(r"\b[a-z]*\d[\w-]*\b", " ", s)  # tokens with digits: dates, refs, card numbers
    s = re.sub(r"\s+", " ", s).strip(" -.,") or (name or "").lower()
    return " ".join(s.split()[:3])  # 'city water utilities' and 'city water' are the same biller


def _cadence(gaps):
    if len(gaps) < 2:
        return None
    g = statistics.median(gaps)
    for label, days, wobble, per_month in CADENCES:
        if abs(g - days) <= wobble:
            # most gaps must agree (one skipped or doubled month is fine)
            ok = sum(1 for x in gaps if abs(x - days) <= wobble * 1.6)
            if ok >= max(2, len(gaps) * 0.6):
                return label, days, per_month
    return None


def _dismissed():
    return set(db.get_json("recurring_dismissed", []) or [])


def dismiss_recurring(key, undo=False):
    d = _dismissed()
    (d.discard if undo else d.add)(key)
    db.set_json("recurring_dismissed", sorted(d))


def recurring(include_transfers=False):
    """Charges that repeat on a schedule. Bills & subscriptions by default; with include_transfers, also
    regular moves out of cash accounts (e.g. weekly Robinhood deposits) for the forecast."""
    flows = ("spend", "transfer") if include_transfers else ("spend",)
    since = (date.today() - timedelta(days=400)).isoformat()
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(f"""SELECT t.txn_id, t.date, t.name, t.amount, t.account_id, a.type AS acct_type,
                a.name AS account_name, k.flow, k.kind, k.category, k.pair_id, tp.account_id AS pair_account
            {analytics._FROM} WHERE k.flow IN ({','.join('?' * len(flows))}) AND t.amount > 0 AND t.pending = 0
            AND t.date >= ? AND k.kind NOT IN ('card_payment', 'mortgage') ORDER BY t.date""", (*flows, since))]
    groups = defaultdict(list)
    for r in rows:
        groups[(_merchant_key(r["name"]), r["account_id"])].append(r)
    today = date.today()
    dismissed = _dismissed()
    out = []
    for (mkey, acct), rs in groups.items():
        # one charge per day (a split or duplicate shouldn't look like a new cycle)
        by_day = defaultdict(float)
        for r in rs:
            by_day[r["date"]] += r["amount"]
        days = sorted(by_day)
        if len(days) < 3:
            continue
        gaps = [(date.fromisoformat(b) - date.fromisoformat(a)).days for a, b in zip(days, days[1:])]
        cad = _cadence(gaps[-10:])
        if not cad:
            continue
        label, every, per_month = cad
        amounts = [by_day[d] for d in days]
        recent = amounts[-6:]
        typical = statistics.median(recent)
        spread = (max(recent) - min(recent)) / typical if typical else 9
        if spread > 0.6 and label in ("weekly", "every 2 weeks"):
            continue  # frequent but wildly varying amounts = a habit (coffee), not a bill
        if rs[-1]["category"] in HABIT_CATEGORIES and (spread > 0.02 or len(days) < 4):
            continue  # a regular lunch spot isn't a bill unless it's the exact same charge every time
        last = date.fromisoformat(days[-1])
        nxt = last + timedelta(days=round(every))
        while nxt < today:
            nxt += timedelta(days=round(every))
        active = (today - last).days <= every * 1.8
        prev = statistics.median(amounts[-4:-1]) if len(amounts) >= 4 else None
        change = round(amounts[-1] - prev, 2) if prev and abs(amounts[-1] - prev) > max(1, prev * 0.05) else None
        key = f"{mkey}|{acct}"
        r0 = rs[-1]
        out.append({
            "key": key, "name": r0["name"], "merchant": mkey, "category": r0["category"], "flow": r0["flow"],
            "kind": r0["kind"], "account_id": acct, "account_name": r0["account_name"], "acct_type": r0["acct_type"],
            "pair_account": r0["pair_account"],
            "cadence": label, "every_days": every, "typical": round(typical, 2), "last_amount": round(amounts[-1], 2),
            "last_date": days[-1], "next_date": nxt.isoformat(), "count": len(days), "active": active,
            "monthly": round(typical * per_month, 2), "price_change": change,
            "variable": spread > 0.2, "history": [{"date": d, "amount": round(by_day[d], 2)} for d in days[-12:]],
            "dismissed": key in dismissed,
        })
    m = _mortgage_item(dismissed)
    if m:
        out.append(m)
    out.sort(key=lambda x: (not x["active"], x["next_date"]))
    return out


def _mortgage_item(dismissed):
    """The mortgage is one monthly bill (due on the 1st), however you split or add to the payments."""
    import mortgage
    try:
        m = mortgage.summary()
    except Exception:
        return None
    if not m or not m.get("config"):
        return None
    due = m["current_due"]
    pays = sorted(m["payments"], key=lambda p: p["date"])
    if not pays:
        return None
    today = date.today()
    this_month = today.strftime("%Y-%m")
    paid_now = sum(p["amount"] for p in pays if p["date"].startswith(this_month))
    nxt = _add_months(today.replace(day=1), 1) if paid_now >= due * 0.98 else today.replace(day=1)
    if nxt < today:
        nxt = today
    with db.conn() as c:
        last = c.execute(f"""SELECT t.account_id, a.name {analytics._FROM} WHERE k.kind='mortgage'
            ORDER BY t.date DESC LIMIT 1""").fetchone()
    by_month = defaultdict(float)
    for p in pays:
        by_month[p["date"][:7]] += p["amount"]
    key = "mortgage"
    return {
        "key": key, "name": "Mortgage", "merchant": "mortgage", "category": "Housing", "flow": "spend", "kind": "mortgage",
        "account_id": last["account_id"] if last else None, "account_name": last["name"] if last else "",
        "acct_type": "depository", "pair_account": None, "cadence": "monthly", "every_days": 30.4,
        "typical": round(due, 2), "last_amount": round(pays[-1]["amount"], 2), "last_date": pays[-1]["date"],
        "next_date": nxt.isoformat(), "count": len(by_month), "active": True, "monthly": round(due, 2),
        "price_change": None, "variable": False, "fixed_day": 1,
        "history": [{"date": f"{k}-01", "amount": round(v, 2)} for k, v in sorted(by_month.items())[-12:]],
        "dismissed": key in dismissed, "note": f"${m['note_pi']:,.0f} principal & interest + escrow; extra payments are counted as saving",
    }


def recurring_summary():
    items = [r for r in recurring() if not r["dismissed"]]
    live = [r for r in items if r["active"]]
    soon = (date.today() + timedelta(days=7)).isoformat()
    return {
        "items": items,
        "monthly_total": round(sum(r["monthly"] for r in live), 2),
        "yearly_total": round(sum(r["monthly"] for r in live) * 12, 2),
        "count": len(live),
        "next_7_days": round(sum(r["typical"] for r in live if r["next_date"] <= soon), 2),
        "price_increases": [r for r in live if r["price_change"] and r["price_change"] > 0],
        "dismissed": [r for r in recurring() if r["dismissed"]],
    }


# ---------- cash forecast ----------

def _add_months(d, n):
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    last = [31, 29 if y % 4 == 0 and (y % 100 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(y, m, min(d.day, last))


def forecast(days=60):
    """Day-by-day projected balance for each cash account: today's balance + expected paychecks
    - recurring bills and transfers paid from it - credit card payments (statement balance on the due date,
    then your average monthly card payment). Everything else you spend isn't predictable and isn't included."""
    today = date.today()
    horizon = today + timedelta(days=days)
    low = float(db.get_meta("forecast_low") or 500)
    with db.conn() as c:
        cash = [dict(r) for r in c.execute("""SELECT account_id, institution, name, balance FROM accounts
            WHERE type='depository' AND balance IS NOT NULL AND source != 'venmo' ORDER BY balance DESC""")]
        cash_ids = {a["account_id"] for a in cash}
        # How each paycheck is split across accounts, from the most recent payday.
        pay_rows = [dict(r) for r in c.execute(f"""SELECT t.date, t.account_id, -t.amount AS amount {analytics._FROM}
            WHERE k.kind='paycheck' ORDER BY t.date DESC LIMIT 12""")]
        cards = [dict(r) for r in c.execute("""SELECT a.account_id, a.name, a.balance, l.next_due, l.last_statement
            FROM accounts a LEFT JOIN liabilities l USING(account_id) WHERE a.type='credit'""")]
        card_pays = [dict(r) for r in c.execute(f"""SELECT t.date, t.account_id, t.amount, tp.account_id AS card
            {analytics._FROM} WHERE k.kind='card_payment' AND t.amount > 0 AND t.date >= ? ORDER BY t.date""",
                                                  ((today - timedelta(days=120)).isoformat(),))]
    events = []  # (date, account_id, amount (+in / -out), label, kind)

    # Paychecks: the last payday's split, repeated at the detected frequency.
    if pay_rows:
        last_day = pay_rows[0]["date"]
        split = defaultdict(float)
        for r in pay_rows:
            if r["date"] == last_day:
                split[r["account_id"]] += r["amount"]
        emp = next((e for e in analytics.detected_income() if e["active"]), None)
        step = {"weekly": 7, "biweekly": 14, "semimonthly": 15, "monthly": 30}.get((emp or {}).get("frequency"), 14)
        d = date.fromisoformat(last_day) + timedelta(days=step)
        while d <= horizon:
            if d > today:
                for acct, amt in split.items():
                    if acct in cash_ids:
                        events.append((d, acct, round(amt, 2), "Paycheck", "income"))
            d += timedelta(days=step)

    # Recurring bills and transfers out of cash accounts.
    for r in recurring(include_transfers=True):
        if r["dismissed"] or not r["active"] or r["account_id"] not in cash_ids:
            continue
        d = date.fromisoformat(r["next_date"])
        while d <= horizon:
            if d >= today:
                events.append((d, r["account_id"], -r["typical"], r["name"], "bill" if r["flow"] == "spend" else "transfer"))
                if r["pair_account"] in cash_ids:  # a move between two cash accounts lands on the other side too
                    events.append((d, r["pair_account"], r["typical"], r["name"], "transfer"))
            d = _add_months(d, 1) if r.get("fixed_day") else d + timedelta(days=round(r["every_days"]))

    # Credit cards: this statement (minus what's already been paid toward it), then the average monthly payment.
    for card in cards:
        pays = [p for p in card_pays if p["card"] == card["account_id"]] or card_pays
        payer = pays[-1]["account_id"] if pays else (cash[0]["account_id"] if cash else None)
        if not payer or payer not in cash_ids:
            continue
        monthly = sum(p["amount"] for p in pays) / 4 if pays else card["balance"] or 0
        due = date.fromisoformat(card["next_due"]) if card["next_due"] else today + timedelta(days=20)
        paid = sum(p["amount"] for p in pays if (due - date.fromisoformat(p["date"])).days in range(0, 26))
        first = max((card["last_statement"] or 0) - paid, 0)
        n = 0
        while due <= horizon:
            amt = first if n == 0 else monthly
            if due >= today and amt > 1:
                events.append((due, payer, -round(amt, 2), f"{card['name']} payment", "card"))
            due, n = _add_months(due, 1), n + 1

    events.sort(key=lambda e: e[0])
    series, lows = [], {}
    bal = {a["account_id"]: a["balance"] for a in cash}
    for i in range(days + 1):
        d = today + timedelta(days=i)
        for e in events:
            if e[0] == d:
                bal[e[1]] += e[2]
        point = {"date": d.isoformat(), "total": round(sum(bal.values()), 2)}
        for a in cash:
            point[a["account_id"]] = round(bal[a["account_id"]], 2)
            if a["account_id"] not in lows or bal[a["account_id"]] < lows[a["account_id"]]["balance"]:
                lows[a["account_id"]] = {"balance": round(bal[a["account_id"]], 2), "date": d.isoformat()}
        series.append(point)
    accounts = [{**a, "low": lows.get(a["account_id"]), "warn": lows.get(a["account_id"], {}).get("balance", 1e9) < low}
                for a in cash]
    return {
        "accounts": accounts, "series": series, "low_threshold": low,
        "events": [{"date": e[0].isoformat(), "account_id": e[1], "amount": e[2], "label": e[3], "kind": e[4]} for e in events],
    }


# ---------- tax year ----------

# IRS limits (employee 401(k) deferral, IRA). Editable on the Taxes page if these change.
LIMITS = {2025: {"k401": 23500, "ira": 7000}, 2026: {"k401": 24500, "ira": 7500}}


def tax_year(year=None):
    year = int(year or date.today().year)
    start, end = f"{year}-01-01", f"{year}-12-31"
    saved = (db.get_json("tax_limits", {}) or {}).get(str(year), {})
    limits = {**LIMITS.get(year, LIMITS[max(LIMITS)]), **saved}
    with db.conn() as c:
        q = lambda sql, *a: c.execute(sql, a).fetchone()[0] or 0
        roth = q(f"""SELECT SUM(-t.amount) {analytics._FROM} WHERE lower(COALESCE(a.subtype,'')) LIKE '%roth%'
            AND k.kind='invest_contribution' AND t.amount < 0 AND t.date BETWEEN ? AND ?""", start, end)
        early = q(f"""SELECT SUM(-t.amount) {analytics._FROM} WHERE lower(COALESCE(a.subtype,'')) LIKE '%roth%'
            AND k.kind='invest_contribution' AND t.amount < 0 AND t.date BETWEEN ? AND ?""", f"{year}-01-01", f"{year}-04-15")
        div_taxable = q(f"""SELECT SUM(-t.amount) {analytics._FROM} WHERE k.kind='dividend' AND t.date BETWEEN ? AND ?
            AND lower(COALESCE(a.subtype,'')) NOT LIKE '%roth%' AND lower(COALESCE(a.subtype,'')) NOT LIKE '%ira%'
            AND lower(COALESCE(a.subtype,'')) NOT LIKE '%401%'""", start, end)
        div_sheltered = q(f"""SELECT SUM(-t.amount) {analytics._FROM} WHERE k.kind='dividend' AND t.date BETWEEN ? AND ?
            AND (lower(COALESCE(a.subtype,'')) LIKE '%roth%' OR lower(COALESCE(a.subtype,'')) LIKE '%ira%'
            OR lower(COALESCE(a.subtype,'')) LIKE '%401%')""", start, end)
        interest = [dict(r) for r in c.execute(f"""SELECT a.institution, a.name, ROUND(SUM(-t.amount),2) AS amount
            {analytics._FROM} WHERE k.kind='interest' AND t.date BETWEEN ? AND ? GROUP BY a.account_id""", (start, end))]
        refunds = [dict(r) for r in c.execute(f"""SELECT t.date, t.name, -t.amount AS amount {analytics._FROM}
            WHERE k.kind='tax_refund' ORDER BY t.date DESC""")]
    # 401(k): paychecks this year x your contribution (the limit is on your part; the match is on top).
    history = analytics.pay_history()
    mine = match = 0.0
    for d in analytics.paycheck_dates(start, end):
        h = analytics.settings_on(d, history)
        b = analytics.pay_breakdown(h) if h else None
        if b:
            mine += b["per_paycheck"]["retirement"]; match += b["per_paycheck"]["employer_match"]
    cfg = db.get_json("income", {}) or {}
    b = analytics.pay_breakdown(cfg)
    left_checks = 0
    if b and year == date.today().year:
        left_checks = round((date(year, 12, 31) - date.today()).days / (365 / b["periods_per_year"]))
    projected_401k = mine + left_checks * (b["per_paycheck"]["retirement"] if b else 0)
    months_left = 12 - date.today().month + 1 if year == date.today().year else 0
    return {
        "year": year, "limits": limits,
        "roth": {"contributed": round(roth, 2), "limit": limits["ira"], "left": round(max(limits["ira"] - roth, 0), 2),
                 "jan_to_apr15": round(early, 2),
                 "monthly_to_max": round(max(limits["ira"] - roth, 0) / months_left, 2) if months_left else None},
        "k401": {"yours": round(mine, 2), "match": round(match, 2), "limit": limits["k401"],
                 "projected_year_end": round(projected_401k, 2), "estimated": not analytics.has_linked_401k(),
                 "left": round(max(limits["k401"] - mine, 0), 2)},
        "dividends": {"taxable": round(div_taxable, 2), "sheltered": round(div_sheltered, 2)},
        "interest": interest, "interest_total": round(sum(i["amount"] for i in interest), 2),
        "refunds": refunds,
        "withheld_ytd": round(len(analytics.paycheck_dates(start, end)) * b["per_paycheck"]["taxes_and_other"], 2) if b else None,
    }


def set_tax_limits(year, k401=None, ira=None):
    allv = db.get_json("tax_limits", {}) or {}
    cur = allv.get(str(year), {})
    if k401 is not None:
        cur["k401"] = k401
    if ira is not None:
        cur["ira"] = ira
    allv[str(year)] = cur
    db.set_json("tax_limits", allv)


# ---------- alerts ----------

def _alert_dismissed():
    return db.get_json("alerts_dismissed", {}) or {}


def dismiss_alert(aid):
    d = _alert_dismissed()
    d[aid] = date.today().isoformat()
    cutoff = (date.today() - timedelta(days=120)).isoformat()
    db.set_json("alerts_dismissed", {k: v for k, v in d.items() if v >= cutoff})


def alerts():
    """What deserves a look right now, most serious first. Each has a stable id so dismissing sticks."""
    today = date.today()
    month = today.strftime("%Y-%m")
    out = []

    # Budgets over or running ahead of pace.
    bm = planning.budget_month(month)
    for r in bm["rows"]:
        if r["status"] == "over":
            out.append({"id": f"budget-over|{month}|{r['category']}", "level": "bad", "icon": "budget",
                        "title": f"{r['category']} is over budget", "detail": f"${r['spent']:,.0f} of ${r['budget']:,.0f} this month",
                        "link": {"to": "/budget"}})
        elif r["status"] == "ahead_of_pace":
            out.append({"id": f"budget-pace|{month}|{r['category']}", "level": "warn", "icon": "budget",
                        "title": f"{r['category']} is spending ahead of pace",
                        "detail": f"${r['spent']:,.0f} of ${r['budget']:,.0f} with {bm['days'] - bm['elapsed']} days left",
                        "link": {"to": "/budget"}})

    # Low cash coming up.
    try:
        fc = forecast(30)
        for a in fc["accounts"]:
            if a["warn"] and a["low"]:
                out.append({"id": f"low|{a['account_id']}|{a['low']['date']}", "level": "bad" if a["low"]["balance"] < 0 else "warn",
                            "icon": "forecast", "title": f"{a['name']} may get low",
                            "detail": f"About ${a['low']['balance']:,.0f} on {date.fromisoformat(a['low']['date']):%b %-d} after scheduled bills",
                            "link": {"to": "/forecast"}})
    except Exception as e:  # a forecast problem shouldn't hide the other alerts
        print(f"[alerts] forecast failed: {e}")

    # Unusual spending: this month's pace vs. the category's usual month.
    if bm["elapsed"] >= 7:
        hist = planning.category_history(planning._last_full_months(6))
        for r in bm["rows"]:
            usual = [v for v in (hist.get(r["category"]) or {}).values() if v > 0]
            if len(usual) < 3 or r["spent"] <= 0:
                continue
            med = statistics.median(usual)
            projected = r["spent"] / max(bm["pace"], 0.05)
            if med > 50 and projected > med * 1.4 and projected - med > 75:
                out.append({"id": f"unusual|{month}|{r['category']}", "level": "warn", "icon": "dashboard",
                            "title": f"{r['category']} is running high",
                            "detail": f"On pace for ${projected:,.0f} this month vs. a usual ${med:,.0f}",
                            "link": {"to": "/transactions", "params": {"category": r["category"], "flows": "spend,refund"}}})

    # Large one-off charges in the last 10 days.
    since = (today - timedelta(days=10)).isoformat()
    with db.conn() as c:
        big = [dict(r) for r in c.execute(f"""SELECT t.txn_id, t.date, t.name, t.amount, k.category {analytics._FROM}
            WHERE k.flow='spend' AND t.date >= ? AND t.amount >= 250 AND k.kind != 'mortgage' ORDER BY t.amount DESC LIMIT 5""", (since,))]
    for t in big:
        out.append({"id": f"big|{t['txn_id']}", "level": "info", "icon": "transactions",
                    "title": f"Large charge: {t['name']}", "detail": f"${t['amount']:,.2f} on {date.fromisoformat(t['date']):%b %-d} · {t['category']}",
                    "link": {"to": "/transactions", "params": {"q": t["name"]}}})

    # Price increases and bills due soon.
    rs = recurring_summary()
    for r in rs["price_increases"]:
        out.append({"id": f"price|{r['key']}|{r['last_date']}", "level": "warn", "icon": "recurring",
                    "title": f"{r['name']} went up", "detail": f"${r['last_amount']:,.2f}, up ${r['price_change']:,.2f} from usual",
                    "link": {"to": "/recurring"}})
    due = [r for r in rs["items"] if r["active"] and r["next_date"] <= (today + timedelta(days=3)).isoformat()]
    if due:
        out.append({"id": f"due|{today.isoformat()}", "level": "info", "icon": "recurring",
                    "title": f"{len(due)} bill{'s' if len(due) > 1 else ''} due in the next 3 days",
                    "detail": ", ".join(f"{r['name']} ${r['typical']:,.0f}" for r in due[:4]), "link": {"to": "/recurring"}})

    with db.conn() as c:
        n = c.execute("SELECT COUNT(*) FROM txn_class WHERE review=1").fetchone()[0]
    if n:
        out.append({"id": f"review|{today.isoformat()}|{n}", "level": "info", "icon": "review",
                    "title": f"{n} transaction{'s' if n > 1 else ''} to check", "detail": "The app wasn't sure how to count these.",
                    "link": {"to": "/review"}})

    gone = _alert_dismissed()
    order = {"bad": 0, "warn": 1, "info": 2}
    return sorted([a for a in out if a["id"] not in gone], key=lambda a: order[a["level"]])


# ---------- long-term projection (the math runs in the browser; this supplies today's numbers) ----------

def projection_inputs():
    months = planning._last_full_months(6)
    start, _ = planning._month_bounds(months[0])
    _, end = planning._month_bounds(months[-1])
    six = analytics.cashflow(start, end)["total"]
    y12 = planning._last_full_months(12)
    s12, _ = planning._month_bounds(y12[0])
    _, e12 = planning._month_bounds(y12[-1])
    year = analytics.cashflow(s12, e12)["total"]
    with db.conn() as c:
        cash = c.execute("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type='depository'").fetchone()[0]
        invested = c.execute("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type='investment'").fetchone()[0]
        other_debt = c.execute("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type IN ('credit','loan')").fetchone()[0]
    inv = analytics.investments()
    k401_now = (inv.get("retirement_estimate") or {}).get("value", 0)
    b = analytics.pay_breakdown()
    home = analytics.home_position()
    sched = []
    if home:
        import mortgage
        m = mortgage.summary()
        sched = [{"year": int(y["year"]), "balance": y["end_balance"]} for y in m["years"]]
    return {
        "cash": round(cash, 2), "invested": round(invested + k401_now, 2), "k401_now": round(k401_now, 2),
        "other_debt": round(other_debt, 2),
        "monthly_saved": round(six["saved"] / 6, 2), "monthly_invested": round(six["invested"] / 6, 2),
        "k401_per_year": round(b["per_year"]["retirement"] + b["per_year"]["employer_match"], 2) if b else 0,
        "annual_spending": round(year["spend"], 2),
        "home_value": home["home_value"] if home else 0,
        "mortgage": home["mortgage"] if home else 0,
        "mortgage_by_year": sched,
        "months_used": months,
    }


# ---------- monthly recap ----------

def recap_months():
    floor = analytics.history_start() or "0000"
    with db.conn() as c:
        return [r[0] for r in c.execute("SELECT DISTINCT substr(date,1,7) FROM transactions WHERE date >= ? ORDER BY 1 DESC", (floor,))]


def recap(month=None):
    """One month in review: the totals vs. last month and your usual, where it went, what stood out."""
    today = date.today()
    month = month or (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")  # last full month by default
    start, end = planning._month_bounds(month)
    prev = planning._last_full_months(1, before=date.fromisoformat(start))[0]
    ps, pe = planning._month_bounds(prev)
    six = planning._last_full_months(6, before=date.fromisoformat(start))
    tot = analytics.cashflow(start, end)["total"]
    ptot = analytics.cashflow(ps, pe)["total"]
    hist_tot = [analytics.cashflow(*planning._month_bounds(m))["total"] for m in six]
    avg = lambda k: round(statistics.mean([h[k] or 0 for h in hist_tot]), 2) if hist_tot else None

    cats = {r["category"]: r["amount"] for r in analytics.by_category(start, end)}
    pcats = {r["category"]: r["amount"] for r in analytics.by_category(ps, pe)}
    hist = planning.category_history(six)
    categories = []
    for cat, amt in sorted(cats.items(), key=lambda kv: -kv[1]):
        usual = [v for v in (hist.get(cat) or {}).values()]
        med = statistics.median(usual + [0] * (len(six) - len(usual))) if six else None
        categories.append({"category": cat, "amount": round(amt, 2), "prev": round(pcats.get(cat, 0), 2),
                           "usual": round(med, 2) if med is not None else None})

    where, args = analytics._where(start, end, None, "k.flow='spend'")
    year_ago = (date.fromisoformat(start) - timedelta(days=365)).isoformat()
    with db.conn() as c:
        biggest = [dict(r) for r in c.execute(f"""SELECT t.txn_id, t.date, t.name, t.amount, k.category {analytics._FROM}
            WHERE {where} AND k.kind != 'mortgage' ORDER BY t.amount DESC LIMIT 5""", args)]
        new = [dict(r) for r in c.execute(f"""SELECT MIN(t.name) AS name, ROUND(SUM(t.amount),2) AS amount, COUNT(*) AS n, MIN(k.category) AS category
            {analytics._FROM} WHERE {where} AND lower(t.name) NOT IN (
                SELECT lower(t2.name) FROM transactions t2 WHERE t2.date >= ? AND t2.date < ?)
            GROUP BY lower(t.name) ORDER BY 2 DESC LIMIT 6""", args + [year_ago, start])]
        daily = [dict(r) for r in c.execute(f"""SELECT t.date, ROUND(SUM(CASE WHEN k.flow='spend' THEN {analytics._SPEND_AMT}
                WHEN k.flow='refund' THEN t.amount ELSE 0 END),2) AS amount
            {analytics._FROM} WHERE {analytics._where(start, end)[0]} GROUP BY t.date ORDER BY t.date""", analytics._where(start, end)[1])]
    bills = [r for r in recurring() if not r["dismissed"] and any(h["date"][:7] == month for h in r["history"])]
    bills_total = round(sum(h["amount"] for r in bills for h in r["history"] if h["date"][:7] == month), 2)
    bm = planning.budget_month(month)
    budgeted = [r for r in bm["rows"] if r["budget"]]
    nw = analytics.networth_history()["points"]
    nw_start = next((p for p in reversed(nw) if p["date"] <= start), None)
    nw_end = next((p for p in reversed(nw) if p["date"] <= end), None)

    # Plain-language highlights, most notable first.
    hl = []
    if (tot["income"] or 0) >= 500 and avg("savings_rate") is not None and tot["savings_rate"] is not None:
        rates = [h["savings_rate"] for h in hist_tot if h["savings_rate"] is not None and (h["income"] or 0) >= 500]
        diff = tot["savings_rate"] - (statistics.mean(rates) if rates else tot["savings_rate"])
        hl.append({"tone": "good" if diff >= 0 else "bad",
                   "text": f"You kept {round(tot['savings_rate'] * 100)}% of your income, "
                           f"{abs(round(diff * 100))} points {'above' if diff >= 0 else 'below'} your 6-month average."})
    moves = [(c, c["amount"] - c["usual"]) for c in categories if c["usual"] is not None and c["amount"] > 0 and (c["usual"] or 0) > 40]
    for c, d in sorted(moves, key=lambda x: -abs(x[1]))[:2]:
        if abs(d) >= 50 and c["usual"]:
            hl.append({"tone": "bad" if d > 0 else "good",
                       "text": f"{c['category']}: ${c['amount']:,.0f}, {abs(round(d / c['usual'] * 100))}% {'more' if d > 0 else 'less'} than usual (${c['usual']:,.0f})."})
    if tot["invested"] > 0:
        hl.append({"tone": "good", "text": f"You moved ${tot['invested']:,.0f} into investments."})
    over = [r for r in budgeted if r["status"] == "over"]
    if budgeted:
        hl.append({"tone": "good" if not over else "bad" if len(over) > len(budgeted) / 2 else "info",
                   "text": f"{len(budgeted) - len(over)} of {len(budgeted)} budgets stayed on track" + (f"; over: {', '.join(r['category'] for r in over[:3])}." if over else ".")})
    if new:
        hl.append({"tone": "info", "text": f"{len(new)} new place{'s' if len(new) > 1 else ''} you hadn't paid in the past year, led by {new[0]['name']} (${new[0]['amount']:,.0f})."})

    return {
        "month": month, "prev_month": prev, "months": recap_months(), "partial": month == today.strftime("%Y-%m"),
        "totals": {k: tot.get(k) for k in ("income", "spend", "saved", "savings_rate", "invested", "refunds", "paychecks")},
        "prev": {k: ptot.get(k) for k in ("income", "spend", "saved", "savings_rate", "invested")},
        "usual": {k: avg(k) for k in ("income", "spend", "saved", "invested")},
        "categories": categories, "biggest": biggest, "new_merchants": new, "daily": daily,
        "bills": {"count": len(bills), "total": bills_total},
        "budgets": {"count": len(budgeted), "over": len(over)},
        "net_worth": {"start": nw_start["net_worth"] if nw_start else None, "end": nw_end["net_worth"] if nw_end else None},
        "highlights": hl,
    }

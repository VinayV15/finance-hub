"""Budgets, goals, and windfalls.

Budgets: a monthly limit per spending category (no rollover). Suggested limits are the median of the last
6 full months, rounded up to $10, so one odd month doesn't skew them.

Goals, tracked from real data where possible:
  emergency  keep N months of spending in chosen cash accounts          (progress = their balances)
  roth       yearly Roth IRA contribution target                         (progress = deposits into the Roth)
  investing  monthly amount into investment accounts                     (progress = this month's contributions)
  mortgage   reach the PMI-removal balance, or pay off by a date         (progress = mortgage model)
  custom     any named target; money set aside is logged by hand or from a windfall

Windfalls: one-off money (bonus portion of a paycheck, tax refunds, large one-off deposits, or anything you
mark). Each gets a suggested split across your goals from a default split you set.
"""
import json
import math
import statistics
import uuid
from collections import defaultdict
from datetime import date, datetime

import analytics
import db
import mortgage

NOT_BUDGETED = {"Paybacks from people", "Reimbursements", "Refund", "Transfer", "Ignored", "Income"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS budgets (category TEXT PRIMARY KEY, monthly REAL NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, target REAL, target_date TEXT,
    config TEXT, created_at TEXT, archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goal_contribs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL,
    note TEXT, windfall_id TEXT
);
CREATE TABLE IF NOT EXISTS windfalls (
    id TEXT PRIMARY KEY, txn_id TEXT, date TEXT, label TEXT, amount REAL, source TEXT,
    status TEXT DEFAULT 'new', plan TEXT, dismissed INTEGER DEFAULT 0
);
"""


def init():
    with db.conn() as c:
        c.executescript(SCHEMA)


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _month_bounds(month):
    y, m = int(month[:4]), int(month[5:7])
    start = date(y, m, 1)
    end = date(y + (m == 12), m % 12 + 1, 1)
    return start.isoformat(), (date.fromordinal(end.toordinal() - 1)).isoformat()


def _last_full_months(n, before=None):
    d = (before or date.today()).replace(day=1)
    out = []
    for _ in range(n):
        d = date(d.year - (d.month == 1), (d.month - 2) % 12 + 1, 1)
        out.append(d.strftime("%Y-%m"))
    return list(reversed(out))


def monthly_take_home():
    b = analytics.pay_breakdown()
    return round(b["per_year"]["take_home"] / 12, 2) if b else None


# ---------- budgets ----------

def category_history(months):
    """{category: {month: net spend}} for the given months."""
    start, _ = _month_bounds(months[0])
    _, end = _month_bounds(months[-1])
    where, args = analytics._where(start, end, None, "k.flow IN ('spend','refund')")
    with db.conn() as c:
        rows = c.execute(f"""SELECT k.category, substr(t.date,1,7) AS m, SUM({analytics._SPEND_AMT}) AS s
            {analytics._FROM} WHERE {where} GROUP BY 1, 2""", args).fetchall()
    out = defaultdict(dict)
    for r in rows:
        out[r["category"]][r["m"]] = r["s"]
    return out


def suggestions():
    months = _last_full_months(6)
    hist = category_history(months)
    out = {}
    for cat, by_m in hist.items():
        if cat in NOT_BUDGETED:
            continue
        med = statistics.median([by_m.get(m, 0) for m in months])
        if med > 0:
            out[cat] = {"suggested": float(math.ceil(med / 10) * 10),
                        "avg": round(sum(by_m.get(m, 0) for m in months) / len(months), 2),
                        "history": [{"month": m, "amount": round(by_m.get(m, 0), 2)} for m in months]}
    return out


def get_budgets():
    with db.conn() as c:
        return {r["category"]: r["monthly"] for r in c.execute("SELECT * FROM budgets")}


def set_budgets(values):
    with db.conn() as c:
        for cat, amt in values.items():
            if amt is None or amt == "":
                c.execute("DELETE FROM budgets WHERE category=?", (cat,))
            else:
                c.execute("INSERT OR REPLACE INTO budgets(category, monthly, updated_at) VALUES (?,?,?)",
                          (cat, float(amt), _now()))


def budget_month(month=None):
    month = month or date.today().strftime("%Y-%m")
    start, end = _month_bounds(month)
    today = date.today()
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    days = (last - first).days + 1
    elapsed = days if today > last else max(0, (today - first).days + 1) if today >= first else 0
    pace = elapsed / days
    spent = {r["category"]: r["amount"] for r in analytics.by_category(start, end)}
    budgets = get_budgets()
    sugg = suggestions()
    cats = sorted(set(budgets) | {c for c in spent if c not in NOT_BUDGETED} | set(sugg),
                  key=lambda c: -(budgets.get(c) or sugg.get(c, {}).get("suggested") or 0))
    rows = []
    for cat in cats:
        b = budgets.get(cat)
        s = round(spent.get(cat, 0), 2)
        if not b and not sugg.get(cat) and s <= 0:
            continue  # nothing to show
        status = None
        if b:
            if s > b:
                status = "over"
            elif s > b * pace * 1.1 and pace < 1:
                status = "ahead_of_pace"
            else:
                status = "ok"
        rows.append({"category": cat, "budget": b, "spent": s, "left": round(b - s, 2) if b else None,
                     "suggested": sugg.get(cat, {}).get("suggested"), "avg6": sugg.get(cat, {}).get("avg"),
                     "history": sugg.get(cat, {}).get("history", []), "status": status})
    money_back = round(-sum(v for k, v in spent.items() if k in NOT_BUDGETED and v < 0), 2)
    budgeted_spent = round(sum(r["spent"] for r in rows if r["budget"]), 2)
    unbudgeted_spent = round(sum(r["spent"] for r in rows if not r["budget"] and r["spent"] > 0), 2)
    total_budget = round(sum(budgets.values()), 2)
    income = monthly_take_home()
    return {
        "month": month, "pace": round(pace, 4), "days": days, "elapsed": elapsed,
        "rows": rows, "total_budget": total_budget, "budgeted_spent": budgeted_spent,
        "unbudgeted_spent": unbudgeted_spent, "money_back": money_back,
        "net_spent": round(budgeted_spent + unbudgeted_spent - money_back, 2),
        "take_home": income,
        "left_after_budget": round(income - total_budget, 2) if income else None,
    }


# ---------- goals ----------

def _goal_row(r):
    g = dict(r)
    g["config"] = json.loads(g["config"] or "{}")
    return g


def list_goals(include_archived=False):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM goals" + ("" if include_archived else " WHERE archived=0") +
                         " ORDER BY created_at").fetchall()
    return [_goal_row(r) for r in rows]


def save_goal(g):
    gid = g.get("id") or uuid.uuid4().hex[:10]
    with db.conn() as c:
        c.execute("""INSERT INTO goals(id, type, name, target, target_date, config, created_at, archived)
            VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,
            target=excluded.target, target_date=excluded.target_date, config=excluded.config""",
                  (gid, g["type"], g["name"], g.get("target"), g.get("target_date") or None,
                   json.dumps(g.get("config") or {}), _now()))
    return gid


def archive_goal(gid):
    with db.conn() as c:
        c.execute("UPDATE goals SET archived=1 WHERE id=?", (gid,))


def add_contribution(gid, amount, day=None, note=None, windfall_id=None):
    with db.conn() as c:
        c.execute("INSERT INTO goal_contribs(goal_id, date, amount, note, windfall_id) VALUES (?,?,?,?,?)",
                  (gid, day or date.today().isoformat(), float(amount), note, windfall_id))


def _mon(d):
    """'2031-11-01' -> 'Nov 2031'"""
    return date.fromisoformat(d).strftime("%b %Y") if d else "—"


def _months_until(d):
    if not d:
        return None
    t, today = date.fromisoformat(d), date.today()
    return max(0, (t.year - today.year) * 12 + (t.month - today.month))


def _accounts():
    with db.conn() as c:
        return [dict(r) for r in c.execute("SELECT account_id, institution, name, type, subtype, balance, source FROM accounts")]


def _typical_monthly_spend():
    """Median monthly net spending over the last 6 full months."""
    months = _last_full_months(6)
    start, _ = _month_bounds(months[0])
    _, end = _month_bounds(months[-1])
    per = {p["period"]: p["spend"] for p in analytics.cashflow(start, end, "month")["periods"]}
    return round(statistics.median([per.get(m, 0) for m in months]), 2)


def _contributions(account_ids, start, end=None):
    """Money moved into these investment accounts (from the investment side, or the bank side if unpaired)."""
    if not account_ids:
        return 0.0
    with db.conn() as c:
        q = f"""SELECT COALESCE(SUM(-t.amount),0) FROM transactions t JOIN txn_class k USING(txn_id)
            WHERE t.account_id IN ({','.join('?' * len(account_ids))}) AND k.kind='invest_contribution'
            AND t.amount < 0 AND t.date >= ?""" + (" AND t.date <= ?" if end else "")
        return round(c.execute(q, list(account_ids) + [start] + ([end] if end else [])).fetchone()[0], 2)


def _required_extra_for_date(target_date, pmi=False):
    """Smallest extra monthly mortgage payment that reaches payoff (or the PMI balance) by target_date."""
    def reaches(extra):
        s = mortgage.summary(planned_extra_monthly=extra)
        when = s["pmi"]["request_date_projected"] if pmi else s["payoff_projected"]
        return when and when <= target_date
    if reaches(0):
        return 0.0
    lo, hi = 0.0, 20000.0
    if not reaches(hi):
        return None
    for _ in range(25):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if reaches(mid) else (mid, hi)
    return round(math.ceil(hi / 10) * 10, 2)


def goal_progress(g):
    t, cfg, today = g["type"], g["config"], date.today()
    out = {"current": 0.0, "target": g.get("target"), "detail": "", "monthly_needed": None, "on_track": None}
    months_left = _months_until(g.get("target_date"))
    if t == "emergency":
        accts = cfg.get("accounts") or [a["account_id"] for a in _accounts()
                                         if a["type"] == "depository" and a.get("source") != "venmo"]
        cur = round(sum(a["balance"] or 0 for a in _accounts() if a["account_id"] in accts), 2)
        monthly = _typical_monthly_spend()
        target = round((cfg.get("months") or 6) * monthly, 2) if not g.get("target") else g["target"]
        out.update(current=cur, target=target,
                   detail=f"{cfg.get('months') or 6} months × ${monthly:,.0f} typical monthly spending")
    elif t == "roth":
        roth = [a["account_id"] for a in _accounts() if a["type"] == "investment" and "roth" in (a["subtype"] or "").lower()]
        year_start = today.replace(month=1, day=1).isoformat()
        cur = _contributions(roth, year_start)
        months_left = 12 - today.month + 1 if not g.get("target_date") else months_left
        out.update(current=cur, detail=f"contributed to your Roth IRA in {today.year}")
    elif t == "investing":
        inv = [a["account_id"] for a in _accounts() if a["type"] == "investment"]
        m_start = today.replace(day=1).isoformat()
        cur = _contributions(inv, m_start)
        out.update(current=cur, detail="moved into investment accounts this month")
        out["target"] = g.get("target")
        if g.get("target"):
            out["monthly_needed"] = round(max(0, g["target"] - cur), 2)
            pace = today.day / 30
            out["on_track"] = cur >= g["target"] * min(pace, 1) * 0.9
        out["pct"] = round(cur / g["target"], 4) if g.get("target") else None
        return out
    elif t == "mortgage":
        s = mortgage.summary()
        if not s:
            out["detail"] = "No mortgage set up."
            return out
        pmi = cfg.get("kind", "pmi") == "pmi"
        start_bal = s["config"]["original_amount"]
        target_bal = s["pmi"]["request_at_balance"] if pmi else 0.0
        paid, need = start_bal - s["balance"], start_bal - target_bal
        when = s["pmi"]["request_date_projected"] if pmi else s["payoff_projected"]
        out.update(current=round(paid, 2), target=round(need, 2),
                   detail=(f"PMI can come off at ${target_bal:,.0f} balance — on pace for {_mon(when)}" if pmi
                           else f"on pace to be paid off {_mon(when)}"),
                   projected_date=when)
        if g.get("target_date"):
            extra = _required_extra_for_date(g["target_date"], pmi=pmi)
            out["monthly_needed"] = extra
            out["on_track"] = extra == 0
            out["detail"] += ("" if extra == 0 else f" · pay about ${extra:,.0f}/mo extra to reach it by {_mon(g['target_date'])}"
                              if extra is not None else " · not reachable by that date")
        out["pct"] = round(paid / need, 4) if need else None
        return out
    elif t == "custom":
        with db.conn() as c:
            cur = c.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=?", (g["id"],)).fetchone()[0]
        out.update(current=round(cur + (cfg.get("starting") or 0), 2), detail="set aside so far")
    tgt = out["target"]
    if tgt:
        out["pct"] = round(min(out["current"] / tgt, 1.0), 4) if tgt else None
        remaining = max(0.0, tgt - out["current"])
        if months_left is not None:
            out["monthly_needed"] = round(remaining / max(months_left, 1), 2) if remaining else 0.0
            out["on_track"] = remaining == 0 or _recent_monthly_rate(g) >= out["monthly_needed"] * 0.9
        out["remaining"] = round(remaining, 2)
    return out


def _recent_monthly_rate(g):
    """How fast this goal has been growing lately (per month), for 'on track' checks."""
    t, today = g["type"], date.today()
    if t == "roth":
        return (goal_progress_cache.get(g["id"], {}).get("current") or 0) / max(today.month, 1)
    if t == "custom":
        with db.conn() as c:
            s = c.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=? AND date >= date('now','-90 day')",
                          (g["id"],)).fetchone()[0]
        return s / 3
    if t == "emergency":
        # growth of the chosen cash balances ≈ recent saving rate
        months = _last_full_months(3)
        start, _ = _month_bounds(months[0])
        _, end = _month_bounds(months[-1])
        return max(0.0, analytics.cashflow(start, end)["total"]["saved"] / 3)
    return 0.0


goal_progress_cache = {}


def goals_with_progress():
    out = []
    for g in list_goals():
        if g["type"] == "roth":  # rate needs current first
            goal_progress_cache[g["id"]] = {"current": _contributions(
                [a["account_id"] for a in _accounts() if a["type"] == "investment" and "roth" in (a["subtype"] or "").lower()],
                date.today().replace(month=1, day=1).isoformat())}
        out.append({**g, "progress": goal_progress(g)})
    return out


# ---------- windfalls ----------

WINDFALL_MIN = 250.0


def detect_windfalls():
    """Find one-off money and add new ones to the windfalls table (existing ones keep your plan)."""
    floor = analytics.history_start() or "0000"
    found = []
    with db.conn() as c:
        for r in c.execute("""SELECT t.txn_id, t.date, t.name, -t.amount AS amount, k.kind FROM transactions t
                JOIN txn_class k USING(txn_id) WHERE k.flow='income' AND t.date >= ?
                AND k.kind IN ('tax_refund','other_income') AND -t.amount >= ?""", (floor, WINDFALL_MIN)):
            found.append({"id": f"w-{r['txn_id']}", "txn_id": r["txn_id"], "date": r["date"], "amount": round(r["amount"], 2),
                          "label": "Tax refund" if r["kind"] == "tax_refund" else r["name"][:40], "source": r["kind"]})
    for e in analytics.detected_income():
        for b in e["bonuses"]:
            if b["date"] >= floor and b["bonus"] >= WINDFALL_MIN:
                found.append({"id": f"b-{e['employer']}-{b['date']}", "txn_id": None, "date": b["date"],
                              "amount": b["bonus"], "label": f"{e['employer'].title()} bonus", "source": "bonus"})
    with db.conn() as c:
        for w in found:
            c.execute("""INSERT INTO windfalls(id, txn_id, date, label, amount, source) VALUES (?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, date=excluded.date""",
                      (w["id"], w["txn_id"], w["date"], w["label"], w["amount"], w["source"]))


def default_split():
    """Your saved split, or a starting guess that skips goals already reached."""
    split = db.get_json("windfall_split", None)
    if split:
        return split
    open_goals = {}
    for g in goals_with_progress():
        if (g["progress"].get("pct") or 0) < 1:
            open_goals.setdefault(g["type"], g["id"])
    weights = [("emergency", 40), ("roth", 30), ("mortgage", 30), ("custom", 20)]
    guess = [{"target": open_goals[t], "pct": w} for t, w in weights if t in open_goals]
    if not any(t in open_goals for t in ("roth",)):
        guess.append({"target": "invest", "pct": 30})
    guess.append({"target": "fun", "pct": 20})
    total = sum(x["pct"] for x in guess)
    for x in guess:  # scale to 100%
        x["pct"] = round(x["pct"] * 100 / total)
    guess[-1]["pct"] += 100 - sum(x["pct"] for x in guess)
    return guess


def windfalls():
    detect_windfalls()
    split = default_split()
    goals = {g["id"]: g["name"] for g in list_goals()}
    with db.conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM windfalls WHERE dismissed=0 ORDER BY date DESC")]
    for w in rows:
        w["plan"] = json.loads(w["plan"]) if w["plan"] else None
        w["suggested"] = [{"target": s["target"], "label": goals.get(s["target"], "Spend / fun" if s["target"] == "fun" else s["target"]),
                           "pct": s["pct"], "amount": round(w["amount"] * s["pct"] / 100, 2)} for s in split]
    return {"split": split, "items": rows}


def plan_windfall(wid, plan):
    """Save how a windfall was split. Custom-goal portions are logged as money set aside for that goal."""
    goals = {g["id"]: g for g in list_goals()}
    with db.conn() as c:
        w = c.execute("SELECT * FROM windfalls WHERE id=?", (wid,)).fetchone()
        c.execute("DELETE FROM goal_contribs WHERE windfall_id=?", (wid,))
        c.execute("UPDATE windfalls SET plan=?, status='planned' WHERE id=?", (json.dumps(plan), wid))
    for p in plan:
        g = goals.get(p["target"])
        if g and g["type"] == "custom" and p.get("amount"):
            add_contribution(g["id"], p["amount"], w["date"], f"from {w['label']}", windfall_id=wid)


def mark_windfall(txn_id, label=None):
    """Treat any income transaction as a windfall."""
    with db.conn() as c:
        t = c.execute("SELECT date, name, amount FROM transactions WHERE txn_id=?", (txn_id,)).fetchone()
        c.execute("""INSERT OR IGNORE INTO windfalls(id, txn_id, date, label, amount, source) VALUES (?,?,?,?,?, 'manual')""",
                  (f"m-{txn_id}", txn_id, t["date"], label or t["name"][:40], round(abs(t["amount"]), 2)))


def dismiss_windfall(wid):
    with db.conn() as c:
        c.execute("UPDATE windfalls SET dismissed=1 WHERE id=?", (wid,))
        c.execute("DELETE FROM goal_contribs WHERE windfall_id=?", (wid,))

"""Finance Hub — a private dashboard for all your accounts.

Runs on your Mac. Open it in any browser on the same Wi-Fi (Mac, iPhone, Windows).
Start it with:  ./run.sh
"""
import hmac
import os
import socket
import threading
import time
from datetime import date, datetime, timedelta, timezone
from functools import wraps

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from flask import (Flask, jsonify, redirect, render_template, request, send_from_directory,  # noqa: E402
                   session, url_for)

import analytics  # noqa: E402
import classify  # noqa: E402
import db  # noqa: E402
import insights  # noqa: E402
import manual  # noqa: E402
import mortgage  # noqa: E402
import planning  # noqa: E402
import plaid_sync  # noqa: E402
import statements  # noqa: E402

app = Flask(__name__)
app.secret_key = os.environ["FLASK_SECRET_KEY"]
app.config.update(
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    MAX_CONTENT_LENGTH=60 * 1024 * 1024,  # a year of statement PDFs in one upload
)
PIN = os.environ["DASHBOARD_PIN"]
SYNC_EVERY = timedelta(hours=int(os.environ.get("SYNC_EVERY_HOURS", "24")))

# ---------- PIN lock (blocks anyone else on the Wi-Fi) ----------

_failed = {}  # ip -> (count, locked_until)


# Test-only: skip the PIN for a sandbox copy bound to this Mac (used to screenshot the UI).
# Refuses to work with real (production) data or when reachable from other devices.
DEV_NO_PIN = (os.environ.get("FH_DEV_NO_PIN") == "1" and plaid_sync.ENV == "sandbox"
              and os.environ.get("HOST") == "127.0.0.1")


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not session.get("ok") and not DEV_NO_PIN:
            if request.path.startswith("/api/"):
                return jsonify(error="locked"), 401
            return redirect(url_for("login"))
        return fn(*a, **kw)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
def login():
    ip = request.remote_addr
    count, until = _failed.get(ip, (0, 0))
    if until > time.time():
        return render_template("login.html", error=f"Too many tries. Wait {int(until - time.time())}s."), 429
    if request.method == "POST":
        if hmac.compare_digest(request.form.get("pin", ""), PIN):
            _failed.pop(ip, None)
            session.permanent = True
            session["ok"] = True
            return redirect(url_for("index"))
        count += 1
        _failed[ip] = (count, time.time() + 300 if count >= 5 else 0)
        return render_template("login.html", error="Wrong PIN."), 401
    return render_template("login.html", error=None)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------- pages ----------

WEB_DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "dist")


@app.route("/")
@app.route("/<path:path>")
@login_required
def index(path=""):
    """Serve the React app (web/dist). Unknown paths fall back to index.html so page links work."""
    if path.startswith("api/"):
        return jsonify(error="not found"), 404
    full = os.path.join(WEB_DIST, path)
    if path and os.path.isfile(full):
        return send_from_directory(WEB_DIST, path)
    if not os.path.isfile(os.path.join(WEB_DIST, "index.html")):
        return "Front end not built yet. Run ./run.sh (it builds it).", 503
    return send_from_directory(WEB_DIST, "index.html")


# ---------- data API ----------

ASSET_TYPES = {"depository", "investment", "other"}
DEBT_TYPES = {"credit", "loan"}


@app.route("/api/summary")
@login_required
def summary():
    with db.conn() as c:
        accounts = [dict(r) for r in c.execute("""
            SELECT a.*, l.kind AS liab_kind, l.apr, l.min_payment, l.next_due, l.last_statement,
                   i.status AS item_status, i.error AS item_error
            FROM accounts a
            LEFT JOIN liabilities l ON l.account_id = a.account_id
            LEFT JOIN items i ON i.item_id = a.item_id
            ORDER BY a.institution, a.name""")]
        holdings = [dict(r) for r in c.execute(
            "SELECT * FROM holdings WHERE value IS NOT NULL ORDER BY value DESC")]
        items = [dict(r) for r in c.execute(
            "SELECT item_id, institution, status, error, products, last_synced FROM items")]
        review = c.execute("SELECT COUNT(*) FROM txn_class WHERE review=1").fetchone()[0]
    month_start = datetime.now().date().replace(day=1).isoformat()
    this_month = analytics.cashflow(start=month_start)["total"]
    assets = sum(a["balance"] or 0 for a in accounts if a["type"] in ASSET_TYPES)
    debts = sum(a["balance"] or 0 for a in accounts if a["type"] in DEBT_TYPES)
    home = analytics.home_position()
    if home:  # the house is an asset and the mortgage a debt, even though neither is a linked account
        assets += home["home_value"]
        debts += home["mortgage"]
        home = {k: home[k] for k in ("home_value", "mortgage", "equity", "mortgage_linked")}
    return jsonify(
        net_worth=assets - debts, assets=assets, debts=debts, home=home, this_month=this_month, review_count=review,
        accounts=accounts, holdings=holdings, items=items,
        last_sync=db.get_meta("last_sync"), env=plaid_sync.ENV, history_start=analytics.history_start(),
    )


@app.route("/api/sync", methods=["POST"])
@login_required
def sync_now():
    return jsonify(results=plaid_sync.sync_all())


@app.route("/api/link_token", methods=["POST"])
@login_required
def link_token():
    body = request.get_json(silent=True) or {}
    try:
        token = plaid_sync.create_link_token(kind=body.get("kind", "bank"), item_id=body.get("item_id"))
        return jsonify(link_token=token)
    except plaid_sync.plaid.ApiException as e:
        code, msg = plaid_sync.plaid_error(e)
        return jsonify(error=f"{code}: {msg}"), 400


@app.route("/api/exchange", methods=["POST"])
@login_required
def exchange():
    body = request.get_json()
    if body.get("item_id"):  # update mode: same login, just re-authenticated
        plaid_sync.mark_item_fixed(body["item_id"])
        return jsonify(ok=True)
    try:
        item_id = plaid_sync.save_public_token(body["public_token"], body.get("institution"))
        return jsonify(ok=True, item_id=item_id)
    except plaid_sync.plaid.ApiException as e:
        code, msg = plaid_sync.plaid_error(e)
        return jsonify(error=f"{code}: {msg}"), 400


@app.route("/api/venmo", methods=["POST"])
@login_required
def venmo_upload():
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file uploaded."), 400
    try:
        return jsonify(imported=manual.import_venmo_csv(f.read()))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@app.route("/api/import/wealthfront", methods=["POST"])
@login_required
def wealthfront_upload():
    files = [(f.filename, f.read()) for f in request.files.getlist("files") if f and f.filename]
    if not files:
        return jsonify(error="No files uploaded."), 400
    return jsonify(report=statements.import_wealthfront_pdfs(files))


@app.route("/api/manual", methods=["POST"])
@login_required
def manual_upsert():
    b = request.get_json()
    try:
        balance = float(str(b["balance"]).replace(",", "").replace("$", ""))
    except (KeyError, ValueError):
        return jsonify(error="Balance must be a number."), 400
    if b.get("type") not in ASSET_TYPES | DEBT_TYPES:
        return jsonify(error="Bad account type."), 400
    aid = manual.upsert_manual(b.get("name") or "Account", b.get("institution") or "", b["type"], balance,
                               b.get("account_id"))
    return jsonify(ok=True, account_id=aid)


@app.route("/api/manual/<account_id>", methods=["DELETE"])
@login_required
def manual_delete(account_id):
    manual.delete_manual(account_id)
    return jsonify(ok=True)


# ---------- analytics ----------

def _range_args():
    a = request.args
    accounts = [x for x in a.get("accounts", "").split(",") if x] or None
    return dict(start=a.get("start") or None, end=a.get("end") or None, accounts=accounts)


@app.route("/api/cashflow")
@login_required
def api_cashflow():
    group = request.args.get("group", "month")
    if group not in analytics.PERIODS:
        return jsonify(error="bad group"), 400
    return jsonify(analytics.cashflow(group=group, **_range_args()))


@app.route("/api/categories")
@login_required
def api_categories():
    return jsonify(analytics.by_category(flow=request.args.get("flow", "spend"), **_range_args()))


@app.route("/api/by_account")
@login_required
def api_by_account():
    r = _range_args()
    return jsonify(analytics.by_account(r["start"], r["end"]))


@app.route("/api/networth_history")
@login_required
def api_networth_history():
    return jsonify(analytics.networth_history())


@app.route("/api/investments")
@login_required
def api_investments():
    return jsonify(analytics.investments(**_range_args()))


@app.route("/api/merchants")
@login_required
def api_merchants():
    return jsonify(analytics.top_merchants(**_range_args()))


@app.route("/api/coverage")
@login_required
def api_coverage():
    return jsonify(analytics.data_coverage())


# ---------- transactions: list, fix, rules ----------

FLOWS = {"spend", "income", "refund", "transfer", "growth", "ignore"}


def _txn_filter(a):
    """WHERE clause for the Transactions page filters (shared by the list and its charts)."""
    where, args = analytics._where(a.get("start"), a.get("end"),
                                   [x for x in a.get("accounts", "").split(",") if x] or None)
    flows = [f for f in (a.get("flows") or a.get("flow") or "").split(",") if f]
    if flows:
        where += f" AND k.flow IN ({','.join('?' * len(flows))})"; args += flows
    if a.get("category"):
        where += " AND k.category = ?"; args.append(a["category"])
    if a.get("name"):  # exact merchant (case-insensitive), as grouped on the dashboard
        where += " AND lower(t.name) = ?"; args.append(a["name"].lower())
    if a.get("review") == "1":
        where += " AND k.review = 1"
    if a.get("invested") == "1":  # exactly the rows behind the dashboard's Invested number
        where += f" AND ({analytics._INVESTED}) != 0"
    if a.get("q"):
        q = a["q"].strip().lower()
        try:  # a number searches amounts too ("42.10", "$1,200")
            amt = float(q.replace("$", "").replace(",", ""))
        except ValueError:
            amt = None
        if amt is not None:
            where += " AND (lower(t.name) LIKE ? OR ABS(ABS(t.amount) - ?) < 0.5)"; args += [f"%{q}%", amt]
        else:
            where += " AND (lower(t.name) LIKE ? OR lower(k.category) LIKE ?)"; args += [f"%{q}%"] * 2
    return where, args


@app.route("/api/transactions")
@login_required
def api_transactions():
    """List transactions. Totals use the exact same math as the dashboards, so a drill-down always adds up
    to the number you clicked."""
    a = request.args
    where, args = _txn_filter(a)
    limit = min(int(a.get("limit", 200)), 2000)
    offset = int(a.get("offset", 0))
    with db.conn() as c:
        t = dict(c.execute(f"""SELECT COUNT(*) AS n,
                COALESCE(ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2), 0) AS money_out,
                COALESCE(ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2), 0) AS money_in,
                COALESCE(ROUND(SUM(CASE WHEN k.flow='spend' THEN {analytics._SPEND_AMT} WHEN k.flow='refund' THEN t.amount ELSE 0 END), 2), 0) AS net_spend,
                COALESCE(ROUND(SUM(COALESCE(m.extra, 0)), 2), 0) AS extra_principal,
                COALESCE(ROUND(SUM({analytics._INVESTED}), 2), 0) AS invested
                {analytics._FROM} WHERE {where}""", args).fetchone())
        rows = [dict(r) for r in c.execute(f"""SELECT t.txn_id, t.date, t.name, t.amount, t.pending, t.account_id,
                a.institution, a.name AS account_name, k.flow, k.kind, k.category, k.review, k.reason, k.pair_id,
                o.note, COALESCE(m.extra, 0) AS extra_principal
                {analytics._FROM} LEFT JOIN txn_overrides o ON o.txn_id=t.txn_id
                WHERE {where} ORDER BY t.date DESC, t.txn_id LIMIT ? OFFSET ?""", args + [limit, offset])]
    return jsonify(total=t["n"], totals=t, rows=rows)


@app.route("/api/transactions/charts")
@login_required
def api_txn_charts():
    """Charts for the Transactions page, over the same filtered rows as the list. Shows income when the
    type filter is Income, otherwise spending (refunds and paybacks subtract)."""
    a = request.args
    where, args = _txn_filter(a)
    measure = "income" if (a.get("flows") or a.get("flow")) == "income" else "spend"
    if measure == "income":
        where += " AND k.flow='income'"; amt = "-t.amount"
    else:
        where += " AND k.flow IN ('spend','refund')"; amt = analytics._SPEND_AMT
    with db.conn() as c:
        q = lambda sql: [dict(r) for r in c.execute(sql.format(amt=amt, FROM=analytics._FROM, where=where), args)]
        by_month = q("""SELECT substr(t.date,1,7) AS month, k.category, ROUND(SUM({amt}),2) AS amount
            {FROM} WHERE {where} GROUP BY 1,2""")
        categories = q("""SELECT k.category, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n
            {FROM} WHERE {where} GROUP BY 1 HAVING SUM({amt}) != 0 ORDER BY 2 DESC""")
        merchants = q("""SELECT MIN(t.name) AS name, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n
            {FROM} WHERE {where} GROUP BY lower(t.name) HAVING SUM({amt}) > 0 ORDER BY 2 DESC LIMIT 15""")
        daily = q("""SELECT t.date, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n
            {FROM} WHERE {where} GROUP BY 1 ORDER BY 1""")
    return jsonify(measure=measure, by_month=by_month, categories=categories, merchants=merchants, daily=daily)


@app.route("/api/transactions/<txn_id>", methods=["PATCH"])
@login_required
def api_fix_txn(txn_id):
    b = request.get_json() or {}
    if b.get("flow") and b["flow"] not in FLOWS:
        return jsonify(error="bad flow"), 400
    with db.conn() as c:
        if b.get("clear"):
            c.execute("DELETE FROM txn_overrides WHERE txn_id=?", (txn_id,))
        else:
            c.execute("""INSERT INTO txn_overrides(txn_id, flow, category, note, updated_at) VALUES (?,?,?,?,datetime('now'))
                ON CONFLICT(txn_id) DO UPDATE SET flow=excluded.flow, category=excluded.category,
                note=excluded.note, updated_at=excluded.updated_at""",
                      (txn_id, b.get("flow") or None, b.get("category") or None, b.get("note") or None))
    classify.run()
    return jsonify(ok=True)


@app.route("/api/categories/all")
@login_required
def api_category_names():
    with db.conn() as c:
        used = [r[0] for r in c.execute("SELECT DISTINCT category FROM txn_class WHERE category IS NOT NULL")]
    return jsonify(sorted(set(used) | set(classify.CATEGORY_NAMES.values()) | {"Housing", "Groceries", "Subscriptions"}))


@app.route("/api/rules", methods=["GET", "POST"])
@login_required
def api_rules():
    if request.method == "POST":
        b = request.get_json() or {}
        if not (b.get("pattern") or "").strip():
            return jsonify(error="Pattern is required."), 400
        if b.get("set_flow") and b["set_flow"] not in FLOWS:
            return jsonify(error="bad flow"), 400
        with db.conn() as c:
            c.execute("""INSERT INTO rules(pattern, account_id, direction, set_flow, set_category, created_at)
                VALUES (?,?,?,?,?,datetime('now'))""",
                      (b["pattern"].strip(), b.get("account_id") or None, b.get("direction") or None,
                       b.get("set_flow") or None, b.get("set_category") or None))
        classify.run()
    with db.conn() as c:
        return jsonify([dict(r) for r in c.execute("SELECT * FROM rules ORDER BY id DESC")])


@app.route("/api/rules/<int:rule_id>", methods=["DELETE"])
@login_required
def api_rule_delete(rule_id):
    with db.conn() as c:
        c.execute("DELETE FROM rules WHERE id=?", (rule_id,))
    classify.run()
    return jsonify(ok=True)


# ---------- income ----------

@app.route("/api/income", methods=["GET", "PUT"])
@login_required
def api_income():
    if request.method == "PUT":
        b = request.get_json() or {}

        def num(key, required=False):
            v = str(b.get(key, "")).replace(",", "").replace("$", "").replace("%", "").strip()
            if not v:
                if required:
                    raise ValueError(key)
                return None
            return float(v)
        try:
            cfg = {
                "gross_annual": num("gross_annual", True),
                "net_per_paycheck": num("net_per_paycheck", True),
                "retirement_pct": num("retirement_pct") or 0,
                "employer_match_pct": num("employer_match_pct") or 0,
            }
        except ValueError:
            return jsonify(error="Salary and take-home per paycheck are required, and every field must be a number."), 400
        freq = b.get("pay_frequency") or "biweekly"
        if freq not in analytics.PERIODS_PER_YEAR:
            return jsonify(error="bad pay frequency"), 400
        cfg.update(pay_frequency=freq, employer=(b.get("employer") or "").strip(),
                   match_notes=(b.get("match_notes") or "").strip(), notes=(b.get("notes") or "").strip())
        cfg["annual_net"] = round(cfg["net_per_paycheck"] * analytics.PERIODS_PER_YEAR[freq], 2)
        old = db.get_json("income", {}) or {}
        cfg["history"] = old.get("history") or []
        cfg["effective"] = (b.get("effective") or old.get("effective") or "").strip() or None
        db.set_json("income", cfg)
    return jsonify(analytics.income_check())


@app.route("/api/income/history", methods=["POST"])
@login_required
def api_income_history_add():
    """Add a past pay period, e.g. last year's salary before a raise."""
    b = request.get_json() or {}
    try:
        entry = {
            "effective": str(date.fromisoformat(b["effective"])),
            "gross_annual": float(str(b["gross_annual"]).replace(",", "").replace("$", "")),
            "net_per_paycheck": float(str(b["net_per_paycheck"]).replace(",", "").replace("$", "")),
            "retirement_pct": float(b.get("retirement_pct") or 0),
            "employer_match_pct": float(b.get("employer_match_pct") or 0),
            "pay_frequency": b.get("pay_frequency") or "biweekly",
        }
    except (KeyError, ValueError):
        return jsonify(error="Start date, salary, and take-home per paycheck are required."), 400
    cfg = db.get_json("income", {}) or {}
    hist = [h for h in cfg.get("history") or [] if h["effective"] != entry["effective"]] + [entry]
    cfg["history"] = sorted(hist, key=lambda h: h["effective"])
    db.set_json("income", cfg)
    return jsonify(analytics.income_check())


@app.route("/api/income/history/<effective>", methods=["DELETE"])
@login_required
def api_income_history_delete(effective):
    cfg = db.get_json("income", {}) or {}
    cfg["history"] = [h for h in cfg.get("history") or [] if h["effective"] != effective]
    db.set_json("income", cfg)
    return jsonify(analytics.income_check())


# ---------- mortgage ----------

@app.route("/api/mortgage")
@login_required
def api_mortgage():
    try:
        extra = float(request.args.get("extra") or 0)
    except ValueError:
        extra = 0.0
    s = mortgage.summary(planned_extra_monthly=max(extra, 0))
    return jsonify(s or {"config": None})


def _money_arg(v):
    return float(str(v).replace(",", "").replace("$", "").strip())


@app.route("/api/mortgage", methods=["PUT"])
@login_required
def api_mortgage_update():
    """Edit the numbers that change over time (escrow after the yearly review, PMI, home value)."""
    cfg = mortgage.get_config()
    if not cfg:
        return jsonify(error="No mortgage set up."), 400
    b = request.get_json() or {}
    try:
        for k in ("escrow_monthly", "pmi_monthly", "current_value"):
            if k in b:
                cfg[k] = _money_arg(b[k]) if str(b[k]).strip() else None
    except ValueError:
        return jsonify(error="Amounts must be numbers."), 400
    mortgage.save_config(cfg)
    classify.run()
    return jsonify(mortgage.summary())


@app.route("/api/mortgage/checkpoints", methods=["POST"])
@login_required
def api_mortgage_checkpoint():
    """Pin the model to the real principal balance from a servicer statement."""
    cfg = mortgage.get_config()
    b = request.get_json() or {}
    try:
        cp = {"date": str(date.fromisoformat(b["date"])), "balance": _money_arg(b["balance"])}
    except (KeyError, ValueError):
        return jsonify(error="Enter the statement date and the principal balance."), 400
    cfg["checkpoints"] = [c for c in cfg.get("checkpoints") or [] if c["date"] != cp["date"]] + [cp]
    mortgage.save_config(cfg)
    return jsonify(mortgage.summary())


@app.route("/api/mortgage/checkpoints/<d>", methods=["DELETE"])
@login_required
def api_mortgage_checkpoint_delete(d):
    cfg = mortgage.get_config()
    cfg["checkpoints"] = [c for c in cfg.get("checkpoints") or [] if c["date"] != d]
    mortgage.save_config(cfg)
    return jsonify(mortgage.summary())


# ---------- budgets, goals, windfalls ----------

@app.route("/api/budget")
@login_required
def api_budget():
    return jsonify(planning.budget_month(request.args.get("month") or None))


@app.route("/api/budget", methods=["PUT"])
@login_required
def api_budget_set():
    b = request.get_json() or {}
    try:
        values = {k: (None if v in (None, "") else float(str(v).replace(",", "").replace("$", ""))) for k, v in b.items()}
    except ValueError:
        return jsonify(error="Budgets must be numbers."), 400
    planning.set_budgets(values)
    return jsonify(planning.budget_month(request.args.get("month") or None))


@app.route("/api/budget/suggest", methods=["POST"])
@login_required
def api_budget_suggest():
    """Fill every category that has no budget yet with its suggested amount."""
    current = planning.get_budgets()
    planning.set_budgets({k: v["suggested"] for k, v in planning.suggestions().items() if k not in current})
    return jsonify(planning.budget_month(request.args.get("month") or None))


GOAL_TYPES = {"emergency", "roth", "investing", "mortgage", "custom"}


@app.route("/api/goals")
@login_required
def api_goals():
    return jsonify(planning.goals_with_progress())


@app.route("/api/goals", methods=["POST"])
@login_required
def api_goal_save():
    b = request.get_json() or {}
    if b.get("type") not in GOAL_TYPES or not (b.get("name") or "").strip():
        return jsonify(error="Pick a goal type and give it a name."), 400
    try:
        target = float(str(b["target"]).replace(",", "").replace("$", "")) if str(b.get("target") or "").strip() else None
        if b.get("target_date"):
            date.fromisoformat(b["target_date"])
    except ValueError:
        return jsonify(error="Target must be a number and the date must be valid."), 400
    if b["type"] in ("roth", "investing", "custom") and not target:
        return jsonify(error="This goal needs a target amount."), 400
    planning.save_goal({"id": b.get("id"), "type": b["type"], "name": b["name"].strip(), "target": target,
                        "target_date": b.get("target_date"), "config": b.get("config") or {}})
    return jsonify(planning.goals_with_progress())


@app.route("/api/goals/<gid>", methods=["DELETE"])
@login_required
def api_goal_archive(gid):
    planning.archive_goal(gid)
    return jsonify(planning.goals_with_progress())


@app.route("/api/goals/<gid>/contribute", methods=["POST"])
@login_required
def api_goal_contribute(gid):
    b = request.get_json() or {}
    try:
        amt = float(str(b.get("amount")).replace(",", "").replace("$", ""))
    except ValueError:
        return jsonify(error="Amount must be a number."), 400
    planning.add_contribution(gid, amt, b.get("date"), b.get("note"))
    return jsonify(planning.goals_with_progress())


@app.route("/api/windfalls")
@login_required
def api_windfalls():
    return jsonify(planning.windfalls())


@app.route("/api/windfalls/split", methods=["PUT"])
@login_required
def api_windfall_split():
    split = (request.get_json() or {}).get("split") or []
    try:
        split = [{"target": s["target"], "pct": float(s["pct"])} for s in split if float(s.get("pct") or 0) > 0]
    except (KeyError, ValueError):
        return jsonify(error="Each part needs a goal and a percent."), 400
    if abs(sum(s["pct"] for s in split) - 100) > 0.5:
        return jsonify(error="The split has to add up to 100%."), 400
    db.set_json("windfall_split", split)
    return jsonify(planning.windfalls())


@app.route("/api/windfalls/<wid>/plan", methods=["POST"])
@login_required
def api_windfall_plan(wid):
    plan = (request.get_json() or {}).get("plan") or []
    planning.plan_windfall(wid, plan)
    return jsonify(planning.windfalls())


@app.route("/api/windfalls/<wid>", methods=["DELETE"])
@login_required
def api_windfall_dismiss(wid):
    planning.dismiss_windfall(wid)
    return jsonify(planning.windfalls())


@app.route("/api/transactions/<txn_id>/windfall", methods=["POST"])
@login_required
def api_mark_windfall(txn_id):
    planning.mark_windfall(txn_id, (request.get_json() or {}).get("label"))
    return jsonify(ok=True)


# ---------- phase 4: recurring, forecast, taxes, alerts ----------

@app.route("/api/recurring")
@login_required
def api_recurring():
    return jsonify(insights.recurring_summary())


@app.route("/api/recurring/dismiss", methods=["POST"])
@login_required
def api_recurring_dismiss():
    b = request.get_json() or {}
    if not b.get("key"):
        return jsonify(error="key required"), 400
    insights.dismiss_recurring(b["key"], undo=bool(b.get("undo")))
    return jsonify(ok=True)


@app.route("/api/forecast")
@login_required
def api_forecast():
    days = max(7, min(int(request.args.get("days", 60)), 120))
    return jsonify(insights.forecast(days))


@app.route("/api/forecast/low", methods=["PUT"])
@login_required
def api_forecast_low():
    try:
        v = float((request.get_json() or {}).get("low"))
    except (TypeError, ValueError):
        return jsonify(error="Enter a dollar amount."), 400
    db.set_meta("forecast_low", str(max(v, 0)))
    return jsonify(ok=True)


@app.route("/api/taxes")
@login_required
def api_taxes():
    return jsonify(insights.tax_year(request.args.get("year")))


@app.route("/api/taxes/limits", methods=["PUT"])
@login_required
def api_tax_limits():
    b = request.get_json() or {}
    try:
        year = int(b["year"])
        k401 = float(b["k401"]) if b.get("k401") not in (None, "") else None
        ira = float(b["ira"]) if b.get("ira") not in (None, "") else None
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Enter the limits as dollar amounts."), 400
    insights.set_tax_limits(year, k401, ira)
    return jsonify(ok=True)


@app.route("/api/home_value")
@login_required
def api_home_value():
    import home
    if request.args.get("refresh"):
        home.index(refresh=True)
    return jsonify(home.estimate(mortgage.get_config()))


@app.route("/api/projection")
@login_required
def api_projection():
    return jsonify(insights.projection_inputs())


@app.route("/api/recap")
@login_required
def api_recap():
    return jsonify(insights.recap(request.args.get("month")))


@app.route("/api/alerts")
@login_required
def api_alerts():
    return jsonify(insights.alerts())


@app.route("/api/alerts/<path:aid>/dismiss", methods=["POST"])
@login_required
def api_alert_dismiss(aid):
    insights.dismiss_alert(aid)
    return jsonify(ok=True)


# ---------- daily background refresh ----------

def _auto_sync_loop():
    while True:
        last = db.get_meta("last_sync")
        due = not last or datetime.now(timezone.utc) - datetime.fromisoformat(last) >= SYNC_EVERY
        if due:
            try:
                plaid_sync.sync_all()
            except Exception as e:  # never let the background loop die
                print(f"[auto-sync] failed: {e}")
        time.sleep(15 * 60)


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    db.init()
    db.snapshot_balances()
    planning.init()
    threading.Thread(target=_auto_sync_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8750"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"\n  Finance Hub ({plaid_sync.ENV})")
    print(f"  On this Mac:          http://localhost:{port}")
    if host == "0.0.0.0":
        print(f"  Phone / other PCs:    http://{_lan_ip()}:{port}   (same Wi-Fi)\n")
    app.run(host=host, port=port, debug=False, threaded=True)

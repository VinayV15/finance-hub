"""Finance Hub — a private dashboard for all your accounts.

Runs on your Mac. Open it in any browser on the same Wi-Fi (Mac, iPhone, Windows).
Start it with:  ./run.sh
"""
import hmac
import os
import socket
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from flask import (Flask, jsonify, redirect, render_template, request, send_from_directory,  # noqa: E402
                   session, url_for)

import analytics  # noqa: E402
import classify  # noqa: E402
import db  # noqa: E402
import manual  # noqa: E402
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
    return jsonify(
        net_worth=assets - debts, assets=assets, debts=debts, this_month=this_month, review_count=review,
        accounts=accounts, holdings=holdings, items=items,
        last_sync=db.get_meta("last_sync"), env=plaid_sync.ENV,
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


@app.route("/api/merchants")
@login_required
def api_merchants():
    return jsonify(analytics.top_merchants(**_range_args()))


@app.route("/api/coverage")
@login_required
def api_coverage():
    return jsonify(analytics.data_coverage())


# ---------- transactions: list, fix, rules ----------

FLOWS = {"spend", "income", "refund", "transfer", "growth"}


@app.route("/api/transactions")
@login_required
def api_transactions():
    a = request.args
    where, args = analytics._where(a.get("start"), a.get("end"),
                                   [x for x in a.get("accounts", "").split(",") if x] or None)
    if a.get("flow"):
        where += " AND k.flow = ?"; args.append(a["flow"])
    if a.get("category"):
        where += " AND k.category = ?"; args.append(a["category"])
    if a.get("review") == "1":
        where += " AND k.review = 1"
    if a.get("q"):
        where += " AND (lower(t.name) LIKE ? OR lower(k.category) LIKE ?)"
        args += [f"%{a['q'].lower()}%"] * 2
    limit = min(int(a.get("limit", 200)), 2000)
    offset = int(a.get("offset", 0))
    with db.conn() as c:
        total = c.execute(f"SELECT COUNT(*) {analytics._FROM} WHERE {where}", args).fetchone()[0]
        rows = [dict(r) for r in c.execute(f"""SELECT t.txn_id, t.date, t.name, t.amount, t.pending, t.account_id,
                a.institution, a.name AS account_name, k.flow, k.kind, k.category, k.review, k.reason, k.pair_id,
                o.note FROM transactions t JOIN txn_class k USING(txn_id)
                LEFT JOIN accounts a ON a.account_id=t.account_id
                LEFT JOIN txn_overrides o ON o.txn_id=t.txn_id
                WHERE {where} ORDER BY t.date DESC, t.txn_id LIMIT ? OFFSET ?""", args + [limit, offset])]
    return jsonify(total=total, rows=rows)


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
        try:
            annual = float(str(b.get("annual_net", "")).replace(",", "").replace("$", ""))
        except ValueError:
            return jsonify(error="Annual after-tax income must be a number."), 400
        db.set_json("income", {
            "annual_net": annual,
            "pay_frequency": b.get("pay_frequency") or "biweekly",
            "employer": (b.get("employer") or "").strip(),
            "notes": (b.get("notes") or "").strip(),
        })
    return jsonify(analytics.income_check())


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
    threading.Thread(target=_auto_sync_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8750"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"\n  Finance Hub ({plaid_sync.ENV})")
    print(f"  On this Mac:          http://localhost:{port}")
    if host == "0.0.0.0":
        print(f"  Phone / other PCs:    http://{_lan_ip()}:{port}   (same Wi-Fi)\n")
    app.run(host=host, port=port, debug=False, threaded=True)

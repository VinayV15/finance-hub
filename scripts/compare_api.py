"""Check the Supabase API against the original Flask app, endpoint by endpoint, on the same data.

    PLAID_ENV=production .venv/bin/python scripts/compare_api.py <sqlite copy> <api base url> <access token>

The Flask side runs in-process against the SQLite copy; the Supabase side is called over HTTP. Numbers must
match to the cent; list order only matters where the app shows it in that order.
"""
import json
import sys
import urllib.request

SQLITE, BASE, TOKEN = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3]

import db  # noqa: E402

db.DB_PATH = SQLITE
import app  # noqa: E402

import sqlite3  # noqa: E402

# One real cash account from this database, for the single-account checks.
ACCT = (sqlite3.connect(SQLITE).execute("SELECT account_id FROM accounts WHERE type='depository' ORDER BY balance DESC").fetchone() or [""])[0]

client = app.app.test_client()
with client.session_transaction() as s:
    s["ok"] = True

GET = [
    "/api/summary",
    "/api/cashflow?group=month", "/api/cashflow?group=week&start=2026-06-01", "/api/cashflow?group=quarter",
    "/api/cashflow?group=year", "/api/cashflow?group=day&start=2026-09-01",
    "/api/cashflow?start=2026-01-01&end=2026-06-30&accounts={ACCT}",
    "/api/categories", "/api/categories?flow=income", "/api/categories?start=2026-08-01&end=2026-08-31",
    "/api/by_account", "/api/by_account?start=2026-01-01",
    "/api/networth_history",
    "/api/investments", "/api/investments?start=2026-01-01", "/api/investments?start=2026-09-28",
    "/api/merchants", "/api/merchants?start=2026-03-01&end=2026-05-31",
    "/api/coverage",
    "/api/transactions?limit=2000", "/api/transactions?flows=spend,refund&start=2026-08-01&limit=500",
    "/api/transactions?invested=1&limit=500", "/api/transactions?q=1082.83", "/api/transactions?q=netflix",
    "/api/transactions?review=1", "/api/transactions?category=Food%20%26%20Drink&limit=500",
    "/api/transactions/charts", "/api/transactions/charts?flows=income", "/api/transactions/charts?start=2026-01-01&category=Shopping",
    "/api/categories/all", "/api/rules", "/api/income",
    "/api/mortgage", "/api/mortgage?extra=250", "/api/home_value",
    "/api/budget", "/api/budget?month=2026-08", "/api/budget?month=2026-03",
    "/api/goals", "/api/windfalls", "/api/recurring",
    "/api/forecast", "/api/forecast?days=30", "/api/forecast?days=90",
    "/api/taxes", "/api/taxes?year=2025",
    "/api/plan", "/api/recap", "/api/recap?month=2026-07", "/api/recap?month=2026-02",
    "/api/alerts",
]

# Fields whose values legitimately differ between the two (time of the request, backend identity).
SKIP_KEYS = {"cloud"}
UNORDERED = {"/api/categories/all"}
# Lists whose order on screen comes from the page itself (grouped or re-sorted there).
UNORDERED_KEYS = {"events"}


def remote(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


ORDER_ONLY = []


def same_items(a, b):
    """Two lists hold the same items (to the cent) in a different order."""
    if len(a) != len(b):
        return False
    key = lambda v: json.dumps(v, sort_keys=True)
    return all(not diff(x, y) for x, y in zip(sorted(a, key=key), sorted(b, key=key)))


def diff(a, b, path="", out=None, unordered=False):
    out = [] if out is None else out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in SKIP_KEYS:
                continue
            if k not in a or k not in b:
                if (a.get(k) is None) and (b.get(k) is None):
                    continue
                out.append(f"{path}.{k}: only in {'flask' if k in a else 'supabase'} ({a.get(k, b.get(k))!r:.80})")
                continue
            diff(a[k], b[k], f"{path}.{k}", out, unordered=k in UNORDERED_KEYS)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items vs {len(b)}")
        inner = []
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", inner)
        if inner and (unordered or same_items(a, b)):
            # Same items, different order (equal amounts tie differently, or the page sorts them itself).
            key = lambda v: json.dumps(v, sort_keys=True)
            inner = []
            for i, (x, y) in enumerate(zip(sorted(a, key=key), sorted(b, key=key))):
                diff(x, y, f"{path}[sorted {i}]", inner)
            if not inner:
                ORDER_ONLY.append(path)
        out.extend(inner)
    elif isinstance(a, bool) or isinstance(b, bool):
        if bool(a) != bool(b):
            out.append(f"{path}: {a!r} vs {b!r}")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        # 1 cent of float noise is allowed: Postgres adds the same numbers in a different order than SQLite
        if abs(a - b) > 0.0101 and not (abs(a) > 1000 and abs(a - b) / abs(a) < 1e-9):
            out.append(f"{path}: {a!r} vs {b!r}")
    elif a != b:
        out.append(f"{path}: {a!r:.90} vs {b!r:.90}")
    return out


total = 0
for p in GET:
    p = p.replace("{ACCT}", ACCT)
    flask = client.get(p).get_json()
    try:
        supa = remote(p)
    except urllib.error.HTTPError as e:
        print(f"✗ {p}: HTTP {e.code} {e.read()[:200]!r}")
        total += 1
        continue
    ORDER_ONLY.clear()
    d = diff(flask, supa, unordered=p in UNORDERED)
    total += bool(d)
    note = f"  (order differs only in {', '.join(sorted(set(ORDER_ONLY)))[:80]})" if ORDER_ONLY and not d else ""
    print(("✓ " if not d else "✗ ") + p + ("" if not d else f"  ({len(d)} differences)") + note)
    for line in d[:12]:
        print("    " + line)
print(f"\n{len(GET) - total}/{len(GET)} endpoints match")

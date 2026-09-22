"""SQLite storage. One file (finance-<env>.db) next to this script, readable only by you."""
import os
import sqlite3
from contextlib import contextmanager

# Separate file per Plaid environment so sandbox test data never mixes with your real accounts.
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       f"finance-{os.environ.get('PLAID_ENV', 'sandbox').lower()}.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    item_id        TEXT PRIMARY KEY,
    access_token   TEXT NOT NULL,
    institution    TEXT,
    env            TEXT NOT NULL,
    products       TEXT,
    cursor         TEXT,
    status         TEXT DEFAULT 'ok',
    error          TEXT,
    last_synced    TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
    account_id     TEXT PRIMARY KEY,
    item_id        TEXT,
    source         TEXT NOT NULL,          -- plaid | venmo | manual
    institution    TEXT,
    name           TEXT,
    mask           TEXT,
    type           TEXT,                   -- depository | investment | credit | loan | other
    subtype        TEXT,
    balance        REAL,                   -- current balance, positive number
    available      REAL,
    currency       TEXT DEFAULT 'USD',
    updated_at     TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
    txn_id         TEXT PRIMARY KEY,
    account_id     TEXT,
    date           TEXT,
    name           TEXT,
    amount         REAL,                   -- positive = money out, negative = money in (Plaid convention)
    category       TEXT,
    pending        INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS holdings (
    account_id     TEXT,
    security_id    TEXT,
    ticker         TEXT,
    name           TEXT,
    quantity       REAL,
    price          REAL,
    value          REAL,
    cost_basis     REAL,
    PRIMARY KEY (account_id, security_id)
);
CREATE TABLE IF NOT EXISTS liabilities (
    account_id     TEXT PRIMARY KEY,
    kind           TEXT,                   -- credit | mortgage | student
    apr            REAL,
    min_payment    REAL,
    next_due       TEXT,
    last_statement REAL,
    extra          TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    key            TEXT PRIMARY KEY,
    value          TEXT
);
-- Your manual fixes to a transaction. Kept separate so a re-sync never wipes them.
CREATE TABLE IF NOT EXISTS txn_overrides (
    txn_id         TEXT PRIMARY KEY,
    flow           TEXT,
    category       TEXT,
    note           TEXT,
    updated_at     TEXT
);
-- "Always treat transactions like X as Y."
CREATE TABLE IF NOT EXISTS rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern        TEXT NOT NULL,          -- case-insensitive substring of the name
    account_id     TEXT,                   -- NULL = any account
    direction      TEXT,                   -- out | in | NULL (either)
    set_flow       TEXT,
    set_category   TEXT,
    created_at     TEXT
);
-- Output of classify.py, rebuilt after every sync/import. Never edit by hand.
CREATE TABLE IF NOT EXISTS txn_class (
    txn_id         TEXT PRIMARY KEY,
    flow           TEXT,                   -- spend | income | transfer | refund | growth
    kind           TEXT,                   -- finer detail, e.g. card_payment, invest_contribution, paycheck
    category       TEXT,
    pair_id        TEXT,                   -- the other half of an internal transfer
    review         INTEGER DEFAULT 0,      -- 1 = the app wasn't sure; shows in the Review queue
    reason         TEXT
);
"""

# Columns added after the first version. Added in place so existing data is kept.
MIGRATIONS = [
    ("transactions", "detailed", "TEXT"),        # Plaid detailed category, e.g. TRANSFER_OUT_ACCOUNT_TRANSFER
    ("transactions", "raw_primary", "TEXT"),     # Plaid primary category, e.g. TRANSFER_OUT
    ("transactions", "source", "TEXT"),          # plaid | plaid_inv | venmo | import
    ("transactions", "txn_type", "TEXT"),        # Venmo type / investment subtype
    ("transactions", "funding_source", "TEXT"),  # Venmo: what paid for it (balance or a bank)
    ("transactions", "counterparty", "TEXT"),
]


@contextmanager
def conn():
    new = not os.path.exists(DB_PATH)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    if new:
        os.chmod(DB_PATH, 0o600)
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        for table, col, typ in MIGRATIONS:
            cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        c.execute("UPDATE transactions SET source='venmo' WHERE source IS NULL AND account_id='venmo'")
        c.execute("UPDATE transactions SET source='plaid' WHERE source IS NULL")


def upsert_txn(c, **t):
    """Insert or update one transaction's raw fields (never touches overrides or classification)."""
    cols = ["txn_id", "account_id", "date", "name", "amount", "category", "pending", "detailed",
            "raw_primary", "source", "txn_type", "funding_source", "counterparty"]
    vals = [t.get(k) for k in cols]
    updates = ", ".join(f"{k}=excluded.{k}" for k in cols[1:])
    c.execute(f"INSERT INTO transactions ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
              f"ON CONFLICT(txn_id) DO UPDATE SET {updates}", vals)


def get_json(key, default=None):
    import json
    v = get_meta(key)
    return json.loads(v) if v else default


def set_json(key, value):
    import json
    set_meta(key, json.dumps(value))


def get_meta(key, default=None):
    with conn() as c:
        row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_meta(key, value):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))

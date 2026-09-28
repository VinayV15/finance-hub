"""Copy every table from the SQLite database into Postgres (the Supabase version of the app).

Writes one SQL script to stdout (COPY blocks inside a single transaction); pipe it into psql:

    python3 scripts/copy_to_postgres.py finance-production.db | psql "$DATABASE_URL"

Existing rows in the target tables are replaced. Run it once when switching over.
"""
import csv
import io
import sqlite3
import sys

TABLES = ["items", "accounts", "transactions", "holdings", "liabilities", "meta", "txn_overrides", "rules",
          "txn_class", "mortgage_alloc", "budgets", "goals", "goal_contribs", "windfalls", "balance_snapshots"]
IDENTITY = {"rules": "id", "goal_contribs": "id"}


def main(path):
    src = sqlite3.connect(path)
    out = sys.stdout
    out.write("BEGIN;\n")
    for table in TABLES:
        cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})")]
        out.write(f"DELETE FROM public.{table};\n")
        out.write(f"COPY public.{table} ({', '.join(cols)}) FROM STDIN WITH (FORMAT csv, NULL '\\N');\n")
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        order = " ORDER BY rowid" if table == "transactions" else ""  # keep insertion order (Postgres seq)
        for row in src.execute(f"SELECT {', '.join(cols)} FROM {table}{order}"):
            w.writerow(["\\N" if v is None else repr(v) if isinstance(v, float) else v for v in row])
        out.write(buf.getvalue())
        out.write("\\.\n")
        if table in IDENTITY:
            col = IDENTITY[table]
            out.write(f"SELECT setval(pg_get_serial_sequence('public.{table}', '{col}'), "
                      f"COALESCE((SELECT MAX({col}) FROM public.{table}), 0) + 1, false);\n")
    out.write("COMMIT;\n")


if __name__ == "__main__":
    main(sys.argv[1])

"""Copy every table from the SQLite database into Postgres (the Supabase version of the app).

Writes one SQL script to stdout (COPY blocks inside a single transaction); pipe it into psql:

    python3 scripts/copy_to_postgres.py finance-production.db | psql "$DATABASE_URL"

With --inserts it writes plain INSERT statements instead, one file per table into a folder, for tools that
can't stream COPY (e.g. `supabase db query --linked -f <file>`):

    python3 scripts/copy_to_postgres.py finance-production.db --inserts out/

Existing rows in the target tables are replaced. Run it once when switching over.
"""
import csv
import io
import sqlite3
import sys

TABLES = ["items", "accounts", "transactions", "holdings", "liabilities", "meta", "txn_overrides", "rules",
          "txn_class", "mortgage_alloc", "budgets", "goals", "goal_contribs", "windfalls", "balance_snapshots"]
IDENTITY = {"rules": "id", "goal_contribs": "id"}


def sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main_inserts(path, out_dir, batch=400):
    """One file per table: delete, then batched INSERTs (in rowid order, so transactions keep their order)."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    src = sqlite3.connect(path)
    files = []
    for n, table in enumerate(TABLES):
        cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})")]
        order = " ORDER BY rowid" if table == "transactions" else ""
        rows = list(src.execute(f"SELECT {', '.join(cols)} FROM {table}{order}"))
        parts = [f"DELETE FROM public.{table};"]
        for i in range(0, len(rows), batch):
            vals = ",\n".join("(" + ", ".join(sql_value(v) for v in r) + ")" for r in rows[i:i + batch])
            parts.append(f"INSERT INTO public.{table} ({', '.join(cols)}) VALUES\n{vals};")
        if table in IDENTITY:
            col = IDENTITY[table]
            parts.append(f"PERFORM setval(pg_get_serial_sequence('public.{table}', '{col}'), "
                         f"COALESCE((SELECT MAX({col}) FROM public.{table}), 0) + 1, false);")
        f = os.path.join(out_dir, f"{n:02d}_{table}.sql")
        # One command per file (some tools run a single statement); a DO block is also all-or-nothing.
        body = "\n".join(parts)
        assert "$fh$" not in body
        open(f, "w").write("DO $fh$ BEGIN\n" + body + "\nEND $fh$;\n")
        files.append((f, len(rows)))
    for f, n in files:
        print(f"{f}\t{n}")


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
    if len(sys.argv) > 3 and sys.argv[2] == "--inserts":
        main_inserts(sys.argv[1], sys.argv[3])
    else:
        main(sys.argv[1])

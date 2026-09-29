# Finance Hub

Private personal-finance dashboard. Runs in the cloud for free (Supabase + GitHub Pages) with passkey sign-in
for a single owner; the original Mac version still works for local development.

- Pulls balances, transactions, holdings, and loan details from Plaid (banks, cards, brokerages, loans)
- Venmo via statement CSV import; anything else via manual balances
- Classifies every transaction as spending / income / refund / transfer / investment growth, so money moving
  between your own accounts is never counted twice (`classify.py`)
- Dashboards over any date range and set of accounts (`analytics.py`, `web/`)

## Run

```bash
./run.sh          # builds the React screens if needed, then starts on http://localhost:8750
```

Setup once: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then create `.env`
with `PLAID_CLIENT_ID`, `PLAID_SECRET_SANDBOX`, `PLAID_SECRET_PRODUCTION`, `PLAID_ENV`, `DASHBOARD_PIN`,
`FLASK_SECRET_KEY`. `.env` and the `finance-*.db` data files are never committed.

Front-end development: run the app, then `cd web && npm run dev` (proxies `/api` to the running server).

## Cloud version (Supabase + GitHub Pages)

- `supabase/functions/api`: the same `/api/...` endpoints as `app.py`, as one edge function. It answers only the
  owner's signed-in session (`OWNER_EMAIL`) or the scheduler (`x-cron-secret`).
- `supabase/migrations`: the schema (row-level security on every table, no policies) and a pg_cron job that
  calls the API every 30 minutes (full Plaid sync once a day).
- `web/` built with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` runs in cloud mode (sign-in screen, passkeys);
  `.github/workflows/pages.yml` publishes it on every push to `main`.

Function secrets (`supabase secrets set`): `PLAID_ENV`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `OWNER_EMAIL`,
`CRON_SECRET`, `APP_TZ`, `ALLOWED_ORIGINS`, `SYNC_EVERY_HOURS`. Vault secrets for the scheduler: `api_url`,
`cron_secret`. Your own billers, mortgage servicer, and home price area live in the `meta` table, not the code.

Deploy server changes: `npx supabase db push` (migrations) and `npx supabase functions deploy api --no-verify-jwt`.
Check the port against the Flask app: `scripts/compare_api.py`. Move data from SQLite: `scripts/copy_to_postgres.py`.
Statement PDF import is Mac-only.

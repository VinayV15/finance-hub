# Finance Hub

Private, local personal-finance dashboard. Runs on a Mac; open it from any browser on the same Wi-Fi.

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

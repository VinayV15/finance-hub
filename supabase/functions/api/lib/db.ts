// Database access. Queries are written SQLite-style with ? placeholders (as in the original app) and
// converted to Postgres $1, $2, … here, so the SQL could be carried over unchanged.
import postgres from 'npm:postgres@3.4.5'

type Row = Record<string, any>

const asNumber = { serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) }
let _sql: ReturnType<typeof postgres> | null = null
export function sql() {
  if (!_sql) {
    _sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
      prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10,
      // bigint (COUNT) and numeric come back as strings by default; the app wants plain numbers
      types: { int8: { to: 20, from: [20], ...asNumber }, numeric: { to: 1700, from: [1700], ...asNumber } } as any,
      onnotice: () => {},
    })
  }
  return _sql
}

// deno-lint-ignore no-explicit-any
type Exec = any // postgres.js Sql or TransactionSql; both have .unsafe(query, params)

function convert(q: string) {
  let i = 0
  return q.replace(/\?/g, () => `$${++i}`)
}

export async function all(q: string, params: unknown[] = [], tx: Exec = sql()): Promise<Row[]> {
  const rows = await tx.unsafe(convert(q), params as any[])
  return Array.from(rows as Row[])
}
export async function one(q: string, params: unknown[] = [], tx: Exec = sql()): Promise<Row | null> {
  return (await all(q, params, tx))[0] ?? null
}
/** First column of the first row (SQLite's fetchone()[0]). */
export async function scalar(q: string, params: unknown[] = [], tx: Exec = sql()): Promise<any> {
  const r = await one(q, params, tx)
  return r ? Object.values(r)[0] : null
}
export async function run(q: string, params: unknown[] = [], tx: Exec = sql()) {
  await tx.unsafe(convert(q), params as any[])
}
/** Run several statements atomically. */
export async function transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
  return await sql().begin(async (tx) => await fn(tx as unknown as Exec)) as T
}

// ---------- meta (small settings stored as key/value) ----------

const metaCache = new Map<string, string | null>()
export function clearMetaCache() { metaCache.clear() }

export async function getMeta(key: string, def: string | null = null): Promise<string | null> {
  if (!metaCache.has(key)) {
    const r = await one('SELECT value FROM meta WHERE key=?', [key])
    metaCache.set(key, r ? r.value : null)
  }
  const v = metaCache.get(key)
  return v ?? def
}
export async function setMeta(key: string, value: string) {
  await run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value])
  metaCache.set(key, value)
}
export async function getJson<T = any>(key: string, def: T | null = null): Promise<T | null> {
  const v = await getMeta(key)
  return v ? JSON.parse(v) as T : def
}
export async function setJson(key: string, value: unknown) { await setMeta(key, JSON.stringify(value)) }

// ---------- writes shared by the importers ----------

const TXN_COLS = ['txn_id', 'account_id', 'date', 'name', 'amount', 'category', 'pending', 'detailed',
  'raw_primary', 'source', 'txn_type', 'funding_source', 'counterparty']

/** Insert or update one transaction's raw fields (never touches overrides or classification). */
export async function upsertTxn(t: Row, tx: Exec = sql()) {
  const vals = TXN_COLS.map((k) => t[k] ?? null)
  const updates = TXN_COLS.slice(1).map((k) => `${k}=excluded.${k}`).join(', ')
  await run(`INSERT INTO transactions (${TXN_COLS.join(', ')}) VALUES (${TXN_COLS.map(() => '?').join(', ')})
    ON CONFLICT(txn_id) DO UPDATE SET ${updates}`, vals, tx)
}

/** Record today's balance for every account (re-running the same day overwrites it). */
export async function snapshotBalances(todayIso: string) {
  await run(`INSERT INTO balance_snapshots (date, account_id, balance, cost_basis)
    SELECT ?, a.account_id, a.balance, (SELECT SUM(h.cost_basis) FROM holdings h WHERE h.account_id=a.account_id)
    FROM accounts a WHERE a.balance IS NOT NULL
    ON CONFLICT(date, account_id) DO UPDATE SET balance=excluded.balance, cost_basis=excluded.cost_basis`, [todayIso])
}

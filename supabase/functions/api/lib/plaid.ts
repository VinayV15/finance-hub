// Everything that talks to Plaid (port of plaid_sync.py), over Plaid's JSON API.
// Secrets come from function environment variables: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV.
import { all, one, run, setMeta, snapshotBalances, transaction, upsertTxn } from './db.ts'
import { addDays, nowIso, today } from './util.ts'
import * as classify from './classify.ts'
import { upsertAccount } from './manual.ts'

export const ENV = (Deno.env.get('PLAID_ENV') || 'sandbox').toLowerCase()
const HOST = ENV === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com'

export class PlaidError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function plaid(path: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(HOST + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: Deno.env.get('PLAID_CLIENT_ID'), secret: Deno.env.get('PLAID_SECRET'), ...body }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new PlaidError(data.error_code || 'UNKNOWN', data.error_message || `Plaid ${path} failed (${r.status})`)
  return data
}

// What to ask Plaid for, per kind of account being linked.
const LINK_KINDS: Record<string, { required: string[]; optional: string[] }> = {
  bank: { required: ['transactions'], optional: ['liabilities', 'investments'] },
  investment: { required: ['investments'], optional: ['transactions'] },
  loan: { required: ['liabilities'], optional: ['transactions'] },
}

/** New login (kind=bank/investment/loan), or update mode for an existing item (fixes a broken login). */
export async function createLinkToken(kind = 'bank', itemId?: string | null) {
  const args: Record<string, unknown> = { client_name: 'Finance Hub', language: 'en', country_codes: ['US'], user: { client_user_id: 'owner' } }
  if (itemId) {
    const row = await one('SELECT access_token FROM items WHERE item_id=?', [itemId])
    args.access_token = row?.access_token
  } else {
    const spec = LINK_KINDS[kind] || LINK_KINDS.bank
    args.products = spec.required
    args.optional_products = spec.optional
    if ([...spec.required, ...spec.optional].includes('transactions')) args.transactions = { days_requested: 730 }
  }
  return (await plaid('/link/token/create', args)).link_token as string
}

export async function savePublicToken(publicToken: string, institutionName?: string | null) {
  const resp = await plaid('/item/public_token/exchange', { public_token: publicToken })
  await run(`INSERT INTO items(item_id, access_token, institution, env, linked_at) VALUES (?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token, institution=excluded.institution, env=excluded.env, linked_at=excluded.linked_at`,
    [resp.item_id, resp.access_token, institutionName ?? null, ENV, nowIso()])
  // Plaid prepares the history a few minutes after linking; the scheduled job re-pulls new logins for an hour.
  await syncItem(resp.item_id)
  return resp.item_id as string
}

export async function markItemFixed(itemId: string) {
  await run("UPDATE items SET status='ok', error=NULL WHERE item_id=?", [itemId])
  await syncItem(itemId)
}

// ---------- syncing ----------

export async function syncAll() {
  const ids = (await all('SELECT item_id FROM items WHERE env=?', [ENV])).map((r) => r.item_id)
  const results: Record<string, string> = {}
  for (const id of ids) results[id] = await syncItem(id, false)
  await classify.run()
  await snapshotBalances(today())
  await setMeta('last_sync', nowIso())
  return results
}

/** Re-pull logins linked in the last hour (their history arrives a few minutes after linking). */
export async function syncRecentlyLinked() {
  const since = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, '+00:00')
  const ids = (await all('SELECT item_id FROM items WHERE env=? AND linked_at > ?', [ENV, since])).map((r) => r.item_id)
  for (const id of ids) await syncItem(id, false)
  if (ids.length) await classify.run()
  return ids.length
}

export async function syncItem(itemId: string, reclassify = true) {
  const item = await one('SELECT * FROM items WHERE item_id=?', [itemId])
  if (!item) return 'NOT_FOUND'
  const token = item.access_token
  try {
    const acct = await plaid('/accounts/get', { access_token: token })
    const products: string[] = (acct.item?.products || []).map(String)
    const institution = item.institution || await institutionName(acct.item?.institution_id)
    await saveAccounts(itemId, institution, acct.accounts)
    if (products.includes('transactions')) await syncTransactions(itemId, token, item.cursor)
    if (products.includes('investments')) {
      await syncHoldings(token)
      try { await syncInvestmentTxns(token) } catch (e) {
        if (!(e instanceof PlaidError) || !['PRODUCTS_NOT_SUPPORTED', 'NO_INVESTMENT_ACCOUNTS'].includes(e.code)) throw e
      }
    }
    if (products.includes('liabilities')) await syncLiabilities(token)
    await run("UPDATE items SET status='ok', error=NULL, institution=?, products=?, last_synced=? WHERE item_id=?", [institution, products.join(','), nowIso(), itemId])
    if (reclassify) await classify.run()
    return 'ok'
  } catch (e) {
    if (!(e instanceof PlaidError)) throw e
    await run('UPDATE items SET status=?, error=? WHERE item_id=?', [e.code, e.message, itemId])
    return e.code
  }
}

async function institutionName(instId?: string) {
  if (!instId) return null
  try { return (await plaid('/institutions/get_by_id', { institution_id: instId, country_codes: ['US'] })).institution.name } catch { return instId }
}

async function saveAccounts(itemId: string, institution: string | null, accounts: any[]) {
  for (const a of accounts) {
    const bal = a.balances || {}
    await upsertAccount({ account_id: a.account_id, item_id: itemId, source: 'plaid', institution, name: a.official_name || a.name, mask: a.mask ?? null,
      type: String(a.type), subtype: String(a.subtype || ''), balance: bal.current ?? null, available: bal.available ?? null,
      currency: bal.iso_currency_code || 'USD', updated_at: nowIso() })
  }
}

const titleWords = (s: string) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

async function syncTransactions(itemId: string, token: string, cursor: string | null) {
  let hasMore = true
  while (hasMore) {
    const args: Record<string, unknown> = { access_token: token, count: 500 }
    if (cursor) args.cursor = cursor
    const r = await plaid('/transactions/sync', args)
    await transaction(async (tx) => {
      for (const t of [...r.added, ...r.modified]) {
        const pfc = t.personal_finance_category || {}
        const primary = pfc.primary || ''
        const cps = t.counterparties || []
        await upsertTxn({
          txn_id: t.transaction_id, account_id: t.account_id, date: String(t.date), name: t.merchant_name || t.name, amount: t.amount,
          category: titleWords(primary.replace(/_/g, ' ')), pending: t.pending ? 1 : 0, detailed: pfc.detailed ?? null, raw_primary: primary,
          source: 'plaid', txn_type: String(t.payment_channel || ''), counterparty: cps.length ? cps[0].name : null,
        }, tx)
      }
      for (const t of r.removed) await run('DELETE FROM transactions WHERE txn_id=?', [t.transaction_id], tx)
    })
    cursor = r.next_cursor; hasMore = r.has_more
  }
  await run('UPDATE items SET cursor=? WHERE item_id=?', [cursor, itemId])
}

// Investment-account cash movements kept as transactions (buys/sells stay inside the account).
const INV_CASH_SUBTYPES = new Set(['deposit', 'withdrawal', 'contribution', 'transfer', 'dividend', 'interest', 'qualified dividend',
  'non-qualified dividend', 'fee', 'account fee', 'management fee', 'distribution', 'tax withheld', 'rebalance'])

async function syncInvestmentTxns(token: string, days = 730) {
  const end = new Date().toISOString().slice(0, 10)
  const start = addDays(end, -days)
  let offset = 0, total: number | null = null
  while (total == null || offset < total) {
    const r = await plaid('/investments/transactions/get', { access_token: token, start_date: start, end_date: end, options: { count: 500, offset } })
    total = r.total_investment_transactions
    const batch = r.investment_transactions || []
    await transaction(async (tx) => {
      for (const t of batch) {
        const subtype = String(t.subtype || '')
        if (!['cash', 'fee', 'transfer'].includes(String(t.type)) && !INV_CASH_SUBTYPES.has(subtype)) continue
        await upsertTxn({
          txn_id: `inv-${t.investment_transaction_id}`, account_id: t.account_id, date: String(t.date), name: t.name || titleWords(subtype),
          amount: t.amount, category: titleWords(subtype), pending: 0, detailed: `INVESTMENT_${subtype.toUpperCase().replace(/ /g, '_')}`,
          raw_primary: 'INVESTMENT', source: 'plaid_inv', txn_type: subtype,
        }, tx)
      }
    })
    if (!batch.length) break
    offset += batch.length
  }
}

async function syncHoldings(token: string) {
  const r = await plaid('/investments/holdings/get', { access_token: token })
  const secs = new Map((r.securities || []).map((s: any) => [s.security_id, s]))
  const accountIds = new Set([...(r.holdings || []).map((h: any) => h.account_id), ...(r.accounts || []).map((a: any) => a.account_id)])
  await transaction(async (tx) => {
    for (const aid of accountIds) await run('DELETE FROM holdings WHERE account_id=?', [aid], tx)
    for (const h of r.holdings || []) {
      const s: any = secs.get(h.security_id) || {}
      await run(`INSERT INTO holdings VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id, security_id) DO UPDATE SET
          ticker=excluded.ticker, name=excluded.name, quantity=excluded.quantity, price=excluded.price, value=excluded.value, cost_basis=excluded.cost_basis`,
        [h.account_id, h.security_id, s.ticker_symbol ?? null, s.name ?? null, h.quantity, h.institution_price ?? null, h.institution_value ?? null, h.cost_basis ?? null], tx)
    }
  })
}

async function syncLiabilities(token: string) {
  const r = (await plaid('/liabilities/get', { access_token: token })).liabilities || {}
  const upsert = `INSERT INTO liabilities VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET kind=excluded.kind, apr=excluded.apr,
      min_payment=excluded.min_payment, next_due=excluded.next_due, last_statement=excluded.last_statement, extra=excluded.extra`
  for (const cr of r.credit || []) {
    const aprs = (cr.aprs || []).filter((a: any) => a.apr_type === 'purchase_apr').map((a: any) => a.apr_percentage)
    await run(upsert, [cr.account_id, 'credit', aprs.length ? aprs[0] : null, cr.minimum_payment_amount ?? null, String(cr.next_payment_due_date || ''), cr.last_statement_balance ?? null, null])
  }
  for (const m of r.mortgage || []) {
    const extra = { escrow: m.escrow_balance ?? null, maturity: String(m.maturity_date || ''), ytd_principal: m.ytd_principal_paid ?? null, ytd_interest: m.ytd_interest_paid ?? null }
    await run(upsert, [m.account_id, 'mortgage', m.interest_rate?.percentage ?? null, m.next_monthly_payment ?? null, String(m.next_payment_due_date || ''), m.last_payment_amount ?? null, JSON.stringify(extra)])
  }
}

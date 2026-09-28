// Finance Hub API: the same /api/... endpoints as the original Flask app, as one Supabase edge function.
//
// Who can call it: only the owner's signed-in Supabase session (checked against OWNER_EMAIL), or the
// daily scheduler (x-cron-secret header). Everything else gets 401.
import { createClient } from 'npm:@supabase/supabase-js@2.105.0'
import { all, clearMetaCache, getJson, getMeta, one, run, setJson, setMeta } from './lib/db.ts'
import { HttpError, bad, isIsoDate, num, round, today } from './lib/util.ts'
import * as analytics from './lib/analytics.ts'
import * as classify from './lib/classify.ts'
import * as home from './lib/home.ts'
import * as insights from './lib/insights.ts'
import * as manual from './lib/manual.ts'
import * as mortgage from './lib/mortgage.ts'
import * as planning from './lib/planning.ts'
import * as plaid from './lib/plaid.ts'

const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean)
const OWNER = (Deno.env.get('OWNER_EMAIL') || '').toLowerCase()
const CRON_SECRET = Deno.env.get('CRON_SECRET') || ''
const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } })

const okTokens = new Map<string, number>() // access token -> checked until (ms), avoids an auth round trip per request

async function isOwner(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token || !OWNER) return false
  const until = okTokens.get(token)
  if (until && until > Date.now()) return true
  const { data, error } = await auth.auth.getUser(token)
  if (error || !data.user || (data.user.email || '').toLowerCase() !== OWNER) return false
  okTokens.set(token, Date.now() + 60_000)
  if (okTokens.size > 50) okTokens.delete(okTokens.keys().next().value!)
  return true
}

const cronOk = (req: Request) => !!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0] || '',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Vary': 'Origin',
  }
}

type Ctx = { req: Request; q: URLSearchParams; params: string[]; body: () => Promise<any> }
type Handler = (c: Ctx) => Promise<unknown>
const routes: [string, RegExp, Handler][] = []
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp('^' + path.replace(/<path>/g, '(.+)').replace(/<[^>]+>/g, '([^/]+)') + '$'), h])

const rangeArgs = (q: URLSearchParams) => ({
  start: q.get('start') || null, end: q.get('end') || null,
  accounts: (q.get('accounts') || '').split(',').filter(Boolean),
})
const numOr = (v: unknown, msg: string) => { try { return num(v) } catch { throw bad(msg) } }

// Timestamps like SQLite's datetime('now'): UTC 'YYYY-MM-DD HH:MM:SS'
const SQL_NOW = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')"

const ASSET_TYPES = new Set(['depository', 'investment', 'other'])
const DEBT_TYPES = new Set(['credit', 'loan'])
const FLOWS = new Set(['spend', 'income', 'refund', 'transfer', 'growth', 'ignore'])
const GOAL_TYPES = new Set(['emergency', 'roth', 'investing', 'mortgage', 'custom'])

// ---------- data ----------

route('GET', '/summary', async () => {
  const accounts = await all(`SELECT a.*, l.kind AS liab_kind, l.apr, l.min_payment, l.next_due, l.last_statement,
      i.status AS item_status, i.error AS item_error
    FROM accounts a LEFT JOIN liabilities l ON l.account_id = a.account_id LEFT JOIN items i ON i.item_id = a.item_id
    ORDER BY a.institution, a.name`)
  const holdings = await all('SELECT * FROM holdings WHERE value IS NOT NULL ORDER BY value DESC')
  const items = await all('SELECT item_id, institution, status, error, products, last_synced FROM items')
  const review = await one('SELECT COUNT(*) AS n FROM txn_class WHERE review=1')
  const thisMonth = (await analytics.cashflow(`${today().slice(0, 7)}-01`)).total
  let assets = accounts.filter((a) => ASSET_TYPES.has(a.type)).reduce((s, a) => s + (a.balance || 0), 0)
  let debts = accounts.filter((a) => DEBT_TYPES.has(a.type)).reduce((s, a) => s + (a.balance || 0), 0)
  const hp = await analytics.homePosition()
  let homeOut = null
  if (hp) {
    assets += hp.home_value; debts += hp.mortgage
    homeOut = { home_value: hp.home_value, mortgage: hp.mortgage, equity: hp.equity, mortgage_linked: hp.mortgage_linked }
  }
  return { net_worth: assets - debts, assets, debts, home: homeOut, this_month: thisMonth, review_count: review!.n,
    accounts, holdings, items, last_sync: await getMeta('last_sync'), env: plaid.ENV, history_start: await analytics.historyStart(), cloud: true }
})

route('POST', '/sync', async () => ({ results: await plaid.syncAll() }))

route('POST', '/link_token', async (c) => {
  const b = (await c.body()) || {}
  try { return { link_token: await plaid.createLinkToken(b.kind || 'bank', b.item_id) } }
  catch (e) { if (e instanceof plaid.PlaidError) throw bad(`${e.code}: ${e.message}`); throw e }
})

route('POST', '/exchange', async (c) => {
  const b = await c.body()
  if (b.item_id) { await plaid.markItemFixed(b.item_id); return { ok: true } }
  try { return { ok: true, item_id: await plaid.savePublicToken(b.public_token, b.institution) } }
  catch (e) { if (e instanceof plaid.PlaidError) throw bad(`${e.code}: ${e.message}`); throw e }
})

route('POST', '/venmo', async (c) => {
  const form = await c.req.formData()
  const f = form.get('file')
  if (!(f instanceof File)) throw bad('No file uploaded.')
  try { return { imported: await manual.importVenmoCsv(new Uint8Array(await f.arrayBuffer())) } }
  catch (e) { throw bad((e as Error).message) }
})

route('POST', '/import/wealthfront', async () => {
  throw bad('Statement PDF import is only available in the Mac version of the app.')
})

route('POST', '/manual', async (c) => {
  const b = await c.body()
  const balance = numOr(b.balance, 'Balance must be a number.')
  if (!ASSET_TYPES.has(b.type) && !DEBT_TYPES.has(b.type)) throw bad('Bad account type.')
  return { ok: true, account_id: await manual.upsertManual(b.name || 'Account', b.institution || '', b.type, balance, b.account_id) }
})
route('DELETE', '/manual/<id>', async (c) => { await manual.deleteManual(c.params[0]); return { ok: true } })

// ---------- analytics ----------

route('GET', '/cashflow', async (c) => {
  const group = c.q.get('group') || 'month'
  if (!(group in analytics.PERIODS)) throw bad('bad group')
  const r = rangeArgs(c.q)
  return await analytics.cashflow(r.start, r.end, group, r.accounts)
})
route('GET', '/categories', async (c) => { const r = rangeArgs(c.q); return await analytics.byCategory(r.start, r.end, r.accounts, c.q.get('flow') || 'spend') })
route('GET', '/by_account', async (c) => { const r = rangeArgs(c.q); return await analytics.byAccount(r.start, r.end) })
route('GET', '/networth_history', async () => await analytics.networthHistory())
route('GET', '/investments', async (c) => { const r = rangeArgs(c.q); return await analytics.investments(r.start, r.end, r.accounts) })
route('GET', '/merchants', async (c) => { const r = rangeArgs(c.q); return await analytics.topMerchants(r.start, r.end, r.accounts) })
route('GET', '/coverage', async () => await analytics.dataCoverage())

// ---------- transactions ----------

async function txnFilter(q: URLSearchParams): Promise<[string, unknown[]]> {
  let [w, args] = await analytics.where(q.get('start'), q.get('end'), (q.get('accounts') || '').split(',').filter(Boolean))
  const flows = (q.get('flows') || q.get('flow') || '').split(',').filter(Boolean)
  if (flows.length) { w += ` AND k.flow IN (${flows.map(() => '?').join(',')})`; args.push(...flows) }
  if (q.get('category')) { w += ' AND k.category = ?'; args.push(q.get('category')) }
  if (q.get('name')) { w += ' AND lower(t.name) = ?'; args.push(q.get('name')!.toLowerCase()) }
  if (q.get('review') === '1') w += ' AND k.review = 1'
  if (q.get('invested') === '1') w += ` AND (${analytics.INVESTED}) != 0`
  if (q.get('q')) {
    const s = q.get('q')!.trim().toLowerCase()
    const cleaned = s.replace(/\$/g, '').replace(/,/g, '')
    const amt = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? parseFloat(cleaned) : null
    if (amt != null) { w += ' AND (lower(t.name) LIKE ? OR ABS(ABS(t.amount) - ?) < 0.5)'; args.push(`%${s}%`, amt) }
    else { w += ' AND (lower(t.name) LIKE ? OR lower(k.category) LIKE ?)'; args.push(`%${s}%`, `%${s}%`) }
  }
  return [w, args]
}

route('GET', '/transactions', async (c) => {
  const [w, args] = await txnFilter(c.q)
  const limit = Math.min(parseInt(c.q.get('limit') || '200'), 2000)
  const offset = parseInt(c.q.get('offset') || '0')
  const t = await one(`SELECT COUNT(*) AS n,
      COALESCE(ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2), 0) AS money_out,
      COALESCE(ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2), 0) AS money_in,
      COALESCE(ROUND(SUM(CASE WHEN k.flow='spend' THEN ${analytics.SPEND_AMT} WHEN k.flow='refund' THEN t.amount ELSE 0 END), 2), 0) AS net_spend,
      COALESCE(ROUND(SUM(COALESCE(m.extra, 0)), 2), 0) AS extra_principal,
      COALESCE(ROUND(SUM(${analytics.INVESTED}), 2), 0) AS invested
      ${analytics.FROM} WHERE ${w}`, args)
  const rows = await all(`SELECT t.txn_id, t.date, t.name, t.amount, t.pending, t.account_id,
      a.institution, a.name AS account_name, k.flow, k.kind, k.category, k.review, k.reason, k.pair_id,
      o.note, COALESCE(m.extra, 0) AS extra_principal
      ${analytics.FROM} LEFT JOIN txn_overrides o ON o.txn_id=t.txn_id
      WHERE ${w} ORDER BY t.date DESC, t.txn_id LIMIT ? OFFSET ?`, [...args, limit, offset])
  return { total: t!.n, totals: t, rows }
})

route('GET', '/transactions/charts', async (c) => {
  let [w, args] = await txnFilter(c.q)
  const measure = (c.q.get('flows') || c.q.get('flow')) === 'income' ? 'income' : 'spend'
  let amt: string
  if (measure === 'income') { w += " AND k.flow='income'"; amt = '-t.amount' } else { w += " AND k.flow IN ('spend','refund')"; amt = analytics.SPEND_AMT }
  const qq = (s: string) => all(s.replaceAll('{amt}', amt).replaceAll('{FROM}', analytics.FROM).replaceAll('{where}', w), args)
  return {
    measure,
    by_month: await qq('SELECT substr(t.date,1,7) AS month, k.category, ROUND(SUM({amt}),2) AS amount {FROM} WHERE {where} GROUP BY 1,2 ORDER BY 1,2'),
    categories: await qq('SELECT k.category, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n {FROM} WHERE {where} GROUP BY 1 HAVING SUM({amt}) != 0 ORDER BY 2 DESC, 1'),
    merchants: await qq('SELECT MIN(t.name) AS name, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n {FROM} WHERE {where} GROUP BY lower(t.name) HAVING SUM({amt}) > 0 ORDER BY 2 DESC LIMIT 15'),
    daily: await qq('SELECT t.date, ROUND(SUM({amt}),2) AS amount, COUNT(*) AS n {FROM} WHERE {where} GROUP BY 1 ORDER BY 1'),
  }
})

route('PATCH', '/transactions/<id>', async (c) => {
  const b = (await c.body()) || {}
  if (b.flow && !FLOWS.has(b.flow)) throw bad('bad flow')
  if (b.clear) await run('DELETE FROM txn_overrides WHERE txn_id=?', [c.params[0]])
  else await run(`INSERT INTO txn_overrides(txn_id, flow, category, note, updated_at) VALUES (?,?,?,?,${SQL_NOW})
      ON CONFLICT(txn_id) DO UPDATE SET flow=excluded.flow, category=excluded.category, note=excluded.note, updated_at=excluded.updated_at`,
    [c.params[0], b.flow || null, b.category || null, b.note || null])
  await classify.run()
  return { ok: true }
})

route('GET', '/categories/all', async () => {
  const used = (await all('SELECT DISTINCT category FROM txn_class WHERE category IS NOT NULL')).map((r) => r.category)
  return [...new Set([...used, ...Object.values(classify.CATEGORY_NAMES), 'Housing', 'Groceries', 'Subscriptions'])].sort()
})

route('GET', '/rules', async () => await all('SELECT * FROM rules ORDER BY id DESC'))
route('POST', '/rules', async (c) => {
  const b = (await c.body()) || {}
  if (!(b.pattern || '').trim()) throw bad('Pattern is required.')
  if (b.set_flow && !FLOWS.has(b.set_flow)) throw bad('bad flow')
  await run(`INSERT INTO rules(pattern, account_id, direction, set_flow, set_category, created_at) VALUES (?,?,?,?,?,${SQL_NOW})`,
    [b.pattern.trim(), b.account_id || null, b.direction || null, b.set_flow || null, b.set_category || null])
  await classify.run()
  return await all('SELECT * FROM rules ORDER BY id DESC')
})
route('DELETE', '/rules/<id>', async (c) => { await run('DELETE FROM rules WHERE id=?', [parseInt(c.params[0])]); await classify.run(); return { ok: true } })

// ---------- income ----------

route('GET', '/income', async () => await analytics.incomeCheck())
route('PUT', '/income', async (c) => {
  const b = (await c.body()) || {}
  const n = (key: string, required = false) => {
    const v = String(b[key] ?? '').replace(/[,$%]/g, '').trim()
    if (!v) { if (required) throw new Error(key); return null }
    return num(v)
  }
  let cfg: any
  try {
    cfg = { gross_annual: n('gross_annual', true), net_per_paycheck: n('net_per_paycheck', true), retirement_pct: n('retirement_pct') || 0, employer_match_pct: n('employer_match_pct') || 0 }
  } catch { throw bad('Salary and take-home per paycheck are required, and every field must be a number.') }
  const freq = b.pay_frequency || 'biweekly'
  if (!(freq in analytics.PERIODS_PER_YEAR)) throw bad('bad pay frequency')
  Object.assign(cfg, { pay_frequency: freq, employer: (b.employer || '').trim(), match_notes: (b.match_notes || '').trim(), notes: (b.notes || '').trim() })
  cfg.annual_net = round(cfg.net_per_paycheck * analytics.PERIODS_PER_YEAR[freq], 2)
  const old: any = (await getJson('income', {})) || {}
  cfg.history = old.history || []
  cfg.effective = (b.effective || old.effective || '').trim() || null
  await setJson('income', cfg)
  return await analytics.incomeCheck()
})
route('POST', '/income/history', async (c) => {
  const b = (await c.body()) || {}
  let entry: any
  try {
    if (!isIsoDate(b.effective)) throw new Error('date')
    entry = { effective: b.effective, gross_annual: num(b.gross_annual), net_per_paycheck: num(b.net_per_paycheck),
      retirement_pct: Number(b.retirement_pct || 0), employer_match_pct: Number(b.employer_match_pct || 0), pay_frequency: b.pay_frequency || 'biweekly' }
  } catch { throw bad('Start date, salary, and take-home per paycheck are required.') }
  const cfg: any = (await getJson('income', {})) || {}
  cfg.history = [...(cfg.history || []).filter((h: any) => h.effective !== entry.effective), entry].sort((a: any, b: any) => (a.effective < b.effective ? -1 : 1))
  await setJson('income', cfg)
  return await analytics.incomeCheck()
})
route('DELETE', '/income/history/<d>', async (c) => {
  const cfg: any = (await getJson('income', {})) || {}
  cfg.history = (cfg.history || []).filter((h: any) => h.effective !== c.params[0])
  await setJson('income', cfg)
  return await analytics.incomeCheck()
})

// ---------- mortgage ----------

route('GET', '/mortgage', async (c) => {
  const extra = Number(c.q.get('extra') || 0) || 0
  return (await mortgage.summary(Math.max(extra, 0))) || { config: null }
})
route('PUT', '/mortgage', async (c) => {
  const cfg = await mortgage.getConfig()
  if (!cfg) throw bad('No mortgage set up.')
  const b = (await c.body()) || {}
  for (const k of ['escrow_monthly', 'pmi_monthly', 'current_value']) {
    if (k in b) cfg[k] = String(b[k]).trim() ? numOr(b[k], 'Amounts must be numbers.') : null
  }
  await mortgage.saveConfig(cfg)
  mortgage.clearCache()
  await classify.run()
  return await mortgage.summary()
})
route('POST', '/mortgage/checkpoints', async (c) => {
  const cfg = await mortgage.getConfig()
  const b = (await c.body()) || {}
  if (!isIsoDate(b.date)) throw bad('Enter the statement date and the principal balance.')
  const cp = { date: b.date, balance: numOr(b.balance, 'Enter the statement date and the principal balance.') }
  cfg.checkpoints = [...(cfg.checkpoints || []).filter((x: any) => x.date !== cp.date), cp]
  await mortgage.saveConfig(cfg)
  mortgage.clearCache()
  return await mortgage.summary()
})
route('DELETE', '/mortgage/checkpoints/<d>', async (c) => {
  const cfg = await mortgage.getConfig()
  cfg.checkpoints = (cfg.checkpoints || []).filter((x: any) => x.date !== c.params[0])
  await mortgage.saveConfig(cfg)
  mortgage.clearCache()
  return await mortgage.summary()
})
route('GET', '/home_value', async (c) => {
  if (c.q.get('refresh')) await home.index(true)
  return await home.estimate(await mortgage.getConfig())
})

// ---------- budgets, goals, windfalls ----------

route('GET', '/budget', async (c) => await planning.budgetMonth(c.q.get('month')))
route('PUT', '/budget', async (c) => {
  const b = (await c.body()) || {}
  const values: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(b)) values[k] = v == null || v === '' ? null : numOr(v, 'Budgets must be numbers.')
  await planning.setBudgets(values)
  return await planning.budgetMonth(c.q.get('month'))
})
route('POST', '/budget/suggest', async (c) => {
  const current = await planning.getBudgets()
  const sugg = await planning.suggestions()
  await planning.setBudgets(Object.fromEntries(Object.entries(sugg).filter(([k]) => !(k in current)).map(([k, v]: any) => [k, v.suggested])))
  return await planning.budgetMonth(c.q.get('month'))
})

route('GET', '/goals', async () => await planning.goalsWithProgress())
route('POST', '/goals', async (c) => {
  const b = (await c.body()) || {}
  if (!GOAL_TYPES.has(b.type) || !(b.name || '').trim()) throw bad('Pick a goal type and give it a name.')
  let target: number | null = null
  try {
    target = String(b.target ?? '').trim() ? num(b.target) : null
    if (b.target_date && !isIsoDate(b.target_date)) throw new Error('date')
  } catch { throw bad('Target must be a number and the date must be valid.') }
  if (['roth', 'investing', 'custom'].includes(b.type) && !target) throw bad('This goal needs a target amount.')
  await planning.saveGoal({ id: b.id, type: b.type, name: b.name.trim(), target, target_date: b.target_date, config: b.config || {} })
  return await planning.goalsWithProgress()
})
route('DELETE', '/goals/<id>', async (c) => { await planning.archiveGoal(c.params[0]); return await planning.goalsWithProgress() })
route('POST', '/goals/<id>/contribute', async (c) => {
  const b = (await c.body()) || {}
  const amt = numOr(b.amount, 'Amount must be a number.')
  await planning.addContribution(c.params[0], amt, b.date, b.note)
  return await planning.goalsWithProgress()
})
route('GET', '/windfalls', async () => await planning.windfalls())
route('PUT', '/windfalls/split', async (c) => {
  let split = ((await c.body()) || {}).split || []
  try { split = split.filter((s: any) => Number(s.pct || 0) > 0).map((s: any) => { if (!s.target || Number.isNaN(Number(s.pct))) throw new Error(); return { target: s.target, pct: Number(s.pct) } }) }
  catch { throw bad('Each part needs a goal and a percent.') }
  if (Math.abs(split.reduce((s: number, x: any) => s + x.pct, 0) - 100) > 0.5) throw bad('The split has to add up to 100%.')
  await setJson('windfall_split', split)
  return await planning.windfalls()
})
route('POST', '/windfalls/<id>/plan', async (c) => { await planning.planWindfall(c.params[0], ((await c.body()) || {}).plan || []); return await planning.windfalls() })
route('DELETE', '/windfalls/<id>', async (c) => { await planning.dismissWindfall(c.params[0]); return await planning.windfalls() })
route('POST', '/transactions/<id>/windfall', async (c) => { await planning.markWindfall(c.params[0], ((await c.body()) || {}).label); return { ok: true } })

// ---------- recurring, forecast, taxes, plan, recap, alerts ----------

route('GET', '/recurring', async () => await insights.recurringSummary())
route('POST', '/recurring/dismiss', async (c) => {
  const b = (await c.body()) || {}
  if (!b.key) throw bad('key required')
  await insights.dismissRecurring(b.key, !!b.undo)
  return { ok: true }
})
route('GET', '/forecast', async (c) => await insights.forecast(Math.max(7, Math.min(parseInt(c.q.get('days') || '60'), 120))))
route('PUT', '/forecast/low', async (c) => {
  const v = Number(((await c.body()) || {}).low)
  if (!Number.isFinite(v)) throw bad('Enter a dollar amount.')
  await setMeta('forecast_low', String(Math.max(v, 0)))
  return { ok: true }
})
route('GET', '/taxes', async (c) => await insights.taxYear(c.q.get('year')))
route('PUT', '/taxes/limits', async (c) => {
  const b = (await c.body()) || {}
  const year = parseInt(b.year)
  const opt = (v: any) => (v == null || v === '' ? null : Number(v))
  const k401 = opt(b.k401), ira = opt(b.ira)
  if (!year || (k401 != null && Number.isNaN(k401)) || (ira != null && Number.isNaN(ira))) throw bad('Enter the limits as dollar amounts.')
  await insights.setTaxLimits(year, k401, ira)
  return { ok: true }
})
route('GET', '/plan', async () => await insights.planInputs())
route('PUT', '/plan', async (c) => { await insights.savePlanSettings((await c.body()) || {}); return await insights.planInputs() })
route('GET', '/recap', async (c) => await insights.recap(c.q.get('month')))
route('GET', '/alerts', async () => await insights.alerts())
route('POST', '/alerts/<path>/dismiss', async (c) => { await insights.dismissAlert(decodeURIComponent(c.params[0])); return { ok: true } })

// ---------- scheduler (pg_cron, every 30 minutes) ----------

async function cron() {
  const last = await getMeta('last_sync')
  const every = Number(Deno.env.get('SYNC_EVERY_HOURS') || '24') * 3600e3
  if (!last || Date.now() - new Date(last).getTime() >= every) return { full: await plaid.syncAll() }
  return { recent: await plaid.syncRecentlyLinked() }
}

// ---------- server ----------

Deno.serve(async (req) => {
  const headers = cors(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const url = new URL(req.url)
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/'
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
  clearMetaCache(); mortgage.clearCache()
  try {
    if (path === '/cron' && req.method === 'POST') {
      if (!cronOk(req)) return json({ error: 'locked' }, 401)
      return json(await cron())
    }
    if (!(await isOwner(req))) return json({ error: 'locked' }, 401)
    let cached: any
    const ctx: Ctx = { req, q: url.searchParams, params: [], body: async () => (cached ??= await req.json().catch(() => ({}))) }
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue
      const m = path.match(re)
      if (!m) continue
      ctx.params = m.slice(1).map(decodeURIComponent)
      return json(await h(ctx))
    }
    return json({ error: 'not found' }, 404)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    console.error(e)
    return json({ error: 'Something went wrong on the server. Try again in a minute.' }, 500)
  }
})

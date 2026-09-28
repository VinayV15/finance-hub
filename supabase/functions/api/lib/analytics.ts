// Numbers for the dashboards (port of analytics.py). Everything reads classified transactions (classify.ts),
// so transfers between your own accounts never show up as spending or income.
import { all, getJson, getMeta, one, scalar } from './db.ts'
import { addDays, diffDays, median, parts, round, sum, today } from './util.ts'
import * as mortgage from './mortgage.ts'

export const PERIODS: Record<string, string> = {
  day: 't.date',
  week: "to_char(date_trunc('week', t.date::date), 'YYYY-MM-DD')", // week starting Monday
  month: 'substr(t.date, 1, 7)',
  quarter: "substr(t.date,1,4) || '-Q' || ((cast(substr(t.date,6,2) as integer) + 2) / 3)",
  year: 'substr(t.date, 1, 4)',
}

/** Earliest date shown anywhere (older data is kept for transfer matching but hidden). */
export const historyStart = () => getMeta('history_start')

export async function where(start?: string | null, end?: string | null, accounts?: string[] | null, extra = ''): Promise<[string, unknown[]]> {
  const sqlParts = ['1=1'], args: unknown[] = []
  const floor = await historyStart()
  if (floor && (!start || start < floor)) start = floor
  if (start) { sqlParts.push('t.date >= ?'); args.push(start) }
  if (end) { sqlParts.push('t.date <= ?'); args.push(end) }
  if (accounts && accounts.length) { sqlParts.push(`t.account_id IN (${accounts.map(() => '?').join(',')})`); args.push(...accounts) }
  if (extra) sqlParts.push(extra)
  return [sqlParts.join(' AND '), args]
}

// Money into an investment account = invested. Counted once, on the investment account's side, and moves
// between two of your investment accounts (e.g. brokerage -> Roth) don't count as new investing. Bank-side rows
// only count when no investment account received them (an investment account that isn't linked).
const INV_EXTERNAL = "COALESCE(ap.type, '') != 'investment'"
export const INVESTED = `CASE
    WHEN k.kind='invest_contribution' AND a.type='investment' AND t.amount<0 AND ${INV_EXTERNAL} THEN -t.amount
    WHEN k.kind='invest_withdrawal' AND a.type='investment' AND t.amount>0 AND ${INV_EXTERNAL} THEN -t.amount
    WHEN k.kind='invest_contribution' AND a.type!='investment' AND t.amount>0 AND k.pair_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.type='investment') THEN t.amount
    ELSE 0 END`
const INVESTED_ROTH = `CASE WHEN lower(COALESCE(a.subtype,'')) LIKE '%roth%' AND k.kind='invest_contribution'
    AND t.amount<0 THEN -t.amount ELSE 0 END`

export const SELECT_TOTALS = `
    ROUND(SUM(CASE WHEN k.flow='income' THEN -t.amount ELSE 0 END), 2) AS income,
    ROUND(SUM(CASE WHEN k.flow='spend' THEN t.amount - COALESCE(m.extra, 0) ELSE 0 END), 2) AS spend_gross,
    ROUND(SUM(CASE WHEN k.flow='refund' THEN -t.amount ELSE 0 END), 2) AS refunds,
    ROUND(SUM(${INVESTED}), 2) AS invested,
    ROUND(SUM(${INVESTED_ROTH}), 2) AS invested_roth,
    ROUND(SUM(CASE WHEN lower(COALESCE(a.subtype,'')) LIKE '%roth%' THEN 0 ELSE ${INVESTED} END), 2) AS invested_other,
    ROUND(SUM(COALESCE(m.extra, 0)), 2) AS extra_principal,
    ROUND(SUM(CASE WHEN k.flow='growth' THEN -t.amount ELSE 0 END), 2) AS growth,
    ROUND(SUM(CASE WHEN k.kind IN ('paycheck','paycheck_bonus') THEN -t.amount ELSE 0 END), 2) AS paychecks`

export const FROM = `FROM transactions t JOIN txn_class k USING(txn_id) LEFT JOIN accounts a ON a.account_id=t.account_id
    LEFT JOIN mortgage_alloc m ON m.txn_id=t.txn_id
    LEFT JOIN transactions tp ON tp.txn_id=k.pair_id LEFT JOIN accounts ap ON ap.account_id=tp.account_id`

// Spending amount of a row: extra mortgage principal is saving (it becomes equity), not spending.
export const SPEND_AMT = '(t.amount - COALESCE(m.extra, 0))'

export function finish(row: Record<string, any>) {
  const r = { ...row }
  r.spend = round((r.spend_gross || 0) - (r.refunds || 0), 2)
  r.saved = round((r.income || 0) - r.spend, 2)
  r.savings_rate = r.income ? round(r.saved / r.income, 4) : null
  return r
}

export async function cashflow(start?: string | null, end?: string | null, group = 'month', accounts?: string[] | null) {
  const [w, args] = await where(start, end, accounts)
  const rows = await all(`SELECT ${PERIODS[group]} AS period, ${SELECT_TOTALS} ${FROM} WHERE ${w} GROUP BY period ORDER BY period`, args)
  const totalRow = await one(`SELECT ${SELECT_TOTALS} ${FROM} WHERE ${w}`, args)
  const periods = rows.map(finish)
  // 401(k) never hits a bank account, so it's estimated from paychecks (only when viewing all accounts).
  const ret = !accounts?.length ? await retirementByPeriod(start, end, group) : {}
  for (const p of periods) p.retirement = ret[p.period] ?? 0
  const total = finish(totalRow || {})
  total.retirement = round(sum(Object.values(ret)), 2)
  total.months = await scalar(`SELECT COUNT(DISTINCT substr(t.date,1,7)) ${FROM} WHERE ${w}`, args)
  return { periods, total }
}

// ---------- your home ----------

export async function homePosition() {
  let m
  try { m = await mortgage.summary() } catch { return null }
  if (!m) return null
  const linked = await one("SELECT 1 FROM accounts WHERE type='loan' AND lower(COALESCE(subtype,''))='mortgage'")
  const cfg = m.config
  return {
    home_value: m.home_value, mortgage: linked ? 0 : m.balance, mortgage_linked: !!linked,
    equity: m.equity, closing_date: cfg.closing_date, original_amount: cfg.original_amount,
    schedule: m.actual.filter((r: any) => !r.projected).map((r: any) => [r.date, r.balance] as [string, number]),
  }
}

function mortgageOn(home: any, day: string) {
  if (!home || !home.closing_date || day < home.closing_date) return null
  const past = home.schedule.filter(([d]: [string, number]) => d <= day).map(([, b]: [string, number]) => b)
  return past.length ? past[past.length - 1] : home.original_amount
}

// ---------- net worth over time ----------

export async function networthHistory(weeks = 52) {
  const t0 = today()
  const floor = await historyStart()
  let days: string[] = []
  for (let w = weeks; w > 0; w--) days.push(addDays(t0, -7 * w))
  days.push(t0)
  days = days.filter((d) => !floor || d >= floor)
  const accts = await all('SELECT account_id, type, balance FROM accounts WHERE balance IS NOT NULL')
  const txns = new Map<string, [string, number][]>()
  for (const r of await all('SELECT account_id, date, amount FROM transactions WHERE pending=0 ORDER BY date')) {
    if (!txns.has(r.account_id)) txns.set(r.account_id, [])
    txns.get(r.account_id)!.push([r.date, r.amount])
  }
  const snaps = new Map<string, [string, number][]>()
  for (const r of await all('SELECT account_id, date, balance FROM balance_snapshots ORDER BY date')) {
    if (!snaps.has(r.account_id)) snaps.set(r.account_id, [])
    snaps.get(r.account_id)!.push([r.date, r.balance])
  }
  const firsts = [...snaps.values()].filter((v) => v.length).map((v) => v[0][0])
  const firstSnap = firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null
  const home = await homePosition()
  const out = []
  for (const d of days) {
    let cash = 0, invested = 0, debts = 0
    for (const a of accts) {
      const movedAfter = sum((txns.get(a.account_id) || []).filter(([dt]) => dt > d).map(([, amt]) => amt)) // + = money out
      if (a.type === 'credit' || a.type === 'loan') { debts += a.balance - movedAfter; continue }
      if (a.type === 'investment') {
        const s = (snaps.get(a.account_id) || []).filter(([dt]) => dt <= d).map(([, b]) => b)
        invested += s.length ? s[s.length - 1] : a.balance + movedAfter
        continue
      }
      cash += a.balance + movedAfter
    }
    const owed = mortgageOn(home, d)
    let equity = 0
    if (owed != null) equity = home!.home_value - (!home!.mortgage_linked ? owed : 0)
    out.push({ date: d, cash: round(cash, 2), invested: round(invested, 2), debts: round(debts, 2), home_equity: round(equity, 2),
      net_worth: round(cash + invested - debts + equity, 2), estimated: !firstSnap || d < firstSnap })
  }
  return { points: out, exact_from: firstSnap }
}

// ---------- investments ----------

async function snapshotOn(accountId: string, day: string): Promise<[string | null, number | null]> {
  const r = await one('SELECT date, balance FROM balance_snapshots WHERE account_id=? AND date<=? ORDER BY date DESC LIMIT 1', [accountId, day])
  return r ? [r.date, r.balance] : [null, null]
}

export async function investments(start?: string | null, end?: string | null, accounts?: string[] | null) {
  const t0 = today()
  const [w, args] = await where(start, end, null, "a.type='investment'")
  let accts = await all(`SELECT a.account_id, a.institution, a.name, a.subtype, a.balance AS value,
      (SELECT SUM(h.cost_basis) FROM holdings h WHERE h.account_id=a.account_id) AS cost_basis
    FROM accounts a WHERE a.type='investment' ORDER BY a.balance DESC`)
  if (accounts?.length) accts = accts.filter((a) => accounts.includes(a.account_id))
  const flows = new Map((await all(`SELECT t.account_id,
      ROUND(SUM(${INVESTED}), 2) AS put_in,
      ROUND(SUM(CASE WHEN k.flow='growth' THEN -t.amount ELSE 0 END), 2) AS dividends,
      ROUND(SUM(CASE WHEN k.kind='invest_fee' THEN t.amount ELSE 0 END), 2) AS fees
    ${FROM} WHERE ${w} GROUP BY t.account_id ORDER BY 1`, args)).map((r) => [r.account_id, r]))
  const firstSnap = await scalar('SELECT MIN(date) FROM balance_snapshots')
  for (const a of accts) {
    const f: any = flows.get(a.account_id) || {}
    a.put_in = f.put_in || 0
    a.dividends = f.dividends || 0
    a.fees = f.fees || 0
    const sub = (a.subtype || '')
    a.kind = sub.toLowerCase().includes('roth') ? 'roth' : sub.includes('401') ? '401k' : sub.toLowerCase().includes('ira') ? 'ira' : 'brokerage'
    a.gain_all_time = a.cost_basis ? round(a.value - a.cost_basis, 2) : null
    a.gain_all_time_pct = a.cost_basis ? round(a.gain_all_time / a.cost_basis, 4) : null
    a.gain_range = null
    if (start) {
      const [sDay, sVal] = await snapshotOn(a.account_id, start)
      const [eDay, eVal] = !end || end >= t0 ? [t0, a.value] : await snapshotOn(a.account_id, end)
      if (sDay && eDay && eVal != null) {
        const moved = await scalar(`SELECT COALESCE(SUM(-t.amount), 0) FROM transactions t JOIN txn_class k USING(txn_id)
            WHERE t.account_id=? AND k.kind IN ('invest_contribution','invest_withdrawal')
            AND t.date > ? AND t.date <= ?`, [a.account_id, sDay, eDay])
        a.gain_range = round(eVal - (sVal as number) - moved, 2)
      }
    }
  }
  // 401(k) isn't linked yet: estimate from paychecks (all accounts view only), contributions with no market gains.
  let est: { value: number; put_in: number } | null = null
  if (!accounts?.length && !(await hasLinked401k())) {
    const allTime = sum(Object.values(await retirementByPeriod(null, null, 'year')))
    const inRange = sum(Object.values(await retirementByPeriod(start, end, 'year')))
    if (allTime) est = { value: round(allTime, 2), put_in: round(inRange, 2) }
  }
  const haveRange = accts.length > 0 && accts.every((a) => a.gain_range != null)
  const tot = (k: string) => round(sum(accts.map((a) => a[k] || 0)), 2)
  return {
    accounts: accts,
    retirement_estimate: est,
    total: {
      value: round(tot('value') + (est ? est.value : 0), 2),
      put_in: round(tot('put_in') + (est ? est.put_in : 0), 2),
      dividends: tot('dividends'), fees: tot('fees'),
      gain_all_time: tot('gain_all_time'),
      cost_basis: tot('cost_basis'),
      gain_range: haveRange ? tot('gain_range') : null,
    },
    tracking_since: firstSnap,
  }
}

export async function byCategory(start?: string | null, end?: string | null, accounts?: string[] | null, flow = 'spend') {
  const flows = flow === 'spend' ? ['spend', 'refund'] : ['income']
  const [w, args] = await where(start, end, accounts, `k.flow IN (${flows.map(() => '?').join(',')})`)
  args.push(...flows)
  const expr = flow === 'spend' ? SPEND_AMT : '-t.amount'
  return await all(`SELECT k.category, ROUND(SUM(${expr}), 2) AS amount, COUNT(*) AS n
      ${FROM} WHERE ${w} GROUP BY k.category HAVING SUM(${expr}) != 0 ORDER BY 2 DESC, 1`, args)
}

export async function byAccount(start?: string | null, end?: string | null) {
  const [w, args] = await where(start, end)
  const rows = await all(`SELECT a.account_id, a.institution, a.name, a.type, ${SELECT_TOTALS},
      ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount<0 THEN -t.amount ELSE 0 END), 2) AS transfers_in,
      ROUND(SUM(CASE WHEN k.flow='transfer' AND t.amount>0 THEN t.amount ELSE 0 END), 2) AS transfers_out,
      ROUND(SUM(-t.amount), 2) AS net_change,
      a.balance, COUNT(*) AS n
      ${FROM} WHERE ${w} GROUP BY a.account_id ORDER BY a.institution, a.name`, args)
  return rows.map(finish)
}

export async function topMerchants(start?: string | null, end?: string | null, accounts?: string[] | null, limit = 15) {
  const [w, args] = await where(start, end, accounts, "k.flow IN ('spend','refund')")
  return await all(`SELECT MIN(t.name) AS name, ROUND(SUM(${SPEND_AMT}),2) AS amount, COUNT(*) AS n,
      ROUND(SUM(t.amount),2) AS paid, ROUND(SUM(COALESCE(m.extra,0)),2) AS extra_principal
      ${FROM} WHERE ${w} GROUP BY lower(t.name) HAVING SUM(${SPEND_AMT}) > 0 ORDER BY 2 DESC LIMIT ?`, [...args, limit])
}

export async function dataCoverage() {
  return await all(`SELECT a.account_id, a.institution, a.name, MIN(t.date) AS first, MAX(t.date) AS last,
      COUNT(t.txn_id) AS n FROM accounts a LEFT JOIN transactions t ON t.account_id=a.account_id
      GROUP BY a.account_id ORDER BY first NULLS FIRST`)
}

// ---------- income ----------

/** 'ACME PAYROLL 0YAVDY… JANE' / 'Acme - Payroll Deposit' -> 'ACME'. Leading words up to the first payroll-ish word. */
export function employerKey(name: string | null) {
  const stop = new Set(['PAYROLL', 'DEPOSIT', 'DIRECT', 'DEP', 'ACH', 'PAYMENTS', 'PMT', '-'])
  const out: string[] = []
  for (const w of (name || '').toUpperCase().split(',')[0].split(/\s+/).filter(Boolean)) {
    if (stop.has(w) || /\d/.test(w) || ((w === 'INSTANT' || w === 'FROM') && !out.length)) {
      if (out.length) break
      continue
    }
    out.push(w)
    if (out.length === 4) break
  }
  return out.join(' ') || 'Unknown'
}

function frequency(gaps: number[]): [string | null, number | null] {
  if (!gaps.length) return [null, null]
  const g = median(gaps)
  for (const [label, days, perYear] of [['weekly', 7, 52], ['biweekly', 14, 26], ['semimonthly', 15.2, 24], ['monthly', 30.4, 12]] as const) {
    if (Math.abs(g - days) <= 2.5) return [label, perYear]
  }
  return [`every ~${round(g)} days`, round(365 / g, 1)]
}

export async function detectedIncome() {
  const rows = await all(`SELECT t.date, t.name, -t.amount AS amount, a.institution, k.kind
      ${FROM} WHERE k.flow='income' AND k.kind IN ('paycheck','paycheck_bonus') AND t.date >= ?
      ORDER BY t.date`, [(await historyStart()) || ''])
  const byEmp = new Map<string, Map<string, number>>()
  const split = new Map<string, Set<string>>()
  const bonusDays = new Map<string, Set<string>>()
  for (const r of rows) {
    const k = employerKey(r.name)
    if (!byEmp.has(k)) { byEmp.set(k, new Map()); split.set(k, new Set()); bonusDays.set(k, new Set()) }
    byEmp.get(k)!.set(r.date, (byEmp.get(k)!.get(r.date) || 0) + r.amount)
    split.get(k)!.add(r.institution)
    if (r.kind === 'paycheck_bonus') bonusDays.get(k)!.add(r.date)
  }
  const t0 = today()
  const out = []
  for (const [emp, days] of byEmp) {
    const dates = [...days.keys()].sort()
    const amounts = dates.map((d) => days.get(d)!)
    const gaps = dates.slice(1).map((b, i) => diffDays(b, dates[i]))
    const [freq, perYear] = frequency(gaps.slice(-8))
    const bd = bonusDays.get(emp)!
    const regular = dates.filter((d) => !bd.has(d)).map((d) => days.get(d)!)
    const recent = (regular.length ? regular : amounts).slice(-6)
    const lastDate = dates[dates.length - 1]
    const regMedian = (() => { const xs = dates.filter((x) => !bd.has(x)).map((x) => days.get(x)!).slice(-6); return median(xs.length ? xs : [0]) })()
    out.push({
      employer: emp,
      deposits: dates.length,
      first: dates[0], last: lastDate,
      active: diffDays(t0, lastDate) <= 45,
      frequency: freq,
      typical_paycheck: round(median(recent), 2),
      annualized: perYear ? round(median(recent) * perYear, 2) : null,
      last_12_months: round(sum(dates.filter((d) => d >= addDays(t0, -365)).map((d) => days.get(d)!)), 2),
      accounts: [...split.get(emp)!].filter(Boolean).sort(),
      history: dates.map((d) => ({ date: d, amount: round(days.get(d)!, 2) })),
      bonuses: [...bd].sort().map((d) => ({ date: d, total: round(days.get(d)!, 2), bonus: round(days.get(d)! - regMedian, 2) })),
    })
  }
  out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
  return out
}

export const PERIODS_PER_YEAR: Record<string, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

export async function payBreakdown(cfg?: any) {
  cfg = cfg !== undefined ? cfg : ((await getJson('income', {})) || {})
  const n = PERIODS_PER_YEAR[cfg.pay_frequency || 'biweekly'] ?? 26
  const grossAnnual = cfg.gross_annual, net = cfg.net_per_paycheck
  if (!grossAnnual || !net) return null
  const gross = grossAnnual / n
  const k401 = gross * (cfg.retirement_pct || 0) / 100
  const match = gross * (cfg.employer_match_pct || 0) / 100
  return {
    periods_per_year: n,
    per_paycheck: { gross: round(gross, 2), retirement: round(k401, 2), taxes_and_other: round(gross - k401 - net, 2), take_home: round(net, 2), employer_match: round(match, 2) },
    per_year: { gross: round(grossAnnual, 2), retirement: round(k401 * n, 2), taxes_and_other: round((gross - k401 - net) * n, 2), take_home: round(net * n, 2), employer_match: round(match * n, 2) },
    effective_tax_rate: gross ? round((gross - k401 - net) / gross, 4) : null,
  }
}

export async function payHistory() {
  const cfg: any = (await getJson('income', {})) || {}
  const past = [...(cfg.history || [])].sort((a: any, b: any) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0))
  const current: any = {}
  for (const k of ['gross_annual', 'net_per_paycheck', 'retirement_pct', 'employer_match_pct', 'pay_frequency']) current[k] = cfg[k] ?? null
  current.effective = cfg.effective || (past.length ? past[past.length - 1].effective : '0000-01-01')
  return cfg.gross_annual ? [...past, current] : past
}

export function settingsOn(day: string, history: any[]) {
  const active = history.filter((h) => h.effective <= day)
  return active.length ? active[active.length - 1] : null
}

export async function paycheckDates(start?: string | null, end?: string | null) {
  const [w, args] = await where(start, end, null, "k.kind IN ('paycheck','paycheck_bonus')")
  return (await all(`SELECT DISTINCT t.date ${FROM} WHERE ${w} ORDER BY t.date`, args)).map((r) => r.date as string)
}

export async function hasLinked401k() {
  return !!(await one("SELECT 1 FROM accounts WHERE type='investment' AND lower(COALESCE(subtype,'')) LIKE '%401%'"))
}

export async function retirementByPeriod(start?: string | null, end?: string | null, group = 'month'): Promise<Record<string, number>> {
  const history = await payHistory()
  if (!history.length || await hasLinked401k()) return {}
  const [w, args] = await where(start, end, null, "k.kind IN ('paycheck','paycheck_bonus')")
  const rows = await all(`SELECT DISTINCT ${PERIODS[group]} AS period, t.date ${FROM} WHERE ${w} ORDER BY 1, 2`, args)
  const out: Record<string, number> = {}
  for (const r of rows) {
    const h = settingsOn(r.date, history)
    const b = h ? await payBreakdown(h) : null
    if (b) out[r.period] = (out[r.period] || 0) + b.per_paycheck.retirement + b.per_paycheck.employer_match
  }
  for (const k of Object.keys(out)) out[k] = round(out[k], 2)
  return out
}

export async function incomeCheck() {
  const cfg: any = (await getJson('income', {})) || {}
  const b = await payBreakdown(cfg)
  const yearStart = `${parts(today()).y}-01-01`
  const ytdDates = await paycheckDates(yearStart)
  const ytdTakeHome = await scalar(`SELECT COALESCE(SUM(-t.amount),0) ${FROM} WHERE k.kind IN ('paycheck','paycheck_bonus') AND t.date>=?`, [yearStart])
  const n = ytdDates.length
  const ytd: any = { paychecks: n, take_home: round(ytdTakeHome, 2) }
  let warning: string | null = null
  if (b) {
    Object.assign(ytd, {
      expected_take_home: round(n * b.per_paycheck.take_home, 2), gross: round(n * b.per_paycheck.gross, 2),
      retirement: round(n * b.per_paycheck.retirement, 2), employer_match: round(n * b.per_paycheck.employer_match, 2),
    })
    const gap = ytd.take_home - ytd.expected_take_home
    if (n && Math.abs(gap) > b.per_paycheck.take_home * 0.05) {
      warning = `This year's paychecks add up to $${Math.abs(gap).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${gap > 0 ? 'more' : 'less'} than ${n} × your take-home per paycheck.`
    }
  }
  return { settings: cfg, breakdown: b, ytd, detected: await detectedIncome(), warning, history: await payHistory() }
}

// Mortgage model (port of mortgage.py): the lender's original schedule, what you've actually paid, and where
// that leaves you. See mortgage.py for how buydowns, extra principal, and statement checkpoints work.
import { all, getJson, run, setJson, transaction } from './db.ts'
import { diffDays, parts, round, sum, today, ymd } from './util.ts'
import * as home from './home.ts'

const DUE_WINDOW = 25 // days before a due date that a payment counts toward it
const DATE_MIN = '0001-01-01'

/** First of the month, n months after d's month. */
function addMonths(d: string, n: number) { const p = parts(d); return ymd(p.y, p.m + n, 1) }

function pmt(principal: number, annualRate: number, months: number) {
  const r = annualRate / 1200
  return r === 0 ? principal / months : principal * r / (1 - (1 + r) ** -months)
}

export const getConfig = () => getJson<any>('mortgage', null)
export const saveConfig = (cfg: any) => setJson('mortgage', cfg)

function borrowerRate(cfg: any, n: number) {
  const year = Math.floor((n - 1) / 12)
  const buydown = cfg.buydown_rates || []
  return year < buydown.length ? buydown[year] : cfg.note_rate
}

export function originalSchedule(cfg: any) {
  const P = cfg.original_amount, rate = cfg.note_rate, term = cfg.term_months
  const first = cfg.first_payment
  const notePi = round(pmt(P, rate, term), 2)
  let bal = P
  const rows = []
  for (let n = 1; n <= term; n++) {
    const interest = round(bal * rate / 1200, 2)
    const principal = n === term ? bal : round(notePi - interest, 2)
    bal = round(bal - principal, 2)
    const yourPi = round(pmt(P, borrowerRate(cfg, n), term), 2)
    rows.push({ n, date: addMonths(first, n - 1), rate: borrowerRate(cfg, n), your_pi: yourPi, subsidy: round(notePi - yourPi, 2),
      principal: round(principal, 2), interest, balance: Math.max(bal, 0.0) })
  }
  return rows
}

function scheduledDue(cfg: any, n: number) {
  return round(pmt(cfg.original_amount, borrowerRate(cfg, n), cfg.term_months) + (cfg.escrow_monthly || 0), 2)
}

let names: Map<string, string> | null = null

async function actualPayments(cfg: any) {
  const pat = new RegExp(cfg.match_pattern || 'mortgage|home loan', 'i')
  const rows = await all(`SELECT t.txn_id, t.date, t.amount, a.institution FROM transactions t
      JOIN txn_class k USING(txn_id) LEFT JOIN accounts a ON a.account_id=t.account_id
      WHERE t.amount > 0 AND k.flow != 'ignore' ORDER BY t.date`)
  if (!names) {
    names = new Map((await all('SELECT txn_id, name, counterparty FROM transactions')).map((r) => [r.txn_id, `${r.name} ${r.counterparty || ''}`]))
  }
  const found = rows.filter((r) => pat.test(names!.get(r.txn_id) || ''))
  const manual = (cfg.manual_payments || []).map((m: any) => ({ txn_id: null, date: m.date, amount: m.amount, institution: m.note || 'entered by hand' }))
  return [...found, ...manual].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function allocate(cfg: any, payments: any[]) {
  const first = cfg.first_payment
  const owed = new Map<number, number>()
  let nextN = 1
  let out: any[] = []
  for (const p of payments) {
    const payDay = p.date
    let left = p.amount, sched = 0.0
    while (left > 0.004) {
      while (nextN <= cfg.term_months && diffDays(addMonths(first, nextN - 1), payDay) <= DUE_WINDOW) {
        if (!owed.has(nextN)) owed.set(nextN, scheduledDue(cfg, nextN))
        nextN++
      }
      const open = [...owed.keys()].sort((a, b) => a - b).filter((n) => owed.get(n)! > 0.004)
      if (!open.length) break
      const n = open[0]
      const take = Math.min(left, owed.get(n)!)
      owed.set(n, round(owed.get(n)! - take, 2))
      left = round(left - take, 2)
      sched += take
    }
    out.push({ ...p, scheduled: round(sched, 2), extra: round(Math.max(left, 0), 2) })
  }
  out = applyCheckpointGaps(cfg, out)
  let covered = sum(out.map((a) => a.scheduled)), paidThrough = 0
  while (paidThrough < cfg.term_months && covered >= scheduledDue(cfg, paidThrough + 1) - 0.004) {
    covered -= scheduledDue(cfg, paidThrough + 1)
    paidThrough++
  }
  return [out, paidThrough] as const
}

/** Extra principal paid on day d lowers the balance before the next due date's interest (the 1st). */
function extraKey(d: string) { return addMonths(d, parts(d).d > 1 ? 1 : 0) }

function runSchedule(cfg: any, alloc: any[], plannedExtra = 0.0, pin = true, todayIso?: string) {
  const P = cfg.original_amount, rate = cfg.note_rate, term = cfg.term_months
  const notePi = round(pmt(P, rate, term), 2)
  const first = cfg.first_payment
  const t0 = todayIso || today()
  const extras = alloc.filter((a) => a.extra > 0).map((a) => [a.date, a.extra] as [string, number])
  const checkpoints = pin ? [...(cfg.checkpoints || [])].map((c: any) => [c.date, c.balance] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])) : []
  let pinnedThrough = DATE_MIN
  let bal = P, n = 0
  const rows = []
  while (bal > 0.004 && n < term) {
    n++
    const due = addMonths(first, n - 1)
    const future = due > t0
    const extra = future ? plannedExtra : sum(extras.filter(([d]) => extraKey(d) === due && d > pinnedThrough).map(([, amt]) => amt))
    bal = round(bal - extra, 2)
    const interest = round(bal * rate / 1200, 2)
    const principal = Math.min(bal, round(notePi - interest, 2))
    bal = round(bal - principal, 2)
    const nxt = addMonths(first, n)
    for (const [cd, cb] of checkpoints) {
      if (due <= cd && cd < nxt) { bal = cb; pinnedThrough = cd }
    }
    rows.push({ n, date: due, principal: round(principal, 2), interest, extra: round(extra, 2), balance: Math.max(bal, 0.0), projected: future })
  }
  return rows
}

function modelBalanceOn(cfg: any, alloc: any[], day: string) {
  const rows = runSchedule(cfg, alloc, 0, false, day)
  const past = rows.filter((r) => r.date <= day)
  const bal = past.length ? past[past.length - 1].balance : cfg.original_amount
  const lastDue = past.length ? past[past.length - 1].date : DATE_MIN
  return round(bal - sum(alloc.filter((a) => a.extra > 0 && a.date <= day && extraKey(a.date) > lastDue).map((a) => a.extra)), 2)
}

function applyCheckpointGaps(cfg: any, alloc: any[]) {
  for (const cp of [...(cfg.checkpoints || [])].sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const day = cp.date
    let gap = round(modelBalanceOn(cfg, alloc, day) - cp.balance, 2)
    const older = alloc.filter((a) => a.date <= day).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    for (const a of older) {
      if (gap <= 0.004) break
      const move = Math.min(gap, a.scheduled)
      a.scheduled = round(a.scheduled - move, 2)
      a.extra = round(a.extra + move, 2)
      a.from_statement = true
      gap = round(gap - move, 2)
    }
  }
  return alloc
}

async function actualSchedule(cfg: any, plannedExtra = 0.0) {
  const [alloc, paidThrough] = allocate(cfg, await actualPayments(cfg))
  return [runSchedule(cfg, alloc, plannedExtra), alloc, paidThrough] as const
}

// A mortgage summary is needed by many screens in one request; compute each (config, extra) once per request.
const cache = new Map<string, any>()
export function clearCache() { cache.clear(); names = null }

export async function summary(plannedExtra = 0.0): Promise<any> {
  const cfg = await getConfig()
  if (!cfg) return null
  const key = `${plannedExtra}|${JSON.stringify(cfg)}`
  if (cache.has(key)) return cache.get(key)
  const orig = originalSchedule(cfg)
  const [rows, alloc, paidThrough] = await actualSchedule(cfg, plannedExtra)
  const t0 = today()
  const past = rows.filter((r) => !r.projected)
  const curBal = past.length ? past[past.length - 1].balance : cfg.original_amount
  const origNow = [...orig].reverse().find((r) => r.date <= t0)?.balance ?? cfg.original_amount
  const value = cfg.original_value || cfg.original_amount
  const pmiRequest = round(0.80 * value, 2), pmiAuto = round(0.78 * value, 2)
  const firstBelow = (sched: any[], limit: number) => sched.find((r) => r.balance <= limit)?.date ?? null
  const totalInterestOrig = round(sum(orig.map((r) => r.interest)), 2)
  const totalInterestNow = round(sum(rows.map((r) => r.interest)), 2)
  const extraTotal = round(sum(alloc.map((a) => a.extra)), 2)
  const est = await home.estimate(cfg)
  const homeValue = est ? est.value : (cfg.current_value || cfg.appraised_value || value)
  const years = new Map<string, any>()
  for (const r of rows) {
    const y = r.date.slice(0, 4)
    if (!years.has(y)) years.set(y, { year: y, principal: 0.0, interest: 0.0, extra: 0.0, end_balance: 0.0 })
    const e = years.get(y)
    e.principal += r.principal; e.interest += r.interest; e.extra += r.extra
    e.end_balance = r.balance
  }
  const passed = orig.filter((r) => r.date <= t0).length
  const out = {
    config: cfg,
    balance: curBal,
    original_balance_now: origNow,
    ahead_by: round(origNow - curBal, 2),
    paid_off_pct: round(1 - curBal / cfg.original_amount, 4),
    principal_paid: round(cfg.original_amount - curBal, 2),
    interest_paid: round(sum(past.map((r) => r.interest)), 2),
    extra_principal: extraTotal,
    total_paid: round(sum(alloc.map((a) => a.amount)), 2),
    paid_through_payment: paidThrough,
    paid_through_date: paidThrough ? orig[paidThrough - 1].date : null,
    payoff_original: orig[orig.length - 1].date,
    payoff_projected: rows.length ? rows[rows.length - 1].date : null,
    months_saved: orig.length - rows.length,
    interest_original: totalInterestOrig,
    interest_projected: totalInterestNow,
    interest_saved: round(totalInterestOrig - totalInterestNow, 2),
    note_pi: round(pmt(cfg.original_amount, cfg.note_rate, cfg.term_months), 2),
    current_due: scheduledDue(cfg, Math.max(1, Math.min(orig.length, passed + 1))),
    rate_now: borrowerRate(cfg, Math.max(1, passed)),
    home_value: homeValue,
    equity: round(homeValue - curBal, 2),
    ltv: round(curBal / value, 4),
    pmi: {
      request_at_balance: pmiRequest, auto_at_balance: pmiAuto,
      request_date_projected: firstBelow(rows, pmiRequest), auto_date_projected: firstBelow(rows, pmiAuto),
      request_date_original: firstBelow(orig, pmiRequest), monthly: cfg.pmi_monthly ?? null,
    },
    payments: [...alloc].reverse(),
    original: orig,
    actual: rows,
    years: [...years.values()].map((y) => ({ ...y, principal: round(y.principal, 2), interest: round(y.interest, 2), extra: round(y.extra, 2), end_balance: round(y.end_balance, 2) })),
  }
  cache.set(key, out)
  return out
}

/** Store each mortgage payment's extra-principal portion for the dashboards. */
export async function refreshAllocations() {
  const cfg = await getConfig()
  names = null
  const extra: [string, number][] = []
  if (cfg) {
    const [alloc] = allocate(cfg, await actualPayments(cfg))
    for (const a of alloc) if (a.txn_id && a.extra > 0) extra.push([a.txn_id, a.extra])
  }
  await transaction(async (tx) => {
    await run('DELETE FROM mortgage_alloc', [], tx)
    for (const [id, e] of extra) await run('INSERT INTO mortgage_alloc(txn_id, extra) VALUES (?, ?) ON CONFLICT(txn_id) DO UPDATE SET extra=excluded.extra', [id, e], tx)
  })
  cache.clear()
  return Object.fromEntries(extra)
}

// Things that look ahead (port of insights.py): recurring bills, a cash forecast, tax-year limits, alerts,
// the monthly recap, and the facts the in-browser retirement planner needs.
import { all, getJson, getMeta, one, scalar, setJson } from './db.ts'
import { addDays, bDay, commas, diffDays, lastDayOfMonth, mean, median, parts, round, sum, today, ymd } from './util.ts'
import * as analytics from './analytics.ts'
import * as planning from './planning.ts'
import * as mortgage from './mortgage.ts'
import * as home from './home.ts'

const CADENCES: [string, number, number, number][] = [ // label, days between charges, allowed wobble, per-month factor
  ['weekly', 7, 1.5, 52 / 12], ['every 2 weeks', 14, 2.5, 26 / 12], ['monthly', 30.4, 4, 1],
  ['every 3 months', 91, 10, 1 / 3], ['every 6 months', 182, 15, 1 / 6], ['yearly', 365, 20, 1 / 12],
]

// Places you go often but don't have a bill with; only exact repeating charges here count as recurring.
const HABIT_CATEGORIES = new Set(['Food & Drink', 'Transportation', 'Shopping', 'Travel', 'Entertainment', 'Personal Care'])

const stripChars = (s: string, chars: string) => { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b) }

/** 'CARD CO ACH PMT 260818 A0896' -> 'card co ach pmt'; 'Planet Gym' -> 'planet gym'. */
function merchantKey(name: string | null) {
  let s = (name || '').toLowerCase()
  s = s.replace(/\b(on|ref|id|conf|web id|ppd|ccd)\b.*$/, '')
  s = s.replace(/[#*].*$/, '')
  s = s.replace(/\b[a-z]*\d[\w-]*\b/g, ' ')
  s = stripChars(s.replace(/\s+/g, ' '), ' -.,') || (name || '').toLowerCase()
  return s.split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
}

function cadence(gaps: number[]): [string, number, number] | null {
  if (gaps.length < 2) return null
  const g = median(gaps)
  for (const [label, days, wobble, perMonth] of CADENCES) {
    if (Math.abs(g - days) <= wobble) {
      const ok = gaps.filter((x) => Math.abs(x - days) <= wobble * 1.6).length
      if (ok >= Math.max(2, gaps.length * 0.6)) return [label, days, perMonth]
    }
  }
  return null
}

const dismissedSet = async () => new Set<string>((await getJson<string[]>('recurring_dismissed', [])) || [])

export async function dismissRecurring(key: string, undo = false) {
  const d = await dismissedSet()
  if (undo) d.delete(key); else d.add(key)
  await setJson('recurring_dismissed', [...d].sort())
}

/** Python _add_months keeping the day (clamped to the month's end). */
function addMonthsKeepDay(iso: string, n: number) {
  const p = parts(iso)
  const m0 = p.m - 1 + n
  const y = p.y + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12 + 1
  return ymd(y, m, Math.min(p.d, lastDayOfMonth(y, m)))
}

export async function recurring(includeTransfers = false) {
  const flows = includeTransfers ? ['spend', 'transfer'] : ['spend']
  const t0 = today()
  const since = addDays(t0, -400)
  const rows = await all(`SELECT t.txn_id, t.date, t.name, t.amount, t.account_id, a.type AS acct_type,
        a.name AS account_name, k.flow, k.kind, k.category, k.pair_id, tp.account_id AS pair_account
      ${analytics.FROM} WHERE k.flow IN (${flows.map(() => '?').join(',')}) AND t.amount > 0 AND t.pending = 0
      AND t.date >= ? AND k.kind NOT IN ('card_payment', 'mortgage') ORDER BY t.date, t.seq`, [...flows, since])
  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const k = `${merchantKey(r.name)}\u0000${r.account_id}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const dismissed = await dismissedSet()
  const out: any[] = []
  for (const [gk, rs] of groups) {
    const [mkey, acct] = gk.split('\u0000')
    const byDay = new Map<string, number>()
    for (const r of rs) byDay.set(r.date, (byDay.get(r.date) || 0) + r.amount)
    const days = [...byDay.keys()].sort()
    if (days.length < 3) continue
    const gaps = days.slice(1).map((b, i) => diffDays(b, days[i]))
    const cad = cadence(gaps.slice(-10))
    if (!cad) continue
    const [label, every, perMonth] = cad
    const amounts = days.map((d) => byDay.get(d)!)
    const recent = amounts.slice(-6)
    const typical = median(recent)
    const spread = typical ? (Math.max(...recent) - Math.min(...recent)) / typical : 9
    if (spread > 0.6 && (label === 'weekly' || label === 'every 2 weeks')) continue
    if (HABIT_CATEGORIES.has(rs[rs.length - 1].category) && (spread > 0.02 || days.length < 4)) continue
    const last = days[days.length - 1]
    let nxt = addDays(last, round(every))
    while (nxt < t0) nxt = addDays(nxt, round(every))
    const active = diffDays(t0, last) <= every * 1.8
    const prev = amounts.length >= 4 ? median(amounts.slice(-4, -1)) : null
    const lastAmt = amounts[amounts.length - 1]
    const change = prev && Math.abs(lastAmt - prev) > Math.max(1, prev * 0.05) ? round(lastAmt - prev, 2) : null
    const key = `${mkey}|${acct}`
    const r0 = rs[rs.length - 1]
    out.push({
      key, name: r0.name, merchant: mkey, category: r0.category, flow: r0.flow, kind: r0.kind, account_id: acct,
      account_name: r0.account_name, acct_type: r0.acct_type, pair_account: r0.pair_account,
      cadence: label, every_days: every, typical: round(typical, 2), last_amount: round(lastAmt, 2),
      last_date: last, next_date: nxt, count: days.length, active, monthly: round(typical * perMonth, 2), price_change: change,
      variable: spread > 0.2, history: days.slice(-12).map((d) => ({ date: d, amount: round(byDay.get(d)!, 2) })),
      dismissed: dismissed.has(key),
    })
  }
  const m = await mortgageItem(dismissed)
  if (m) out.push(m)
  out.sort((a, b) => (Number(!a.active) - Number(!b.active)) || (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0))
  return out
}

async function mortgageItem(dismissed: Set<string>) {
  let m
  try { m = await mortgage.summary() } catch { return null }
  if (!m || !m.config) return null
  const due = m.current_due
  const pays = [...m.payments].sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (!pays.length) return null
  const t0 = today()
  const thisMonth = t0.slice(0, 7)
  const paidNow = sum(pays.filter((p: any) => p.date.startsWith(thisMonth)).map((p: any) => p.amount))
  const first = `${thisMonth}-01`
  let nxt = paidNow >= due * 0.98 ? addMonthsKeepDay(first, 1) : first
  if (nxt < t0) nxt = t0
  const last = await one(`SELECT t.account_id, a.name ${analytics.FROM} WHERE k.kind='mortgage' ORDER BY t.date DESC, t.seq DESC LIMIT 1`)
  const byMonth = new Map<string, number>()
  for (const p of pays) byMonth.set(p.date.slice(0, 7), (byMonth.get(p.date.slice(0, 7)) || 0) + p.amount)
  const key = 'mortgage'
  return {
    key, name: 'Mortgage', merchant: 'mortgage', category: 'Housing', flow: 'spend', kind: 'mortgage',
    account_id: last ? last.account_id : null, account_name: last ? last.name : '', acct_type: 'depository', pair_account: null,
    cadence: 'monthly', every_days: 30.4, typical: round(due, 2), last_amount: round(pays[pays.length - 1].amount, 2),
    last_date: pays[pays.length - 1].date, next_date: nxt, count: byMonth.size, active: true, monthly: round(due, 2),
    price_change: null, variable: false, fixed_day: 1,
    history: [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12).map(([k, v]) => ({ date: `${k}-01`, amount: round(v, 2) })),
    dismissed: dismissed.has(key), note: `$${commas(m.note_pi)} principal & interest + escrow; extra payments are counted as saving`,
  }
}

export async function recurringSummary() {
  const allItems = await recurring()
  const items = allItems.filter((r) => !r.dismissed)
  const live = items.filter((r) => r.active)
  const soon = addDays(today(), 7)
  return {
    items,
    monthly_total: round(sum(live.map((r) => r.monthly)), 2),
    yearly_total: round(sum(live.map((r) => r.monthly)) * 12, 2),
    count: live.length,
    next_7_days: round(sum(live.filter((r) => r.next_date <= soon).map((r) => r.typical)), 2),
    price_increases: live.filter((r) => r.price_change && r.price_change > 0),
    dismissed: allItems.filter((r) => r.dismissed),
  }
}

// ---------- cash forecast ----------

export async function forecast(days = 60) {
  const t0 = today()
  const horizon = addDays(t0, days)
  const low = parseFloat((await getMeta('forecast_low')) || '500')
  const cash = await all(`SELECT account_id, institution, name, balance FROM accounts
      WHERE type='depository' AND balance IS NOT NULL AND source != 'venmo' ORDER BY balance DESC`)
  const cashIds = new Set(cash.map((a) => a.account_id))
  const payRows = await all(`SELECT t.date, t.account_id, -t.amount AS amount ${analytics.FROM}
      WHERE k.kind='paycheck' ORDER BY t.date DESC, t.seq DESC LIMIT 12`)
  const cards = await all(`SELECT a.account_id, a.name, a.balance, l.next_due, l.last_statement
      FROM accounts a LEFT JOIN liabilities l USING(account_id) WHERE a.type='credit'`)
  const cardPays = await all(`SELECT t.date, t.account_id, t.amount, tp.account_id AS card
      ${analytics.FROM} WHERE k.kind='card_payment' AND t.amount > 0 AND t.date >= ? ORDER BY t.date, t.seq`, [addDays(t0, -120)])
  const events: [string, string, number, string, string][] = []

  if (payRows.length) {
    const lastDay = payRows[0].date
    const split = new Map<string, number>()
    for (const r of payRows) if (r.date === lastDay) split.set(r.account_id, (split.get(r.account_id) || 0) + r.amount)
    const emp = (await analytics.detectedIncome()).find((e) => e.active)
    const step = ({ weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 } as Record<string, number>)[emp?.frequency || ''] ?? 14
    let d = addDays(lastDay, step)
    while (d <= horizon) {
      if (d > t0) for (const [acct, amt] of split) if (cashIds.has(acct)) events.push([d, acct, round(amt, 2), 'Paycheck', 'income'])
      d = addDays(d, step)
    }
  }

  for (const r of await recurring(true)) {
    if (r.dismissed || !r.active || !cashIds.has(r.account_id)) continue
    let d = r.next_date
    while (d <= horizon) {
      if (d >= t0) {
        events.push([d, r.account_id, -r.typical, r.name, r.flow === 'spend' ? 'bill' : 'transfer'])
        if (cashIds.has(r.pair_account)) events.push([d, r.pair_account, r.typical, r.name, 'transfer'])
      }
      d = r.fixed_day ? addMonthsKeepDay(d, 1) : addDays(d, round(r.every_days))
    }
  }

  for (const card of cards) {
    let pays = cardPays.filter((p) => p.card === card.account_id)
    if (!pays.length) pays = cardPays
    const payer = pays.length ? pays[pays.length - 1].account_id : (cash.length ? cash[0].account_id : null)
    if (!payer || !cashIds.has(payer)) continue
    const monthly = pays.length ? sum(pays.map((p) => p.amount)) / 4 : (card.balance || 0)
    let due = card.next_due ? card.next_due : addDays(t0, 20)
    const paid = sum(pays.filter((p) => { const g = diffDays(due, p.date); return g >= 0 && g < 26 }).map((p) => p.amount))
    const first = Math.max((card.last_statement || 0) - paid, 0)
    let n = 0
    while (due <= horizon) {
      const amt = n === 0 ? first : monthly
      if (due >= t0 && amt > 1) events.push([due, payer, -round(amt, 2), `${card.name} payment`, 'card'])
      due = addMonthsKeepDay(due, 1); n++
    }
  }

  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const series: any[] = []
  const lows: Record<string, { balance: number; date: string }> = {}
  const bal: Record<string, number> = Object.fromEntries(cash.map((a) => [a.account_id, a.balance]))
  for (let i = 0; i <= days; i++) {
    const d = addDays(t0, i)
    for (const e of events) if (e[0] === d) bal[e[1]] += e[2]
    const point: any = { date: d, total: round(sum(Object.values(bal)), 2) }
    for (const a of cash) {
      point[a.account_id] = round(bal[a.account_id], 2)
      if (!(a.account_id in lows) || bal[a.account_id] < lows[a.account_id].balance) lows[a.account_id] = { balance: round(bal[a.account_id], 2), date: d }
    }
    series.push(point)
  }
  const accounts: any[] = cash.map((a) => ({ ...a, low: lows[a.account_id] ?? null, warn: (lows[a.account_id]?.balance ?? 1e9) < low }))
  return { accounts, series, low_threshold: low, events: events.map((e) => ({ date: e[0], account_id: e[1], amount: e[2], label: e[3], kind: e[4] })) }
}

// ---------- tax year ----------

const LIMITS: Record<number, { k401: number; ira: number }> = { 2025: { k401: 23500, ira: 7000 }, 2026: { k401: 24500, ira: 7500 } }

export async function taxYear(yearArg?: string | number | null) {
  const t0 = today()
  const year = Number(yearArg || parts(t0).y)
  const start = `${year}-01-01`, end = `${year}-12-31`
  const saved = (((await getJson<any>('tax_limits', {})) || {})[String(year)]) || {}
  const limits = { ...(LIMITS[year] ?? LIMITS[Math.max(...Object.keys(LIMITS).map(Number))]), ...saved }
  const q = async (sqlText: string, ...a: unknown[]) => (await scalar(sqlText, a)) || 0
  const roth = await q(`SELECT SUM(-t.amount) ${analytics.FROM} WHERE lower(COALESCE(a.subtype,'')) LIKE '%roth%'
      AND k.kind='invest_contribution' AND t.amount < 0 AND t.date BETWEEN ? AND ?`, start, end)
  const early = await q(`SELECT SUM(-t.amount) ${analytics.FROM} WHERE lower(COALESCE(a.subtype,'')) LIKE '%roth%'
      AND k.kind='invest_contribution' AND t.amount < 0 AND t.date BETWEEN ? AND ?`, `${year}-01-01`, `${year}-04-15`)
  const divTaxable = await q(`SELECT SUM(-t.amount) ${analytics.FROM} WHERE k.kind='dividend' AND t.date BETWEEN ? AND ?
      AND lower(COALESCE(a.subtype,'')) NOT LIKE '%roth%' AND lower(COALESCE(a.subtype,'')) NOT LIKE '%ira%'
      AND lower(COALESCE(a.subtype,'')) NOT LIKE '%401%'`, start, end)
  const divSheltered = await q(`SELECT SUM(-t.amount) ${analytics.FROM} WHERE k.kind='dividend' AND t.date BETWEEN ? AND ?
      AND (lower(COALESCE(a.subtype,'')) LIKE '%roth%' OR lower(COALESCE(a.subtype,'')) LIKE '%ira%'
      OR lower(COALESCE(a.subtype,'')) LIKE '%401%')`, start, end)
  const interest = await all(`SELECT a.institution, a.name, ROUND(SUM(-t.amount),2) AS amount
      ${analytics.FROM} WHERE k.kind='interest' AND t.date BETWEEN ? AND ? GROUP BY a.account_id ORDER BY a.account_id`, [start, end])
  const refunds = await all(`SELECT t.date, t.name, -t.amount AS amount ${analytics.FROM} WHERE k.kind='tax_refund' ORDER BY t.date DESC`)
  const history = await analytics.payHistory()
  let mine = 0.0, match = 0.0
  const dates = await analytics.paycheckDates(start, end)
  for (const d of dates) {
    const h = analytics.settingsOn(d, history)
    const b = h ? await analytics.payBreakdown(h) : null
    if (b) { mine += b.per_paycheck.retirement; match += b.per_paycheck.employer_match }
  }
  const cfg = (await getJson<any>('income', {})) || {}
  const b = await analytics.payBreakdown(cfg)
  let leftChecks = 0
  if (b && year === parts(t0).y) leftChecks = round(diffDays(`${year}-12-31`, t0) / (365 / b.periods_per_year))
  const projected401k = mine + leftChecks * (b ? b.per_paycheck.retirement : 0)
  const monthsLeft = year === parts(t0).y ? 12 - parts(t0).m + 1 : 0
  return {
    year, limits,
    roth: { contributed: round(roth, 2), limit: limits.ira, left: round(Math.max(limits.ira - roth, 0), 2), jan_to_apr15: round(early, 2),
      monthly_to_max: monthsLeft ? round(Math.max(limits.ira - roth, 0) / monthsLeft, 2) : null },
    k401: { yours: round(mine, 2), match: round(match, 2), limit: limits.k401, projected_year_end: round(projected401k, 2),
      estimated: !(await analytics.hasLinked401k()), left: round(Math.max(limits.k401 - mine, 0), 2) },
    dividends: { taxable: round(divTaxable, 2), sheltered: round(divSheltered, 2) },
    interest, interest_total: round(sum(interest.map((i) => i.amount)), 2),
    refunds,
    withheld_ytd: b ? round(dates.length * b.per_paycheck.taxes_and_other, 2) : null,
  }
}

export async function setTaxLimits(year: number, k401: number | null, ira: number | null) {
  const allv: any = (await getJson('tax_limits', {})) || {}
  const cur = allv[String(year)] || {}
  if (k401 != null) cur.k401 = k401
  if (ira != null) cur.ira = ira
  allv[String(year)] = cur
  await setJson('tax_limits', allv)
}

// ---------- alerts ----------

export async function dismissAlert(aid: string) {
  const d: Record<string, string> = (await getJson('alerts_dismissed', {})) || {}
  const t0 = today()
  d[aid] = t0
  const cutoff = addDays(t0, -120)
  await setJson('alerts_dismissed', Object.fromEntries(Object.entries(d).filter(([, v]) => v >= cutoff)))
}

export async function alerts() {
  const t0 = today()
  const month = t0.slice(0, 7)
  const out: any[] = []
  const bm = await planning.budgetMonth(month)
  for (const r of bm.rows) {
    if (r.status === 'over') out.push({ id: `budget-over|${month}|${r.category}`, level: 'bad', icon: 'budget', title: `${r.category} is over budget`,
      detail: `$${commas(r.spent)} of $${commas(r.budget!)} this month`, link: { to: '/budget' } })
    else if (r.status === 'ahead_of_pace') out.push({ id: `budget-pace|${month}|${r.category}`, level: 'warn', icon: 'budget', title: `${r.category} is spending ahead of pace`,
      detail: `$${commas(r.spent)} of $${commas(r.budget!)} with ${bm.days - bm.elapsed} days left`, link: { to: '/budget' } })
  }
  try {
    const fc = await forecast(30)
    for (const a of fc.accounts) {
      if (a.warn && a.low) out.push({ id: `low|${a.account_id}|${a.low.date}`, level: a.low.balance < 0 ? 'bad' : 'warn', icon: 'forecast',
        title: `${a.name} may get low`, detail: `About $${commas(a.low.balance)} on ${bDay(a.low.date)} after scheduled bills`, link: { to: '/forecast' } })
    }
  } catch (e) { console.log(`[alerts] forecast failed: ${e}`) }
  if (bm.elapsed >= 7) {
    const hist = await planning.categoryHistory(planning.lastFullMonths(6))
    for (const r of bm.rows) {
      const usual = Object.values(hist.get(r.category) || {}).filter((v) => v > 0)
      if (usual.length < 3 || r.spent <= 0) continue
      const med = median(usual)
      const projected = r.spent / Math.max(bm.pace, 0.05)
      if (med > 50 && projected > med * 1.4 && projected - med > 75) {
        out.push({ id: `unusual|${month}|${r.category}`, level: 'warn', icon: 'dashboard', title: `${r.category} is running high`,
          detail: `On pace for $${commas(projected)} this month vs. a usual $${commas(med)}`,
          link: { to: '/transactions', params: { category: r.category, flows: 'spend,refund' } } })
      }
    }
  }
  const big = await all(`SELECT t.txn_id, t.date, t.name, t.amount, k.category ${analytics.FROM}
      WHERE k.flow='spend' AND t.date >= ? AND t.amount >= 250 AND k.kind != 'mortgage' ORDER BY t.amount DESC, t.seq LIMIT 5`, [addDays(t0, -10)])
  for (const t of big) out.push({ id: `big|${t.txn_id}`, level: 'info', icon: 'transactions', title: `Large charge: ${t.name}`,
    detail: `$${commas(t.amount, 2)} on ${bDay(t.date)} · ${t.category}`, link: { to: '/transactions', params: { q: t.name } } })
  const rs = await recurringSummary()
  for (const r of rs.price_increases) out.push({ id: `price|${r.key}|${r.last_date}`, level: 'warn', icon: 'recurring', title: `${r.name} went up`,
    detail: `$${commas(r.last_amount, 2)}, up $${commas(r.price_change, 2)} from usual`, link: { to: '/recurring' } })
  const due = rs.items.filter((r) => r.active && r.next_date <= addDays(t0, 3))
  if (due.length) out.push({ id: `due|${t0}`, level: 'info', icon: 'recurring', title: `${due.length} bill${due.length > 1 ? 's' : ''} due in the next 3 days`,
    detail: due.slice(0, 4).map((r) => `${r.name} $${commas(r.typical)}`).join(', '), link: { to: '/recurring' } })
  const n = await scalar('SELECT COUNT(*) FROM txn_class WHERE review=1')
  if (n) out.push({ id: `review|${t0}|${n}`, level: 'info', icon: 'review', title: `${n} transaction${n > 1 ? 's' : ''} to check`,
    detail: "The app wasn't sure how to count these.", link: { to: '/review' } })
  const gone: Record<string, string> = (await getJson('alerts_dismissed', {})) || {}
  const order: Record<string, number> = { bad: 0, warn: 1, info: 2 }
  return out.filter((a) => !(a.id in gone)).sort((a, b) => order[a.level] - order[b.level])
}

// ---------- monthly recap ----------

async function recapMonths() {
  const floor = (await analytics.historyStart()) || '0000'
  return (await all('SELECT DISTINCT substr(date,1,7) AS m FROM transactions WHERE date >= ? ORDER BY 1 DESC', [floor])).map((r) => r.m as string)
}

export async function recap(month?: string | null) {
  const t0 = today()
  month = month || addDays(`${t0.slice(0, 7)}-01`, -1).slice(0, 7)
  const [start, end] = planning.monthBounds(month)
  const prev = planning.lastFullMonths(1, start)[0]
  const [ps, pe] = planning.monthBounds(prev)
  const six = planning.lastFullMonths(6, start)
  const tot = (await analytics.cashflow(start, end)).total
  const ptot = (await analytics.cashflow(ps, pe)).total
  const histTot: any[] = []
  for (const m of six) histTot.push((await analytics.cashflow(...planning.monthBounds(m))).total)
  const avg = (k: string) => (histTot.length ? round(mean(histTot.map((h) => h[k] || 0)), 2) : null)

  const cats: Record<string, number> = Object.fromEntries((await analytics.byCategory(start, end)).map((r) => [r.category, r.amount]))
  const pcats: Record<string, number> = Object.fromEntries((await analytics.byCategory(ps, pe)).map((r) => [r.category, r.amount]))
  const hist = await planning.categoryHistory(six)
  const categories = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => {
    const usual = Object.values(hist.get(cat) || {})
    const med = six.length ? median([...usual, ...Array(Math.max(0, six.length - usual.length)).fill(0)]) : null
    return { category: cat, amount: round(amt, 2), prev: round(pcats[cat] || 0, 2), usual: med != null ? round(med, 2) : null }
  })

  const [w, args] = await analytics.where(start, end, null, "k.flow='spend'")
  const yearAgo = addDays(start, -365)
  const biggest = await all(`SELECT t.txn_id, t.date, t.name, t.amount, k.category ${analytics.FROM}
      WHERE ${w} AND k.kind != 'mortgage' ORDER BY t.amount DESC, t.seq LIMIT 5`, args)
  const fresh = await all(`SELECT MIN(t.name) AS name, ROUND(SUM(t.amount),2) AS amount, COUNT(*) AS n, MIN(k.category) AS category
      ${analytics.FROM} WHERE ${w} AND lower(t.name) NOT IN (
        SELECT lower(t2.name) FROM transactions t2 WHERE t2.date >= ? AND t2.date < ? AND t2.name IS NOT NULL)
      GROUP BY lower(t.name) ORDER BY 2 DESC, lower(t.name) LIMIT 6`, [...args, yearAgo, start])
  const [w2, args2] = await analytics.where(start, end)
  const daily = await all(`SELECT t.date, ROUND(SUM(CASE WHEN k.flow='spend' THEN ${analytics.SPEND_AMT}
        WHEN k.flow='refund' THEN t.amount ELSE 0 END),2) AS amount
      ${analytics.FROM} WHERE ${w2} GROUP BY t.date ORDER BY t.date`, args2)
  const bills = (await recurring()).filter((r) => !r.dismissed && r.history.some((h: any) => h.date.slice(0, 7) === month))
  const billsTotal = round(sum(bills.flatMap((r) => r.history.filter((h: any) => h.date.slice(0, 7) === month).map((h: any) => h.amount))), 2)
  const bm = await planning.budgetMonth(month)
  const budgeted = bm.rows.filter((r) => r.budget)
  const nw = (await analytics.networthHistory()).points
  const nwStart = [...nw].reverse().find((p) => p.date <= start) ?? null
  const nwEnd = [...nw].reverse().find((p) => p.date <= end) ?? null

  const hl: { tone: string; text: string }[] = []
  if ((tot.income || 0) >= 500 && avg('savings_rate') != null && tot.savings_rate != null) {
    const rates = histTot.filter((h) => h.savings_rate != null && (h.income || 0) >= 500).map((h) => h.savings_rate)
    const diff = tot.savings_rate - (rates.length ? mean(rates) : tot.savings_rate)
    hl.push({ tone: diff >= 0 ? 'good' : 'bad', text: `You kept ${round(tot.savings_rate * 100)}% of your income, ${Math.abs(round(diff * 100))} points ${diff >= 0 ? 'above' : 'below'} your 6-month average.` })
  }
  const moves = categories.filter((c) => c.usual != null && c.amount > 0 && (c.usual || 0) > 40).map((c) => [c, c.amount - c.usual!] as const)
  for (const [c, d] of [...moves].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2)) {
    if (Math.abs(d) >= 50 && c.usual) hl.push({ tone: d > 0 ? 'bad' : 'good', text: `${c.category}: $${commas(c.amount)}, ${Math.abs(round(d / c.usual * 100))}% ${d > 0 ? 'more' : 'less'} than usual ($${commas(c.usual)}).` })
  }
  if (tot.invested > 0) hl.push({ tone: 'good', text: `You moved $${commas(tot.invested)} into investments.` })
  const over = budgeted.filter((r) => r.status === 'over')
  if (budgeted.length) hl.push({ tone: !over.length ? 'good' : over.length > budgeted.length / 2 ? 'bad' : 'info',
    text: `${budgeted.length - over.length} of ${budgeted.length} budgets stayed on track` + (over.length ? `; over: ${over.slice(0, 3).map((r) => r.category).join(', ')}.` : '.') })
  if (fresh.length) hl.push({ tone: 'info', text: `${fresh.length} new place${fresh.length > 1 ? 's' : ''} you hadn't paid in the past year, led by ${fresh[0].name} ($${commas(fresh[0].amount)}).` })

  const pick = (o: any, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k] ?? null]))
  return {
    month, prev_month: prev, months: await recapMonths(), partial: month === t0.slice(0, 7),
    totals: pick(tot, ['income', 'spend', 'saved', 'savings_rate', 'invested', 'refunds', 'paychecks']),
    prev: pick(ptot, ['income', 'spend', 'saved', 'savings_rate', 'invested']),
    usual: Object.fromEntries(['income', 'spend', 'saved', 'invested'].map((k) => [k, avg(k)])),
    categories, biggest, new_merchants: fresh, daily,
    bills: { count: bills.length, total: billsTotal },
    budgets: { count: budgeted.length, over: over.length },
    net_worth: { start: nwStart ? nwStart.net_worth : null, end: nwEnd ? nwEnd.net_worth : null },
    highlights: hl,
  }
}

// ---------- retirement & goals planner ----------

const PLAN_DEFAULTS: Record<string, unknown> = {
  birth_year: null, retire_age: 60, plan_to_age: 95,
  cash_monthly: null, brokerage_monthly: null, roth_yearly: null, k401_yearly: null,
  stock_return: 7.0, inflation: 2.5, cash_apy: null, home_growth: null,
  salary_growth: 1.0, spend_change_pct: 0, healthcare_yearly: 7000, ss_monthly: 0, ss_age: 67,
  tax_401k: 12, tax_brokerage: 5, cash_floor_months: 6,
}

export async function planSettings() { return { ...PLAN_DEFAULTS, ...((await getJson('plan', {})) || {}) } }

export async function savePlanSettings(values: Record<string, unknown>) {
  const cur: any = (await getJson('plan', {})) || {}
  for (const [k, v] of Object.entries(values)) if (k in PLAN_DEFAULTS) cur[k] = v
  await setJson('plan', cur)
}

export async function planInputs() {
  const t0 = today()
  const months = planning.lastFullMonths(6)
  const [s6] = planning.monthBounds(months[0]); const [, e6] = planning.monthBounds(months[months.length - 1])
  const six = (await analytics.cashflow(s6, e6)).total
  const y12 = planning.lastFullMonths(12)
  const [s12] = planning.monthBounds(y12[0]); const [, e12] = planning.monthBounds(y12[y12.length - 1])
  const year = (await analytics.cashflow(s12, e12)).total
  const accts = await all('SELECT account_id, name, type, subtype, balance FROM accounts WHERE balance IS NOT NULL')
  const basis: Record<string, number> = Object.fromEntries((await all('SELECT account_id, SUM(cost_basis) AS b FROM holdings GROUP BY account_id')).map((r) => [r.account_id, r.b]))
  const interest = await scalar(`SELECT COALESCE(SUM(-t.amount),0) ${analytics.FROM} WHERE k.kind='interest'
      AND a.type='depository' AND t.date BETWEEN ? AND ?`, [s12, e12])
  const brokerageIn = await scalar(`SELECT COALESCE(SUM(${analytics.INVESTED}),0) ${analytics.FROM}
      WHERE t.date BETWEEN ? AND ? AND a.type='investment' AND lower(COALESCE(a.subtype,'')) NOT LIKE '%roth%'
      AND lower(COALESCE(a.subtype,'')) NOT LIKE '%ira%' AND lower(COALESCE(a.subtype,'')) NOT LIKE '%401%'`, [s6, e6])
  const sub = (a: any) => (a.subtype || '').toLowerCase()
  const cash = sum(accts.filter((a) => a.type === 'depository').map((a) => a.balance))
  const cards = sum(accts.filter((a) => a.type === 'credit').map((a) => a.balance))
  const roth = accts.filter((a) => a.type === 'investment' && sub(a).includes('roth'))
  const k401 = accts.filter((a) => a.type === 'investment' && (sub(a).includes('401') || (sub(a).includes('ira') && !sub(a).includes('roth'))))
  const brokerage = accts.filter((a) => a.type === 'investment' && !roth.includes(a) && !k401.includes(a))
  let k401Bal = sum(k401.map((a) => a.balance))
  let k401Est: number | null = null
  if (!k401.length) { k401Est = (await analytics.investments()).retirement_estimate?.value ?? 0; k401Bal = k401Est }
  const avgCash = cash || 1
  const cashApy = interest ? round(interest / avgCash * 100, 2) : 0.0
  const b = await analytics.payBreakdown()
  const takeHomeMonth = b ? round(b.per_year.take_home / 12, 2) : null
  const cfg = await mortgage.getConfig()
  const m = cfg ? await mortgage.summary() : null
  const est = cfg ? await home.estimate(cfg) : null
  const taxRows = await taxYear()
  const goals = (await planning.goalsWithProgress()).map((g: any) => ({ id: g.id, type: g.type, name: g.name, target: g.progress.target ?? null,
    target_date: g.target_date ?? null, current: g.progress.current ?? null, monthly_needed: g.progress.monthly_needed ?? null }))
  const cats = await planning.suggestions()
  return {
    today: t0,
    buckets: {
      cash: round(cash - cards, 2), cash_gross: round(cash, 2), cards: round(cards, 2),
      brokerage: round(sum(brokerage.map((a) => a.balance)), 2),
      brokerage_basis: round(sum(brokerage.map((a) => basis[a.account_id] || a.balance)), 2),
      roth: round(sum(roth.map((a) => a.balance)), 2),
      roth_basis: round(sum(roth.map((a) => basis[a.account_id] || a.balance)), 2),
      k401: round(k401Bal, 2), k401_estimated: k401Est != null,
    },
    cash_apy: cashApy,
    avg: {
      take_home_month: takeHomeMonth, income_month: round(six.income / 6, 2), spend_month: round(six.spend / 6, 2),
      saved_month: round(six.saved / 6, 2), invested_month: round(six.invested / 6, 2),
      brokerage_month: round(brokerageIn / 6, 2), spend_year: round(year.spend, 2),
    },
    roth_this_year: taxRows.roth.contributed, roth_limit: taxRows.roth.limit,
    k401_yearly: b ? round(b.per_year.retirement + b.per_year.employer_match, 2) : 0,
    k401_limit: taxRows.k401.limit,
    mortgage: m ? { balance: m.balance, pi_monthly: m.note_pi, escrow_monthly: m.config.escrow_monthly || 0, payoff: m.payoff_projected,
      by_year: m.years.map((y: any) => ({ year: Number(y.year), balance: y.end_balance })) } : null,
    home: est ? { value: est.value, source: est.source, stats: est.stats } : null,
    goals,
    categories: Object.entries(cats).sort((a: any, b: any) => b[1].avg - a[1].avg).map(([k, v]: any) => ({ category: k, avg: v.avg, suggested: v.suggested })),
    budgets: await planning.getBudgets(),
    settings: await planSettings(),
  }
}

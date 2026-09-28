// Budgets, goals, and windfalls (port of planning.py).
import { all, getJson, one, run, scalar, transaction } from './db.ts'
import { addDays, bYear, commas, lastDayOfMonth, median, nowLocalIso, parts, round, sum, today, ymd } from './util.ts'
import * as analytics from './analytics.ts'
import * as mortgage from './mortgage.ts'

export const NOT_BUDGETED = new Set(['Paybacks from people', 'Reimbursements', 'Refund', 'Transfer', 'Ignored', 'Income'])

export function monthBounds(month: string): [string, string] {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
  return [ymd(y, m, 1), ymd(y, m, lastDayOfMonth(y, m))]
}

/** The n full months before `before` (default today), oldest first, as 'YYYY-MM'. */
export function lastFullMonths(n: number, before?: string) {
  const p = parts(before || today())
  let y = p.y, m = p.m
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out.reverse()
}

async function monthlyTakeHome() {
  const b = await analytics.payBreakdown()
  return b ? round(b.per_year.take_home / 12, 2) : null
}

// ---------- budgets ----------

export async function categoryHistory(months: string[]) {
  const [start] = monthBounds(months[0])
  const [, end] = monthBounds(months[months.length - 1])
  const [w, args] = await analytics.where(start, end, null, "k.flow IN ('spend','refund')")
  const rows = await all(`SELECT k.category, substr(t.date,1,7) AS m, SUM(${analytics.SPEND_AMT}) AS s
      ${analytics.FROM} WHERE ${w} GROUP BY 1, 2 ORDER BY 1, 2`, args)
  const out = new Map<string, Record<string, number>>()
  for (const r of rows) { if (!out.has(r.category)) out.set(r.category, {}); out.get(r.category)![r.m] = r.s }
  return out
}

export async function suggestions() {
  const months = lastFullMonths(6)
  const hist = await categoryHistory(months)
  const out: Record<string, any> = {}
  for (const [cat, byM] of hist) {
    if (NOT_BUDGETED.has(cat)) continue
    const med = median(months.map((m) => byM[m] || 0))
    if (med > 0) {
      out[cat] = {
        suggested: Math.ceil(med / 10) * 10,
        avg: round(sum(months.map((m) => byM[m] || 0)) / months.length, 2),
        history: months.map((m) => ({ month: m, amount: round(byM[m] || 0, 2) })),
      }
    }
  }
  return out
}

export async function getBudgets(): Promise<Record<string, number>> {
  return Object.fromEntries((await all('SELECT * FROM budgets')).map((r) => [r.category, r.monthly]))
}

export async function setBudgets(values: Record<string, number | null | ''>) {
  await transaction(async (tx) => {
    for (const [cat, amt] of Object.entries(values)) {
      if (amt == null || amt === '') await run('DELETE FROM budgets WHERE category=?', [cat], tx)
      else await run(`INSERT INTO budgets(category, monthly, updated_at) VALUES (?,?,?)
        ON CONFLICT(category) DO UPDATE SET monthly=excluded.monthly, updated_at=excluded.updated_at`, [cat, Number(amt), nowLocalIso()], tx)
    }
  })
}

export async function budgetMonth(month?: string | null) {
  const t0 = today()
  month = month || t0.slice(0, 7)
  const [start, end] = monthBounds(month)
  const days = parts(end).d
  const elapsed = t0 > end ? days : t0 >= start ? Math.max(0, parts(t0).d) : 0
  const pace = elapsed / days
  const spent: Record<string, number> = Object.fromEntries((await analytics.byCategory(start, end)).map((r) => [r.category, r.amount]))
  const budgets = await getBudgets()
  const sugg = await suggestions()
  const catSet = new Set([...Object.keys(budgets), ...Object.keys(spent).filter((c) => !NOT_BUDGETED.has(c)), ...Object.keys(sugg)])
  const cats = [...catSet].sort()  // Python sorted() of a set, then by budget/suggestion (stable)
    .sort((a, b) => -(budgets[a] || sugg[a]?.suggested || 0) + (budgets[b] || sugg[b]?.suggested || 0))
  const rows = []
  for (const cat of cats) {
    const b = budgets[cat]
    const s = round(spent[cat] || 0, 2)
    if (!b && !sugg[cat] && s <= 0) continue
    let status: string | null = null
    if (b) status = s > b ? 'over' : s > b * pace * 1.1 && pace < 1 ? 'ahead_of_pace' : 'ok'
    rows.push({ category: cat, budget: b ?? null, spent: s, left: b ? round(b - s, 2) : null,
      suggested: sugg[cat]?.suggested ?? null, avg6: sugg[cat]?.avg ?? null, history: sugg[cat]?.history ?? [], status })
  }
  const moneyBack = round(-sum(Object.entries(spent).filter(([k, v]) => NOT_BUDGETED.has(k) && v < 0).map(([, v]) => v)), 2)
  const budgetedSpent = round(sum(rows.filter((r) => r.budget).map((r) => r.spent)), 2)
  const unbudgetedSpent = round(sum(rows.filter((r) => !r.budget && r.spent > 0).map((r) => r.spent)), 2)
  const totalBudget = round(sum(Object.values(budgets)), 2)
  const income = await monthlyTakeHome()
  return {
    month, pace: round(pace, 4), days, elapsed, rows, total_budget: totalBudget, budgeted_spent: budgetedSpent,
    unbudgeted_spent: unbudgetedSpent, money_back: moneyBack, net_spent: round(budgetedSpent + unbudgetedSpent - moneyBack, 2),
    take_home: income, left_after_budget: income ? round(income - totalBudget, 2) : null,
  }
}

// ---------- goals ----------

const goalRow = (r: any) => ({ ...r, config: JSON.parse(r.config || '{}') })

export async function listGoals(includeArchived = false) {
  return (await all('SELECT * FROM goals' + (includeArchived ? '' : ' WHERE archived=0') + ' ORDER BY created_at')).map(goalRow)
}

export async function saveGoal(g: any) {
  const gid = g.id || crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  await run(`INSERT INTO goals(id, type, name, target, target_date, config, created_at, archived)
      VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,
      target=excluded.target, target_date=excluded.target_date, config=excluded.config`,
    [gid, g.type, g.name, g.target ?? null, g.target_date || null, JSON.stringify(g.config || {}), nowLocalIso()])
  return gid
}

export async function archiveGoal(gid: string) { await run('UPDATE goals SET archived=1 WHERE id=?', [gid]) }

export async function addContribution(gid: string, amount: number, day?: string | null, note?: string | null, windfallId?: string | null) {
  await run('INSERT INTO goal_contribs(goal_id, date, amount, note, windfall_id) VALUES (?,?,?,?,?)', [gid, day || today(), Number(amount), note ?? null, windfallId ?? null])
}

const mon = (d: string | null) => (d ? bYear(d) : '—')

function monthsUntil(d: string | null) {
  if (!d) return null
  const t = parts(d), n = parts(today())
  return Math.max(0, (t.y - n.y) * 12 + (t.m - n.m))
}

async function accountsList() { return await all('SELECT account_id, institution, name, type, subtype, balance, source FROM accounts') }

async function typicalMonthlySpend() {
  const months = lastFullMonths(6)
  const [start] = monthBounds(months[0]); const [, end] = monthBounds(months[months.length - 1])
  const per: Record<string, number> = Object.fromEntries((await analytics.cashflow(start, end, 'month')).periods.map((p: any) => [p.period, p.spend]))
  return round(median(months.map((m) => per[m] || 0)), 2)
}

async function contributions(accountIds: string[], start: string, end?: string) {
  if (!accountIds.length) return 0.0
  const q = `SELECT COALESCE(SUM(-t.amount),0) FROM transactions t JOIN txn_class k USING(txn_id)
      WHERE t.account_id IN (${accountIds.map(() => '?').join(',')}) AND k.kind='invest_contribution'
      AND t.amount < 0 AND t.date >= ?` + (end ? ' AND t.date <= ?' : '')
  return round(await scalar(q, [...accountIds, start, ...(end ? [end] : [])]), 2)
}

async function requiredExtraForDate(targetDate: string, pmi = false) {
  const reaches = async (extra: number) => {
    const s = await mortgage.summary(extra)
    const when = pmi ? s.pmi.request_date_projected : s.payoff_projected
    return !!when && when <= targetDate
  }
  if (await reaches(0)) return 0.0
  let lo = 0.0, hi = 20000.0
  if (!(await reaches(hi))) return null
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2
    if (await reaches(mid)) hi = mid; else lo = mid
  }
  return round(Math.ceil(hi / 10) * 10, 2)
}

const rothIds = (accts: any[]) => accts.filter((a) => a.type === 'investment' && (a.subtype || '').toLowerCase().includes('roth')).map((a) => a.account_id)

async function goalProgress(g: any, rothCurrent: number) {
  const t = g.type, cfg = g.config, t0 = today()
  const out: any = { current: 0.0, target: g.target ?? null, detail: '', monthly_needed: null, on_track: null }
  let monthsLeft = monthsUntil(g.target_date)
  const accts = await accountsList()
  if (t === 'emergency') {
    const ids = cfg.accounts || accts.filter((a) => a.type === 'depository' && a.source !== 'venmo').map((a) => a.account_id)
    const cur = round(sum(accts.filter((a) => ids.includes(a.account_id)).map((a) => a.balance || 0)), 2)
    const monthly = await typicalMonthlySpend()
    const target = !g.target ? round((cfg.months || 6) * monthly, 2) : g.target
    Object.assign(out, { current: cur, target, detail: `${cfg.months || 6} months × $${commas(monthly)} typical monthly spending` })
  } else if (t === 'roth') {
    const cur = await contributions(rothIds(accts), `${parts(t0).y}-01-01`)
    if (!g.target_date) monthsLeft = 12 - parts(t0).m + 1
    Object.assign(out, { current: cur, detail: `contributed to your Roth IRA in ${parts(t0).y}` })
  } else if (t === 'investing') {
    const inv = accts.filter((a) => a.type === 'investment').map((a) => a.account_id)
    const cur = await contributions(inv, `${t0.slice(0, 7)}-01`)
    Object.assign(out, { current: cur, detail: 'moved into investment accounts this month', target: g.target ?? null })
    if (g.target) {
      out.monthly_needed = round(Math.max(0, g.target - cur), 2)
      const pace = parts(t0).d / 30
      out.on_track = cur >= g.target * Math.min(pace, 1) * 0.9
    }
    out.pct = g.target ? round(cur / g.target, 4) : null
    return out
  } else if (t === 'mortgage') {
    const s = await mortgage.summary()
    if (!s) { out.detail = 'No mortgage set up.'; return out }
    const pmi = (cfg.kind || 'pmi') === 'pmi'
    const startBal = s.config.original_amount
    const targetBal = pmi ? s.pmi.request_at_balance : 0.0
    const paid = startBal - s.balance, need = startBal - targetBal
    const when = pmi ? s.pmi.request_date_projected : s.payoff_projected
    Object.assign(out, { current: round(paid, 2), target: round(need, 2),
      detail: pmi ? `PMI can come off at $${commas(targetBal)} balance — on pace for ${mon(when)}` : `on pace to be paid off ${mon(when)}`,
      projected_date: when })
    if (g.target_date) {
      const extra = await requiredExtraForDate(g.target_date, pmi)
      out.monthly_needed = extra
      out.on_track = extra === 0
      out.detail += extra === 0 ? '' : extra != null ? ` · pay about $${commas(extra)}/mo extra to reach it by ${mon(g.target_date)}` : ' · not reachable by that date'
    }
    out.pct = need ? round(paid / need, 4) : null
    return out
  } else if (t === 'custom') {
    const cur = await scalar('SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=?', [g.id])
    Object.assign(out, { current: round(cur + (cfg.starting || 0), 2), detail: 'set aside so far' })
  }
  const tgt = out.target
  if (tgt) {
    out.pct = round(Math.min(out.current / tgt, 1.0), 4)
    const remaining = Math.max(0.0, tgt - out.current)
    if (monthsLeft != null) {
      out.monthly_needed = remaining ? round(remaining / Math.max(monthsLeft, 1), 2) : 0.0
      out.on_track = remaining === 0 || (await recentMonthlyRate(g, rothCurrent)) >= out.monthly_needed * 0.9
    }
    out.remaining = round(remaining, 2)
  }
  return out
}

async function recentMonthlyRate(g: any, rothCurrent: number) {
  const t = g.type
  if (t === 'roth') return rothCurrent / Math.max(parts(today()).m, 1)
  if (t === 'custom') {
    const s = await scalar('SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=? AND date >= ?', [g.id, addDays(today(), -90)])
    return s / 3
  }
  if (t === 'emergency') {
    const months = lastFullMonths(3)
    const [start] = monthBounds(months[0]); const [, end] = monthBounds(months[months.length - 1])
    return Math.max(0.0, (await analytics.cashflow(start, end)).total.saved / 3)
  }
  return 0.0
}

export async function goalsWithProgress() {
  const out = []
  for (const g of await listGoals()) {
    const rothCurrent = g.type === 'roth' ? await contributions(rothIds(await accountsList()), `${parts(today()).y}-01-01`) : 0
    out.push({ ...g, progress: await goalProgress(g, rothCurrent) })
  }
  return out
}

// ---------- windfalls ----------

const WINDFALL_MIN = 250.0

async function detectWindfalls() {
  const floor = (await analytics.historyStart()) || '0000'
  const found: any[] = []
  for (const r of await all(`SELECT t.txn_id, t.date, t.name, -t.amount AS amount, k.kind FROM transactions t
      JOIN txn_class k USING(txn_id) WHERE k.flow='income' AND t.date >= ?
      AND k.kind IN ('tax_refund','other_income') AND -t.amount >= ? ORDER BY t.seq`, [floor, WINDFALL_MIN])) {
    found.push({ id: `w-${r.txn_id}`, txn_id: r.txn_id, date: r.date, amount: round(r.amount, 2), label: r.kind === 'tax_refund' ? 'Tax refund' : String(r.name).slice(0, 40), source: r.kind })
  }
  for (const e of await analytics.detectedIncome()) {
    for (const b of e.bonuses) {
      if (b.date >= floor && b.bonus >= WINDFALL_MIN) {
        found.push({ id: `b-${e.employer}-${b.date}`, txn_id: null, date: b.date, amount: b.bonus, label: `${titleCase(e.employer)} bonus`, source: 'bonus' })
      }
    }
  }
  for (const w of found) {
    await run(`INSERT INTO windfalls(id, txn_id, date, label, amount, source) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, date=excluded.date`, [w.id, w.txn_id, w.date, w.label, w.amount, w.source])
  }
}
const titleCase = (s: string) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

async function defaultSplit() {
  const split = await getJson<any[]>('windfall_split', null)
  if (split) return split
  const openGoals: Record<string, string> = {}
  for (const g of await goalsWithProgress()) if ((g.progress.pct || 0) < 1 && !(g.type in openGoals)) openGoals[g.type] = g.id
  const weights: [string, number][] = [['emergency', 40], ['roth', 30], ['mortgage', 30], ['custom', 20]]
  const guess: any[] = weights.filter(([t]) => t in openGoals).map(([t, w]) => ({ target: openGoals[t], pct: w }))
  if (!('roth' in openGoals)) guess.push({ target: 'invest', pct: 30 })
  guess.push({ target: 'fun', pct: 20 })
  const total = sum(guess.map((x) => x.pct))
  for (const x of guess) x.pct = round(x.pct * 100 / total)
  guess[guess.length - 1].pct += 100 - sum(guess.map((x) => x.pct))
  return guess
}

export async function windfalls() {
  await detectWindfalls()
  const split = await defaultSplit()
  const goals = Object.fromEntries((await listGoals()).map((g) => [g.id, g.name]))
  const rows = await all('SELECT * FROM windfalls WHERE dismissed=0 ORDER BY date DESC')
  for (const w of rows) {
    w.plan = w.plan ? JSON.parse(w.plan) : null
    w.suggested = split.map((s: any) => ({ target: s.target, label: goals[s.target] ?? (s.target === 'fun' ? 'Spend / fun' : s.target), pct: s.pct, amount: round(w.amount * s.pct / 100, 2) }))
  }
  return { split, items: rows }
}

export async function planWindfall(wid: string, plan: any[]) {
  const goals = Object.fromEntries((await listGoals()).map((g) => [g.id, g]))
  const w = await one('SELECT * FROM windfalls WHERE id=?', [wid])
  if (!w) return
  await run('DELETE FROM goal_contribs WHERE windfall_id=?', [wid])
  await run("UPDATE windfalls SET plan=?, status='planned' WHERE id=?", [JSON.stringify(plan), wid])
  for (const p of plan) {
    const g = goals[p.target]
    if (g && g.type === 'custom' && p.amount) await addContribution(g.id, p.amount, w.date, `from ${w.label}`, wid)
  }
}

export async function markWindfall(txnId: string, label?: string | null) {
  const t = await one('SELECT date, name, amount FROM transactions WHERE txn_id=?', [txnId])
  if (!t) return
  await run(`INSERT INTO windfalls(id, txn_id, date, label, amount, source) VALUES (?,?,?,?,?, 'manual') ON CONFLICT(id) DO NOTHING`,
    [`m-${txnId}`, txnId, t.date, label || String(t.name).slice(0, 40), round(Math.abs(t.amount), 2)])
}

export async function dismissWindfall(wid: string) {
  await run('UPDATE windfalls SET dismissed=1 WHERE id=?', [wid])
  await run('DELETE FROM goal_contribs WHERE windfall_id=?', [wid])
}

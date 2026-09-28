// Retirement & goals planner. Runs year by year in today's dollars (returns minus inflation).
// Four buckets with their own rules: cash (interest), brokerage (taxed gains, usable anytime),
// Roth IRA (your deposits usable anytime, growth after 59½), 401(k) (after 59½, taxed on the way out).

export interface PlanSettings {
  birth_year: number | null; retire_age: number; plan_to_age: number
  cash_monthly: number | null; brokerage_monthly: number | null; roth_yearly: number | null; k401_yearly: number | null
  stock_return: number; inflation: number; cash_apy: number | null; home_growth: number | null
  salary_growth: number; spend_change_pct: number; healthcare_yearly: number; ss_monthly: number; ss_age: number
  tax_401k: number; tax_brokerage: number; cash_floor_months: number
}
export interface PlanGoal { id: string; type: string; name: string; target: number | null; target_date: string | null; current: number | null; monthly_needed: number | null }
export interface PlanInputs {
  today: string
  buckets: { cash: number; cash_gross: number; cards: number; brokerage: number; brokerage_basis: number; roth: number; roth_basis: number; k401: number; k401_estimated: boolean }
  cash_apy: number
  avg: { take_home_month: number | null; income_month: number; spend_month: number; saved_month: number; invested_month: number; brokerage_month: number; spend_year: number }
  roth_this_year: number; roth_limit: number; k401_yearly: number; k401_limit: number
  mortgage: { balance: number; pi_monthly: number; escrow_monthly: number; payoff: string; by_year: { year: number; balance: number }[] } | null
  home: { value: number; source: string; stats: { expected_real: number; low_real: number; high_real: number } | null } | null
  goals: PlanGoal[]
  categories: { category: string; avg: number; suggested: number }[]
  budgets: Record<string, number>
  settings: PlanSettings
}

/** Settings with blanks filled from your own data. */
export function resolved(inp: PlanInputs, s: PlanSettings = inp.settings) {
  const r50 = (n: number) => Math.max(0, Math.round(n / 50) * 50)
  return {
    ...s,
    cash_monthly: s.cash_monthly ?? r50(inp.avg.saved_month - inp.avg.invested_month),
    brokerage_monthly: s.brokerage_monthly ?? r50(inp.avg.brokerage_month),
    roth_yearly: s.roth_yearly ?? Math.min(inp.roth_this_year || inp.roth_limit, inp.roth_limit),
    k401_yearly: s.k401_yearly ?? Math.round(inp.k401_yearly),
    cash_apy: s.cash_apy ?? inp.cash_apy,
    home_growth: s.home_growth ?? inp.home?.stats?.expected_real ?? 1,
  }
}
export type Plan = ReturnType<typeof resolved>

export interface YearRow {
  year: number; age: number; retired: boolean
  cash: number; brokerage: number; roth: number; k401: number; liquid: number; home: number
  need: number; ss: number; withdrawn: Record<string, number>; shortfall: number; purchases: string[]
}

export interface SimResult {
  rows: YearRow[]; success: boolean; runsOutAge: number | null; endLiquid: number
  atRetire: YearRow | null; accessibleAtRetire: number; lockedAtRetire: number
  needAtRetire: number; bridgeYears: number
}

const EARLY = 59.5

/** Yearly spending you'd need at a given age: today's spending (adjusted), no mortgage payment once it's paid off,
 *  healthcare before Medicare at 65, minus Social Security once it starts. */
export function needAt(inp: PlanInputs, p: Plan, year: number, age: number) {
  let spend = inp.avg.spend_year * (1 + p.spend_change_pct / 100)
  const payoffYear = inp.mortgage ? +inp.mortgage.payoff.slice(0, 4) : 0
  if (inp.mortgage && year > payoffYear) spend -= inp.mortgage.pi_monthly * 12
  if (age < 65) spend += p.healthcare_yearly
  const ss = age >= p.ss_age ? p.ss_monthly * 12 : 0
  return { spend: Math.max(spend, 0), ss }
}

export function simulate(inp: PlanInputs, p: Plan, opt: { retireAge?: number; extraMonthly?: number; returnShift?: number; noCash?: boolean } = {}): SimResult {
  const y0 = +inp.today.slice(0, 4)
  const age0 = p.birth_year ? y0 - p.birth_year : 30
  const retireAge = opt.retireAge ?? p.retire_age
  const rs = (p.stock_return + (opt.returnShift ?? 0) - p.inflation) / 100
  const rc = ((p.cash_apy ?? 0) - p.inflation) / 100
  const b = { ...inp.buckets }
  let rothBasis = b.roth_basis
  const owed = new Map((inp.mortgage?.by_year || []).map((m) => [m.year, m.balance]))
  const purchases = inp.goals.filter((g) => g.type === 'custom' && g.target && g.target_date && g.target_date.slice(0, 4) >= String(y0))
  const rows: YearRow[] = []
  let runsOutAge: number | null = null, atRetire: YearRow | null = null
  let accessibleAtRetire = 0, lockedAtRetire = 0, needAtRetire = 0

  for (let k = 0; age0 + k <= p.plan_to_age; k++) {
    const year = y0 + k, age = age0 + k
    const retired = age >= retireAge
    const withdrawn: Record<string, number> = {}
    let shortfall = 0
    const bought: string[] = []
    if (!retired) {
      const grow = Math.pow(1 + p.salary_growth / 100, k)
      const cashIn = (opt.noCash ? 0 : p.cash_monthly) * 12
      const brokIn = (p.brokerage_monthly + (opt.extraMonthly ?? 0)) * 12
      b.cash = b.cash * (1 + rc) + cashIn * (1 + rc / 2)
      b.brokerage = b.brokerage * (1 + rs) + brokIn * (1 + rs / 2)
      b.roth = b.roth * (1 + rs) + p.roth_yearly * (1 + rs / 2); rothBasis += p.roth_yearly
      b.k401 = b.k401 * (1 + rs) + p.k401_yearly * grow * (1 + rs / 2)
    } else {
      b.cash *= 1 + rc; b.brokerage *= 1 + rs; b.roth *= 1 + rs; b.k401 *= 1 + rs
    }
    // Big purchases from your Goals, paid in their target year: cash first, then brokerage.
    for (const g of purchases.filter((g) => +g.target_date!.slice(0, 4) === year)) {
      let amt = Math.max((g.target || 0) - (g.current || 0), 0)
      const fromCash = Math.min(amt, Math.max(b.cash, 0)); b.cash -= fromCash; amt -= fromCash
      const fromBrok = Math.min(amt, Math.max(b.brokerage, 0)); b.brokerage -= fromBrok; amt -= fromBrok
      bought.push(g.name)
      if (amt > 1) shortfall += amt
    }
    const { spend, ss } = needAt(inp, p, year, age)
    let need = retired ? Math.max(spend - ss, 0) : 0
    if (retired && !atRetire) {
      needAtRetire = spend
      accessibleAtRetire = b.cash + b.brokerage + Math.min(rothBasis, b.roth)
      lockedAtRetire = b.k401 + Math.max(b.roth - rothBasis, 0)
    }
    if (need > 0) {
      const floor = (p.cash_floor_months / 12) * spend
      const take = (key: 'cash' | 'brokerage' | 'roth' | 'k401', limit: number, tax = 0) => {
        if (need <= 0) return
        const grossNeed = need / (1 - tax)
        const g = Math.max(Math.min(grossNeed, limit), 0)
        b[key] -= g; need -= g * (1 - tax)
        withdrawn[key] = (withdrawn[key] || 0) + g
        if (key === 'roth') rothBasis = Math.max(rothBasis - g, 0)
      }
      take('cash', b.cash - floor)
      take('brokerage', b.brokerage, p.tax_brokerage / 100)
      if (age >= EARLY) { take('k401', b.k401, p.tax_401k / 100); take('roth', b.roth) }
      else take('roth', Math.min(rothBasis, b.roth))
      take('cash', b.cash) // dip into the cushion last
      if (need > 1) shortfall += need
    }
    if (shortfall > 1 && runsOutAge == null) runsOutAge = age
    const homeEq = inp.home ? inp.home.value * Math.pow(1 + (p.home_growth ?? 0) / 100, k) - (k === 0 ? (inp.mortgage?.balance ?? 0) : (owed.get(year) ?? 0)) : 0
    const row: YearRow = {
      year, age, retired, cash: b.cash, brokerage: b.brokerage, roth: b.roth, k401: b.k401,
      liquid: b.cash + b.brokerage + b.roth + b.k401, home: homeEq, need: retired ? spend : 0, ss: retired ? ss : 0,
      withdrawn, shortfall, purchases: bought,
    }
    if (retired && !atRetire) atRetire = row
    rows.push(row)
  }
  const last = rows[rows.length - 1]
  return {
    rows, success: runsOutAge == null, runsOutAge, endLiquid: last?.liquid ?? 0, atRetire,
    accessibleAtRetire, lockedAtRetire, needAtRetire, bridgeYears: Math.max(0, EARLY - retireAge),
  }
}

/** Earliest age the money lasts to the end of the plan (null if never before 75). */
export function earliestAge(inp: PlanInputs, p: Plan, opt: { returnShift?: number; extraMonthly?: number } = {}) {
  const age0 = p.birth_year ? +inp.today.slice(0, 4) - p.birth_year : 30
  for (let a = age0 + 1; a <= 75; a++) if (simulate(inp, p, { ...opt, retireAge: a }).success) return a
  return null
}

/** Extra invested per month (on top of the plan) needed to retire at `age`. 0 if already fine, null if > $20k/mo. */
export function extraNeeded(inp: PlanInputs, p: Plan, age: number) {
  if (simulate(inp, p, { retireAge: age }).success) return 0
  let lo = 0, hi = 20000
  if (!simulate(inp, p, { retireAge: age, extraMonthly: hi }).success) return null
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (simulate(inp, p, { retireAge: age, extraMonthly: mid }).success) hi = mid; else lo = mid }
  return Math.ceil(hi / 10) * 10
}

/** Least you'd need to save each month (Roth first up to its limit, then brokerage; 401(k) as set) to retire at `age`. */
export function retirementNeed(inp: PlanInputs, p: Plan, age: number) {
  const withMonthly = (m: number): Plan => ({ ...p, cash_monthly: 0, roth_yearly: Math.min(m * 12, inp.roth_limit), brokerage_monthly: Math.max(m - inp.roth_limit / 12, 0) })
  const ok = (m: number) => simulate(inp, withMonthly(m), { retireAge: age }).success
  if (ok(0)) return 0
  let lo = 0, hi = 20000
  if (!ok(hi)) return null
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid }
  return Math.ceil(hi / 10) * 10
}

// ---------- goals -> budgets ----------

/** Categories you can't easily trim month to month; recommendations leave them alone. */
export const ESSENTIAL = new Set(['Housing', 'Bills & Utilities', 'Health', 'Loan Payments', 'Taxes & Donations', 'Insurance', 'Childcare', 'Education', 'Transfers out', 'Investing'])

export interface Demand { key: string; name: string; deadline: string | null; monthly: number; funded: number; kind: 'goal' | 'retirement' }

/** Fund goals soonest deadline first, retirement last. Returns what's funded and the monthly gap. */
export function allocate(available: number, demands: Omit<Demand, 'funded'>[]) {
  const order = [...demands].sort((a, b) => (a.kind === 'retirement' ? 1 : 0) - (b.kind === 'retirement' ? 1 : 0) || (a.deadline || '9999').localeCompare(b.deadline || '9999'))
  let left = Math.max(available, 0)
  const out: Demand[] = order.map((d) => { const f = Math.min(d.monthly, left); left -= f; return { ...d, funded: f } })
  const need = demands.reduce((s, d) => s + d.monthly, 0)
  // if you already spend more than you take home, the gap includes that too
  return { demands: out, gap: Math.max(need - available, 0), surplus: Math.max(available - need, 0) }
}

/** Trim flexible categories (up to `maxCut` of each, bigger categories first in proportion) to free `gap` a month. */
export function recommendBudgets(cats: { category: string; avg: number }[], gap: number, maxCut = 0.35) {
  const flex = cats.filter((c) => !ESSENTIAL.has(c.category) && c.avg > 15)
  const room = flex.reduce((s, c) => s + c.avg * maxCut, 0)
  const share = room > 0 ? Math.min(gap / room, 1) : 0
  const rows = flex.map((c) => {
    const cut = c.avg * maxCut * share
    return { category: c.category, avg: c.avg, budget: Math.max(Math.floor((c.avg - cut) / 10) * 10, 0), cut }
  }).filter((r) => r.cut >= 5)
  const freed = rows.reduce((s, r) => s + (r.avg - r.budget), 0)
  return { rows, freed, unmet: Math.max(gap - freed, 0) }
}

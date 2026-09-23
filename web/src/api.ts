// Thin wrapper around the Flask API. Every call sends the session cookie; a 401 bounces to the PIN screen.

export type Flow = 'spend' | 'income' | 'refund' | 'transfer' | 'growth' | 'ignore'

export interface Account {
  account_id: string
  item_id: string | null
  source: 'plaid' | 'venmo' | 'manual'
  institution: string | null
  name: string
  mask: string | null
  type: 'depository' | 'investment' | 'credit' | 'loan' | 'other'
  subtype: string | null
  balance: number | null
  updated_at: string
  liab_kind: string | null
  apr: number | null
  min_payment: number | null
  next_due: string | null
  item_status: string | null
}

export interface Item {
  item_id: string
  institution: string | null
  status: string
  error: string | null
  last_synced: string | null
}

export interface Holding {
  account_id: string
  ticker: string | null
  name: string | null
  quantity: number
  value: number | null
  cost_basis: number | null
}

export interface Totals {
  income: number
  spend: number
  spend_gross: number
  refunds: number
  saved: number
  savings_rate: number | null
  invested: number
  growth: number
  paychecks: number
  retirement?: number
}

export interface Summary {
  net_worth: number
  assets: number
  debts: number
  this_month: Totals
  review_count: number
  accounts: Account[]
  holdings: Holding[]
  items: Item[]
  last_sync: string | null
  env: string
}

export interface Txn {
  txn_id: string
  date: string
  name: string
  amount: number // positive = money out
  pending: number
  account_id: string
  institution: string | null
  account_name: string | null
  flow: Flow
  kind: string
  category: string
  review: number
  reason: string
  pair_id: string | null
  note: string | null
}

export interface CategoryRow { category: string; amount: number; n: number }
export interface AccountFlow extends Totals {
  account_id: string; institution: string; name: string; type: string
  transfers_in: number; transfers_out: number; n: number
}
export interface Coverage { account_id: string; institution: string; name: string; first: string | null; last: string | null; n: number }
export interface Rule { id: number; pattern: string; account_id: string | null; direction: string | null; set_flow: string | null; set_category: string | null }

export interface Employer {
  employer: string; deposits: number; first: string; last: string; active: boolean
  frequency: string | null; typical_paycheck: number; annualized: number | null; last_12_months: number
  accounts: string[]; history: { date: string; amount: number }[]
  bonuses: { date: string; total: number; bonus: number }[]
}
export interface PayPeriod {
  effective: string; gross_annual: number; net_per_paycheck: number
  retirement_pct: number; employer_match_pct: number; pay_frequency: string
}
export interface IncomeSettings {
  gross_annual?: number; net_per_paycheck?: number; retirement_pct?: number; employer_match_pct?: number
  pay_frequency?: string; employer?: string; match_notes?: string; notes?: string; annual_net?: number
  effective?: string
}
type PayLines = { gross: number; retirement: number; taxes_and_other: number; take_home: number; employer_match: number }
export interface IncomeCheck {
  settings: IncomeSettings
  breakdown: { periods_per_year: number; per_paycheck: PayLines; per_year: PayLines; effective_tax_rate: number | null } | null
  ytd: { paychecks: number; take_home: number; expected_take_home?: number; gross?: number; retirement?: number; employer_match?: number }
  detected: Employer[]
  warning: string | null
  history: PayPeriod[]
}

export interface Range { start?: string; end?: string; accounts?: string[] }

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const isForm = opts.body instanceof FormData
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: isForm ? opts.headers : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (r.status === 401) {
    window.location.href = '/login'
    throw new Error('locked')
  }
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as { error?: string }).error || `Request failed (${r.status})`)
  return body as T
}

export function qs(params: Record<string, string | number | undefined | null | string[]>) {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
    u.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ''
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' })

export interface MortgageRow { n: number; date: string; principal: number; interest: number; balance: number; extra?: number; projected?: boolean; rate?: number; your_pi?: number; subsidy?: number }
export interface MortgagePayment { txn_id: string | null; date: string; amount: number; institution: string; scheduled: number; extra: number }
export interface Mortgage {
  config: {
    lender: string; servicer: string; original_amount: number; note_rate: number; term_months: number
    closing_date: string; first_payment: string; buydown_rates: number[]; escrow_monthly: number; pmi_monthly: number
    taxes_monthly?: number; insurance_monthly?: number; original_value: number; appraised_value?: number; current_value?: number | null
    checkpoints: { date: string; balance: number }[]
  } | null
  balance: number; original_balance_now: number; ahead_by: number; paid_off_pct: number
  principal_paid: number; interest_paid: number; extra_principal: number; total_paid: number
  paid_through_payment: number; paid_through_date: string | null
  payoff_original: string; payoff_projected: string; months_saved: number
  interest_original: number; interest_projected: number; interest_saved: number
  note_pi: number; current_due: number; rate_now: number
  home_value: number; equity: number; ltv: number
  pmi: { request_at_balance: number; auto_at_balance: number; request_date_projected: string | null; auto_date_projected: string | null; request_date_original: string | null; monthly: number }
  payments: MortgagePayment[]
  original: MortgageRow[]
  actual: MortgageRow[]
  years: { year: string; principal: number; interest: number; extra: number; end_balance: number }[]
}

export interface BudgetRow {
  category: string; budget: number | null; spent: number; left: number | null
  suggested: number | null; avg6: number | null; history: { month: string; amount: number }[]
  status: 'ok' | 'ahead_of_pace' | 'over' | null
}
export interface BudgetMonth {
  month: string; pace: number; days: number; elapsed: number; rows: BudgetRow[]
  total_budget: number; budgeted_spent: number; unbudgeted_spent: number; money_back: number; net_spent: number
  take_home: number | null; left_after_budget: number | null
}
export type GoalType = 'emergency' | 'roth' | 'investing' | 'mortgage' | 'custom'
export interface Goal {
  id: string; type: GoalType; name: string; target: number | null; target_date: string | null
  config: { months?: number; accounts?: string[]; kind?: 'pmi' | 'payoff'; starting?: number }
  progress: { current: number; target: number | null; pct?: number | null; remaining?: number; detail: string
    monthly_needed: number | null; on_track: boolean | null; projected_date?: string }
}
export interface Windfall {
  id: string; txn_id: string | null; date: string; label: string; amount: number; source: string
  status: string; plan: { target: string; amount: number }[] | null
  suggested: { target: string; label: string; pct: number; amount: number }[]
}
export interface Windfalls { split: { target: string; pct: number }[]; items: Windfall[] }

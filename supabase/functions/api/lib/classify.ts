// Decide what every transaction really is (port of classify.py), so money moving between your own accounts is
// never counted as spending or income. Priority: your per-transaction fix > your rules > automatic detection.
// Rebuilt from scratch on every sync/import; results live in the txn_class table.
import { all, getJson, run, transaction } from './db.ts'
import { commas, diffDays, median, round } from './util.ts'
import { employerKey } from './analytics.ts'
import * as mortgage from './mortgage.ts'

const PAIR_WINDOW_DAYS = 5
const INVEST_PAIR_WINDOW_DAYS = 10

export const CATEGORY_NAMES: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink', GENERAL_MERCHANDISE: 'Shopping', TRANSPORTATION: 'Transportation', TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities', ENTERTAINMENT: 'Entertainment', PERSONAL_CARE: 'Personal Care', MEDICAL: 'Health',
  GENERAL_SERVICES: 'Services', HOME_IMPROVEMENT: 'Home', LOAN_PAYMENTS: 'Loan Payments', BANK_FEES: 'Fees',
  GOVERNMENT_AND_NON_PROFIT: 'Taxes & Donations', INCOME: 'Income', TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer', OTHER: 'Other',
}

// Names that mean "one of my own accounts". Extended at runtime with linked institution names.
const OWN_ALIASES: Record<string, string[]> = {
  Robinhood: ['robinhood'], Wealthfront: ['wealthfront'], Betterment: ['betterment'],
  Fidelity: ['fidelity'], Vanguard: ['vanguard'], 'Charles Schwab': ['schwab'], 'E*TRADE': ['etrade', 'e*trade'],
  Chase: ['chase'], 'Bank of America': ['bank of america', 'bofa'], 'Wells Fargo': ['wells fargo', 'wf bank'],
  Citi: ['citibank', 'citi card'], 'Capital One': ['capital one'], Ally: ['ally bank'],
  'American Express': ['american express', 'amex'], Discover: ['discover'],
  Venmo: ['venmo'], Empower: ['empower'],
}

const PAYROLL_RE = /payroll|direct dep|salary|\bpayrl\b|\bach credit\b.*payroll/i
const P2P_RE = /\bzelle\b|money transfer authorized .* apple|apple cash|cash app|\bpaypal\b/i
const MORTGAGE_RE = /mortgage|home loan|loancare|mr\\.? cooper/i // plus your servicer, from the Mortgage page settings
const VERIFY_RE = /acctverify|acct verify|verification|verify|micro[- ]?deposit|trial deposit|ach test/i
const ATM_OUT_RE = /atm withdrawal|non-wf atm withdrawal/i

type T = Record<string, any>
type C = { flow: string; kind: string; category: string; pair_id: string | null; review: number; reason: string; locked: boolean }

function ownPatterns(institutions: Set<string>) {
  const pats: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(OWN_ALIASES)) pats[k] = [...v]
  for (const inst of institutions) (pats[inst] ??= []).push(inst.toLowerCase())
  return pats
}

function mentionsOwn(t: T, own: Record<string, string[]>) {
  const text = `${t.name || ''} ${t.counterparty || ''}`.toLowerCase()
  for (const [inst, words] of Object.entries(own)) {
    if (inst === t.acct_inst) continue
    if (words.some((w) => text.includes(w))) return inst
  }
  return null
}

function transferLike(t: T) {
  return ['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'].includes(t.raw_primary || '') ||
    (t.source === 'plaid_inv' && ['deposit', 'withdrawal', 'contribution', 'transfer'].includes(t.txn_type || '')) ||
    (t.source === 'venmo' && (t.txn_type || '').toLowerCase().includes('transfer'))
}

const baseCategory = (t: T) => (t.source === 'venmo' ? 'Venmo' : CATEGORY_NAMES[t.raw_primary || ''] ?? (t.category || 'Other'))

function auto(t: T, own: Record<string, string[]>, servicer: RegExp): [string, string, string, number, string] {
  const out = t.amount > 0
  const name: string = t.name || ''
  const detailed = t.detailed || ''
  const primary = t.raw_primary || ''
  const cat = baseCategory(t)

  if (Math.abs(t.amount) < 2 && VERIFY_RE.test(name)) return ['ignore', 'verification', 'Ignored', 0, 'account-verification micro-deposit — not real income or spending']
  if (t.source === 'import' && name.startsWith('ACH transfer')) return ['transfer', 'internal', 'Transfer', 0, 'transfer you started to/from your own bank']

  if (t.source === 'plaid_inv') {
    const st = t.txn_type || ''
    if (['deposit', 'contribution', 'withdrawal', 'transfer', 'distribution'].includes(st)) return ['transfer', !out ? 'invest_contribution' : 'invest_withdrawal', 'Investing', 0, 'investment cash move']
    if (st.includes('dividend') || st === 'interest') return ['growth', st.replace(/ /g, '_'), 'Investment growth', 0, 'earned inside account']
    if (st.includes('fee') || st === 'tax withheld') return ['spend', 'invest_fee', 'Fees', 0, 'investment fee']
    return ['transfer', 'invest_other', 'Investing', 1, `unrecognized investment type '${st}'`]
  }

  if (t.source === 'venmo') {
    const vt = (t.txn_type || '').toLowerCase()
    if (vt.includes('transfer')) return ['transfer', out ? 'venmo_cashout' : 'venmo_topup', 'Transfer', 0, 'Venmo ↔ bank']
    if (out) return ['spend', vt === 'payment' ? 'p2p' : 'purchase', vt === 'payment' ? 'Sent to people' : 'Shopping', 0, 'Venmo']
    return ['refund', 'p2p', 'Paybacks from people', 0, 'Venmo payment received — counted as a payback']
  }

  const target = ['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'].includes(primary) ? mentionsOwn(t, own) : null
  if (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' || (t.acct_type === 'credit' && primary === 'LOAN_PAYMENTS' && !out)) return ['transfer', 'card_payment', 'Credit card payment', 0, 'credit card payment']
  if (target === 'Venmo' && out) return ['spend', 'venmo_unmatched', 'Venmo', 1, "Venmo charge — import that month's Venmo CSV to see what it was"]
  if (target) {
    let kind = ['Robinhood', 'Empower'].includes(target) && out ? 'invest_contribution' : 'internal'
    if (['Robinhood', 'Empower'].includes(target) && !out) kind = 'invest_withdrawal'
    return ['transfer', kind, kind.startsWith('invest') ? 'Investing' : 'Transfer', 0, `to/from your ${target} account`]
  }

  if (detailed === 'LOAN_PAYMENTS_MORTGAGE_PAYMENT' || (primary === 'LOAN_PAYMENTS' && (MORTGAGE_RE.test(name) || servicer.test(name)))) return ['spend', 'mortgage', 'Housing', 0, 'mortgage payment']
  if (primary === 'LOAN_PAYMENTS' && out) return ['spend', 'loan_payment', 'Loan Payments', 0, 'loan payment']

  if (primary === 'INCOME' || (!out && PAYROLL_RE.test(name))) {
    if (detailed === 'INCOME_WAGES' || PAYROLL_RE.test(name)) return ['income', 'paycheck', 'Paycheck', 0, 'payroll deposit']
    if (detailed === 'INCOME_INTEREST_EARNED' || name.toLowerCase().includes('interest')) return ['income', 'interest', 'Interest', 0, 'interest']
    if (name.toLowerCase().includes('tax ref') || name.toLowerCase().includes('irs treas')) return ['income', 'tax_refund', 'Tax refund', 0, 'tax refund']
    if (t.acct_type === 'credit') return ['refund', 'refund', 'Refund', 0, 'credit on card']
    return ['income', 'other_income', 'Other income', 1, 'one-off deposit — is this income?']
  }

  if (P2P_RE.test(name)) {
    if (out) return ['spend', 'p2p', 'Sent to people', 0, 'Zelle / Apple Cash']
    return ['refund', 'p2p', 'Paybacks from people', 0, 'Zelle / Apple Cash received — counted as a payback']
  }
  if (out && ATM_OUT_RE.test(name)) return ['spend', 'cash', 'Cash', 0, 'ATM withdrawal']
  if (primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT') {
    if (out) return ['spend', 'external_transfer', 'Transfers out', 1, "transfer to an account the app doesn't know"]
    return ['income', 'external_transfer', 'Deposits', 1, "deposit from an account the app doesn't know"]
  }
  if (out) return ['spend', 'purchase', cat, 0, 'purchase']
  return ['refund', 'refund', cat, 0, 'money back']
}

function ruleMatch(t: T, rules: T[]) {
  const text = `${t.name || ''} ${t.counterparty || ''}`.toLowerCase()
  for (const r of rules) {
    if (!text.includes(r.pattern.toLowerCase())) continue
    if (r.account_id && r.account_id !== t.account_id) continue
    if ((r.direction === 'out' && t.amount <= 0) || (r.direction === 'in' && t.amount >= 0)) continue
    return r
  }
  return null
}

function pairTransfers(txns: T[], cls: Map<string, C>) {
  const byAmt = new Map<number, T[]>()
  for (const t of txns) {
    const c = cls.get(t.txn_id)!
    if (c.locked && c.flow !== 'transfer') continue
    if (c.flow === 'ignore' || ['p2p', 'cash', 'paycheck', 'mortgage'].includes(c.kind)) continue
    if ((t.amount && transferLike(t)) || c.flow === 'transfer') {
      const k = round(Math.abs(t.amount), 2)
      if (!byAmt.has(k)) byAmt.set(k, [])
      byAmt.get(k)!.push(t)
    }
  }
  const used = new Set<string>()
  for (const group of byAmt.values()) {
    const outs = group.filter((t) => t.amount > 0)
    const ins = group.filter((t) => t.amount < 0)
    const candidates: [number, T, T][] = []
    for (const o of outs) for (const i of ins) if (o.account_id !== i.account_id) candidates.push([Math.abs(diffDays(o.date.slice(0, 10), i.date.slice(0, 10))), o, i])
    candidates.sort((a, b) => a[0] - b[0]) // stable, like Python's sorted(key=gap)
    for (const [gap, o, i] of candidates) {
      const window = o.acct_type === 'investment' || i.acct_type === 'investment' ? INVEST_PAIR_WINDOW_DAYS : PAIR_WINDOW_DAYS
      if (gap > window || used.has(o.txn_id) || used.has(i.txn_id)) continue
      used.add(o.txn_id); used.add(i.txn_id)
      const oc = cls.get(o.txn_id)!, ic = cls.get(i.txn_id)!
      let kind: string
      if (oc.kind === 'card_payment' || ic.kind === 'card_payment' || i.acct_type === 'credit') kind = 'card_payment'
      else if (i.acct_type === 'investment') kind = 'invest_contribution'
      else if (o.acct_type === 'investment') kind = 'invest_withdrawal'
      else kind = 'internal'
      for (const [t, other] of [[o, i], [i, o]] as [T, T][]) {
        const c = cls.get(t.txn_id)!
        if (c.locked) continue
        Object.assign(c, {
          flow: 'transfer', kind, pair_id: other.txn_id, review: 0,
          category: kind === 'card_payment' ? 'Credit card payment' : kind.startsWith('invest') ? 'Investing' : 'Transfer',
          reason: `matched with ${other.acct_inst || 'another account'} on ${other.date}`,
        })
      }
    }
  }
}

function pairVenmoFunding(txns: T[], cls: Map<string, C>) {
  const bank = txns.filter((t) => cls.get(t.txn_id)!.kind === 'venmo_unmatched' && !cls.get(t.txn_id)!.locked)
  const venmo = txns.filter((t) => t.source === 'venmo' && t.amount > 0 && !(t.funding_source || 'venmo balance').toLowerCase().includes('venmo balance'))
  const used = new Set<string>()
  for (const b of bank) {
    let best: [number, T] | null = null
    for (const v of venmo) {
      if (used.has(v.txn_id) || round(v.amount, 2) !== round(b.amount, 2)) continue
      const gap = Math.abs(diffDays(v.date.slice(0, 10), b.date.slice(0, 10)))
      if (gap <= PAIR_WINDOW_DAYS && (best == null || gap < best[0])) best = [gap, v]
    }
    if (best) {
      used.add(best[1].txn_id)
      Object.assign(cls.get(b.txn_id)!, { flow: 'transfer', kind: 'venmo_funding', category: 'Transfer', review: 0, pair_id: best[1].txn_id, reason: 'paid for a Venmo payment (counted in Venmo)' })
    }
  }
}

function checkPaySchedule(txns: T[], cls: Map<string, C>) {
  let pay = txns.filter((t) => cls.get(t.txn_id)!.kind === 'paycheck' && !cls.get(t.txn_id)!.locked)
  for (const t of pay) {
    if (-t.amount < 5) Object.assign(cls.get(t.txn_id)!, { flow: 'ignore', kind: 'test_deposit', category: 'Ignored', review: 0, reason: 'tiny test deposit from payroll setup — not counted' })
  }
  pay = pay.filter((t) => cls.get(t.txn_id)!.kind === 'paycheck')
  const days = new Map<string, Map<string, T[]>>() // employer -> date -> [txns]
  for (const t of pay) {
    const emp = employerKey(t.name), d = t.date.slice(0, 10)
    if (!days.has(emp)) days.set(emp, new Map())
    const m = days.get(emp)!
    if (!m.has(d)) m.set(d, [])
    m.get(d)!.push(t)
  }
  for (const byDay of days.values()) {
    const order = [...byDay.keys()].sort()
    if (order.length < 3) continue
    const totals = new Map(order.map((d) => [d, -byDay.get(d)!.reduce((s, t) => s + t.amount, 0)]))
    order.forEach((d, i) => {
      const near = order.slice(Math.max(0, i - 4), i + 5).filter((o) => o !== d).map((o) => totals.get(o)!)
      const typical = median(near)
      const total = totals.get(d)!
      const onSchedule = order.some((o) => o !== d && [7, 14].some((gap) => Math.abs(Math.abs(diffDays(d, o)) - gap) <= 5))
      for (const t of byDay.get(d)!) {
        const c = cls.get(t.txn_id)!
        if (total > 1.5 * typical && total - typical >= 1000 && onSchedule) {
          Object.assign(c, { kind: 'paycheck_bonus', category: 'Paycheck + bonus', reason: `about $${commas(total - typical)} more than your usual $${commas(typical)} paycheck — likely a bonus` })
        } else if (total < 0.6 * typical) {
          Object.assign(c, { flow: 'refund', kind: 'reimbursement', category: 'Reimbursements', review: 1, reason: 'off-schedule deposit from your employer — reimbursement or bonus?' })
        }
      }
    })
  }
}

export async function run_() {
  const txns = await all(`SELECT t.*, a.type AS acct_type, a.institution AS acct_inst
      FROM transactions t LEFT JOIN accounts a ON a.account_id = t.account_id ORDER BY t.seq`)
  const overrides = new Map((await all('SELECT * FROM txn_overrides')).map((r) => [r.txn_id, r]))
  const rules = await all('SELECT * FROM rules ORDER BY id DESC')
  const institutions = new Set((await all('SELECT DISTINCT institution FROM accounts')).map((r) => r.institution).filter(Boolean) as string[])
  const pat = ((await getJson<any>('mortgage', {})) || {}).match_pattern
  const servicer = pat ? new RegExp(pat, 'i') : /(?!x)x/
  const own = ownPatterns(institutions)
  const cls = new Map<string, C>()
  for (const t of txns) {
    const ov = overrides.get(t.txn_id)
    const rule = ruleMatch(t, rules)
    let [flow, kind, cat, review, reason] = auto(t, own, servicer)
    let locked = false
    if (rule) {
      flow = rule.set_flow || flow; cat = rule.set_category || cat
      kind = 'rule'; review = 0; reason = `your rule: '${rule.pattern}'`; locked = !!rule.set_flow
    }
    if (ov) {
      flow = ov.flow || flow; cat = ov.category || cat
      kind = 'manual'; review = 0; reason = 'you set this'; locked = !!ov.flow
    }
    cls.set(t.txn_id, { flow, kind, category: cat, pair_id: null, review, reason, locked })
  }
  pairTransfers(txns, cls)
  pairVenmoFunding(txns, cls)
  checkPaySchedule(txns, cls)
  await transaction(async (tx) => {
    await run('DELETE FROM txn_class', [], tx)
    const rows = [...cls.entries()]
    for (let i = 0; i < rows.length; i += 500) { // multi-row inserts keep this fast
      const chunk = rows.slice(i, i + 500)
      const ph = chunk.map(() => '(?,?,?,?,?,?,?)').join(',')
      await run(`INSERT INTO txn_class(txn_id, flow, kind, category, pair_id, review, reason) VALUES ${ph}`,
        chunk.flatMap(([id, v]) => [id, v.flow, v.kind, v.category, v.pair_id, v.review, v.reason]), tx)
    }
  })
  await mortgage.refreshAllocations()
  return cls.size
}
export { run_ as run }

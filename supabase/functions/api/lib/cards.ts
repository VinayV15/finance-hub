// Credit cards: what each card is for, which card to use for what, how much you've earned and missed, and what
// cards and banks cost you. Reward rules are per card product (not per person); your cards are matched by name.
import { all, getJson, setJson } from './db.ts'
import { FROM } from './analytics.ts'
import { addDays, round, sum, today } from './util.ts'

export type Cat = 'grocery' | 'gas' | 'online' | 'dining' | 'travel' | 'travel_portal' | 'other'

export const CAT_LABEL: Record<Cat, string> = {
  grocery: 'Groceries (U.S. supermarkets)', gas: 'Gas (U.S. stations)', online: 'Online shopping (U.S. retail)',
  dining: 'Restaurants & coffee', travel: 'Travel (booked directly)', travel_portal: 'Travel via Capital One Travel', other: 'Everything else',
}

interface Earn { rate: number; unit: 'cash' | 'miles'; cap?: number } // rate per $; cap = $ per calendar year at that rate
interface Profile {
  key: string; name: string; match: RegExp; annual_fee: number; foreign_fee: number
  earn: Partial<Record<Cat, Earn>> & { other: Earn }
  meant_for: string; use_for: string[]; avoid_for: string[]
  perks: { label: string; detail: string; value?: number }[]
}

// Product terms as of 2026 (issuer sites; check them if something looks off). Annual values are what you'd get
// if you use the perk; the page lets you say which ones you actually use.
export const PROFILES: Profile[] = [
  {
    key: 'venture_x', name: 'Capital One Venture X', match: /venture\s*x/i, annual_fee: 395, foreign_fee: 0,
    earn: {
      travel_portal: { rate: 5, unit: 'miles' }, // 10x hotels & rental cars, 5x flights & vacation rentals via Capital One Travel
      travel: { rate: 2, unit: 'miles' },
      other: { rate: 2, unit: 'miles' },
    },
    meant_for: 'Your everyday card for anything that isn\'t a 3% Amex category, all travel, and anything abroad.',
    use_for: [
      'Restaurants, coffee, bills, subscriptions, and shopping in stores (2 miles per $1)',
      'Hotels and rental cars booked through Capital One Travel (10 miles per $1), flights there (5 per $1)',
      'Anything in another currency: no foreign transaction fee (the Amex charges 2.7%)',
      'Rental cars: decline the counter insurance; the card\'s coverage is primary when you pay with it',
    ],
    avoid_for: ['Groceries, gas, and online shopping while the Amex 3% categories still have room under $6,000 a year'],
    perks: [
      { label: '$300 travel credit', detail: 'Each card year, for bookings made through Capital One Travel', value: 300 },
      { label: '10,000 anniversary miles', detail: 'Every account anniversary, no spending needed', value: 100 },
      { label: 'Global Entry / TSA PreCheck', detail: 'Up to $120 credit every 4 years', value: 30 },
      { label: 'Airport lounges', detail: 'Capital One Lounges and Priority Pass for you (guests and authorized users cost extra since Feb 2026)' },
      { label: 'Travel protections', detail: 'Primary rental car coverage, trip delay/cancellation, cell phone protection when you pay your bill with it' },
      { label: 'Miles', detail: '1¢ each to "erase" travel purchases; more when moved to airline/hotel partners (often 1.5–2¢)' },
    ],
  },
  {
    key: 'amex_bce', name: 'Amex Blue Cash Everyday', match: /blue cash everyday/i, annual_fee: 0, foreign_fee: 2.7,
    earn: {
      grocery: { rate: 0.03, unit: 'cash', cap: 6000 }, gas: { rate: 0.03, unit: 'cash', cap: 6000 },
      online: { rate: 0.03, unit: 'cash', cap: 6000 }, other: { rate: 0.01, unit: 'cash' },
    },
    meant_for: 'Your 3% card for groceries, gas, and online shopping, up to $6,000 a year in each.',
    use_for: [
      'U.S. supermarkets (3%; superstores like Walmart and Target don\'t count)',
      'U.S. gas stations (3%)',
      'U.S. online retail: Amazon and other online stores (3%)',
      'Disney+ bundle and Home Chef if you use them: monthly statement credits after enrolling',
    ],
    avoid_for: ['Restaurants, travel, bills, and everything else (only 1%; the Venture X earns 2 miles)', 'Anything abroad: 2.7% foreign transaction fee'],
    perks: [
      { label: 'Disney Bundle credit', detail: '$7 a month back on a $9.99+ Disney streaming bundle (enroll in the Amex app)', value: 84 },
      { label: 'Home Chef credit', detail: 'Up to $15 a month back (enroll first)', value: 180 },
      { label: 'Amex Offers', detail: 'Merchant deals in the Amex app; add them before you shop' },
      { label: 'No annual fee', detail: 'Free to keep open, which helps your credit history length' },
    ],
  },
  {
    key: 'amex_bcp', name: 'Amex Blue Cash Preferred', match: /blue cash preferred/i, annual_fee: 95, foreign_fee: 2.7,
    earn: { grocery: { rate: 0.06, unit: 'cash', cap: 6000 }, gas: { rate: 0.03, unit: 'cash' }, other: { rate: 0.01, unit: 'cash' } },
    meant_for: 'Groceries (6% up to $6,000/yr) and gas.', use_for: ['U.S. supermarkets', 'U.S. gas stations'], avoid_for: ['Travel abroad'], perks: [],
  },
]

const GENERIC: Profile = {
  key: 'generic', name: 'Other card', match: /$^/, annual_fee: 0, foreign_fee: 3, earn: { other: { rate: 0.01, unit: 'cash' } },
  meant_for: 'Assumed 1% back (its rewards aren\'t known to the app).', use_for: [], avoid_for: [], perks: [],
}

export const profileFor = (name: string | null, institution: string | null) =>
  PROFILES.find((p) => p.match.test(`${name || ''} ${institution || ''}`)) || GENERIC

/** Which reward category a purchase falls in, from Plaid's categories and how it was paid (online vs in store). */
export function categorize(t: { name: string; raw_primary: string | null; detailed: string | null; txn_type: string | null }): Cat {
  const d = t.detailed || '', p = t.raw_primary || '', name = (t.name || '').toLowerCase()
  if (/capital one travel/.test(name)) return 'travel_portal'
  if (d.startsWith('FOOD_AND_DRINK_GROCERIES')) return 'grocery'
  if (d === 'TRANSPORTATION_GAS') return 'gas'
  if (p === 'FOOD_AND_DRINK') return 'dining'
  if (p === 'TRAVEL') return 'travel'
  if (t.txn_type === 'online' && ['GENERAL_MERCHANDISE', 'HOME_IMPROVEMENT', 'PERSONAL_CARE'].includes(p)) return 'online'
  return 'other'
}

// Spending you can't (or wouldn't) put on a card: mortgage and loan payments, money sent to people, cash, taxes,
// investment fees, and transfers out to accounts the app doesn't know.
const CARDABLE = `k.flow='spend' AND k.kind NOT IN ('mortgage','loan_payment','p2p','cash','invest_fee','external_transfer','venmo_unmatched')
  AND COALESCE(t.raw_primary,'') NOT IN ('LOAN_PAYMENTS','TRANSFER_OUT','TRANSFER_IN')
  AND COALESCE(t.detailed,'') NOT LIKE 'GOVERNMENT_AND_NON_PROFIT_TAX%' AND t.amount > 0 AND t.source != 'venmo'`

type Settings = { mile_value: number; perks_used: Record<string, boolean> }
export async function settings(): Promise<Settings> {
  return { mile_value: 1.0, perks_used: {}, ...((await getJson<Settings>('card_settings', null)) || {}) }
}
export async function saveSettings(v: Partial<Settings>) {
  await setJson('card_settings', { ...(await settings()), ...v })
}

/** Value in dollars of earning on `p` for `amount` in `cat`, with a running per-year cap tally. */
function value(p: Profile, cat: Cat, amount: number, year: string, used: Map<string, number>, mileValue: number) {
  const e = p.earn[cat] || p.earn.other
  const per = (x: Earn) => (x.unit === 'miles' ? x.rate * mileValue / 100 : x.rate)
  if (!e.cap) return amount * per(e)
  const k = `${p.key}|${cat}|${year}`
  const room = Math.max(e.cap - (used.get(k) || 0), 0)
  const inCap = Math.min(room, amount)
  return inCap * per(e) + (amount - inCap) * per(p.earn.other)
}

export async function overview() {
  const s = await settings()
  const t0 = today()
  const since = addDays(t0, -365)
  const cards = await all(`SELECT a.account_id, a.name, a.institution, a.balance, a.credit_limit, a.mask,
      l.apr, l.min_payment, l.next_due, l.last_statement
    FROM accounts a LEFT JOIN liabilities l USING(account_id) WHERE a.type='credit' ORDER BY a.balance DESC`)
  const profiles = new Map(cards.map((c) => [c.account_id, profileFor(c.name, c.institution)]))
  const yourProfiles = [...new Map([...profiles.values()].map((p) => [p.key, p])).values()]
  const txns = await all(`SELECT t.txn_id, t.date, t.name, t.amount, t.account_id, t.raw_primary, t.detailed, t.txn_type,
      a.type AS acct_type, k.category ${FROM} WHERE ${CARDABLE} AND t.date >= ? ORDER BY t.date, t.seq`, [since])

  // Walk the year in order so caps fill up the way they would have.
  const usedActual = new Map<string, number>(), usedBest = new Map<string, number>()
  const byCat = new Map<Cat, any>()
  const byCard = new Map<string, { earned: number; spend: number }>()
  const missedTxns: any[] = []
  let onCards = 0, offCards = 0
  for (const t of txns) {
    const cat = categorize(t as { name: string; raw_primary: string | null; detailed: string | null; txn_type: string | null })
    const year = t.date.slice(0, 4)
    const prof = t.acct_type === 'credit' ? profiles.get(t.account_id) || GENERIC : null
    const actual = prof ? value(prof, cat, t.amount, year, usedActual, s.mile_value) : 0
    if (prof) {
      const e = prof.earn[cat] || prof.earn.other
      if (e.cap) usedActual.set(`${prof.key}|${cat}|${year}`, (usedActual.get(`${prof.key}|${cat}|${year}`) || 0) + t.amount)
      const bc = byCard.get(t.account_id) || { earned: 0, spend: 0 }
      bc.earned += actual; bc.spend += t.amount; byCard.set(t.account_id, bc)
      onCards += t.amount
    } else offCards += t.amount
    // best of your cards for this purchase
    let best = { key: '', name: 'a credit card', value: t.amount * 0.01 }
    for (const p of yourProfiles) {
      const v = value(p, cat, t.amount, year, usedBest, s.mile_value)
      if (v > best.value + 1e-9) best = { key: p.key, name: p.name, value: v }
    }
    const bp = yourProfiles.find((p) => p.key === best.key)
    if (bp) { const e = bp.earn[cat] || bp.earn.other; if (e.cap) usedBest.set(`${bp.key}|${cat}|${year}`, (usedBest.get(`${bp.key}|${cat}|${year}`) || 0) + t.amount) }
    const c = byCat.get(cat) || { category: cat, label: CAT_LABEL[cat], spend: 0, earned: 0, best_value: 0, best_card: {} as Record<string, number>, paid_with: {} as Record<string, number>, n: 0 }
    c.spend += t.amount; c.earned += actual; c.best_value += best.value; c.n++
    c.best_card[best.name] = (c.best_card[best.name] || 0) + t.amount
    const paidWith = prof ? prof.name : 'debit / bank'
    c.paid_with[paidWith] = (c.paid_with[paidWith] || 0) + t.amount
    byCat.set(cat, c)
    if (best.value - actual >= 1) missedTxns.push({ date: t.date, name: t.name, amount: t.amount, category: CAT_LABEL[cat], paid_with: paidWith, best_card: best.name, missed: round(best.value - actual, 2) })
  }
  const categories = [...byCat.values()].map((c) => ({
    ...c, spend: round(c.spend, 2), earned: round(c.earned, 2), best_value: round(c.best_value, 2), missed: round(c.best_value - c.earned, 2),
    best_card: Object.entries(c.best_card as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    paid_with: Object.entries(c.paid_with as Record<string, number>).map(([k, v]) => ({ card: k, amount: round(v, 2) })).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.spend - a.spend)

  // Amex-style caps: how much 3% room is left this calendar year.
  const year = t0.slice(0, 4)
  const caps: any[] = []
  for (const p of yourProfiles) for (const [cat, e] of Object.entries(p.earn) as [Cat, Earn][]) {
    if (!e.cap) continue
    const usedNow = usedActual.get(`${p.key}|${cat}|${year}`) || 0
    caps.push({ card: p.name, category: CAT_LABEL[cat], cap: e.cap, used: round(usedNow, 2), left: round(Math.max(e.cap - usedNow, 0), 2), rate: e.rate })
  }

  const cardRows = cards.map((c) => {
    const p = profiles.get(c.account_id)!
    const st = byCard.get(c.account_id) || { earned: 0, spend: 0 }
    const perkValue = sum(p.perks.filter((x) => x.value && (s.perks_used[`${p.key}|${x.label}`] ?? true)).map((x) => x.value!))
    const miles = p.key === 'venture_x' ? round(st.earned / (s.mile_value / 100)) : null
    return {
      account_id: c.account_id, name: c.name, mask: c.mask, profile: p.key, product: p.name,
      balance: c.balance, limit: c.credit_limit, utilization: c.credit_limit ? round((c.balance || 0) / c.credit_limit, 4) : null,
      apr: c.apr, min_payment: c.min_payment, next_due: c.next_due || null, last_statement: c.last_statement,
      annual_fee: p.annual_fee, foreign_fee: p.foreign_fee, perk_value: perkValue, net_cost: round(p.annual_fee - perkValue, 2),
      spend_12m: round(st.spend, 2), earned_12m: round(st.earned, 2), miles_12m: miles,
      meant_for: p.meant_for, use_for: p.use_for, avoid_for: p.avoid_for,
      perks: p.perks.map((x) => ({ ...x, used: s.perks_used[`${p.key}|${x.label}`] ?? true })),
      earn: Object.entries(p.earn).map(([cat, e]) => ({ category: CAT_LABEL[cat as Cat], rate: e!.rate, unit: e!.unit, cap: e!.cap ?? null })),
    }
  })

  // Fees and interest: what accounts cost you over the last 12 months.
  const costs = await all(`SELECT t.date, t.name, t.amount, a.name AS account, a.type AS acct_type,
      CASE WHEN lower(t.name) LIKE '%interest charge%' OR t.detailed LIKE 'BANK_FEES_INTEREST%' THEN 'Interest charged'
           WHEN lower(t.name) LIKE '%foreign transaction%' OR t.detailed = 'BANK_FEES_FOREIGN_TRANSACTION_FEES' THEN 'Foreign transaction fees'
           WHEN lower(t.name) LIKE '%late fee%' OR t.detailed = 'BANK_FEES_LATE_PAYMENT' THEN 'Late fees'
           WHEN lower(t.name) LIKE '%annual fee%' OR lower(t.name) LIKE '%membership fee%' THEN 'Annual fees'
           WHEN t.detailed LIKE 'BANK_FEES_ATM%' OR lower(t.name) LIKE '%atm fee%' THEN 'ATM fees'
           WHEN k.kind='invest_fee' THEN 'Investment fees'
           WHEN t.raw_primary='BANK_FEES' THEN 'Other bank fees' END AS kind
    ${FROM} WHERE t.date >= ? AND t.amount > 0 AND k.flow IN ('spend') AND (t.raw_primary='BANK_FEES' OR k.kind='invest_fee'
      OR lower(t.name) LIKE '%interest charge%' OR lower(t.name) LIKE '%late fee%' OR lower(t.name) LIKE '%annual fee%'
      OR lower(t.name) LIKE '%foreign transaction%' OR lower(t.name) LIKE '%membership fee%') ORDER BY t.date DESC`, [since])
  const costKinds = new Map<string, number>()
  for (const c of costs) costKinds.set(c.kind || 'Other bank fees', (costKinds.get(c.kind || 'Other bank fees') || 0) + c.amount)

  const earned = sum(cardRows.map((c) => c.earned_12m))
  const best = sum(categories.map((c) => c.best_value))
  return {
    settings: s, cards: cardRows, categories, caps,
    totals: { earned_12m: round(earned, 2), best_12m: round(best, 2), missed_12m: round(best - earned, 2),
      on_cards: round(onCards, 2), off_cards: round(offCards, 2), utilization: (() => {
        const lim = sum(cards.map((c) => c.credit_limit || 0)); return lim ? round(sum(cards.map((c) => c.balance || 0)) / lim, 4) : null
      })() },
    missed: missedTxns.sort((a, b) => b.missed - a.missed).slice(0, 15),
    costs: { total: round(sum(costs.map((c) => c.amount)), 2), by_kind: [...costKinds].map(([kind, amount]) => ({ kind, amount: round(amount, 2) })).sort((a, b) => b.amount - a.amount), items: costs.slice(0, 20) },
  }
}

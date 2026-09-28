export const money = (n: number | null | undefined, opts: { cents?: boolean; sign?: boolean } = {}) => {
  if (n == null || Number.isNaN(n)) return '—'
  const s = Math.abs(n).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: opts.cents === false ? 0 : 2, maximumFractionDigits: opts.cents === false ? 0 : 2,
  })
  if (n < 0) return `−${s}`
  return opts.sign && n > 0 ? `+${s}` : s
}

/** Compact axis labels: $1.2k, $15k, $1.1M */
export const moneyShort = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `$${Math.round(a)}`
  return n < 0 ? `−${s}` : s
}

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`)

export const iso = (d: Date) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-09' -> 'Sep 26', '2026-09-14' -> 'Sep 14', '2026-Q3' -> 'Q3 26', '2026' -> '2026' */
export const periodLabel = (p: string) => {
  if (/^\d{4}-Q\d$/.test(p)) return `${p.slice(5)} ${p.slice(2, 4)}`
  if (/^\d{4}-\d{2}$/.test(p)) return `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(2, 4)}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return `${MONTHS[+p.slice(5, 7) - 1]} ${+p.slice(8, 10)}`
  return p
}

export const niceDate = (s: string) => {
  const d = new Date(`${s}T00:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export const ago = (s: string | null) => {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.round(mins / 60)} hr ago`
  return `${Math.round(mins / 1440)} days ago`
}

export const FLOW_LABEL: Record<string, string> = {
  spend: 'Spending', income: 'Income', refund: 'Refund', transfer: 'Transfer', growth: 'Growth', ignore: 'Ignored',
}

/** False when the device asks for reduced motion: no count-ups, no chart draw-in. */
export const motionOK = typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** First and last day of a chart period: '2026-09', '2026-Q3', '2026', or a day/week-start date. */
export const periodRange = (p: string, group = 'month'): { start: string; end: string } => {
  const d = (y: number, m: number, day: number) => iso(new Date(y, m, day))
  if (/^\d{4}$/.test(p)) return { start: `${p}-01-01`, end: `${p}-12-31` }
  if (/^\d{4}-Q\d$/.test(p)) { const y = +p.slice(0, 4), q = +p.slice(6) - 1; return { start: d(y, q * 3, 1), end: d(y, q * 3 + 3, 0) } }
  if (/^\d{4}-\d{2}$/.test(p)) { const y = +p.slice(0, 4), m = +p.slice(5, 7) - 1; return { start: d(y, m, 1), end: d(y, m + 1, 0) } }
  if (group === 'week') { const s = new Date(`${p}T00:00:00`); const e = new Date(s); e.setDate(e.getDate() + 6); return { start: p, end: iso(e) } }
  return { start: p, end: p }
}

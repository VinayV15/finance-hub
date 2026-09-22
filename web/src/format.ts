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
  spend: 'Spending', income: 'Income', refund: 'Refund', transfer: 'Transfer', growth: 'Growth',
}

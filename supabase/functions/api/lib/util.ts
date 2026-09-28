// Helpers that reproduce Python behavior exactly, so numbers match the original app to the cent.

/** Python's round(): nearest, exact ties go to the even digit. Non-ties follow the float's exact value. */
export function round(x: number | null | undefined, n = 0): number {
  if (x == null || !Number.isFinite(x)) return x as number
  if (n < 0) { // round(353612, -2) -> 353600
    const m = 10 ** -n, v = x / m, f = Math.floor(v)
    return (v - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(v)) * m
  }
  const m = 10 ** n
  const v = x * m
  const f = Math.floor(v)
  if (v - f === 0.5) return (f % 2 === 0 ? f : f + 1) / m
  const r = Number(x.toFixed(n))
  return Object.is(r, -0) ? 0 : r
}

export const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)

/** statistics.median */
export function median(xs: number[]): number {
  if (!xs.length) throw new Error('median of empty list')
  const s = [...xs].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

/** statistics.mean */
export function mean(xs: number[]): number {
  if (!xs.length) throw new Error('mean of empty list')
  return sum(xs) / xs.length
}

/** statistics.quantiles(data, n=4) with the default 'exclusive' method. */
export function quartiles(data: number[]): number[] {
  const s = [...data].sort((a, b) => a - b)
  const n = 4, m = s.length + 1, out: number[] = []
  for (let i = 1; i < n; i++) {
    let j = Math.floor(i * m / n)
    j = Math.min(Math.max(j, 1), s.length - 1)
    const delta = i * m - j * n
    out.push((s[j - 1] * (n - delta) + s[j] * delta) / n)
  }
  return out
}

// ---------- dates (ISO 'YYYY-MM-DD' strings, computed in UTC so no timezone drift) ----------

const TZ = Deno.env.get('APP_TZ') || 'UTC' // your local timezone, set as a function secret

export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') // like Python isoformat(timespec="seconds") in UTC
}
export function nowLocalIso(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`
}

const toUtc = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10)
export const ymd = (y: number, m: number, d: number) => fromUtc(Date.UTC(y, m - 1, d)) // month 1-12, overflow ok

export function addDays(iso: string, n: number) { return fromUtc(toUtc(iso) + n * 864e5) }
export function diffDays(a: string, b: string) { return Math.round((toUtc(a) - toUtc(b)) / 864e5) } // a - b
export function parts(iso: string) { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return { y, m, d } }
/** Python-style weekday(): Monday = 0 … Sunday = 6 */
export function weekday(iso: string) { return (new Date(toUtc(iso)).getUTCDay() + 6) % 7 }
export function lastDayOfMonth(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate() }
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** strftime('%b %-d') */
export const bDay = (iso: string) => { const p = parts(iso); return `${MONTH_ABBR[p.m - 1]} ${p.d}` }
/** strftime('%b %Y') */
export const bYear = (iso: string) => { const p = parts(iso); return `${MONTH_ABBR[p.m - 1]} ${p.y}` }
export const isIsoDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s

// ---------- number formatting like Python f"{x:,.0f}" / f"{x:,.2f}" ----------
export function commas(x: number, digits = 0) {
  const r = round(x, digits)
  const [i, f] = Math.abs(r).toFixed(digits).split('.')
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (r < 0 ? '-' : '') + s + (f ? '.' + f : '')
}

/** Python str.title() */
export const title = (s: string) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

export function groupBy<T, K>(xs: T[], key: (x: T) => K) {
  const m = new Map<K, T[]>()
  for (const x of xs) { const k = key(x); const a = m.get(k); if (a) a.push(x); else m.set(k, [x]) }
  return m
}

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }
export const bad = (msg: string, status = 400) => new HttpError(status, msg)

/** float(str(v).replace(",", "").replace("$", "")) — throws on bad input like Python would. */
export function num(v: unknown): number {
  const s = String(v ?? '').replace(/,/g, '').replace(/\$/g, '').trim()
  if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error(`not a number: ${v}`)
  return parseFloat(s)
}

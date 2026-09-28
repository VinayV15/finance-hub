// Home value from the FHFA house price index for your metro area (port of home.py). Your purchase price
// moves with the index; a value you type on the Mortgage page always wins.
import { getJson, getMeta, setMeta } from './db.ts'
import { quartiles, round, today } from './util.ts'

const HPI_URL = 'https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_metro.csv'
const INFLATION = 2.5 // % a year, to turn market growth into today's dollars

type Series = [number, number, number][] // [year, quarter, index]
interface Hpi { cbsa: string; name: string; series: Series; fetched: string }

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

async function download(cbsa: string): Promise<Hpi> {
  const r = await fetch(HPI_URL, { headers: { 'User-Agent': 'finance-hub/1.0' } })
  if (!r.ok) throw new Error(`FHFA download failed (${r.status})`)
  const text = await r.text()
  let name: string | null = null
  const series: Series = []
  for (const line of text.split('\n')) {
    if (!line.includes(cbsa)) continue
    const row = parseCsvLine(line.trim())
    if (row.length < 5 || row[1].trim() !== cbsa) continue
    const y = parseInt(row[2]), q = parseInt(row[3]), v = parseFloat(row[4])
    if (Number.isNaN(y) || Number.isNaN(q) || Number.isNaN(v)) continue // early quarters are "-"
    series.push([y, q, v]); name = row[0]
  }
  if (!series.length) throw new Error(`No index rows for area ${cbsa}`)
  return { cbsa, name: name!, series, fetched: new Date().toISOString().slice(0, 19) }
}

/** The cached index, re-downloaded when older than 30 days (or on request). Falls back to the cache. */
export async function index(refresh = false): Promise<Hpi | null> {
  const cbsa = await getMeta('home_cbsa')
  if (!cbsa) return null
  let cached = await getJson<Hpi>('hpi')
  const age = (iso: string) => Date.now() - new Date(iso.length === 19 ? iso + 'Z' : iso).getTime()
  const stale = !cached || cached.cbsa !== cbsa || age(cached.fetched) > 30 * 864e5
  const failed = await getMeta('hpi_failed_at')
  const backoff = failed && age(failed) < 6 * 3600e3
  if (refresh || (stale && !backoff)) {
    try {
      cached = await download(cbsa)
      await setMeta('hpi', JSON.stringify(cached))
    } catch (e) { // offline or FHFA down: keep the cache, try again in 6 hours
      console.log(`[home] index download failed: ${e}`)
      await setMeta('hpi_failed_at', new Date().toISOString().slice(0, 19))
      if (!cached || cached.cbsa !== cbsa) return null
    }
  }
  return cached
}

const quarterOf = (iso: string) => { const [y, m] = iso.split('-').map(Number); return [y, Math.floor((m - 1) / 3) + 1] as const }
const le = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])

function idxAt(series: Series, yq: readonly [number, number]) {
  let best: number | null = null
  for (const [y, q, v] of series) if (le([y, q], yq)) best = v
  return best
}

const cagr = (a: number | undefined, b: number, years: number) => (a && b && years > 0 ? ((b / a) ** (1 / years) - 1) * 100 : null)

export function growthStats(series: Series) {
  const by = new Map(series.map(([y, q, v]) => [`${y}-${q}`, v]))
  const last = series[series.length - 1]
  const out: any = { latest_quarter: `${last[0]} Q${last[1]}` }
  for (const yrs of [1, 5, 10, 20, 30]) {
    const prev = by.get(`${last[0] - yrs}-${last[1]}`)
    out[`cagr_${yrs}y`] = prev ? round(cagr(prev, last[2], yrs)!, 2) : null
  }
  const rolling = series.filter(([y, q]) => by.has(`${y - 10}-${q}`)).map(([y, q, v]) => cagr(by.get(`${y - 10}-${q}`), v, 10)!)
  if (rolling.length >= 8) {
    const qs = quartiles(rolling)
    out.low_10y = round(qs[0], 2); out.high_10y = round(qs[2], 2)
  }
  const long = out.cagr_30y || out.cagr_20y || out.cagr_10y || 3.5
  out.expected_nominal = round(long, 2)
  out.expected_real = round(long - INFLATION, 2)
  out.low_real = round((out.low_10y || long - 2) - INFLATION, 2)
  out.high_real = round((out.high_10y || long + 2) - INFLATION, 2)
  return out
}

export async function estimate(cfg: any) {
  if (!cfg) return null
  const base = cfg.original_value || cfg.original_amount
  const closing = cfg.closing_date
  const hpi = await index()
  let idxValue: number | null = null, history: any = null, stats: any = null
  if (hpi && base && closing) {
    const s = hpi.series
    const baseIdx = idxAt(s, quarterOf(closing))
    if (baseIdx) {
      idxValue = round(base * s[s.length - 1][2] / baseIdx, -2)
      const y0 = Number(today().slice(0, 4))
      history = s.filter(([y]) => y >= y0 - 20).map(([y, q, v]) => ({ quarter: `${y} Q${q}`, value: round(base * v / baseIdx, -2) }))
      stats = growthStats(s)
    }
  }
  const manual = cfg.current_value
  return {
    value: manual || idxValue || cfg.appraised_value || base,
    source: manual ? 'manual' : idxValue ? 'index' : cfg.appraised_value ? 'appraisal' : 'purchase',
    index_value: idxValue, manual_value: manual ?? null, purchase_price: base, appraised_value: cfg.appraised_value ?? null,
    closing_date: closing, area: hpi ? hpi.name : null, fetched: hpi ? hpi.fetched : null,
    stats, history,
  }
}

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { money, moneyShort, motionOK, niceDate, periodLabel } from '../format'
import { GradDefs, HBarList } from './Charts'

export interface TxnChartData {
  measure: 'spend' | 'income'
  by_month: { month: string; category: string; amount: number }[]
  categories: { category: string; amount: number; n: number }[]
  merchants: { name: string; amount: number; n: number }[]
  daily: { date: string; amount: number; n: number }[]
}

// Categorical slots in fixed order (index.css --c1..--c7). Big categories keep their color whatever the filter,
// so a filter never repaints them; anything else takes the next free slot, and the rest folds into "Other".
const SLOTS = 7
const FIXED: Record<string, number> = {
  Housing: 0, 'Food & Drink': 1, Shopping: 2, Transportation: 3, Entertainment: 4, 'Bills & Utilities': 5, Services: 6,
}
const OTHER = 'Other'

function seriesFor(cats: { category: string; amount: number }[]) {
  const top = [...cats].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, SLOTS).map((c) => c.category)
  const used = new Set(top.map((c) => FIXED[c]).filter((i) => i != null))
  const free = [...Array(SLOTS).keys()].filter((i) => !used.has(i))
  return top.map((c) => ({ key: c, color: `var(--c${(FIXED[c] ?? free.shift()!) + 1})` }))
}

function monthsBetween(first: string, last: string) {
  const out: string[] = []
  let [y, m] = first.split('-').map(Number)
  const [ly, lm] = last.split('-').map(Number)
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

type MonthRow = Record<string, number | string> & { month: string; total: number }

function OverTimeTip({ active, payload, series }: { active?: boolean; payload?: { payload: MonthRow }[]; series: { key: string; color: string }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="tt">
      <div className="tt-head">{periodLabel(p.month)} · {money(p.total, { cents: false })}</div>
      {series.filter((s) => p[s.key]).map((s) => (
        <div className="tt-row" key={s.key}>
          <span><i className="swatch" style={{ background: s.color }} />{s.key}</span>
          <b className="num">{money(p[s.key] as number, { cents: false })}</b>
        </div>
      ))}
      <div className="tt-hint">Click a segment to see those transactions</div>
    </div>
  )
}

/** Each month's total, split by category (stacked). Money back (refunds, paybacks) stacks below zero. */
export function CategoryOverTime({ data, onPick }: { data: TxnChartData; onPick?: (month: string, category?: string) => void }) {
  const [table, setTable] = useState(false)
  if (!data.by_month.length) return <div className="empty">Nothing here for this range.</div>
  const base = seriesFor(data.categories)
  const keys = new Set(base.map((s) => s.key))
  const series = data.categories.some((c) => !keys.has(c.category)) ? [...base, { key: OTHER, color: 'var(--c-other)' }] : base
  const months = monthsBetween(data.by_month[0].month, data.by_month[data.by_month.length - 1].month)
  const rows: MonthRow[] = months.map((month) => ({ month, total: 0 }))
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  for (const r of data.by_month) {
    const row = byMonth.get(r.month)!
    const k = keys.has(r.category) ? r.category : OTHER
    row[k] = ((row[k] as number) || 0) + r.amount
    row.total += r.amount
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div className="legend">
          {series.map((s) => <span key={s.key}><i className="swatch" style={{ background: s.color }} />{s.key}</span>)}
        </div>
        <button className="link-btn" onClick={() => setTable(!table)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Month</th>{series.map((s) => <th key={s.key} className="r">{s.key}</th>)}<th className="r">Total</th></tr></thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.month}>
                  <td>{periodLabel(r.month)}</td>
                  {series.map((s) => <td key={s.key} className="r">{r[s.key] ? money(r[s.key] as number, { cents: false }) : '—'}</td>)}
                  <td className="r"><b>{money(r.total, { cents: false })}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="month" tickFormatter={periodLabel} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} minTickGap={12} />
            <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={52} />
            <ReferenceLine y={0} stroke="var(--line)" />
            <Tooltip content={<OverTimeTip series={series} />} cursor={{ fill: 'var(--surface-2)' }} />
            {series.map((s, i) => (
              <Bar key={s.key} isAnimationActive={motionOK} animationDuration={700} dataKey={s.key} stackId="a" fill={s.color} stroke="var(--surface)" strokeWidth={1.5}
                   maxBarSize={36} radius={i === series.length - 1 ? [6, 6, 0, 0] : 0} style={{ cursor: 'pointer' }}
                   onClick={(d: unknown) => { const m = (d as { payload?: MonthRow }).payload?.month; if (m) onPick?.(m, s.key === OTHER ? undefined : s.key) }} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Share of the total per category, with count and monthly average. */
export function CategoryBreakdown({ data, months, onPick }: { data: TxnChartData; months: number; onPick: (c: string) => void }) {
  return <HBarList rows={data.categories.map((c) => ({
    label: c.category, amount: c.amount,
    note: `${c.n} transactions · ${money(c.amount / Math.max(months, 1), { cents: false })} / month`,
  }))} onPick={onPick} />
}

export function TopMerchants({ data, onPick }: { data: TxnChartData; onPick: (n: string) => void }) {
  return <HBarList limit={10} rows={data.merchants.map((m) => ({
    label: m.name, amount: m.amount, note: `${m.n} ${m.n === 1 ? 'visit' : 'visits'} · ${money(m.amount / m.n)} each on average`,
  }))} onPick={onPick} />
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const dayIndex = (d: Date) => (d.getDay() + 6) % 7 // Monday = 0
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Calendar heatmap (one square per day, darker = more) plus the average for each day of the week. */
export function DailyPattern({ data, start, end, onPickDay }: { data: TxnChartData; start?: string; end?: string; onPickDay?: (day: string) => void }) {
  if (!data.daily.length) return <div className="empty">Nothing here for this range.</div>
  const amounts = new Map(data.daily.map((d) => [d.date, d]))
  const first = new Date(`${start && start > data.daily[0].date ? start : data.daily[0].date}T00:00:00`)
  const lastIso = end && end < isoDay(new Date()) ? end : isoDay(new Date())
  const last = new Date(`${lastIso}T00:00:00`)
  // Color steps: split the days with spending into 5 equal-size groups, so one big day doesn't wash out the rest.
  const pos = data.daily.map((d) => d.amount).filter((a) => a > 0).sort((a, b) => a - b)
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => pos[Math.floor(q * (pos.length - 1))] ?? 0)
  const step = (a: number) => (a <= 0 ? 0 : 1 + cuts.filter((c) => a > c).length)

  const weeks: (Date | null)[][] = []
  const perDow = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }))
  const cur = new Date(first)
  cur.setDate(cur.getDate() - dayIndex(cur))
  while (cur <= last) {
    const week: (Date | null)[] = []
    for (let i = 0; i < 7; i++) {
      const inRange = cur >= first && cur <= last
      week.push(inRange ? new Date(cur) : null)
      if (inRange) { perDow[i].days++; perDow[i].total += amounts.get(isoDay(cur))?.amount || 0 }
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(week)
  }
  const dow = perDow.map((d, i) => ({ day: DOW[i], avg: d.days ? d.total / d.days : 0 }))

  return (
    <div className="grid two">
      <div>
        <div className="heatmap-wrap">
          <div className="heatmap">
            <div className="heatmap-labels">{DOW.map((d, i) => <span key={d}>{i % 2 === 0 ? d : ''}</span>)}</div>
            {weeks.map((w, wi) => (
              <div key={wi} className="heatmap-col">
                {w.map((d, i) => {
                  if (!d) return <span key={i} className="hm-cell empty-cell" />
                  const row = amounts.get(isoDay(d))
                  const a = row?.amount || 0
                  return <button key={i} className={`hm-cell hm-${step(a)}`} onClick={() => onPickDay?.(isoDay(d))}
                                 aria-label={`${niceDate(isoDay(d))}: ${money(a)}`}
                                 title={`${niceDate(isoDay(d))}: ${money(a)}${row ? ` (${row.n} transactions)` : ''} · click to see them`} />
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="legend small" style={{ marginTop: 8 }}>
          <span>Less</span>{[0, 1, 2, 3, 4, 5].map((s) => <i key={s} className={`hm-cell hm-${s}`} />)}<span>More</span>
          <span className="muted">· hover a day for its total, click to see it</span>
        </div>
      </div>
      <div>
        <div className="muted small" style={{ marginBottom: 4 }}>Average per day of the week</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={dow} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="day" tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={48} />
            <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => active && payload?.length ? (
              <div className="tt"><div className="tt-head">{(payload[0].payload as { day: string }).day}</div>
                <div className="tt-row"><span>Average</span><b className="num">{money(payload[0].value as number)}</b></div></div>) : null} />
            <GradDefs />
            <Bar isAnimationActive={motionOK} animationDuration={700} dataKey="avg" fill="url(#g-seq)" radius={[8, 8, 3, 3]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

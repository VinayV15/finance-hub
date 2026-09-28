import { useState } from 'react'
import {
  Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine,
} from 'recharts'
import type { Totals } from '../api'
import { money, moneyShort, motionOK, pct, periodLabel } from '../format'

type Period = Totals & { period: string }

/** Vertical gradients for bar and area fills: full color at the top, fading toward the baseline.
 *  Drop inside any recharts chart, then use fill="url(#g-income)" etc. */
export function GradDefs() {
  const g = (id: string, color: string, from = 1, to = 0.45) => (
    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style={{ stopColor: color, stopOpacity: from }} />
      <stop offset="100%" style={{ stopColor: color, stopOpacity: to }} />
    </linearGradient>
  )
  return (
    <defs>
      {g('g-income', 'var(--s-income)')}
      {g('g-spend', 'var(--s-spend)')}
      {g('g-invest', 'var(--s-invest)')}
      {g('g-seq', 'var(--seq)')}
      {g('a-income', 'var(--s-income)', 0.45, 0)}
      {g('a-invest', 'var(--s-invest)', 0.5, 0)}
    </defs>
  )
}

const SERIES = [
  { key: 'income', label: 'Income', color: 'var(--s-income)', kind: 'bar' },
  { key: 'spend', label: 'Spending', color: 'var(--s-spend)', kind: 'bar' },
  { key: 'saved', label: 'Saved (income − spending)', color: 'var(--s-saved)', kind: 'line' },
] as const

function CashTooltip({ active, payload }: { active?: boolean; payload?: { payload: Period }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="tt">
      <div className="tt-head">{periodLabel(p.period)}</div>
      {SERIES.map((s) => (
        <div className="tt-row" key={s.key}>
          <span><i className="swatch" style={{ background: s.color }} />{s.label.split(' (')[0]}</span>
          <b className="num">{money(p[s.key], { cents: false })}</b>
        </div>
      ))}
      <div className="tt-row"><span><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested</span><b className="num">{money(p.invested, { cents: false })}</b></div>
      <div className="tt-row"><span>Savings rate</span><b className="num">{pct(p.savings_rate)}</b></div>
      <div className="tt-hint">Click a bar to see its transactions</div>
    </div>
  )
}

/** Income vs spending per period, with what was saved as a line. One $ axis. */
export function CashflowChart({ periods, height = 300, onPick }: {
  periods: Period[]; height?: number; onPick?: (period: string, flows?: string) => void
}) {
  const pick = (flows?: string) => onPick ? (d: unknown) => {
    const p = (d as { payload?: Period }).payload?.period
    if (p) onPick(p, flows)
  } : undefined
  const [table, setTable] = useState(false)
  if (!periods.length) return <div className="empty">No transactions in this range.</div>
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="legend">
          {SERIES.map((s) => (
            <span key={s.key}>
              <i className="swatch" style={s.kind === 'line' ? { background: s.color, height: 2, width: 14, borderRadius: 1 } : { background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <button className="link-btn" onClick={() => setTable(!table)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Period</th><th className="r">Income</th><th className="r">Spending</th><th className="r">Saved</th><th className="r">Rate</th><th className="r">Invested</th></tr></thead>
            <tbody>
              {[...periods].reverse().map((p) => (
                <tr key={p.period}>
                  <td>{periodLabel(p.period)}</td>
                  <td className="r">{money(p.income, { cents: false })}</td>
                  <td className="r">{money(p.spend, { cents: false })}</td>
                  <td className={`r ${p.saved < 0 ? 'neg' : ''}`}>{money(p.saved, { cents: false })}</td>
                  <td className="r">{pct(p.savings_rate)}</td>
                  <td className="r">{money(p.invested, { cents: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={periods} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
            <GradDefs />
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="period" tickFormatter={periodLabel} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} minTickGap={12} />
            <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={52} />
            <ReferenceLine y={0} stroke="var(--line)" />
            <Tooltip content={<CashTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
            <Bar isAnimationActive={motionOK} animationDuration={700} dataKey="income" fill="url(#g-income)" radius={[8, 8, 3, 3]} maxBarSize={26}
                 onClick={pick('income')} style={onPick ? { cursor: 'pointer' } : undefined} />
            <Bar isAnimationActive={motionOK} animationDuration={700} dataKey="spend" fill="url(#g-spend)" radius={[8, 8, 3, 3]} maxBarSize={26}
                 onClick={pick('spend,refund')} style={onPick ? { cursor: 'pointer' } : undefined} />
            <Line isAnimationActive={motionOK} animationDuration={700} dataKey="saved" stroke="var(--s-saved)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)', fill: 'var(--s-saved)' }} activeDot={{ r: 6, strokeWidth: 2, stroke: 'var(--surface)' }} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Ranked horizontal bars (one hue — magnitude, not identity). */
export function HBarList({ rows, onPick, limit = 12 }: {
  rows: { label: string; amount: number; note?: string }[]; onPick?: (label: string) => void; limit?: number
}) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, limit)
  const max = Math.max(...rows.map((r) => Math.abs(r.amount)), 1)
  const total = rows.reduce((s, r) => s + r.amount, 0)
  if (!rows.length) return <div className="empty">Nothing here for this range.</div>
  return (
    <div>
      {shown.map((r) => (
        <div key={r.label} className={`hbar${onPick ? ' clickable' : ''}`} onClick={() => onPick?.(r.label)}
             title={`${r.label}: ${money(r.amount)}${total ? ` (${pct(r.amount / total)})` : ''}`}>
          <span className="name">{r.label}</span>
          <div className="track"><div className="fill" style={{ width: `${(Math.abs(r.amount) / max) * 100}%` }} /></div>
          <span className="num small">{money(r.amount, { cents: false })}<span className="muted"> · {pct(total ? r.amount / total : 0)}</span></span>
          {r.note && <span className="small muted" style={{ gridColumn: '1 / -1', marginTop: -4 }}>{r.note}</span>}
        </div>
      ))}
      {rows.length > limit && <button className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${rows.length}`}</button>}
    </div>
  )
}

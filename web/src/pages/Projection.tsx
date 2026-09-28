import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Num } from '../components/Viz'
import { money, moneyShort, motionOK } from '../format'
import { useFetch } from '../hooks'

interface Inputs {
  cash: number; invested: number; k401_now: number; other_debt: number
  monthly_saved: number; monthly_invested: number; k401_per_year: number; annual_spending: number
  home_value: number; mortgage: number; mortgage_by_year: { year: number; balance: number }[]
}
type Row = { year: number; label: string; cash: number; invested: number; home: number; total: number; low: number; high: number }

/** Year-by-year, in today's dollars: cash earns a little, investments compound at the chosen return,
 *  the home grows at the chosen rate while the mortgage follows its schedule. */
function project(i: Inputs, p: { invest: number; cash: number; k401: number; ret: number; home: number; years: number }) {
  const y0 = new Date().getFullYear()
  const mortgage = new Map(i.mortgage_by_year.map((m) => [m.year, m.balance]))
  const run = (ret: number) => {
    let cash = i.cash - i.other_debt, inv = i.invested
    const out: { cash: number; inv: number }[] = [{ cash, inv }]
    for (let y = 1; y <= p.years; y++) {
      for (let m = 0; m < 12; m++) {
        inv = inv * (1 + ret / 100 / 12) + p.invest + p.k401 / 12
        cash = cash * (1 + 0.5 / 100 / 12) + p.cash
      }
      out.push({ cash, inv })
    }
    return out
  }
  const mid = run(p.ret), lo = run(p.ret - 2), hi = run(p.ret + 2)
  const rows: Row[] = mid.map((m, k) => {
    const yr = y0 + k
    const owed = k === 0 ? i.mortgage : (mortgage.get(yr) ?? 0)
    const home = i.home_value ? i.home_value * Math.pow(1 + p.home / 100, k) - owed : 0
    return {
      year: yr, label: String(yr), cash: m.cash, invested: m.inv, home,
      total: m.cash + m.inv + home, low: lo[k].cash + lo[k].inv + home, high: hi[k].cash + hi[k].inv + home,
    }
  })
  return rows
}

function Slider({ label, value, set, min, max, step, fmt, hint }: {
  label: string; value: number; set: (v: number) => void; min: number; max: number; step: number; fmt: (v: number) => string; hint?: string
}) {
  return (
    <label className="slider">
      <span className="slider-top"><span>{label}</span><b>{fmt(value)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)}
             style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} />
      {hint && <span className="muted small">{hint}</span>}
    </label>
  )
}

function ProjTip({ active, payload }: { active?: boolean; payload?: readonly { payload: Row }[] }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  return (
    <div className="tt"><div className="tt-head">{r.year}</div>
      <div className="tt-row"><span><i className="swatch" style={{ background: 'var(--s-invest)' }} />Investments</span><b className="num">{money(r.invested, { cents: false })}</b></div>
      <div className="tt-row"><span><i className="swatch" style={{ background: 'var(--c4)' }} />Home equity</span><b className="num">{money(r.home, { cents: false })}</b></div>
      <div className="tt-row"><span><i className="swatch" style={{ background: 'var(--s-income)' }} />Cash</span><b className="num">{money(r.cash, { cents: false })}</b></div>
      <div className="tt-row"><span><b>Net worth</b></span><b className="num">{money(r.total, { cents: false })}</b></div>
      <div className="tt-hint">range {moneyShort(r.low)} – {moneyShort(r.high)} (return ±2%)</div>
    </div>
  )
}

export function Projection() {
  const { data } = useFetch<Inputs>('/api/projection')
  const [p, setP] = useState<{ invest: number; cash: number; k401: number; ret: number; home: number; years: number } | null>(null)
  const params = p ?? (data ? {
    invest: Math.round(data.monthly_invested / 50) * 50, cash: Math.max(0, Math.round((data.monthly_saved - data.monthly_invested) / 50) * 50),
    k401: Math.round(data.k401_per_year / 500) * 500, ret: 5, home: 1, years: 30,
  } : null)
  const rows = data && params ? project(data, params) : []  // cheap: 30 years x 12 months x 3 runs
  if (!data || !params) return <div className="empty">Loading…</div>
  const set = (k: keyof typeof params) => (v: number) => setP({ ...params, [k]: v })
  const at = (n: number) => rows[Math.min(n, rows.length - 1)]
  const fi = data.annual_spending * 25
  const fiRow = rows.find((r) => r.cash + r.invested >= fi)
  const payoff = data.mortgage_by_year.find((m) => m.balance <= 1)?.year
  const milestones = [250e3, 500e3, 1e6, 2e6].map((t) => ({ t, row: rows.find((r) => r.total >= t) })).filter((m) => m.row && m.row.year > rows[0].year)
  // What an extra $100/month is worth by the end.
  const plus = project(data, { ...params, invest: params.invest + 100 })
  const extra100 = plus[plus.length - 1].total - rows[rows.length - 1].total
  const pctFmt = (v: number) => `${v}%`

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projection</h1>
          <div className="muted small">Where today's habits lead, in today's dollars (after inflation). An illustration to plan with, not a prediction or advice.</div>
        </div>
        <div className="seg">{[10, 20, 30].map((y) => <button key={y} className={params.years === y ? 'on' : ''} onClick={() => set('years')(y)}>{y} years</button>)}</div>
      </div>

      <div className="tiles">
        {[10, 20, 30].filter((n) => n <= params.years).map((n) => (
          <div key={n} className="tile"><div className="label">In {n} years ({rows[0].year + n})</div>
            <div className="value"><Num v={at(n).total} /></div>
            <div className="sub">{moneyShort(at(n).low)} – {moneyShort(at(n).high)} depending on returns</div></div>
        ))}
        <div className="tile"><div className="label">Financial independence</div>
          <div className="value">{fiRow ? fiRow.year : `${rows[rows.length - 1].year}+`}</div>
          <div className="sub">when cash + investments reach {moneyShort(fi)} (25× your {moneyShort(data.annual_spending)} yearly spending)</div></div>
      </div>

      <div className="grid proj-grid">
        <div className="card">
          <div className="group-head"><h2>Net worth, year by year</h2>
            <div className="legend" style={{ margin: 0 }}>
              <span><i className="swatch" style={{ background: 'var(--s-invest)' }} />Investments</span>
              <span><i className="swatch" style={{ background: 'var(--c4)' }} />Home equity</span>
              <span><i className="swatch" style={{ background: 'var(--s-income)' }} />Cash</span>
              <span><i className="swatch" style={{ background: 'transparent', border: '1.5px dashed var(--text-2)' }} />Range</span>
            </div></div>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <defs>
                {[['pj-inv', 'var(--s-invest)'], ['pj-home', 'var(--c4)'], ['pj-cash', 'var(--s-income)']].map(([id, c]) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: c, stopOpacity: 0.85 }} /><stop offset="100%" style={{ stopColor: c, stopOpacity: 0.35 }} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={60} />
              <Tooltip content={(t) => <ProjTip active={t.active} payload={t.payload as unknown as { payload: Row }[]} />} cursor={{ stroke: 'var(--line-strong)' }} />
              <Area dataKey="cash" stackId="a" stroke="var(--s-income)" fill="url(#pj-cash)" isAnimationActive={motionOK} animationDuration={700} type="monotone" />
              <Area dataKey="home" stackId="a" stroke="var(--c4)" fill="url(#pj-home)" isAnimationActive={motionOK} animationDuration={700} type="monotone" />
              <Area dataKey="invested" stackId="a" stroke="var(--s-invest)" fill="url(#pj-inv)" isAnimationActive={motionOK} animationDuration={700} type="monotone" />
              <Line dataKey="low" stroke="var(--text-2)" strokeDasharray="4 4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              <Line dataKey="high" stroke="var(--text-2)" strokeDasharray="4 4" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2>Try changes</h2>
          <Slider label="Invested each month" value={params.invest} set={set('invest')} min={0} max={5000} step={50} fmt={(v) => money(v, { cents: false })}
                  hint={`you've averaged ${money(data.monthly_invested, { cents: false })}/mo lately`} />
          <Slider label="Added to cash each month" value={params.cash} set={set('cash')} min={0} max={3000} step={50} fmt={(v) => money(v, { cents: false })} />
          <Slider label="401(k), you + match, per year" value={params.k401} set={set('k401')} min={0} max={40000} step={500} fmt={(v) => money(v, { cents: false })}
                  hint={`your pay settings give ${money(data.k401_per_year, { cents: false })}`} />
          <Slider label="Investment return (after inflation)" value={params.ret} set={set('ret')} min={0} max={10} step={0.5} fmt={pctFmt}
                  hint="long-run stock-heavy portfolios have been around 5–7%; the dashed lines show ±2%" />
          <Slider label="Home value growth (after inflation)" value={params.home} set={set('home')} min={-2} max={5} step={0.5} fmt={pctFmt} />
          <button className="link-btn" onClick={() => setP(null)}>Reset to my numbers</button>
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Milestones</h2>
          {milestones.map((m) => (
            <div key={m.t} className="row"><div className="row-main"><div className="row-title">{moneyShort(m.t)} net worth</div></div><div className="row-amt">{m.row!.year}</div></div>
          ))}
          {payoff && <div className="row"><div className="row-main"><div className="row-title">Mortgage paid off</div><div className="muted small">on your current schedule</div></div><div className="row-amt">{payoff}</div></div>}
          {fiRow && <div className="row"><div className="row-main"><div className="row-title">Financial independence</div><div className="muted small">investments could cover your spending at a 4% withdrawal rate</div></div><div className="row-amt">{fiRow.year}</div></div>}
          {!milestones.length && !payoff && !fiRow && <div className="empty">No milestones in this window.</div>}
        </div>
        <div className="card">
          <h2>What small changes do</h2>
          <p className="proj-big"><Num v={extra100} /></p>
          <p className="muted" style={{ marginTop: 0 }}>more by {rows[rows.length - 1].year} for every extra $100 a month you invest, at {params.ret}% a year.</p>
          <p className="muted small">Your yearly spending includes the mortgage, so the independence target drops once the house is paid off.</p>
        </div>
      </div>
    </>
  )
}

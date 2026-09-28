import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { money, moneyShort, motionOK, niceDate } from '../format'
import { useFetch } from '../hooks'

export interface HomeEstimate {
  value: number; source: 'manual' | 'index' | 'appraisal' | 'purchase'; index_value: number | null; manual_value: number | null
  purchase_price: number; appraised_value: number | null; closing_date: string; area: string | null; fetched: string | null
  stats: { latest_quarter: string; cagr_1y: number | null; cagr_5y: number | null; cagr_10y: number | null; cagr_20y: number | null; cagr_30y: number | null
    expected_nominal: number; expected_real: number; low_real: number; high_real: number } | null
  history: { quarter: string; value: number }[] | null
}

const SOURCE = { manual: 'your own number', index: 'purchase price moved with the area price index', appraisal: 'your appraisal', purchase: 'purchase price' }

/** Home value: where it came from, how the area has moved, and a range for the years ahead (today's dollars). */
export function HomeValueCard() {
  const [refresh, setRefresh] = useState(0)
  const { data } = useFetch<HomeEstimate>(`/api/home_value${refresh ? '?refresh=1' : ''}`)
  const [years, setYears] = useState(10)
  if (!data) return null
  const st = data.stats
  const y0 = new Date().getFullYear()
  const future = st ? Array.from({ length: years + 1 }, (_, k) => ({
    quarter: String(y0 + k),
    mid: data.value * Math.pow(1 + st.expected_real / 100, k),
    low: data.value * Math.pow(1 + st.low_real / 100, k),
    high: data.value * Math.pow(1 + st.high_real / 100, k),
  })) : []
  const end = future[future.length - 1]
  const hist = (data.history || []).filter((_, i, a) => i % 4 === 3 || i === a.length - 1).map((h) => ({ quarter: h.quarter.slice(0, 4), past: h.value }))
  const chart = [...hist.slice(0, -1), { ...hist[hist.length - 1], mid: data.value, low: data.value, high: data.value }, ...future.slice(1)]
  return (
    <div className="card section">
      <div className="group-head">
        <h2>Home value</h2>
        <div className="seg">{[5, 10, 20].map((y) => <button key={y} className={years === y ? 'on' : ''} onClick={() => setYears(y)}>{y} yrs</button>)}</div>
      </div>
      <div className="home-top">
        <div>
          <div className="goal-amt">{money(data.value, { cents: false })}</div>
          <div className="muted small">now · {SOURCE[data.source]}{data.source === 'index' && data.area ? ` (${data.area}, through ${st?.latest_quarter})` : ''}</div>
          {data.source === 'manual' && data.index_value && <div className="muted small">The area index would say {money(data.index_value, { cents: false })}.</div>}
          {data.source === 'index' && data.appraised_value && <div className="muted small">Your appraisal was {money(data.appraised_value, { cents: false })}; enter your own value below to use a different number.</div>}
        </div>
        {st && end && (
          <div className="home-proj">
            <div><span className="muted small">in {years} years, likely</span><b>{money(end.mid, { cents: false })}</b></div>
            <div><span className="muted small">range</span><b className="small-b">{moneyShort(end.low)} – {moneyShort(end.high)}</b></div>
          </div>
        )}
      </div>
      {st && (
        <>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={chart} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="hv-past" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: 'var(--s-income)', stopOpacity: 0.45 }} /><stop offset="100%" style={{ stopColor: 'var(--s-income)', stopOpacity: 0 }} /></linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="quarter" tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={56} domain={['auto', 'auto']} />
              <Tooltip cursor={{ stroke: 'var(--line-strong)' }} content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as { quarter: string; past?: number; mid?: number; low?: number; high?: number }
                return <div className="tt"><div className="tt-head">{p.quarter}</div>
                  {p.past != null && <div className="tt-row"><span>Estimated value</span><b className="num">{money(p.past, { cents: false })}</b></div>}
                  {p.mid != null && p.past == null && <><div className="tt-row"><span>Likely</span><b className="num">{money(p.mid, { cents: false })}</b></div>
                    <div className="tt-row"><span>Range</span><b className="num">{moneyShort(p.low!)} – {moneyShort(p.high!)}</b></div></>}
                </div>
              }} />
              <Area dataKey="past" stroke="var(--s-income)" strokeWidth={2} fill="url(#hv-past)" type="monotone" isAnimationActive={motionOK} animationDuration={700} connectNulls={false} />
              <Line dataKey="mid" stroke="var(--accent)" strokeWidth={2.5} dot={false} type="monotone" isAnimationActive={false} />
              <Line dataKey="low" stroke="var(--text-2)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="high" stroke="var(--text-2)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="recap-mini">
            <div><b>{st.cagr_1y?.toFixed(1)}%</b><span>last 12 months</span></div>
            <div><b>{st.cagr_10y?.toFixed(1)}%</b><span>a year, last 10 years</span></div>
            <div><b>{st.expected_real.toFixed(1)}%</b><span>assumed ahead, after {(st.expected_nominal - st.expected_real).toFixed(1)}% inflation</span></div>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Past line: your purchase price moved with the FHFA house price index for your area. Ahead: the area's {st.cagr_30y ? '30' : '20'}-year pace,
            with dashed lines for a slow and a strong decade. In today's dollars. Index updated {data.fetched ? niceDate(data.fetched.slice(0, 10)) : '—'} ·{' '}
            <button className="link-btn" onClick={() => setRefresh((r) => r + 1)}>check for new data</button>
          </p>
        </>
      )}
    </div>
  )
}

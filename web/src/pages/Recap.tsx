import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { qs } from '../api'
import { GradDefs } from '../components/Charts'
import { catColor, Num, Ring } from '../components/Viz'
import { money, moneyShort, motionOK, niceDate, pct, periodRange } from '../format'
import { useFetch, useRange } from '../hooks'

type T = { income: number; spend: number; saved: number; savings_rate: number | null; invested: number }
interface RecapData {
  month: string; prev_month: string; months: string[]; partial: boolean
  totals: T & { refunds: number; paychecks: number }; prev: T; usual: { income: number; spend: number; saved: number; invested: number }
  categories: { category: string; amount: number; prev: number; usual: number | null }[]
  biggest: { txn_id: string; date: string; name: string; amount: number; category: string }[]
  new_merchants: { name: string; amount: number; n: number; category: string }[]
  daily: { date: string; amount: number }[]
  bills: { count: number; total: number }; budgets: { count: number; over: number }
  net_worth: { start: number | null; end: number | null }
  highlights: { tone: 'good' | 'bad' | 'info'; text: string }[]
}

const monthName = (m: string) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

/** "▲ $120 vs Jul" — up is good for income/saved, bad for spending. */
function Delta({ now, then, label, upIsGood }: { now: number; then: number | null | undefined; label: string; upIsGood: boolean }) {
  if (then == null) return null
  const d = now - then
  if (Math.abs(d) < 1) return <span className="delta">same as {label}</span>
  const good = d > 0 === upIsGood
  return <span className={`delta ${good ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {money(Math.abs(d), { cents: false })} vs {label}</span>
}

export function Recap() {
  const [month, setMonth] = useState<string | null>(null)
  const { data } = useFetch<RecapData>(`/api/recap${qs({ month })}`)
  const nav = useNavigate()
  const range = useRange()
  if (!data) return <div className="empty">Loading…</div>
  const t = data.totals
  const rate = t.income >= 100 && t.savings_rate != null && Math.abs(t.savings_rate) <= 1 ? t.savings_rate : null
  const idx = data.months.indexOf(data.month)
  const prevLabel = new Date(+data.prev_month.slice(0, 4), +data.prev_month.slice(5, 7) - 1, 1).toLocaleDateString('en-US', { month: 'short' })
  const toTxns = (params: Record<string, string>) => {
    const r = periodRange(data.month); range.setAccounts([]); range.setCustom(r.start, r.end)
    nav(`/transactions${qs(params)}`)
  }
  const spendCats = data.categories.filter((c) => c.amount > 0)
  const max = Math.max(...spendCats.map((c) => Math.max(c.amount, c.usual || 0)), 1)
  const nwDelta = data.net_worth.start != null && data.net_worth.end != null ? data.net_worth.end - data.net_worth.start : null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{monthName(data.month)}</h1>
          <div className="muted small">Your month in review{data.partial ? ' (still in progress)' : ''}.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn small" disabled={idx >= data.months.length - 1} onClick={() => setMonth(data.months[idx + 1])} aria-label="Previous month">‹</button>
          <select className="input" style={{ width: 170 }} value={data.month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {data.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          <button className="btn small" disabled={idx <= 0} onClick={() => setMonth(data.months[idx - 1])} aria-label="Next month">›</button>
        </div>
      </div>

      <div className="recap-hero card">
        <Ring value={Math.max(rate || 0, 0)} size={132} stroke={12} color={(rate || 0) >= 0.2 ? 'var(--good)' : (rate || 0) > 0 ? 'var(--accent)' : 'var(--bad)'}
              label={`Kept ${pct(rate)} of income`}>
          <span className="ring-stack"><span className="ring-pct big">{pct(rate)}</span><span className="muted small">of income kept</span></span>
        </Ring>
        <div className="recap-stats">
          <div><span className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Income</span><b><Num v={t.income} /></b>
            <Delta now={t.income} then={data.prev.income} label={prevLabel} upIsGood /></div>
          <div><span className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spent</span><b><Num v={t.spend} /></b>
            <Delta now={t.spend} then={data.prev.spend} label={prevLabel} upIsGood={false} /></div>
          <div><span className="label">Saved</span><b className={t.saved < 0 ? 'neg' : ''}><Num v={t.saved} /></b>
            <Delta now={t.saved} then={data.usual.saved} label="usual" upIsGood /></div>
          <div><span className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested</span><b><Num v={t.invested} /></b>
            <Delta now={t.invested} then={data.usual.invested} label="usual" upIsGood /></div>
          {nwDelta != null && <div><span className="label">Net worth</span><b className={nwDelta < 0 ? 'neg' : 'pos'}><Num v={nwDelta} sign /></b><span className="delta">over the month</span></div>}
        </div>
      </div>

      {data.highlights.length > 0 && (
        <div className="card section">
          <h2>What stood out</h2>
          <div className="highlights">
            {data.highlights.map((h, i) => <div key={i} className={`hl hl-${h.tone}`}><span className="hl-dot" aria-hidden>{h.tone === 'good' ? '✓' : h.tone === 'bad' ? '!' : '•'}</span><span>{h.text}</span></div>)}
          </div>
        </div>
      )}

      <div className="grid two section">
        <div className="card">
          <div className="group-head"><h2>Where it went</h2><span className="muted small">bar = this month · tick = your usual month</span></div>
          {spendCats.map((c) => (
            <button key={c.category} className="cmp-row" onClick={() => toTxns({ category: c.category, flows: 'spend,refund' })}>
              <span className="cmp-name">{c.category}</span>
              <span className="cmp-track">
                <span className="cmp-fill" style={{ width: `${(c.amount / max) * 100}%`, background: catColor(c.category) }} />
                {c.usual ? <span className="cmp-tick" style={{ left: `${(c.usual / max) * 100}%` }} title={`usual ${money(c.usual, { cents: false })}`} /> : null}
              </span>
              <span className="cmp-amt">{money(c.amount, { cents: false })}
                {c.usual ? <span className={`muted small ${c.amount > c.usual * 1.15 ? 'neg' : c.amount < c.usual * 0.85 ? 'pos' : ''}`}> {c.amount >= c.usual ? '+' : '−'}{money(Math.abs(c.amount - c.usual), { cents: false })}</span> : <span className="muted small"> new</span>}
              </span>
            </button>
          ))}
        </div>
        <div className="card">
          <h2>Day by day</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.daily} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
              <GradDefs />
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={(d) => String(+d.slice(8))} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={8} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={48} />
              <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => active && payload?.length ? (
                <div className="tt"><div className="tt-head">{niceDate((payload[0].payload as { date: string }).date)}</div>
                  <div className="tt-row"><span>Spent</span><b className="num">{money(payload[0].value as number)}</b></div>
                  <div className="tt-hint">Click to see that day</div></div>) : null} />
              <Bar dataKey="amount" fill="url(#g-spend)" radius={[6, 6, 2, 2]} isAnimationActive={motionOK} animationDuration={700} style={{ cursor: 'pointer' }}
                   onClick={(d: unknown) => { const day = (d as { payload?: { date: string } }).payload?.date; if (day) { range.setAccounts([]); range.setCustom(day, day); nav('/transactions') } }} />
            </BarChart>
          </ResponsiveContainer>
          <div className="recap-mini">
            <div><b>{data.bills.count}</b><span>bills paid · {money(data.bills.total, { cents: false })}</span></div>
            <div><b>{data.budgets.count ? `${data.budgets.count - data.budgets.over}/${data.budgets.count}` : '—'}</b><span>budgets on track</span></div>
            <div><b>{money(t.refunds, { cents: false })}</b><span>came back (refunds, paybacks)</span></div>
          </div>
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Biggest purchases</h2>
          {data.biggest.length === 0 ? <div className="empty">No spending this month.</div> : data.biggest.map((b) => (
            <button key={b.txn_id} className="feed-row" onClick={() => toTxns({ q: b.name })}>
              <span className="avatar" style={{ background: catColor(b.category) }} aria-hidden>{b.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?'}</span>
              <span className="feed-main"><span className="feed-name">{b.name}</span><span className="feed-sub">{niceDate(b.date)} · {b.category}</span></span>
              <span className="feed-amt out">{money(b.amount)}</span>
            </button>
          ))}
        </div>
        <div className="card">
          <h2>New this month</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Places you hadn't paid in the 12 months before.</p>
          {data.new_merchants.length === 0 ? <div className="empty">Nothing new — all familiar places.</div> : data.new_merchants.map((n) => (
            <button key={n.name} className="feed-row" onClick={() => toTxns({ q: n.name })}>
              <span className="avatar" style={{ background: catColor(n.category) }} aria-hidden>{n.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?'}</span>
              <span className="feed-main"><span className="feed-name">{n.name}</span><span className="feed-sub">{n.category}{n.n > 1 ? ` · ${n.n} times` : ''}</span></span>
              <span className="feed-amt out">{money(n.amount)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

import { useState } from 'react'
import { Area, ComposedChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { put } from '../api'
import { Num } from '../components/Viz'
import { money, moneyShort, motionOK, niceDate } from '../format'
import { useFetch, useToast } from '../hooks'

interface FcAccount { account_id: string; institution: string; name: string; balance: number; low: { balance: number; date: string } | null; warn: boolean }
interface FcEvent { date: string; account_id: string; amount: number; label: string; kind: 'income' | 'bill' | 'transfer' | 'card' }
interface Fc { accounts: FcAccount[]; series: Record<string, number | string>[]; events: FcEvent[]; low_threshold: number }

const KIND = { income: 'Paycheck', bill: 'Bill', transfer: 'Transfer', card: 'Card payment' }

function FcTip({ active, payload, byDay }: { active?: boolean; payload?: readonly { payload: { date: string; bal: number } }[]; byDay: Map<string, FcEvent[]> }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const ev = byDay.get(p.date) || []
  return (
    <div className="tt"><div className="tt-head">{niceDate(p.date)}</div>
      <div className="tt-row"><span>Projected balance</span><b className="num">{money(p.bal, { cents: false })}</b></div>
      {ev.map((e, i) => <div key={i} className="tt-row"><span>{e.label}</span><b className={`num ${e.amount > 0 ? 'pos' : ''}`}>{e.amount > 0 ? '+' : '−'}{money(Math.abs(e.amount), { cents: false })}</b></div>)}
    </div>
  )
}

export function Forecast() {
  const [days, setDays] = useState(60)
  const { data, reload } = useFetch<Fc>(`/api/forecast?days=${days}`)
  const toast = useToast()
  const [pick, setPick] = useState<string | null>(null)
  const [low, setLow] = useState('')
  if (!data) return <div className="empty">Loading…</div>
  const sel = pick ?? data.accounts.find((a) => a.warn)?.account_id ?? 'total'
  const acct = data.accounts.find((a) => a.account_id === sel)
  const key = sel
  const events = data.events.filter((e) => sel === 'total' || e.account_id === sel)
  const byDay = new Map<string, FcEvent[]>()
  for (const e of events) byDay.set(e.date, [...(byDay.get(e.date) || []), e])
  const series = data.series.map((p) => ({ date: p.date as string, bal: p[key] as number }))
  const lowPt = series.reduce((m, p) => (p.bal < m.bal ? p : m), series[0])
  const name = (id: string) => data.accounts.find((a) => a.account_id === id)?.name || ''
  const saveLow = async () => {
    try { await put('/api/forecast/low', { low }); setLow(''); reload(); toast(`Warning level set to $${low}.`) }
    catch (e) { toast((e as Error).message, true) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cash forecast</h1>
          <div className="muted small">Today's balances plus expected paychecks, minus bills, transfers, and card payments. Day-to-day spending isn't predictable, so it isn't included.</div>
        </div>
        <div className="seg">
          {[30, 60, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}
        </div>
      </div>

      <div className="tiles">
        {data.accounts.map((a) => (
          <button key={a.account_id} className={`tile clickable fc-tile${sel === a.account_id ? ' on' : ''}`} onClick={() => setPick(a.account_id)}>
            <div className="label">{a.institution} · {a.name}</div>
            <div className="value"><Num v={a.balance} /></div>
            {a.low && <div className={`sub ${a.warn ? 'neg' : ''}`}>{a.warn ? '⚠ ' : ''}lowest {money(a.low.balance, { cents: false })} on {niceDate(a.low.date)}</div>}
          </button>
        ))}
        <button className={`tile clickable fc-tile${sel === 'total' ? ' on' : ''}`} onClick={() => setPick('total')}>
          <div className="label">All cash together</div>
          <div className="value"><Num v={data.accounts.reduce((s, a) => s + a.balance, 0)} /></div>
          <div className="sub">in {days} days: {money(data.series[data.series.length - 1]?.total as number, { cents: false })}</div>
        </button>
      </div>

      {acct?.warn && (
        <div className="alert"><span>⚠ {acct.name} is projected to drop to <b>{money(acct.low!.balance, { cents: false })}</b> on {niceDate(acct.low!.date)}, below your {money(data.low_threshold, { cents: false })} warning level. Move money in before then.</span></div>
      )}

      <div className="card">
        <div className="group-head"><h2>{sel === 'total' ? 'All cash' : name(sel)}, next {days} days</h2>
          <span className="muted small">lowest point {money(lowPt?.bal, { cents: false })} on {lowPt ? niceDate(lowPt.date) : '—'}</span></div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={series} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="fc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.45 }} />
                <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="date" tickFormatter={(d) => niceDate(d)} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={30} />
            <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
            {sel !== 'total' && <ReferenceLine y={data.low_threshold} stroke="var(--warn)" strokeDasharray="5 4"
              label={{ value: `warning ${moneyShort(data.low_threshold)}`, fill: 'var(--warn)', fontSize: 11, position: 'insideTopRight' }} />}
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Tooltip content={(p) => <FcTip active={p.active} payload={p.payload as unknown as { payload: { date: string; bal: number } }[]} byDay={byDay} />} cursor={{ stroke: 'var(--line-strong)' }} />
            <Area type="stepAfter" dataKey="bal" stroke="var(--accent)" strokeWidth={2.5} fill="url(#fc-fill)"
                  isAnimationActive={motionOK} animationDuration={800} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>What's coming</h2>
          {events.length === 0 ? <div className="empty">Nothing scheduled.</div> : [...byDay].map(([d, evs]) => (
            <div key={d} className="fc-day">
              <div className="fc-date">{niceDate(d)}</div>
              {evs.map((e, i) => (
                <div key={i} className="fc-ev">
                  <span className={`fc-kind k-${e.kind}`}>{KIND[e.kind]}</span>
                  <span className="fc-label">{e.label}{sel === 'total' ? <span className="muted small"> · {name(e.account_id)}</span> : null}</span>
                  <b className={`num ${e.amount > 0 ? 'pos' : ''}`}>{e.amount > 0 ? '+' : '−'}{money(Math.abs(e.amount), { cents: false })}</b>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Warning level</h2>
          <p className="muted small" style={{ marginTop: -4 }}>You'll get an alert on Overview when any cash account is projected to fall below this in the next 30 days.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label className="field" style={{ width: 160 }}>Warn me below
              <input className="input" inputMode="decimal" placeholder={String(data.low_threshold)} value={low} onChange={(e) => setLow(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && low && saveLow()} />
            </label>
            <button className="btn" disabled={!low} onClick={saveLow}>Save</button>
          </div>
          <h3 style={{ marginTop: 18 }}>How it's worked out</h3>
          <ul className="muted small fc-how">
            <li>Paychecks repeat at your usual rhythm, split across accounts the way your last one was.</li>
            <li>Bills and regular transfers come from the Bills page, on their next expected date.</li>
            <li>Credit cards: what's left on the current statement on its due date, then your average monthly payment.</li>
          </ul>
        </div>
      </div>
    </>
  )
}

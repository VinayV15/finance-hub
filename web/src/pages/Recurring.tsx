import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { post, qs } from '../api'
import { catColor, Num, Sparkline } from '../components/Viz'
import { money, niceDate } from '../format'
import { useFetch, useRange, useToast } from '../hooks'

export interface Bill {
  key: string; name: string; category: string; cadence: string; account_name: string; typical: number
  last_amount: number; last_date: string; next_date: string; monthly: number; active: boolean
  price_change: number | null; variable: boolean; history: { date: string; amount: number }[]; note?: string; kind: string
}
interface BillsSummary {
  items: Bill[]; dismissed: Bill[]; monthly_total: number; yearly_total: number; count: number
  next_7_days: number; price_increases: Bill[]
}

const daysUntil = (d: string) => Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5)
const whenLabel = (d: string) => { const n = daysUntil(d); return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days` }

export function BillAvatar({ b }: { b: Pick<Bill, 'name' | 'category'> }) {
  const w = b.name.replace(/[^A-Za-z ]/g, ' ').split(' ').filter(Boolean)
  return <span className="avatar" style={{ background: catColor(b.category) }} aria-hidden>{((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase()}</span>
}

export function Recurring() {
  const { data, reload } = useFetch<BillsSummary>('/api/recurring')
  const toast = useToast()
  const nav = useNavigate()
  const range = useRange()
  const [showOld, setShowOld] = useState(false)
  if (!data) return <div className="empty">Loading…</div>
  const live = data.items.filter((b) => b.active)
  const stopped = data.items.filter((b) => !b.active)
  const next30 = live.filter((b) => daysUntil(b.next_date) <= 30)
  const dismiss = async (b: Bill, undo = false) => {
    try { await post('/api/recurring/dismiss', { key: b.key, undo }); reload(); toast(undo ? `${b.name} is back on your bills.` : `${b.name} removed from bills.`) }
    catch (e) { toast((e as Error).message, true) }
  }
  const openTxns = (b: Bill) => { range.setPreset('12m'); nav(`/transactions${qs({ q: b.kind === 'mortgage' ? 'servicer' : b.name.split(' ').slice(0, 2).join(' ') })}`) }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bills & subscriptions</h1>
          <div className="muted small">Found automatically from charges that repeat on a schedule.</div>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">Per month</div><div className="value"><Num v={data.monthly_total} /></div><div className="sub">{data.count} active bills</div></div>
        <div className="tile"><div className="label">Per year</div><div className="value"><Num v={data.yearly_total} /></div><div className="sub">at today's prices</div></div>
        <div className="tile"><div className="label">Due in the next 7 days</div><div className="value"><Num v={data.next_7_days} /></div></div>
        <div className="tile"><div className="label">Price increases</div><div className={`value ${data.price_increases.length ? 'neg' : ''}`}>{data.price_increases.length}</div>
          <div className="sub">{data.price_increases.length ? data.price_increases.map((b) => b.name).join(', ') : 'none lately'}</div></div>
      </div>

      <div className="card">
        <h2>Next 30 days</h2>
        {next30.length === 0 ? <div className="empty">Nothing due in the next 30 days.</div> : (
          <div className="timeline">
            {next30.map((b) => (
              <div key={b.key} className="tl-item">
                <div className="tl-date"><b>{new Date(`${b.next_date}T00:00:00`).getDate()}</b><span>{new Date(`${b.next_date}T00:00:00`).toLocaleDateString('en-US', { month: 'short' })}</span></div>
                <BillAvatar b={b} />
                <div className="tl-name">{b.name}</div>
                <div className="tl-amt">{money(b.typical, { cents: false })}</div>
                <div className="muted small">{whenLabel(b.next_date)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card section">
        <div className="group-head"><h2>All bills</h2><span className="muted small">hover a trend line for past amounts</span></div>
        {live.map((b) => (
          <div key={b.key} className="bill-row">
            <BillAvatar b={b} />
            <div className="bill-main">
              <button className="bill-name link-btn" onClick={() => openTxns(b)} title="See these charges">{b.name}</button>
              <div className="muted small">
                {[b.cadence, b.account_name, `next ${niceDate(b.next_date)}`].filter(Boolean).join(' · ')}
                {b.price_change && b.price_change > 0 && <span className="badge spend" style={{ marginLeft: 6 }}>▲ up {money(b.price_change)}</span>}
                {b.variable && <span className="badge" style={{ marginLeft: 6 }}>amount varies</span>}
              </div>
              {b.note && <div className="muted small">{b.note}</div>}
            </div>
            <div className="bill-spark"><Sparkline values={b.history.map((h) => h.amount)} labels={b.history.map((h) => niceDate(h.date))} color={catColor(b.category)} format={(n) => money(n)} /></div>
            <div className="bill-amt"><b>{money(b.typical, { cents: b.typical < 100 })}</b><span className="muted small">{money(b.monthly, { cents: false })}/mo</span></div>
            <button className="link-btn" onClick={() => dismiss(b)} title="Not a bill? Remove it">Not a bill</button>
          </div>
        ))}
      </div>

      {(stopped.length > 0 || data.dismissed.length > 0) && (
        <div className="card section">
          <div className="group-head"><h2>Stopped or removed</h2><button className="link-btn" onClick={() => setShowOld(!showOld)}>{showOld ? 'Hide' : `Show ${stopped.length + data.dismissed.length}`}</button></div>
          {showOld && [...stopped, ...data.dismissed].map((b) => (
            <div key={b.key} className="bill-row faded">
              <BillAvatar b={b} />
              <div className="bill-main"><div className="bill-name">{b.name}</div>
                <div className="muted small">{data.dismissed.includes(b) ? 'removed by you' : `no charge since ${niceDate(b.last_date)}`}</div></div>
              <div className="bill-amt"><b>{money(b.typical)}</b></div>
              {data.dismissed.includes(b) && <button className="link-btn" onClick={() => dismiss(b, true)}>Put back</button>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

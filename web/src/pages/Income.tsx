import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { put, type IncomeCheck } from '../api'
import { money, moneyShort, niceDate } from '../format'
import { useFetch, useToast } from '../hooks'

const FREQS = [
  { v: 'weekly', label: 'Weekly', n: 52 },
  { v: 'biweekly', label: 'Every 2 weeks', n: 26 },
  { v: 'semimonthly', label: 'Twice a month', n: 24 },
  { v: 'monthly', label: 'Monthly', n: 12 },
]

export function Income() {
  const toast = useToast()
  const { data, reload } = useFetch<IncomeCheck>('/api/income')
  const [annual, setAnnual] = useState('')
  const [freq, setFreq] = useState('biweekly')
  const [employer, setEmployer] = useState('')
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (!data) return
    const s = data.settings
    setAnnual(s.annual_net ? String(s.annual_net) : '')
    setFreq(s.pay_frequency || data.detected.find((e) => e.active)?.frequency || 'biweekly')
    setEmployer(s.employer || data.detected.find((e) => e.active)?.employer || '')
    setNotes(s.notes || '')
  }, [data])

  const save = async () => {
    try { await put('/api/income', { annual_net: annual, pay_frequency: freq, employer, notes }); toast('Saved.'); reload() }
    catch (e) { toast((e as Error).message, true) }
  }
  const per = FREQS.find((f) => f.v === freq)?.n || 26
  const annualNum = parseFloat(annual.replace(/[$,]/g, '')) || 0

  return (
    <>
      <div className="page-head"><h1>Income</h1></div>
      <div className="card">
        <h2>Your take-home pay</h2>
        <p className="muted small" style={{ marginTop: -4 }}>After taxes and anything taken out of your paycheck (401k, insurance). Forecasts and budgets use this number; the app checks it against real deposits below.</p>
        <div className="form-grid">
          <label className="field">Take-home per year
            <input className="input" inputMode="decimal" value={annual} onChange={(e) => setAnnual(e.target.value)} placeholder="e.g. 85000" />
          </label>
          <label className="field">Paid
            <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>
              {FREQS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
            </select>
          </label>
          <label className="field">Employer
            <input className="input" value={employer} onChange={(e) => setEmployer(e.target.value)} />
          </label>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
        {annualNum > 0 && <p className="small" style={{ marginBottom: 0 }}>= <b>{money(annualNum / per)}</b> per paycheck · <b>{money(annualNum / 12, { cents: false })}</b> per month</p>}
        <label className="field" style={{ marginTop: 12 }}>Notes (bonuses, raises coming, etc.)
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. annual bonus in March, raise in January" />
        </label>
      </div>

      {data?.warning && <div className="alert section"><span>⚠ {data.warning}</span></div>}

      <div className="card section">
        <h2>Paychecks the app found</h2>
        <p className="muted small" style={{ marginTop: -4 }}>A paycheck split between Wells Fargo and Wealthfront on the same day counts as one.</p>
        {!data ? <div className="empty">Loading…</div> : data.detected.length === 0 ? <div className="empty">No paychecks detected yet.</div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employer</th><th>Status</th><th>How often</th><th className="r">Typical paycheck</th><th className="r">Per year (at that rate)</th><th className="r">Last 12 months</th><th>Lands in</th></tr></thead>
              <tbody>
                {data.detected.map((e) => (
                  <tr key={e.employer}>
                    <td><b>{e.employer}</b><div className="muted small">{niceDate(e.first)} – {niceDate(e.last)} · {e.deposits} deposits</div></td>
                    <td>{e.active ? <span className="badge income">● Current</span> : <span className="badge">Past</span>}</td>
                    <td>{e.frequency || '—'}</td>
                    <td className="r">{money(e.typical_paycheck)}</td>
                    <td className="r">{money(e.annualized, { cents: false })}</td>
                    <td className="r">{money(e.last_12_months, { cents: false })}</td>
                    <td className="small">{e.accounts.join(' + ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data?.detected.filter((e) => e.active).map((e) => (
        <div className="card section" key={e.employer}>
          <h2>{e.employer} paychecks</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={e.history.slice(-26)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={niceDate} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => active && payload?.length ? (
                <div className="tt"><div className="tt-head">{niceDate(String(payload[0].payload.date))}</div><b className="num">{money(Number(payload[0].value))}</b></div>) : null} />
              <Bar isAnimationActive={false} dataKey="amount" fill="var(--s-income)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ))}
    </>
  )
}

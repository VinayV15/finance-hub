import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { del, post, put, qs, type Mortgage as M, type MortgageRow } from '../api'
import { money, moneyShort, niceDate, pct } from '../format'
import { useFetch, useToast } from '../hooks'

const monthYear = (d: string | null) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'
const yearsMonths = (m: number) => `${Math.floor(m / 12) ? `${Math.floor(m / 12)} yr ` : ''}${m % 12 ? `${m % 12} mo` : ''}`.trim() || '0 mo'

function TT({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="tt">
      <div className="tt-head">{label}</div>
      {payload.map((p) => (
        <div className="tt-row" key={p.name}><span><i className="swatch" style={{ background: p.color }} />{p.name}</span><b className="num">{money(p.value, { cents: false })}</b></div>
      ))}
    </div>
  )
}

export function Mortgage() {
  const toast = useToast()
  const [extraInput, setExtraInput] = useState('0')
  const [extra, setExtra] = useState(0)
  useEffect(() => { const h = setTimeout(() => setExtra(Math.max(0, parseFloat(extraInput) || 0)), 300); return () => clearTimeout(h) }, [extraInput])
  const { data, reload } = useFetch<M>(`/api/mortgage${qs({ extra: extra || undefined })}`)
  const [which, setWhich] = useState<'actual' | 'original'>('actual')
  const [year, setYear] = useState<string>('')
  const [cp, setCp] = useState({ date: '', balance: '' })
  const [edit, setEdit] = useState({ escrow_monthly: '', pmi_monthly: '', current_value: '' })
  useEffect(() => {
    if (data?.config) setEdit({ escrow_monthly: String(data.config.escrow_monthly ?? ''), pmi_monthly: String(data.config.pmi_monthly ?? ''), current_value: String(data.config.current_value ?? '') })
  }, [data?.config])

  const balanceSeries = useMemo(() => {
    if (!data?.config) return []
    const byYear = new Map<string, { year: string; lender?: number; yours?: number }>()
    const endOf = (rows: MortgageRow[], key: 'lender' | 'yours') => {
      for (const r of rows) { const y = r.date.slice(0, 4); const e = byYear.get(y) || { year: y }; e[key] = r.balance; byYear.set(y, e) }
    }
    endOf(data.original, 'lender'); endOf(data.actual, 'yours')
    return [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year))
  }, [data])

  if (!data) return <div className="empty">Loading…</div>
  if (!data.config) return <div className="card empty">No mortgage set up yet.</div>
  const c = data.config
  const rows = which === 'actual' ? data.actual : data.original
  const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))]
  const shownYear = year || new Date().getFullYear().toString()
  const tableRows = rows.filter((r) => r.date.startsWith(shownYear))
  const buydownNote = c.buydown_rates.length
    ? c.buydown_rates.map((r, i) => `${r}% in year ${i + 1}`).join(', ') + `, then ${c.note_rate}% for the rest`
    : `${c.note_rate}% fixed`

  const saveCp = async () => {
    try { await post('/api/mortgage/checkpoints', cp); setCp({ date: '', balance: '' }); toast('Saved — the model now starts from that balance.'); reload() }
    catch (e) { toast((e as Error).message, true) }
  }
  const saveEdit = async () => {
    try { await put('/api/mortgage', edit); toast('Saved.'); reload() } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mortgage</h1>
          <div className="muted small">{money(c.original_amount, { cents: false })} · {c.term_months / 12} years · {buydownNote} · serviced by {c.servicer}</div>
        </div>
      </div>

      <div className="tiles">
        <div className="tile hero" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Principal left (estimated)</div>
          <div className="value">{money(data.balance)}</div>
          <div className="sub">{pct(data.paid_off_pct)} paid off · <b className="pos">{money(data.ahead_by, { cents: false })} ahead</b> of the lender's schedule ({money(data.original_balance_now, { cents: false })})</div>
          <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, marginTop: 10, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(1, data.paid_off_pct * 100)}%`, height: '100%', background: 'var(--s-invest)', borderRadius: 4 }} />
          </div>
        </div>
        <div className="tile"><div className="label">Paid off by</div><div className="value">{monthYear(data.payoff_projected)}</div>
          <div className="sub">lender's schedule: {monthYear(data.payoff_original)} · {yearsMonths(data.months_saved)} sooner</div></div>
        <div className="tile"><div className="label">Interest saved</div><div className="value pos">{money(data.interest_saved, { cents: false })}</div>
          <div className="sub">{money(data.interest_projected, { cents: false })} total interest vs {money(data.interest_original, { cents: false })}</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Extra principal paid</div><div className="value">{money(data.extra_principal, { cents: false })}</div>
          <div className="sub">counted as saving, not spending</div></div>
        <div className="tile"><div className="label">Home equity</div><div className="value">{money(data.equity, { cents: false })}</div>
          <div className="sub">at {money(data.home_value, { cents: false })} value</div></div>
        <div className="tile"><div className="label">This year's payment</div><div className="value">{money(data.current_due)}</div>
          <div className="sub">{data.rate_now}% rate · paid through {monthYear(data.paid_through_date)}</div></div>
        <div className="tile"><div className="label">PMI ({money(data.pmi.monthly)}/mo) can come off</div><div className="value">{monthYear(data.pmi.request_date_projected)}</div>
          <div className="sub">ask at {money(data.pmi.request_at_balance, { cents: false })} balance · drops on its own at {money(data.pmi.auto_at_balance, { cents: false })} ({monthYear(data.pmi.auto_date_projected)})</div></div>
      </div>

      <div className="card">
        <div className="group-head">
          <h2>What if I pay extra every month?</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted small">extra per month $</span>
            <input className="input" style={{ width: 110 }} inputMode="decimal" value={extraInput} onChange={(e) => setExtraInput(e.target.value)} aria-label="Extra per month" />
          </div>
        </div>
        <input type="range" min={0} max={3000} step={50} value={Math.min(3000, parseFloat(extraInput) || 0)} onChange={(e) => setExtraInput(e.target.value)} style={{ width: '100%' }} aria-label="Extra per month slider" />
        <p className="small" style={{ margin: '6px 0 0' }}>
          {extra > 0
            ? <>Paying <b>{money(extra, { cents: false })}</b> extra each month from now on: paid off <b>{monthYear(data.payoff_projected)}</b>, {yearsMonths(data.months_saved)} early, <b>{money(data.interest_saved, { cents: false })}</b> less interest than the lender's schedule. PMI can come off {monthYear(data.pmi.request_date_projected)}.</>
            : <>Drag to see how extra payments change the payoff date. Numbers above update too.</>}
        </p>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Balance over time</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={balanceSeries} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="year" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={20} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<TT />} />
              <Legend wrapperStyle={{ fontSize: 12.5, color: 'var(--text-2)' }} iconType="plainline" />
              <Line isAnimationActive={false} name="Your loan" dataKey="yours" stroke="var(--s-income)" strokeWidth={2} dot={false} />
              <Line isAnimationActive={false} name="Lender's schedule" dataKey="lender" stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Where each year's payments go</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.years} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="year" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={20} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<TT />} cursor={{ fill: 'var(--surface-2)' }} />
              <Legend wrapperStyle={{ fontSize: 12.5, color: 'var(--text-2)' }} />
              <Bar isAnimationActive={false} name="Interest" dataKey="interest" stackId="a" fill="var(--s-spend)" />
              <Bar isAnimationActive={false} name="Principal" dataKey="principal" stackId="a" fill="var(--s-invest)" />
              <Bar isAnimationActive={false} name="Extra principal" dataKey="extra" stackId="a" fill="var(--s-income)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card section">
        <div className="group-head">
          <h2>Amortization schedule</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="seg">
              <button className={which === 'actual' ? 'on' : ''} onClick={() => setWhich('actual')}>Your loan</button>
              <button className={which === 'original' ? 'on' : ''} onClick={() => setWhich('original')}>Lender's schedule</button>
            </div>
            <select className="input" style={{ width: 100 }} value={shownYear} onChange={(e) => setYear(e.target.value)} aria-label="Year">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          {which === 'actual'
            ? 'Past months use your real payments; future months assume the regular payment' + (extra ? ` plus ${money(extra, { cents: false })} extra` : '') + '. Interest is at the note rate — during the buydown your payment is lower and the buydown fund covers the difference.'
            : 'The schedule from your closing documents — no extra payments.'}
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>#</th><th>Date</th>{which === 'original' && <th className="r">You pay (P&I)</th>}<th className="r">Principal</th>{which === 'actual' && <th className="r">Extra</th>}<th className="r">Interest</th><th className="r">Balance</th></tr></thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={r.n} style={r.projected ? { color: 'var(--text-2)' } : undefined}>
                  <td>{r.n}</td><td>{monthYear(r.date)}{which === 'actual' && r.projected ? <span className="muted small"> · projected</span> : null}</td>
                  {which === 'original' && <td className="r">{money(r.your_pi)}{r.subsidy ? <div className="muted small">+{money(r.subsidy)} buydown</div> : null}</td>}
                  <td className="r">{money(r.principal)}</td>
                  {which === 'actual' && <td className="r">{r.extra ? money(r.extra) : '—'}</td>}
                  <td className="r">{money(r.interest)}</td><td className="r">{money(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Payments you've made</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Each payment first covers the regular payment that's due; the rest counts as extra principal. {money(data.total_paid, { cents: false })} paid in total.</p>
          {data.payments.map((p) => (
            <div className="row" key={`${p.date}-${p.amount}-${p.txn_id}`}>
              <div className="row-main"><div className="row-title">{niceDate(p.date)}</div><div className="muted small">{p.institution}{p.extra ? ` · ${money(p.scheduled)} regular + ${money(p.extra)} extra` : ' · regular payment'}</div></div>
              <div className="row-amt">{money(p.amount)}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Match your real balance</h2>
          <p className="muted small" style={{ marginTop: -4 }}>The balance here is an estimate. Enter the principal balance from a Servicer statement and the model starts from the real number on that date.</p>
          <div className="form-grid">
            <label className="field">Statement date<input className="input" type="date" value={cp.date} onChange={(e) => setCp({ ...cp, date: e.target.value })} /></label>
            <label className="field">Principal balance<input className="input" inputMode="decimal" value={cp.balance} onChange={(e) => setCp({ ...cp, balance: e.target.value })} /></label>
            <button className="btn primary" onClick={saveCp}>Save</button>
          </div>
          {c.checkpoints.map((k) => (
            <div className="row" key={k.date}>
              <div className="row-main"><div className="row-title">{niceDate(k.date)}</div><div className="muted small">from statement</div></div>
              <div className="row-amt">{money(k.balance)}</div>
              <button className="link-btn" onClick={async () => { await del(`/api/mortgage/checkpoints/${k.date}`); reload() }}>Remove</button>
            </div>
          ))}
          <h2 style={{ marginTop: 18 }}>Monthly costs</h2>
          <div className="form-grid">
            <label className="field">Escrow / month<input className="input" inputMode="decimal" value={edit.escrow_monthly} onChange={(e) => setEdit({ ...edit, escrow_monthly: e.target.value })} /></label>
            <label className="field">PMI / month<input className="input" inputMode="decimal" value={edit.pmi_monthly} onChange={(e) => setEdit({ ...edit, pmi_monthly: e.target.value })} /></label>
            <label className="field">Home value (optional)<input className="input" inputMode="decimal" value={edit.current_value} onChange={(e) => setEdit({ ...edit, current_value: e.target.value })} placeholder={String(c.appraised_value || '')} /></label>
            <button className="btn" onClick={saveEdit}>Save</button>
          </div>
          <p className="muted small">Escrow changes after the yearly escrow review — update it when Servicer sends the new amount.</p>
        </div>
      </div>
    </>
  )
}

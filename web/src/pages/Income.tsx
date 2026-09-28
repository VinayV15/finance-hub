import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { GradDefs } from '../components/Charts'
import { del, post, put, type IncomeCheck } from '../api'
import { money, moneyShort, motionOK, niceDate, pct } from '../format'
import { useFetch, useToast } from '../hooks'

const FREQS = [
  { v: 'weekly', label: 'Weekly' },
  { v: 'biweekly', label: 'Every 2 weeks' },
  { v: 'semimonthly', label: 'Twice a month' },
  { v: 'monthly', label: 'Monthly' },
]

const LINES = [
  { key: 'gross', label: 'Gross pay', note: 'salary before anything comes out' },
  { key: 'retirement', label: 'Your 401(k)', note: 'comes out before taxes', minus: true },
  { key: 'taxes_and_other', label: 'Taxes & other deductions', note: 'federal, Social Security, Medicare, insurance…', minus: true },
  { key: 'take_home', label: 'Take-home', note: 'what lands in your bank accounts', strong: true },
] as const

export function Income() {
  const toast = useToast()
  const { data, reload } = useFetch<IncomeCheck>('/api/income')
  const [f, setF] = useState({ gross_annual: '', net_per_paycheck: '', retirement_pct: '', employer_match_pct: '', pay_frequency: 'biweekly', employer: '', match_notes: '', notes: '', effective: '' })
  const blankPast = { effective: '', gross_annual: '', net_per_paycheck: '', retirement_pct: '', employer_match_pct: '' }
  const [past, setPast] = useState(blankPast)
  useEffect(() => {
    if (!data) return
    const s = data.settings
    const active = data.detected.find((e) => e.active)
    setF({
      gross_annual: s.gross_annual ? String(s.gross_annual) : '',
      net_per_paycheck: s.net_per_paycheck ? String(s.net_per_paycheck) : active ? String(active.typical_paycheck) : '',
      retirement_pct: s.retirement_pct != null ? String(s.retirement_pct) : '',
      employer_match_pct: s.employer_match_pct != null ? String(s.employer_match_pct) : '',
      pay_frequency: s.pay_frequency || 'biweekly',
      employer: s.employer || active?.employer || '',
      match_notes: s.match_notes || '',
      notes: s.notes || '',
      effective: s.effective || '',
    })
  }, [data])
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })

  const save = async () => {
    try { await put('/api/income', f); toast('Saved.'); reload() } catch (e) { toast((e as Error).message, true) }
  }

  const addPast = async () => {
    try { await post('/api/income/history', past); setPast(blankPast); toast('Saved.'); reload() } catch (e) { toast((e as Error).message, true) }
  }
  const removePast = async (eff: string) => { await del(`/api/income/history/${eff}`); reload() }
  const history = (data?.history || []).filter((h) => h.effective !== (data?.settings.effective || ''))
  const bonuses = (data?.detected || []).flatMap((e) => e.bonuses.map((x) => ({ ...x, employer: e.employer }))).sort((a, z) => z.date.localeCompare(a.date))

  const b = data?.breakdown
  const ytd = data?.ytd
  return (
    <>
      <div className="page-head"><h1>Income</h1></div>

      {ytd && (
        <div className="tiles">
          <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Take-home this year</div>
            <div className="value">{money(ytd.take_home)}</div><div className="sub">{ytd.paychecks} paychecks</div></div>
          {ytd.gross != null && <div className="tile"><div className="label">Gross pay this year</div><div className="value">{money(ytd.gross, { cents: false })}</div><div className="sub">before 401(k) & taxes</div></div>}
          {ytd.retirement != null && <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />401(k) this year</div>
            <div className="value">{money((ytd.retirement || 0) + (ytd.employer_match || 0), { cents: false })}</div>
            <div className="sub">{money(ytd.retirement, { cents: false })} you + {money(ytd.employer_match, { cents: false })} employer match (est.)</div></div>}
        </div>
      )}
      {data?.warning && <div className="alert"><span>⚠ {data.warning}</span></div>}

      <div className="grid two">
        <div className="card">
          <h2>Your pay</h2>
          <div className="form-grid">
            <label className="field">Salary per year (before taxes)<input className="input" inputMode="decimal" value={f.gross_annual} onChange={set('gross_annual')} placeholder="e.g. 75000" /></label>
            <label className="field">Take-home per paycheck<input className="input" inputMode="decimal" value={f.net_per_paycheck} onChange={set('net_per_paycheck')} placeholder="e.g. 2200.00" /></label>
            <label className="field">Paid<select className="input" value={f.pay_frequency} onChange={set('pay_frequency')}>{FREQS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select></label>
            <label className="field">Your 401(k) %<input className="input" inputMode="decimal" value={f.retirement_pct} onChange={set('retirement_pct')} placeholder="5" /></label>
            <label className="field">Employer match %<input className="input" inputMode="decimal" value={f.employer_match_pct} onChange={set('employer_match_pct')} placeholder="4" /></label>
            <label className="field">Employer<input className="input" value={f.employer} onChange={set('employer')} /></label>
            <label className="field">In effect since<input className="input" type="date" value={f.effective} onChange={set('effective')} /></label>
          </div>
          <label className="field" style={{ marginTop: 12 }}>How the match works<input className="input" value={f.match_notes} onChange={set('match_notes')} placeholder="you 5% → they 4%" /></label>
          <label className="field" style={{ marginTop: 12 }}>Notes (bonuses, raises…)<input className="input" value={f.notes} onChange={set('notes')} /></label>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>Save</button>
        </div>

        <div className="card">
          <h2>Where each paycheck goes</h2>
          {!b ? <div className="empty">Enter your salary and take-home to see the breakdown.</div> : (
            <>
              <table className="data">
                <thead><tr><th></th><th className="r">Per paycheck</th><th className="r">Per year</th></tr></thead>
                <tbody>
                  {LINES.map((l) => (
                    <tr key={l.key}>
                      <td>{'strong' in l ? <b>{l.label}</b> : l.label}<div className="muted small">{l.note}</div></td>
                      <td className="r">{'minus' in l ? '−' : ''}{money(b.per_paycheck[l.key])}</td>
                      <td className="r">{'minus' in l ? '−' : ''}{money(b.per_year[l.key], { cents: false })}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{data?.settings.employer || 'Employer'} 401(k) match<div className="muted small">added on top, never hits your bank</div></td>
                    <td className="r">+{money(b.per_paycheck.employer_match)}</td>
                    <td className="r">+{money(b.per_year.employer_match, { cents: false })}</td>
                  </tr>
                </tbody>
              </table>
              <p className="small muted" style={{ marginBottom: 0 }}>Taxes & deductions are {pct(b.effective_tax_rate)} of gross. Retirement saving: {money(b.per_year.retirement + b.per_year.employer_match, { cents: false })}/yr total.</p>
            </>
          )}
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Past pay</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Earlier salaries, so 401(k) and take-home for past years use what you actually earned then.</p>
          {history.length > 0 && (
            <table className="data">
              <thead><tr><th>From</th><th className="r">Salary</th><th className="r">Take-home</th><th className="r">401(k)</th><th className="r">Match</th><th></th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.effective}>
                    <td>{niceDate(h.effective)}</td><td className="r">{money(h.gross_annual, { cents: false })}</td>
                    <td className="r">{money(h.net_per_paycheck)}</td><td className="r">{h.retirement_pct}%</td><td className="r">{h.employer_match_pct}%</td>
                    <td className="r"><button className="link-btn" onClick={() => removePast(h.effective)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label className="field">From<input className="input" type="date" value={past.effective} onChange={(e) => setPast({ ...past, effective: e.target.value })} /></label>
            <label className="field">Salary<input className="input" inputMode="decimal" value={past.gross_annual} onChange={(e) => setPast({ ...past, gross_annual: e.target.value })} /></label>
            <label className="field">Take-home / check<input className="input" inputMode="decimal" value={past.net_per_paycheck} onChange={(e) => setPast({ ...past, net_per_paycheck: e.target.value })} /></label>
            <label className="field">401(k) %<input className="input" inputMode="decimal" value={past.retirement_pct} onChange={(e) => setPast({ ...past, retirement_pct: e.target.value })} /></label>
            <label className="field">Match %<input className="input" inputMode="decimal" value={past.employer_match_pct} onChange={(e) => setPast({ ...past, employer_match_pct: e.target.value })} /></label>
            <button className="btn" onClick={addPast}>Add</button>
          </div>
        </div>
        <div className="card">
          <h2>Bonuses</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Paydays well above your usual paycheck. The extra is estimated as that day's total minus a normal paycheck.</p>
          {bonuses.length === 0 ? <div className="empty">None found.</div> : bonuses.map((x) => (
            <div className="row" key={x.date}>
              <div className="row-main"><div className="row-title">{niceDate(x.date)}</div><div className="muted small">{x.employer} · deposit was {money(x.total)}</div></div>
              <div className="row-amt">≈ {money(x.bonus, { cents: false })}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card section">
        <h2>Paychecks the app found</h2>
        <p className="muted small" style={{ marginTop: -4 }}>A paycheck split between Wells Fargo and Wealthfront on the same day counts as one. Off-schedule deposits (reimbursements, bonuses) aren't counted here.</p>
        {!data ? <div className="empty">Loading…</div> : data.detected.length === 0 ? <div className="empty">No paychecks detected yet.</div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employer</th><th>Status</th><th>How often</th><th className="r">Typical paycheck</th><th className="r">Last 12 months</th><th>Lands in</th></tr></thead>
              <tbody>
                {data.detected.map((e) => (
                  <tr key={e.employer}>
                    <td><b>{e.employer}</b><div className="muted small">{niceDate(e.first)} – {niceDate(e.last)} · {e.deposits} deposits</div></td>
                    <td>{e.active ? <span className="badge income">● Current</span> : <span className="badge">Past</span>}</td>
                    <td>{e.frequency || '—'}</td>
                    <td className="r">{money(e.typical_paycheck)}</td>
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
              <GradDefs />
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={niceDate} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tickFormatter={moneyShort} tick={{ fill: 'var(--axis)', fontSize: 12.5 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => active && payload?.length ? (
                <div className="tt"><div className="tt-head">{niceDate(String(payload[0].payload.date))}</div><b className="num">{money(Number(payload[0].value))}</b></div>) : null} />
              <Bar isAnimationActive={motionOK} animationDuration={700} dataKey="amount" fill="url(#g-income)" radius={[7, 7, 2, 2]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ))}
    </>
  )
}

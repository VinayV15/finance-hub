import { useState } from 'react'
import { put } from '../api'
import { Num, Ring } from '../components/Viz'
import { money, niceDate, pct } from '../format'
import { useFetch, useToast } from '../hooks'

interface TaxYear {
  year: number; limits: { k401: number; ira: number }
  roth: { contributed: number; limit: number; left: number; jan_to_apr15: number; monthly_to_max: number | null }
  k401: { yours: number; match: number; limit: number; projected_year_end: number; estimated: boolean; left: number }
  dividends: { taxable: number; sheltered: number }
  interest: { institution: string; name: string; amount: number }[]; interest_total: number
  refunds: { date: string; name: string; amount: number }[]
  withheld_ytd: number | null
}

export function Taxes() {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const { data, reload } = useFetch<TaxYear>(`/api/taxes?year=${year}`)
  const toast = useToast()
  const [edit, setEdit] = useState<{ k401: string; ira: string } | null>(null)
  if (!data) return <div className="empty">Loading…</div>
  const r = data.roth, k = data.k401
  const current = year === thisYear
  const saveLimits = async () => {
    try { await put('/api/taxes/limits', { year, ...edit }); setEdit(null); reload(); toast(`Limits for ${year} saved.`) }
    catch (e) { toast((e as Error).message, true) }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Taxes & limits</h1>
          <div className="muted small">Retirement contribution room and the income you'll report for {year}. A guide, not tax advice.</div>
        </div>
        <div className="seg">
          {[thisYear - 1, thisYear].map((y) => <button key={y} className={year === y ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <div className="group-head"><h2>Roth IRA</h2><span className="muted small">limit {money(r.limit, { cents: false })}</span></div>
          <div className="goal-body">
            <Ring value={r.contributed / r.limit} size={108} stroke={10} color={r.left <= 0 ? 'var(--good)' : 'var(--accent)'} label={`${pct(r.contributed / r.limit)} of Roth IRA limit`}>
              <span className="ring-pct big">{pct(r.contributed / r.limit)}</span>
            </Ring>
            <div>
              <div className="goal-amt"><Num v={r.contributed} /></div>
              <div className="muted">deposited in {year}</div>
              <div style={{ marginTop: 6, fontWeight: 650 }} className={r.left <= 0 ? 'pos' : ''}>
                {r.left <= 0 ? '✓ Maxed out' : <>{money(r.left, { cents: false })} of room left{current && r.monthly_to_max ? <> · {money(r.monthly_to_max, { cents: false })}/mo to max it</> : null}</>}
              </div>
            </div>
          </div>
          {r.jan_to_apr15 > 0 && <p className="note">{money(r.jan_to_apr15, { cents: false })} went in between Jan 1 and Apr 15. If any of it counted toward {year - 1}, you have that much more room for {year}.</p>}
        </div>

        <div className="card">
          <div className="group-head"><h2>401(k)</h2><span className="muted small">your limit {money(k.limit, { cents: false })}</span></div>
          <div className="goal-body">
            <Ring value={k.yours / k.limit} pace={current ? Math.min(k.projected_year_end / k.limit, 0.999) : null} size={108} stroke={10}
                  color="var(--s-invest)" label={`${pct(k.yours / k.limit)} of 401(k) limit`}>
              <span className="ring-pct big">{pct(k.yours / k.limit)}</span>
            </Ring>
            <div>
              <div className="goal-amt"><Num v={k.yours} /></div>
              <div className="muted">yours so far{k.estimated ? ' (estimated from paychecks)' : ''}</div>
              <div style={{ marginTop: 6 }} className="small">+ {money(k.match, { cents: false })} employer match (doesn't count toward your limit)</div>
              {current && <div className="small muted">On pace for {money(k.projected_year_end, { cents: false })} by Dec 31 · the tick shows where</div>}
            </div>
          </div>
          {current && k.left > 0 && <p className="note">To max it out you'd need {money(k.left, { cents: false })} more this year. Change your contribution % with your employer; update it on the Income page after.</p>}
        </div>
      </div>

      <div className="tiles section">
        <div className="tile"><div className="label">Taxable dividends</div><div className="value"><Num v={data.dividends.taxable} cents /></div><div className="sub">brokerage only · {money(data.dividends.sheltered)} more inside retirement accounts (not taxed now)</div></div>
        <div className="tile"><div className="label">Interest earned</div><div className="value"><Num v={data.interest_total} cents /></div>
          <div className="sub">{data.interest.map((i) => `${i.institution} ${money(i.amount)}`).join(' · ') || 'none yet'}</div></div>
        {data.withheld_ytd != null && <div className="tile"><div className="label">Taxes & deductions from pay</div><div className="value"><Num v={data.withheld_ytd} /></div><div className="sub">from your pay settings, {year}</div></div>}
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Tax refunds</h2>
          {data.refunds.length === 0 ? <div className="empty">No tax refunds found.</div> : data.refunds.map((t) => (
            <div key={t.date} className="row"><div className="row-main"><div className="row-title">{new Date(`${t.date}T00:00:00`).getFullYear() - 1} tax year refund</div><div className="muted small">arrived {niceDate(t.date)}</div></div>
              <div className="row-amt pos">+{money(t.amount)}</div></div>
          ))}
        </div>
        <div className="card">
          <div className="group-head"><h2>Limits for {year}</h2>{!edit && <button className="link-btn" onClick={() => setEdit({ k401: String(data.limits.k401), ira: String(data.limits.ira) })}>Edit</button>}</div>
          {edit ? (
            <div className="form-grid">
              <label className="field">401(k) (your part)<input className="input" inputMode="decimal" value={edit.k401} onChange={(e) => setEdit({ ...edit, k401: e.target.value })} /></label>
              <label className="field">IRA / Roth IRA<input className="input" inputMode="decimal" value={edit.ira} onChange={(e) => setEdit({ ...edit, ira: e.target.value })} /></label>
              <div style={{ display: 'flex', gap: 8 }}><button className="btn primary" onClick={saveLimits}>Save limits</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>401(k): {money(data.limits.k401, { cents: false })} · IRA: {money(data.limits.ira, { cents: false })}. These are the IRS limits for people under 50. If yours differ, edit them.</p>
          )}
        </div>
      </div>
    </>
  )
}

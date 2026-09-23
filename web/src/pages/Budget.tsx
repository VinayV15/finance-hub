import { useEffect, useState } from 'react'
import { post, put, qs, type BudgetMonth, type BudgetRow } from '../api'
import { money, periodLabel } from '../format'
import { useFetch, useToast } from '../hooks'

const shiftMonth = (m: string, n: number) => {
  const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }

const STATUS = {
  over: { icon: '⚠', label: 'Over', color: 'var(--bad)' },
  ahead_of_pace: { icon: '◔', label: 'Ahead of pace', color: 'var(--warn)' },
  ok: { icon: '✓', label: 'On track', color: 'var(--good)' },
} as const

/** One category: spent vs. limit, with a tick showing where you'd be if you spent evenly all month. */
function Bar({ r, pace, onEdit }: { r: BudgetRow; pace: number; onEdit: (v: string) => void }) {
  const [val, setVal] = useState(r.budget != null ? String(r.budget) : '')
  useEffect(() => setVal(r.budget != null ? String(r.budget) : ''), [r.budget])
  const b = r.budget || 0
  const pct = b ? Math.min(r.spent / b, 1) : 0
  const st = r.status ? STATUS[r.status] : null
  const fill = r.status === 'over' ? 'var(--bad)' : r.status === 'ahead_of_pace' ? 'var(--warn)' : 'var(--seq)'
  return (
    <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div className="row-main" style={{ minWidth: 180 }}>
        <div className="row-title">{r.category}</div>
        <div className="small muted">
          {b ? <>{money(r.spent, { cents: false })} of {money(b, { cents: false })} · {r.left! >= 0 ? `${money(r.left, { cents: false })} left` : `${money(-r.left!, { cents: false })} over`}</>
            : <>{money(r.spent, { cents: false })} spent · no budget{r.suggested ? ` (suggested ${money(r.suggested, { cents: false })})` : ''}</>}
          {st && <span style={{ color: st.color, marginLeft: 8, fontWeight: 600 }}>{st.icon} {st.label}</span>}
        </div>
        {b > 0 && (
          <div style={{ position: 'relative', height: 10, background: 'var(--surface-2)', borderRadius: 5, marginTop: 6 }}
               title={`${Math.round((r.spent / b) * 100)}% used, ${Math.round(pace * 100)}% of the month gone`}>
            <div style={{ width: `${pct * 100}%`, height: '100%', background: fill, borderRadius: 5 }} />
            {pace < 1 && <div style={{ position: 'absolute', left: `${pace * 100}%`, top: -3, bottom: -3, width: 2, background: 'var(--text-2)', borderRadius: 1 }} />}
          </div>
        )}
        {r.avg6 != null && <div className="small muted" style={{ marginTop: 4 }}>6-month average {money(r.avg6, { cents: false })}</div>}
      </div>
      <label className="field" style={{ width: 120 }}>Monthly limit
        <input className="input" inputMode="decimal" value={val} placeholder={r.suggested ? String(r.suggested) : '—'}
               onChange={(e) => setVal(e.target.value)} onBlur={() => val !== (r.budget != null ? String(r.budget) : '') && onEdit(val)}
               onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
    </div>
  )
}

export function Budget() {
  const toast = useToast()
  const [month, setMonth] = useState(thisMonth())
  const { data, reload } = useFetch<BudgetMonth>(`/api/budget${qs({ month })}`)
  const save = async (category: string, value: string) => {
    try { await put(`/api/budget${qs({ month })}`, { [category]: value.trim() }); reload(); toast(value.trim() ? `${category} set to $${value}.` : `${category} budget removed.`) }
    catch (e) { toast((e as Error).message, true) }
  }
  const fill = async () => {
    try { await post(`/api/budget/suggest${qs({ month })}`, {}); reload(); toast('Filled in suggested budgets. Adjust any of them.') }
    catch (e) { toast((e as Error).message, true) }
  }
  if (!data) return <div className="empty">Loading…</div>
  const budgeted = data.rows.filter((r) => r.budget)
  const unbudgeted = data.rows.filter((r) => !r.budget)
  const over = budgeted.filter((r) => r.status === 'over')
  const isCurrent = month === thisMonth()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Budget</h1>
          <div className="muted small">Monthly limits per category. Each month starts fresh.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn small" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
          <b style={{ minWidth: 70, textAlign: 'center' }}>{periodLabel(month)}</b>
          <button className="btn small" onClick={() => setMonth(shiftMonth(month, 1))} disabled={isCurrent} aria-label="Next month">›</button>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">Budgeted</div><div className="value">{money(data.total_budget, { cents: false })}</div>
          <div className="sub">{data.take_home ? `of ${money(data.take_home, { cents: false })} monthly take-home` : 'set your pay on the Income page'}</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spent so far</div>
          <div className="value">{money(data.budgeted_spent + data.unbudgeted_spent, { cents: false })}</div>
          <div className="sub">{money(data.money_back, { cents: false })} came back (paybacks, refunds) · net {money(data.net_spent, { cents: false })}</div></div>
        <div className="tile"><div className="label">Left in budgets</div>
          <div className={`value ${data.total_budget - data.budgeted_spent < 0 ? 'neg' : ''}`}>{money(data.total_budget - data.budgeted_spent, { cents: false })}</div>
          <div className="sub">{isCurrent ? `${data.days - data.elapsed} days left in the month` : 'month closed'}</div></div>
        {data.left_after_budget != null && <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Not budgeted = can save</div>
          <div className={`value ${data.left_after_budget < 0 ? 'neg' : 'pos'}`}>{money(data.left_after_budget, { cents: false })}</div>
          <div className="sub">take-home minus all budgets, per month</div></div>}
      </div>

      {over.length > 0 && <div className="alert"><span>⚠ Over budget: {over.map((r) => `${r.category} (${money(-r.left!, { cents: false })} over)`).join(', ')}</span></div>}

      {budgeted.length === 0 ? (
        <div className="card">
          <h2>Start with suggested budgets</h2>
          <p className="muted small">Each suggestion is the middle value of your last 6 full months for that category, rounded up to $10, so one unusual month doesn't throw it off.</p>
          <button className="btn primary" onClick={fill}>Fill in suggested budgets</button>
        </div>
      ) : (
        <div className="card">
          <div className="group-head"><h2>Your budgets</h2><span className="muted small">the tick shows where even spending would put you today</span></div>
          {budgeted.map((r) => <Bar key={r.category} r={r} pace={isCurrent ? data.pace : 1} onEdit={(v) => save(r.category, v)} />)}
        </div>
      )}

      {unbudgeted.length > 0 && (
        <div className="card section">
          <div className="group-head"><h2>No budget yet</h2>{budgeted.length > 0 && unbudgeted.some((r) => r.suggested) && <button className="btn small" onClick={fill}>Fill suggestions</button>}</div>
          {unbudgeted.map((r) => <Bar key={r.category} r={r} pace={isCurrent ? data.pace : 1} onEdit={(v) => save(r.category, v)} />)}
        </div>
      )}
    </>
  )
}

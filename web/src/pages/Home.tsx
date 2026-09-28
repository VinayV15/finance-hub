import { Link } from 'react-router-dom'
import type { Account, Totals } from '../api'
import { qs } from '../api'
import { CashflowChart } from '../components/Charts'
import { ago, money, pct } from '../format'
import { presetRange, useFetch, useSummary } from '../hooks'

const GROUPS: { key: Account['type']; title: string; debt?: boolean }[] = [
  { key: 'depository', title: 'Cash' },
  { key: 'investment', title: 'Investments' },
  { key: 'other', title: 'Other assets' },
  { key: 'credit', title: 'Credit cards', debt: true },
  { key: 'loan', title: 'Loans & mortgage', debt: true },
]

export function Home() {
  const { summary: s } = useSummary()
  const six = presetRange('6m')
  const cf = useFetch<{ periods: (Totals & { period: string })[] }>(`/api/cashflow${qs({ ...six, group: 'month' })}`).data
  if (!s) return <div className="empty">Loading…</div>
  const m = s.this_month
  const broken = s.items.filter((i) => i.status && i.status !== 'ok')
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="muted small">Refreshed {ago(s.last_sync)} · updates daily while the app runs</div>
        </div>
      </div>

      {broken.map((i) => (
        <div className="alert" key={i.item_id}>
          <span>⚠ <b>{i.institution}</b> needs you to sign in again.</span>
          <Link className="btn small" to="/accounts">Fix it</Link>
        </div>
      ))}
      {s.review_count > 0 && (
        <div className="alert">
          <span>⚠ {s.review_count} transaction{s.review_count === 1 ? '' : 's'} need a quick look so your totals are right.</span>
          <Link className="btn small" to="/review">Review</Link>
        </div>
      )}

      <div className="tiles">
        <div className="tile hero" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Net worth</div>
          <div className={`value ${s.net_worth < 0 ? 'neg' : ''}`}>{money(s.net_worth, { cents: false })}</div>
          <div className="hero-foot">
            <div><b>{money(s.accounts.filter((a) => a.type === 'depository').reduce((t, a) => t + (a.balance || 0), 0), { cents: false })}</b>cash</div>
            <div><b>{money(s.accounts.filter((a) => a.type === 'investment').reduce((t, a) => t + (a.balance || 0), 0), { cents: false })}</b>invested</div>
            <div><b>{money(s.debts, { cents: false })}</b>owed</div>
          </div>
        </div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Income this month</div><div className="value">{money(m.income, { cents: false })}</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spent this month</div><div className="value">{money(m.spend, { cents: false })}</div></div>
        <div className="tile"><div className="label">Saved this month</div><div className={`value ${m.saved < 0 ? 'neg' : ''}`}>{money(m.saved, { cents: false })}</div><div className="sub">{pct(m.savings_rate)} of income</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested this month</div><div className="value">{money(m.invested, { cents: false })}</div></div>
      </div>

      <div className="card">
        <div className="group-head"><h2>Last 6 months</h2><Link to="/dashboard" className="small">Full dashboard →</Link></div>
        {cf ? <CashflowChart periods={cf.periods} height={240} /> : <div className="empty">Loading…</div>}
      </div>

      <div className="grid two section">
        {GROUPS.map((g) => {
          const rows = s.accounts.filter((a) => (a.type || 'other') === g.key)
          if (!rows.length) return null
          return (
            <div className="card" key={g.key}>
              <div className="group-head"><h2>{g.title}</h2><span className="num">{money(rows.reduce((t, a) => t + (a.balance || 0), 0), { cents: false })}</span></div>
              {rows.map((a) => (
                <div className="row" key={a.account_id}>
                  <div className="row-main">
                    <div className="row-title">{a.name}{a.mask ? <span className="muted"> ••{a.mask}</span> : null}</div>
                    <div className="muted small">
                      {a.institution}
                      {a.apr ? ` · ${a.apr.toFixed(2)}% APR` : ''}
                      {a.next_due ? ` · due ${a.next_due}` : ''}
                      {a.source !== 'plaid' ? ` · ${a.source === 'venmo' ? 'from CSV' : 'manual'}, updated ${ago(a.updated_at)}` : ''}
                    </div>
                  </div>
                  <div className="row-amt">{money(a.balance)}</div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

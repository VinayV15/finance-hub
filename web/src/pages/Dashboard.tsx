import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { qs, type AccountFlow, type CategoryRow, type Coverage, type Totals } from '../api'
import { CashflowChart, HBarList } from '../components/Charts'
import { Filters } from '../components/Filters'
import { money, niceDate, pct } from '../format'
import { useFetch, useRange } from '../hooks'

type Group = 'week' | 'month' | 'quarter' | 'year'

export function Dashboard() {
  const r = useRange()
  const nav = useNavigate()
  const [group, setGroup] = useState<Group>('month')
  const q = { start: r.start, end: r.end, accounts: r.accounts }
  const cf = useFetch<{ periods: (Totals & { period: string })[]; total: Totals }>(`/api/cashflow${qs({ ...q, group })}`).data
  const cats = useFetch<CategoryRow[]>(`/api/categories${qs(q)}`).data || []
  const incomeCats = useFetch<CategoryRow[]>(`/api/categories${qs({ ...q, flow: 'income' })}`).data || []
  const merchants = useFetch<{ name: string; amount: number; n: number }[]>(`/api/merchants${qs(q)}`).data || []
  const perAcct = useFetch<AccountFlow[]>(`/api/by_account${qs({ start: r.start, end: r.end })}`).data || []
  const coverage = useFetch<Coverage[]>('/api/coverage').data || []

  const t = cf?.total
  // Accounts whose history starts after the range begins -> numbers for the range are incomplete.
  // Grouped by institution (earliest date across its accounts) so each bank is listed once.
  const firstByInst = new Map<string, string>()
  for (const c of coverage) {
    if (!c.first || !c.n || (r.accounts.length && !r.accounts.includes(c.account_id))) continue
    const prev = firstByInst.get(c.institution)
    if (!prev || c.first < prev) firstByInst.set(c.institution, c.first)
  }
  const gaps = [...firstByInst].filter(([, first]) => !r.start || first > r.start).map(([institution, first]) => ({ institution, first }))
  const months = cf?.periods.length || 1

  const toTxns = (params: Record<string, string>) => nav(`/transactions${qs(params)}`)

  return (
    <>
      <div className="page-head"><h1>Dashboard</h1></div>
      <Filters />

      {gaps.length > 0 && (
        <div className="alert">
          <span>⚠ History is incomplete for this range: {gaps.map((g) => `${g.institution} starts ${niceDate(g.first)}`).join('; ')}.
            {gaps.some((g) => g.institution === 'Wealthfront') ? ' Import past Wealthfront statements to fill it in.' : ''}</span>
        </div>
      )}

      <div className="tiles">
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Income</div><div className="value">{money(t?.income, { cents: false })}</div><div className="sub">{money(t?.paychecks, { cents: false })} paychecks + {money((t?.income || 0) - (t?.paychecks || 0), { cents: false })} other (interest, tax refund…)</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spending</div><div className="value">{money(t?.spend, { cents: false })}</div><div className="sub">{money((t?.spend || 0) / months, { cents: false })} / {group} avg · after {money(t?.refunds, { cents: false })} refunds, paybacks & reimbursements</div></div>
        <div className="tile"><div className="label">Saved</div><div className={`value ${(t?.saved || 0) < 0 ? 'neg' : ''}`}>{money(t?.saved, { cents: false })}</div><div className="sub">{pct(t?.savings_rate)} of income</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested</div><div className="value">{money(t?.invested, { cents: false })}</div><div className="sub">into Robinhood etc.{t?.retirement ? <> · plus {money(t.retirement, { cents: false })} into your 401(k) from paychecks (est., you + match)</> : null}</div></div>
        <div className="tile"><div className="label">Investment earnings</div><div className="value">{money(t?.growth, { cents: false })}</div><div className="sub">dividends & interest inside accounts</div></div>
      </div>

      <div className="card">
        <div className="group-head">
          <h2>Income vs. spending</h2>
          <div className="seg">
            {(['week', 'month', 'quarter', 'year'] as Group[]).map((g) => (
              <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{g[0].toUpperCase() + g.slice(1)}</button>
            ))}
          </div>
        </div>
        {cf ? <CashflowChart periods={cf.periods} /> : <div className="empty">Loading…</div>}
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Spending by category</h2>
          <HBarList rows={cats.map((c) => ({ label: c.category, amount: c.amount }))}
                    onPick={(c) => toTxns({ category: c, flow: 'spend' })} />
        </div>
        <div className="card">
          <h2>Where it went (top merchants)</h2>
          <HBarList rows={merchants.map((m) => ({ label: m.name, amount: m.amount }))} limit={10}
                    onPick={(n) => toTxns({ q: n })} />
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Income by source</h2>
          <HBarList rows={incomeCats.map((c) => ({ label: c.category, amount: c.amount }))}
                    onPick={(c) => toTxns({ category: c, flow: 'income' })} />
        </div>
        <div className="card">
          <h2>Where the money lives</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Transfers between your accounts are shown separately and never count as spending.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th className="r">In</th><th className="r">Spent</th><th className="r">Moved in</th><th className="r">Moved out</th></tr></thead>
              <tbody>
                {perAcct.map((a) => (
                  <tr key={a.account_id}>
                    <td>{a.institution}<div className="muted small">{a.name}</div></td>
                    <td className="r">{money(a.income, { cents: false })}</td>
                    <td className="r">{money(a.spend, { cents: false })}</td>
                    <td className="r muted">{money(a.transfers_in, { cents: false })}</td>
                    <td className="r muted">{money(a.transfers_out, { cents: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

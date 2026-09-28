import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { qs, type Account, type AccountFlow, type Mortgage, type CategoryRow, type Coverage, type Investments, type Totals } from '../api'
import { CashflowChart, HBarList } from '../components/Charts'
import { Filters } from '../components/Filters'
import { money, niceDate, pct, periodLabel, periodRange } from '../format'
import { MoneyFlow, Num, Sparkline, type FlowNode } from '../components/Viz'
import { useFetch, useRange, useSummary } from '../hooks'

type Group = 'week' | 'month' | 'quarter' | 'year'

function acctRow(a: Account) {
  return { key: a.account_id, name: a.name, sub: a.institution || '', value: a.balance || 0 }
}

export function Dashboard() {
  const r = useRange()
  const nav = useNavigate()
  const [group, setGroup] = useState<Group>('month')
  const q = { start: r.start, end: r.end, accounts: r.accounts }
  const cf = useFetch<{ periods: (Totals & { period: string })[]; total: Totals }>(`/api/cashflow${qs({ ...q, group })}`).data
  const cats = useFetch<CategoryRow[]>(`/api/categories${qs(q)}`).data || []
  const incomeCats = useFetch<CategoryRow[]>(`/api/categories${qs({ ...q, flow: 'income' })}`).data || []
  const merchants = useFetch<{ name: string; amount: number; n: number; paid: number; extra_principal: number }[]>(`/api/merchants${qs(q)}`).data || []
  const perAcct = useFetch<AccountFlow[]>(`/api/by_account${qs({ start: r.start, end: r.end })}`).data || []
  const coverage = useFetch<Coverage[]>('/api/coverage').data || []
  const { summary } = useSummary()
  const mort = useFetch<Mortgage>('/api/mortgage').data
  const nw = useFetch<{ points: { date: string; invested: number }[] }>('/api/networth_history').data
  const inv = useFetch<Investments>(`/api/investments${qs(q)}`).data

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

  const it = inv?.total
  const KIND_LABEL = { roth: 'Roth IRA', '401k': '401(k)', ira: 'IRA', brokerage: 'Brokerage' }
  const gainPct = it?.cost_basis ? it.gain_all_time / it.cost_basis : null
  const est = inv?.retirement_estimate
  const putInLinked = (it?.put_in || 0) - (est?.put_in || 0)

  // Balances right now, grouped. Credit cards and the mortgage are money owed.
  const accts = summary?.accounts || []
  const GROUPS: { label: string; owed?: boolean; rows: { key: string; name: string; sub: string; value: number; note?: string }[] }[] = [
    { label: 'Cash', rows: accts.filter((a) => a.type === 'depository').map(acctRow) },
    { label: 'Investments', rows: [...accts.filter((a) => a.type === 'investment').map(acctRow),
      ...(est ? [{ key: '401k', name: '401(k)', sub: 'estimated from paychecks', value: est.value, note: 'est.' }] : [])] },
    ...(summary?.home ? [{ label: 'Home', rows: [{ key: 'home', name: 'Home value', sub: 'from the Mortgage page', value: summary.home.home_value }] }] : []),
    { label: 'Credit cards', owed: true, rows: accts.filter((a) => a.type === 'credit').map(acctRow) },
    { label: 'Loans', owed: true, rows: [...accts.filter((a) => a.type === 'loan').map(acctRow),
      ...(mort?.config && !accts.some((a) => a.type === 'loan' && a.subtype === 'mortgage')
        ? [{ key: 'mortgage', name: 'Mortgage', sub: mort.config.servicer || mort.config.lender, value: mort.balance }] : [])] },
  ].filter((g) => g.rows.length)

  const toTxns = (params: Record<string, string>) => nav(`/transactions${qs(params)}`)
  const drill = (period: string, flows?: string) => {
    const pr = periodRange(period, group)
    r.setCustom(pr.start, pr.end)
    toTxns(flows ? { flows } : {})
  }
  const periods = cf?.periods || []
  const plabels = periods.map((p) => periodLabel(p.period))
  const spark = (k: 'income' | 'spend' | 'saved' | 'invested', color: string) =>
    <Sparkline values={periods.map((p) => p[k] || 0)} labels={plabels} color={color} />

  // Money flow: where income (and money back) went. Balanced by "kept in cash" or "from savings".
  const flow = (() => {
    if (!t) return null
    const sources: FlowNode[] = incomeCats.filter((c) => c.amount > 0).map((c) => ({
      label: c.category, amount: c.amount, color: 'var(--s-income)', onClick: () => toTxns({ category: c.category, flows: 'income' }) }))
    const back = cats.filter((c) => c.amount < 0)
    if (back.length) sources.push({ label: 'Money back', amount: -back.reduce((s, c) => s + c.amount, 0), color: 'var(--good)',
      onClick: () => toTxns({ flows: 'refund' }) })
    const spend = cats.filter((c) => c.amount > 0)
    const top = spend.slice(0, 6), rest = spend.slice(6)
    const SPEND_SLOTS = ['--c3', '--c4', '--c6', '--c5', '--c7', '--c2'] // distinct from Invested (lavender) and income (mint)
    const outs: FlowNode[] = top.map((c, i) => ({ label: c.category, amount: c.amount, color: `var(${SPEND_SLOTS[i]})`,
      onClick: () => toTxns({ category: c.category, flows: 'spend,refund' }) }))
    if (rest.length) outs.push({ label: `Other spending (${rest.length})`, amount: rest.reduce((s, c) => s + c.amount, 0), color: 'var(--c-other)',
      onClick: () => toTxns({ flows: 'spend,refund' }) })
    if (t.invested > 0) outs.push({ label: 'Invested', amount: t.invested, color: 'var(--s-invest)', onClick: () => toTxns({ invested: '1' }) })
    const gap = sources.reduce((s, n) => s + n.amount, 0) - outs.reduce((s, n) => s + n.amount, 0)
    if (gap > 1) outs.push({ label: 'Kept in cash', amount: gap, color: 'var(--seq-2)' })
    else if (gap < -1) sources.push({ label: 'From savings', amount: -gap, color: 'var(--warn)' })
    return { sources, outs }
  })()

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
        <div className="tile clickable" onClick={() => toTxns({ flows: 'income' })}><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Income</div><div className="value"><Num v={t?.income} /></div>{spark('income', 'var(--s-income)')}<div className="sub">{money(t?.paychecks, { cents: false })} paychecks + {money((t?.income || 0) - (t?.paychecks || 0), { cents: false })} other (interest, tax refund…)</div></div>
        <div className="tile clickable" onClick={() => toTxns({ flows: 'spend,refund' })}><div className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spending</div><div className="value"><Num v={t?.spend} /></div>{spark('spend', 'var(--s-spend)')}<div className="sub">{money((t?.spend || 0) / months, { cents: false })} / {group} avg · after {money(t?.refunds, { cents: false })} refunds, paybacks & reimbursements{t?.extra_principal ? <> · excludes {money(t.extra_principal, { cents: false })} extra mortgage principal (saving)</> : null}</div></div>
        <div className="tile"><div className="label">Saved</div><div className={`value ${(t?.saved || 0) < 0 ? 'neg' : ''}`}><Num v={t?.saved} /></div>{spark('saved', 'var(--accent)')}<div className="sub"><b>{money((t?.saved || 0) / (t?.months || 1), { cents: false })} / month</b> avg over {t?.months || 0} {t?.months === 1 ? 'month' : 'months'} · {pct(t?.savings_rate)} of income</div></div>
        <div className="tile clickable" onClick={() => toTxns({ invested: '1' })}><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested (worth now)</div><div className="value"><Num v={it?.value} /></div>
          {nw && <Sparkline values={nw.points.map((p) => p.invested)} labels={nw.points.map((p) => niceDate(p.date))} color="var(--s-invest)" />}<div className="sub">
          {inv?.accounts.map((a) => <span key={a.account_id}>{KIND_LABEL[a.kind]} {money(a.value, { cents: false })} · </span>)}
          {est && <span>401(k) ~{money(est.value, { cents: false })} (est. from paychecks, no gains) · </span>}
          put in this range: {money(putInLinked, { cents: false })}{est?.put_in ? <> + ~{money(est.put_in, { cents: false })} 401(k)</> : null}
        </div></div>
        <div className="tile"><div className="label">Investment earnings</div>
          {it?.gain_range != null ? <>
            <div className={`value ${it.gain_range < 0 ? 'neg' : 'pos'}`}><Num v={it.gain_range} sign /></div>
            <div className="sub">in this range: price changes + {money(it.dividends, { cents: false })} dividends & interest, after {money(it.fees, { cents: false })} fees</div>
          </> : <>
            <div className={`value ${(it?.gain_all_time || 0) < 0 ? 'neg' : 'pos'}`}><Num v={it?.gain_all_time} sign /></div>
            <div className="sub">{pct(gainPct)} up on what you hold now vs. what you paid (all time{est ? ', 401(k) not included' : ''}) · {money(it?.dividends, { cents: false })} dividends & interest in this range{inv?.tracking_since ? ` · gains for a date range are tracked from ${niceDate(inv.tracking_since)}` : ''}</div>
          </>}
        </div>
      </div>

      <div className="card section">
        <div className="group-head">
          <h2>Balances right now</h2>
          <span className="muted small">not affected by the date range</span>
        </div>
        <div className="balances">
          {GROUPS.map((g) => {
            const sum = g.rows.reduce((s, r) => s + r.value, 0)
            return (
              <div key={g.label}>
                <div className="bal-head"><span>{g.label}{g.owed ? ' (owed)' : ''}</span><b className={`num ${g.owed ? 'neg' : ''}`}>{money(g.owed ? -sum : sum, { cents: false })}</b></div>
                {g.rows.map((r) => (
                  <div key={r.key} className="bal-row">
                    <span>{r.name}<span className="muted small"> · {r.sub}</span></span>
                    <span className="num">{r.note ? '~' : ''}{money(r.value, { cents: false })}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
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
        {cf ? <CashflowChart periods={cf.periods} onPick={drill} /> : <div className="empty">Loading…</div>}
      </div>

      <div className="card section">
        <div className="group-head">
          <h2>Where the money went</h2>
          <span className="muted small">thicker = more dollars · click a stream to see its transactions</span>
        </div>
        {flow ? <MoneyFlow sources={flow.sources} outs={flow.outs} /> : <div className="empty">Loading…</div>}
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Spending by category</h2>
          <HBarList rows={cats.map((c) => ({ label: c.category, amount: c.amount }))}
                    onPick={(c) => toTxns({ category: c, flows: 'spend,refund' })} />
        </div>
        <div className="card">
          <h2>Where it went (top merchants)</h2>
          <HBarList rows={merchants.map((m) => ({ label: m.name, amount: m.amount,
                      note: m.extra_principal > 0 ? `paid ${money(m.paid, { cents: false })}: ${money(m.amount, { cents: false })} regular + ${money(m.extra_principal, { cents: false })} extra principal (counted as saving)` : undefined }))} limit={10}
                    onPick={(n) => toTxns({ name: n, flows: 'spend,refund' })} />
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Income by source</h2>
          <HBarList rows={incomeCats.map((c) => ({ label: c.category, amount: c.amount }))}
                    onPick={(c) => toTxns({ category: c, flows: 'income' })} />
        </div>
        <div className="card">
          <h2>Where the money lives</h2>
          <p className="muted small" style={{ marginTop: -4 }}>"Change in range" is how much each balance actually grew or shrank (everything in minus everything out). Paychecks that land in one account and then move to another show as earned there, then moved out; moves between your accounts never count as spending.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th className="r">Balance now</th><th className="r">Change in range</th><th className="r">Earned</th><th className="r">Spent</th><th className="r">Net moved</th></tr></thead>
              <tbody>
                {perAcct.map((a) => {
                  const moved = (a.transfers_in || 0) - (a.transfers_out || 0)
                  return (
                    <tr key={a.account_id}>
                      <td>{a.institution}<div className="muted small">{a.name}</div></td>
                      <td className="r">{money(a.type === 'credit' || a.type === 'loan' ? -(a.balance || 0) : a.balance, { cents: false })}</td>
                      {a.type === 'investment'
                        ? <td className="r muted" title="Market moves aren't transactions, so they aren't in this column. See Investment earnings.">—</td>
                        : <td className={`r ${a.net_change < 0 ? 'neg' : ''}`}><b>{money(a.net_change, { cents: false, sign: true })}</b></td>}
                      <td className="r">{money(a.income, { cents: false })}</td>
                      <td className="r">{money(a.spend, { cents: false })}</td>
                      <td className="r muted">{money(moved, { cents: false, sign: true })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

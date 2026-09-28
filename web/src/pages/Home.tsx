import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Account, Totals, Txn } from '../api'
import { post, qs } from '../api'
import { Icon } from '../components/Icons'
import { CashflowChart } from '../components/Charts'
import { TxnDrawer } from '../components/Txns'
import { catColor, Num, Sparkline } from '../components/Viz'
import { ago, money, motionOK, niceDate, pct, periodLabel, periodRange } from '../format'
import { presetRange, useFetch, useRange, useSummary } from '../hooks'

interface Alert { id: string; level: 'bad' | 'warn' | 'info'; icon: string; title: string; detail: string; link: { to: string; params?: Record<string, string> } }

type NwPoint = { date: string; net_worth: number; estimated: boolean }

function NetWorthTip({ active, payload }: { active?: boolean; payload?: { payload: NwPoint }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return <div className="tt"><div className="tt-head">{niceDate(p.date)}</div>
    <div className="tt-row"><span>Net worth</span><b className="num">{money(p.net_worth, { cents: false })}</b></div>
    {p.estimated && <div className="tt-hint">estimated: investment gains before Sep 28 aren't known</div>}</div>
}

/** Initials in a colored circle, colored by category so similar spending looks alike. */
function Avatar({ name, category }: { name: string; category: string }) {
  const words = name.replace(/[^A-Za-z ]/g, ' ').split(' ').filter(Boolean)
  const init = ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase()
  return <span className="avatar" style={{ background: catColor(category) }} aria-hidden>{init}</span>
}

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
  const nw = useFetch<{ points: NwPoint[] }>('/api/networth_history').data
  const recent = useFetch<{ rows: Txn[] }>('/api/transactions?limit=8')
  const [open, setOpen] = useState<Txn | null>(null)
  const alerts = useFetch<Alert[]>('/api/alerts')
  const [allAlerts, setAllAlerts] = useState(false)
  const { reload } = useSummary()
  const range = useRange()
  const nav = useNavigate()
  if (!s) return <div className="empty">Loading…</div>
  const periods = cf?.periods || []
  const labels = periods.map((p) => periodLabel(p.period))
  const spark = (k: 'income' | 'spend' | 'saved' | 'invested', color: string) =>
    <Sparkline values={periods.map((p) => p[k] || 0)} labels={labels} color={color} />
  const nwPts = nw?.points || []
  const nwChange = nwPts.length > 1 ? nwPts[nwPts.length - 1].net_worth - nwPts[0].net_worth : null
  const drill = (period: string, flows?: string) => {
    const pr = periodRange(period)
    range.setAccounts([]); range.setCustom(pr.start, pr.end)
    nav(`/transactions${qs(flows ? { flows } : {})}`)
  }
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
      {alerts.data && alerts.data.length > 0 && (
        <div className="card alerts-card">
          <div className="group-head"><h2>Heads up</h2><span className="muted small">{alerts.data.length} thing{alerts.data.length > 1 ? 's' : ''} worth a look</span></div>
          {(allAlerts ? alerts.data : alerts.data.slice(0, 4)).map((a) => (
            <div key={a.id} className={`alert-row lv-${a.level}`}>
              <span className="alert-ico"><Icon name={a.icon} size={18} /></span>
              <button className="alert-main" onClick={() => {
                if (a.link.to === '/transactions') range.setPreset(a.link.params?.q ? '3m' : 'this_month')
                nav(`${a.link.to}${qs(a.link.params || {})}`)
              }}>
                <b>{a.title}</b><span className="muted small">{a.detail}</span>
              </button>
              <button className="alert-x" aria-label={`Dismiss: ${a.title}`} title="Dismiss"
                      onClick={async () => { await post(`/api/alerts/${encodeURIComponent(a.id)}/dismiss`, {}); alerts.reload() }}>✕</button>
            </div>
          ))}
          {alerts.data.length > 4 && <button className="link-btn" onClick={() => setAllAlerts(!allAlerts)}>{allAlerts ? 'Show fewer' : `Show all ${alerts.data.length}`}</button>}
        </div>
      )}

      <div className="tiles">
        <div className="tile hero" style={{ gridColumn: '1 / -1' }}>
          <div className="hero-grid">
          <div>
          <div className="label">Net worth</div>
          <div className={`value ${s.net_worth < 0 ? 'neg' : ''}`}><Num v={s.net_worth} /></div>
          {nwChange != null && <div className="hero-delta">{nwChange >= 0 ? '▲' : '▼'} {money(Math.abs(nwChange), { cents: false })} over the past year</div>}
          <div className="hero-foot">
            <div><b>{money(s.accounts.filter((a) => a.type === 'depository').reduce((t, a) => t + (a.balance || 0), 0), { cents: false })}</b>cash</div>
            <div><b>{money(s.accounts.filter((a) => a.type === 'investment').reduce((t, a) => t + (a.balance || 0), 0), { cents: false })}</b>invested</div>
            <div><b>{money(s.debts, { cents: false })}</b>owed</div>
          </div>
          </div>
          {nwPts.length > 2 && (
            <div className="hero-chart">
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={nwPts} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ffffff" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Tooltip content={<NetWorthTip />} cursor={{ stroke: 'rgba(255,255,255,.5)', strokeDasharray: '3 3' }} />
                  <Area dataKey="net_worth" type="monotone" stroke="#ffffff" strokeWidth={2.5} fill="url(#nw-fill)"
                        isAnimationActive={motionOK} animationDuration={900} activeDot={{ r: 5, fill: '#fff', stroke: 'var(--accent-deep)', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          </div>
        </div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-income)' }} />Income this month</div><div className="value"><Num v={m.income} /></div>{spark('income', 'var(--s-income)')}</div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-spend)' }} />Spent this month</div><div className="value"><Num v={m.spend} /></div>{spark('spend', 'var(--s-spend)')}</div>
        <div className="tile"><div className="label">Saved this month</div><div className={`value ${m.saved < 0 ? 'neg' : ''}`}><Num v={m.saved} /></div>{spark('saved', 'var(--accent)')}<div className="sub">{pct(m.savings_rate)} of income</div></div>
        <div className="tile"><div className="label"><i className="swatch" style={{ background: 'var(--s-invest)' }} />Invested this month</div><div className="value"><Num v={m.invested} /></div>{spark('invested', 'var(--s-invest)')}</div>
      </div>

      <div className="card">
        <div className="group-head"><h2>Last 6 months</h2><Link to="/dashboard" className="small">Full dashboard →</Link></div>
        {cf ? <CashflowChart periods={cf.periods} height={240} onPick={drill} /> : <div className="empty">Loading…</div>}
      </div>

      <div className="card section">
        <div className="group-head"><h2>Recent activity</h2><Link to="/transactions" className="small">See all</Link></div>
        {!recent.data ? <div className="empty">Loading…</div> : recent.data.rows.length === 0 ? <div className="empty">No transactions yet. Link an account on the Accounts page.</div> : (
          <div className="feed">
            {recent.data.rows.map((t) => {
              const out = t.amount > 0, muted = t.flow === 'transfer' || t.flow === 'ignore'
              return (
                <button key={t.txn_id} className="feed-row" onClick={() => setOpen(t)}>
                  <Avatar name={t.name} category={t.category} />
                  <span className="feed-main">
                    <span className="feed-name">{t.name}</span>
                    <span className="feed-sub">{niceDate(t.date)} · {t.category}{t.pending ? ' · pending' : ''}</span>
                  </span>
                  <span className={`feed-amt ${muted ? 'muted' : out ? 'out' : 'in'}`}>{out ? '−' : '+'}{money(Math.abs(t.amount))}</span>
                </button>
              )
            })}
          </div>
        )}
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
      {open && <TxnDrawer t={open} onClose={() => setOpen(null)} onSaved={() => { recent.reload(); reload() }} />}
    </>
  )
}

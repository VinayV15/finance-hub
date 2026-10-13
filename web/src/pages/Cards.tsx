import { useState } from 'react'
import { put } from '../api'
import { Num, Ring } from '../components/Viz'
import { money, niceDate, pct } from '../format'
import { useFetch, useToast } from '../hooks'

interface CardRow {
  account_id: string; name: string; mask: string | null; profile: string; product: string
  balance: number | null; limit: number | null; utilization: number | null; apr: number | null
  min_payment: number | null; next_due: string | null; last_statement: number | null
  annual_fee: number; foreign_fee: number; perk_value: number; net_cost: number
  spend_12m: number; earned_12m: number; miles_12m: number | null
  meant_for: string; use_for: string[]; avoid_for: string[]
  perks: { label: string; detail: string; value?: number; used: boolean }[]
  earn: { category: string; rate: number; unit: 'cash' | 'miles'; cap: number | null }[]
}
interface CatRow { category: string; label: string; spend: number; earned: number; best_value: number; missed: number; best_card: string | null; paid_with: { card: string; amount: number }[]; n: number }
interface CardsData {
  settings: { mile_value: number; perks_used: Record<string, boolean> }
  cards: CardRow[]; categories: CatRow[]
  caps: { card: string; category: string; cap: number; used: number; left: number; rate: number }[]
  totals: { earned_12m: number; best_12m: number; missed_12m: number; on_cards: number; off_cards: number; utilization: number | null }
  missed: { date: string; name: string; amount: number; category: string; paid_with: string; best_card: string; missed: number }[]
  costs: { total: number; by_kind: { kind: string; amount: number }[]; items: { date: string; name: string; amount: number; account: string; kind: string | null }[] }
}

const usd = (n: number | null | undefined) => money(n, { cents: false })
const rateLabel = (e: CardRow['earn'][number]) => e.unit === 'miles' ? `${e.rate}× miles` : `${round1(e.rate * 100)}%`
const round1 = (n: number) => Math.round(n * 10) / 10
const daysUntil = (d: string) => Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5)

export function Cards() {
  const { data, reload } = useFetch<CardsData>('/api/cards')
  const toast = useToast()
  const [mile, setMile] = useState<number | null>(null)
  if (!data) return <div className="empty">Loading…</div>
  const t = data.totals
  const mileValue = mile ?? data.settings.mile_value
  const saveSettings = async (v: Record<string, unknown>) => {
    try { await put('/api/cards/settings', v); reload() } catch (e) { toast((e as Error).message, true) }
  }
  const togglePerk = (c: CardRow, label: string, used: boolean) =>
    saveSettings({ perks_used: { ...data.settings.perks_used, [`${c.profile}|${label}`]: used } })

  return (
    <>
      <div className="page-head">
        <div><h1>Credit cards</h1><div className="muted small">Which card to use for what, what you've earned, and what you left on the table over the last 12 months.</div></div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">Rewards earned</div><div className="value"><Num v={t.earned_12m} /></div><div className="sub">last 12 months, at {mileValue}¢ a mile</div></div>
        <div className="tile"><div className="label">With the best card every time</div><div className="value"><Num v={t.best_12m} /></div><div className="sub">same spending, right card each purchase</div></div>
        <div className="tile"><div className="label">Left on the table</div><div className={`value ${t.missed_12m > 25 ? 'neg' : ''}`}><Num v={t.missed_12m} /></div>
          <div className="sub">{usd(t.off_cards)} of spending went on debit or bank transfer instead of a card</div></div>
        {t.utilization != null && <div className="tile tile-ring"><div><div className="label">Card utilization</div><div className="value">{pct(t.utilization)}</div><div className="sub">of your total limit (under 30% helps your score; under 10% is best)</div></div>
          <Ring value={t.utilization} size={64} color={t.utilization > 0.3 ? 'var(--bad)' : t.utilization > 0.1 ? 'var(--warn)' : 'var(--good)'} label={`${pct(t.utilization)} utilization`}><span className="ring-pct">{pct(t.utilization)}</span></Ring></div>}
      </div>

      <div className="card">
        <div className="group-head"><h2>Which card to use</h2><span className="muted small">from what you actually spend in each category</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>What you're buying</th><th className="r">Your yearly spend</th><th>Use</th><th className="r">Would earn</th><th className="r">You earned</th><th>You mostly paid with</th></tr></thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.category}>
                  <td><b>{c.label}</b><div className="muted small">{c.n} purchases</div></td>
                  <td className="r">{usd(c.spend)}</td>
                  <td><span className="card-chip">{c.best_card}</span></td>
                  <td className="r">{usd(c.best_value)}</td>
                  <td className={`r ${c.missed >= 5 ? 'neg' : ''}`}>{usd(c.earned)}</td>
                  <td className="small">{c.paid_with.slice(0, 2).map((p) => `${p.card} ${pct(p.amount / c.spend)}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mile-row">
          <label className="slider" style={{ flex: 1, marginBottom: 0 }}>
            <span className="slider-top"><span>What a Venture X mile is worth to you</span><b>{mileValue.toFixed(2)}¢</b></span>
            <input type="range" min={0.5} max={2.5} step={0.05} value={mileValue} onChange={(e) => setMile(+e.target.value)} onMouseUp={() => saveSettings({ mile_value: mileValue })} onTouchEnd={() => saveSettings({ mile_value: mileValue })}
                   style={{ '--fill': `${((mileValue - 0.5) / 2) * 100}%` } as React.CSSProperties} />
            <span className="muted small">1¢ when you use them to erase travel purchases; 1.5–2¢ if you move them to airline or hotel partners. At 1.5¢ or more, the Venture X's 2× beats the Amex's 3% everywhere.</span>
          </label>
        </div>
      </div>

      {data.caps.length > 0 && (
        <div className="card section">
          <h2>3% room left this year</h2>
          <div className="caps">
            {data.caps.map((c) => (
              <div key={c.card + c.category} className="cap">
                <div className="cap-top"><span>{c.category}</span><b>{usd(c.left)} left</b></div>
                <div className="fund-bar"><span className={c.left > 0 ? 'ok' : 'short'} style={{ width: `${Math.min(c.used / c.cap, 1) * 100}%` }} /></div>
                <div className="muted small">{usd(c.used)} of {usd(c.cap)} at {pct(c.rate)} on the {c.card}; after that it's 1%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="cc-grid section">
        {data.cards.map((c) => (
          <div key={c.account_id} className={`card cc cc-${c.profile}`}>
            <div className="cc-face">
              <div className="cc-name">{c.product}</div>
              <div className="cc-mask">•••• {c.mask || '····'}</div>
              <div className="cc-bal"><span>Balance</span><b>{usd(c.balance)}</b></div>
              {c.limit ? <div className="cc-util"><div className="cc-util-bar"><span style={{ width: `${Math.min((c.utilization || 0) * 100, 100)}%` }} /></div><span>{pct(c.utilization)} of {usd(c.limit)} limit</span></div> : null}
            </div>
            {c.next_due && (
              <div className={`cc-due ${daysUntil(c.next_due) <= 5 ? 'soon' : ''}`}>
                Statement {usd(c.last_statement)} due {niceDate(c.next_due)}{daysUntil(c.next_due) >= 0 ? ` (in ${daysUntil(c.next_due)} days)` : ''} · pay it in full to avoid {c.apr ? `${c.apr}% interest` : 'interest'}
              </div>
            )}
            <p className="cc-meant">{c.meant_for}</p>
            <div className="cc-earn">{c.earn.map((e) => <span key={e.category} className="card-chip">{e.category}: {rateLabel(e)}{e.cap ? ` (to ${usd(e.cap)}/yr)` : ''}</span>)}</div>
            <div className="grid two" style={{ gap: 12, marginTop: 10 }}>
              <div><h3>Use it for</h3><ul className="cc-list">{c.use_for.map((u) => <li key={u}>{u}</li>)}</ul></div>
              {c.avoid_for.length > 0 && <div><h3>Not for</h3><ul className="cc-list avoid">{c.avoid_for.map((u) => <li key={u}>{u}</li>)}</ul></div>}
            </div>
            {c.perks.length > 0 && (
              <>
                <h3 style={{ marginTop: 12 }}>Perks <span className="muted small">(tap to mark the ones you use)</span></h3>
                <div className="perks">
                  {c.perks.map((p) => (
                    <button key={p.label} className={`perk ${p.used ? 'on' : ''}`} onClick={() => togglePerk(c, p.label, !p.used)} aria-pressed={p.used} title={p.detail}>
                      <b>{p.label}{p.value ? ` · ${usd(p.value)}/yr` : ''}</b><span>{p.detail}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="cc-foot">
              <div><span>Earned, 12 mo</span><b>{usd(c.earned_12m)}</b>{c.miles_12m != null && <span className="muted small">{c.miles_12m.toLocaleString()} miles</span>}</div>
              <div><span>Annual fee</span><b>{usd(c.annual_fee)}</b></div>
              {c.annual_fee > 0 && <div><span>After perks you use</span><b className={c.net_cost > 0 ? 'neg' : 'pos'}>{c.net_cost > 0 ? `costs ${usd(c.net_cost)}` : `pays ${usd(-c.net_cost)}`}</b></div>}
              <div><span>Abroad</span><b>{c.foreign_fee ? `${c.foreign_fee}% fee` : 'no fee'}</b></div>
            </div>
          </div>
        ))}
        {data.cards.length === 0 && <div className="card empty">No credit cards linked yet.</div>}
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Biggest missed rewards</h2>
          {data.missed.length === 0 ? <div className="empty">Every purchase was on the best card. Nice.</div> : data.missed.map((m, i) => (
            <div key={i} className="row">
              <div className="row-main"><div className="row-title">{m.name}</div><div className="muted small">{niceDate(m.date)} · {usd(m.amount)} on {m.paid_with} → {m.best_card}</div></div>
              <div className="row-amt neg">−{money(m.missed)}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="group-head"><h2>Fees & interest paid</h2><b className={data.costs.total > 0 ? 'neg' : 'pos'}>{usd(data.costs.total)}</b></div>
          <p className="muted small" style={{ marginTop: -4 }}>Last 12 months, across cards, banks, and investment accounts.</p>
          {data.costs.by_kind.length === 0 ? <div className="empty">No fees or interest. Keep paying in full.</div> : (
            <>
              {data.costs.by_kind.map((k) => <div key={k.kind} className="row"><div className="row-main"><div className="row-title">{k.kind}</div></div><div className="row-amt">{money(k.amount)}</div></div>)}
              <details className="plan-more"><summary>Every charge</summary>
                {data.costs.items.map((c, i) => <div key={i} className="row"><div className="row-main"><div className="row-title">{c.name}</div><div className="muted small">{niceDate(c.date)} · {c.account}</div></div><div className="row-amt">{money(c.amount)}</div></div>)}
              </details>
            </>
          )}
        </div>
      </div>
    </>
  )
}

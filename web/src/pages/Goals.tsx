import { useEffect, useState } from 'react'
import { del, post, put, type Goal, type GoalType, type Windfalls, type Windfall } from '../api'
import { money, niceDate, pct } from '../format'
import { useFetch, useSummary, useToast } from '../hooks'
import { Num, Ring } from '../components/Viz'

const TYPES: { v: GoalType; label: string; help: string }[] = [
  { v: 'emergency', label: 'Emergency fund', help: 'Keep a number of months of spending in cash accounts.' },
  { v: 'roth', label: 'Roth IRA (yearly)', help: 'Contribute a set amount to your Roth IRA this year.' },
  { v: 'investing', label: 'Invest every month', help: 'Move a set amount into investment accounts each month.' },
  { v: 'mortgage', label: 'Mortgage', help: 'Reach the PMI-removal balance, or pay the loan off, by a date.' },
  { v: 'custom', label: 'Save for something', help: 'A trip, car, furniture — any target with a date.' },
]

function GoalCard({ g, onChanged }: { g: Goal; onChanged: () => void }) {
  const toast = useToast()
  const [add, setAdd] = useState('')
  const [confirm, setConfirm] = useState(false)
  const p = g.progress
  const status = p.on_track == null ? null : p.on_track
    ? { icon: '✓', label: 'On track', color: 'var(--good)' } : { icon: '⚠', label: 'Behind', color: 'var(--warn)' }
  const contribute = async () => {
    try { await post(`/api/goals/${g.id}/contribute`, { amount: add }); setAdd(''); onChanged(); toast('Added.') }
    catch (e) { toast((e as Error).message, true) }
  }
  const remove = async () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return }
    await del(`/api/goals/${g.id}`); onChanged()
  }
  return (
    <div className="card">
      <div className="group-head">
        <h2 style={{ margin: 0 }}>{g.name}</h2>
        {status && <span style={{ color: status.color, fontWeight: 600, fontSize: 13 }}>{status.icon} {status.label}</span>}
      </div>
      <div className="small muted">{TYPES.find((t) => t.v === g.type)?.label}{g.target_date ? ` · by ${niceDate(g.target_date)}` : ''}</div>
      <div className="goal-body">
        {p.target != null && (
          <Ring value={p.pct || 0} size={92} stroke={9}
                color={p.on_track === false ? 'var(--warn)' : (p.pct || 0) >= 1 ? 'var(--good)' : 'var(--accent)'}
                label={`${pct(p.pct)} of ${g.name}`}>
            <span className="ring-pct big">{pct(p.pct)}</span>
          </Ring>
        )}
        <div>
          <div className="goal-amt"><Num v={p.current} /></div>
          {p.target != null && <div className="muted">of {money(p.target, { cents: false })}</div>}
        </div>
      </div>
      <p className="small" style={{ margin: '8px 0 0', color: 'var(--text-2)' }}>
        {p.detail}
        {p.monthly_needed != null && p.monthly_needed > 0 && g.type !== 'mortgage' && <> · <b>{money(p.monthly_needed, { cents: false })}/mo</b> {g.type === 'investing' ? 'still to go this month' : 'needed to finish on time'}</>}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {g.type === 'custom' && (
          <>
            <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="$ amount" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Amount to add" />
            <button className="btn small" disabled={!add} onClick={contribute}>Add money set aside</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button className="link-btn" onClick={remove}>{confirm ? 'Tap again to remove' : 'Remove'}</button>
      </div>
    </div>
  )
}

function NewGoal({ onSaved }: { onSaved: () => void }) {
  const toast = useToast()
  const { summary } = useSummary()
  const [type, setType] = useState<GoalType>('emergency')
  const [f, setF] = useState({ name: '', target: '', target_date: '', months: '6', kind: 'pmi', starting: '' })
  const cash = (summary?.accounts || []).filter((a) => a.type === 'depository')
  const [accts, setAccts] = useState<string[]>([])
  useEffect(() => { setAccts(cash.filter((a) => ['Wealthfront', 'Wells Fargo'].includes(a.institution || '')).map((a) => a.account_id)) }, [summary]) // eslint-disable-line react-hooks/exhaustive-deps
  const defaults: Record<GoalType, string> = { emergency: 'Emergency fund', roth: `Roth IRA ${new Date().getFullYear()}`, investing: 'Invest monthly', mortgage: 'Drop PMI', custom: '' }
  const save = async () => {
    const config = type === 'emergency' ? { months: +f.months || 6, accounts: accts }
      : type === 'mortgage' ? { kind: f.kind } : type === 'custom' ? { starting: +f.starting || 0 } : {}
    try {
      await post('/api/goals', {
        type, name: f.name || defaults[type], target: type === 'emergency' || type === 'mortgage' ? '' : f.target,
        target_date: f.target_date || (type === 'roth' ? `${new Date().getFullYear()}-12-31` : ''), config,
      })
      setF({ name: '', target: '', target_date: '', months: '6', kind: 'pmi', starting: '' }); onSaved(); toast('Goal added.')
    } catch (e) { toast((e as Error).message, true) }
  }
  return (
    <div className="card">
      <h2>Add a goal</h2>
      <div className="seg" style={{ marginBottom: 10 }}>
        {TYPES.map((t) => <button key={t.v} className={type === t.v ? 'on' : ''} onClick={() => setType(t.v)}>{t.label}</button>)}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>{TYPES.find((t) => t.v === type)?.help}</p>
      <div className="form-grid">
        <label className="field">Name<input className="input" value={f.name} placeholder={defaults[type] || 'e.g. Japan trip'} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        {type === 'emergency' && <label className="field">Months of spending<input className="input" inputMode="numeric" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></label>}
        {(type === 'roth' || type === 'custom') && <label className="field">{type === 'roth' ? 'Contribute this year' : 'Target amount'}<input className="input" inputMode="decimal" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>}
        {type === 'investing' && <label className="field">Per month<input className="input" inputMode="decimal" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>}
        {type === 'mortgage' && <label className="field">Goal<select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="pmi">Get PMI removed</option><option value="payoff">Pay off the loan</option></select></label>}
        {type !== 'investing' && type !== 'roth' && <label className="field">By (optional)<input className="input" type="date" value={f.target_date} onChange={(e) => setF({ ...f, target_date: e.target.value })} /></label>}
        {type === 'custom' && <label className="field">Already saved<input className="input" inputMode="decimal" value={f.starting} onChange={(e) => setF({ ...f, starting: e.target.value })} placeholder="0" /></label>}
      </div>
      {type === 'emergency' && (
        <div style={{ marginTop: 10 }}>
          <div className="small muted">Count these accounts:</div>
          {cash.map((a) => (
            <label key={a.account_id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, padding: '3px 0' }}>
              <input type="checkbox" checked={accts.includes(a.account_id)} onChange={() => setAccts(accts.includes(a.account_id) ? accts.filter((x) => x !== a.account_id) : [...accts, a.account_id])} />
              {a.institution} · {a.name} ({money(a.balance, { cents: false })})
            </label>
          ))}
        </div>
      )}
      <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>Add goal</button>
    </div>
  )
}

function WindfallCard({ w, targets, onChanged }: { w: Windfall; targets: { id: string; label: string }[]; onChanged: () => void }) {
  const toast = useToast()
  const start = w.plan || w.suggested.map((s) => ({ target: s.target, amount: s.amount }))
  const [plan, setPlan] = useState(start.map((p) => ({ ...p, amount: String(p.amount) })))
  const [confirm, setConfirm] = useState(false)
  const total = plan.reduce((s, p) => s + (+p.amount || 0), 0)
  const labelOf = (t: string) => targets.find((x) => x.id === t)?.label || t
  const save = async () => {
    try { await post(`/api/windfalls/${encodeURIComponent(w.id)}/plan`, { plan: plan.map((p) => ({ target: p.target, amount: +p.amount || 0 })) }); onChanged(); toast('Plan saved.') }
    catch (e) { toast((e as Error).message, true) }
  }
  const dismiss = async () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return }
    await del(`/api/windfalls/${encodeURIComponent(w.id)}`); onChanged()
  }
  return (
    <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div className="row-main" style={{ minWidth: 200 }}>
        <div className="row-title">{w.label} · {money(w.amount, { cents: false })}</div>
        <div className="small muted">{niceDate(w.date)} · {w.status === 'planned' ? '✓ planned' : 'not planned yet'}</div>
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          {plan.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="input" style={{ maxWidth: 220 }} value={p.target} onChange={(e) => setPlan(plan.map((x, j) => j === i ? { ...x, target: e.target.value } : x))}>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <input className="input" style={{ width: 110 }} inputMode="decimal" value={p.amount} onChange={(e) => setPlan(plan.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} aria-label={`Amount for ${labelOf(p.target)}`} />
              <button className="link-btn" onClick={() => setPlan(plan.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="link-btn" onClick={() => setPlan([...plan, { target: 'fun', amount: '0' }])}>+ Add line</button>
          <span className={`small ${Math.abs(total - w.amount) > 0.5 ? 'neg' : 'muted'}`}>{money(total, { cents: false })} of {money(w.amount, { cents: false })} split</span>
          <button className="btn small primary" onClick={save}>Save plan</button>
          <button className="link-btn" onClick={dismiss}>{confirm ? 'Tap again' : 'Not a windfall'}</button>
        </div>
      </div>
    </div>
  )
}

function SplitEditor({ split, targets, onSaved }: { split: { target: string; pct: number }[]; targets: { id: string; label: string }[]; onSaved: () => void }) {
  const toast = useToast()
  const [rows, setRows] = useState(split.map((s) => ({ target: s.target, pct: String(s.pct) })))
  useEffect(() => setRows(split.map((s) => ({ target: s.target, pct: String(s.pct) }))), [split])
  const total = rows.reduce((s, r) => s + (+r.pct || 0), 0)
  const save = async () => {
    try { await put('/api/windfalls/split', { split: rows }); onSaved(); toast('Default split saved.') } catch (e) { toast((e as Error).message, true) }
  }
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <select className="input" style={{ maxWidth: 240 }} value={r.target} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, target: e.target.value } : x))}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <input className="input" style={{ width: 80 }} inputMode="decimal" value={r.pct} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} aria-label="Percent" />
          <span className="muted">%</span>
          <button className="link-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="link-btn" onClick={() => setRows([...rows, { target: 'fun', pct: '0' }])}>+ Add</button>
        <span className={`small ${Math.abs(total - 100) > 0.5 ? 'neg' : 'muted'}`}>{total}% of 100%</span>
        <button className="btn small" onClick={save} disabled={Math.abs(total - 100) > 0.5}>Save default split</button>
      </div>
    </div>
  )
}

export function Goals() {
  const goals = useFetch<Goal[]>('/api/goals')
  const wf = useFetch<Windfalls>('/api/windfalls')
  const reload = () => { goals.reload(); wf.reload() }
  const targets = [...(goals.data || []).map((g) => ({ id: g.id, label: g.name })), { id: 'fun', label: 'Spend / fun' }, { id: 'invest', label: 'Invest (general)' }]
  return (
    <>
      <div className="page-head"><div><h1>Goals</h1><div className="muted small">Tracked from your real balances and transfers wherever possible.</div></div></div>
      {!goals.data ? <div className="empty">Loading…</div> : (
        <div className="grid two">
          {goals.data.map((g) => <GoalCard key={g.id} g={g} onChanged={reload} />)}
          <NewGoal onSaved={reload} />
        </div>
      )}

      <div className="card section">
        <h2>Windfalls</h2>
        <p className="muted small" style={{ marginTop: -4 }}>One-off money: bonuses, tax refunds, big one-time deposits. They're kept out of "normal month" numbers. Each one gets a suggested split from your default below. Money you split to a "Save for something" goal is added to that goal.</p>
        {!wf.data ? <div className="empty">Loading…</div> : wf.data.items.length === 0 ? <div className="empty">No windfalls found.</div>
          : wf.data.items.map((w) => <WindfallCard key={w.id + (w.plan ? 'p' : '')} w={w} targets={targets} onChanged={reload} />)}
        <h3 style={{ marginTop: 18 }}>Default split for new windfalls</h3>
        {wf.data && <SplitEditor split={wf.data.split} targets={targets} onSaved={reload} />}
      </div>
    </>
  )
}

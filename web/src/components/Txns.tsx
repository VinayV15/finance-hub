import { useEffect, useState } from 'react'
import { patch, post, type Flow, type Txn } from '../api'
import { FLOW_LABEL, money, niceDate } from '../format'
import { useFetch, useToast } from '../hooks'

const FLOWS: { key: Flow; help: string }[] = [
  { key: 'spend', help: 'Money gone for good — counts as spending' },
  { key: 'income', help: 'New money from outside — counts as income' },
  { key: 'refund', help: 'Money back — lowers spending in its category' },
  { key: 'transfer', help: 'Between my own accounts — not counted' },
  { key: 'growth', help: 'Earned inside an investment account' },
  { key: 'ignore', help: 'Not real money — left out of every total and chart (e.g. bank verification deposits)' },
]

/** "ZELLE TO DOE MOM ON 07/11 REF #RP0Z…" -> "zelle to doe mom" — a sensible default rule pattern. */
const guessPattern = (name: string) =>
  name.toLowerCase().replace(/\b(on|ref|authorized)\b.*$/, '').replace(/[#*].*$/, '').replace(/\d{3,}.*$/, '').trim()

export function TxnRow({ t, onClick }: { t: Txn; onClick: () => void }) {
  const out = t.amount > 0
  return (
    <div className="row clickable" onClick={onClick}>
      <div className="row-main">
        <div className="row-title">
          {t.name}{t.pending ? <span className="badge" style={{ marginLeft: 6 }}>pending</span> : null}
        </div>
        <div className="muted small" style={{ display: 'flex', gap: '2px 8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{niceDate(t.date)}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{t.institution} {t.account_name}</span>
          <span className={`badge ${t.flow}`}>{FLOW_LABEL[t.flow]}</span>
          <span>{t.category}</span>
          {t.review ? <span className="badge warn">⚠ check</span> : null}
          {t.extra_principal > 0 && <span style={{ color: 'var(--s-invest)' }}>{money(t.amount - t.extra_principal)} regular + {money(t.extra_principal)} extra principal (saving)</span>}
        </div>
      </div>
      <div className={`row-amt ${t.flow === 'transfer' || t.flow === 'ignore' ? 'muted' : out ? '' : 'pos'}`} style={t.flow === 'ignore' ? { textDecoration: 'line-through' } : undefined}>{out ? '−' : '+'}{money(Math.abs(t.amount))}</div>
    </div>
  )
}

export function TxnDrawer({ t, onClose, onSaved }: { t: Txn; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const cats = useFetch<string[]>('/api/categories/all').data || []
  const [flow, setFlow] = useState<Flow>(t.flow)
  const [category, setCategory] = useState(t.category)
  const [note, setNote] = useState(t.note || '')
  const [makeRule, setMakeRule] = useState(false)
  const [pattern, setPattern] = useState(guessPattern(t.name))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const save = async () => {
    setBusy(true)
    try {
      if (makeRule) {
        await post('/api/rules', { pattern, direction: t.amount > 0 ? 'out' : 'in', set_flow: flow, set_category: category })
        if (note) await patch(`/api/transactions/${encodeURIComponent(t.txn_id)}`, { flow, category, note })
        toast(`Rule saved — every "${pattern}" transaction now counts as ${FLOW_LABEL[flow].toLowerCase()}.`)
      } else {
        await patch(`/api/transactions/${encodeURIComponent(t.txn_id)}`, { flow, category, note })
        toast('Saved.')
      }
      onSaved(); onClose()
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  const reset = async () => {
    await patch(`/api/transactions/${encodeURIComponent(t.txn_id)}`, { clear: true })
    toast('Back to automatic.'); onSaved(); onClose()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit transaction">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>{t.name}</h2>
            <div className="muted small">{niceDate(t.date)} · {t.institution} {t.account_name}</div>
          </div>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="tile"><div className="value">{t.amount > 0 ? '−' : '+'}{money(Math.abs(t.amount))}</div>
          <div className="sub">Why: {t.reason}</div></div>

        <div className="field">What is this?
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {FLOWS.map((f) => (
              <label key={f.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 10, background: flow === f.key ? 'var(--surface-2)' : undefined, cursor: 'pointer' }}>
                <input type="radio" name="flow" checked={flow === f.key} onChange={() => setFlow(f.key)} style={{ marginTop: 3 }} />
                <span><b style={{ color: 'var(--text)' }}>{FLOW_LABEL[f.key]}</b><br /><span className="small">{f.help}</span></span>
              </label>
            ))}
          </div>
        </div>
        <label className="field">Category
          <input className="input" list="cat-list" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="cat-list">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label className="field">Note (optional)
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. split dinner, paid back by Sam" />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
          Do this for every transaction like it (past and future)
        </label>
        {makeRule && (
          <label className="field">Match transactions whose name contains
            <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} />
            <span className="small muted">Only {t.amount > 0 ? 'money going out' : 'money coming in'} will match.</span>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || (makeRule && !pattern.trim())} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          {t.kind === 'manual' && <button className="btn" onClick={reset}>Undo my change</button>}
        </div>
      </div>
    </div>
  )
}

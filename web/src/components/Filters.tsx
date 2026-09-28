import { useEffect, useRef, useState } from 'react'
import { PRESETS, useRange, useSummary } from '../hooks'

/** One row of filters above every dashboard: time range + which accounts. */
export function Filters({ showAccounts = true }: { showAccounts?: boolean }) {
  const r = useRange()
  return (
    <div className="filters">
      <div className="seg" role="group" aria-label="Time range">
        {PRESETS.map((p) => (
          <button key={p.key} className={r.preset === p.key ? 'on' : ''} onClick={() => r.setPreset(p.key)}>{p.label}</button>
        ))}
      </div>
      {r.preset === 'custom' && (
        <>
          <input className="input" style={{ width: 150 }} type="date" value={r.start || ''} aria-label="Start date"
                 onChange={(e) => r.setCustom(e.target.value || undefined, r.end)} />
          <span className="muted">to</span>
          <input className="input" style={{ width: 150 }} type="date" value={r.end || ''} aria-label="End date"
                 onChange={(e) => r.setCustom(r.start, e.target.value || undefined)} />
        </>
      )}
      {showAccounts && <AccountPicker />}
    </div>
  )
}

function AccountPicker() {
  const { summary } = useSummary()
  const r = useRange()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const accts = (summary?.accounts || []).filter((a) => a.source !== 'manual')
  const label = r.accounts.length === 0 ? 'All accounts' : r.accounts.length === 1
    ? accts.find((a) => a.account_id === r.accounts[0])?.name || '1 account' : `${r.accounts.length} accounts`
  const toggle = (id: string) =>
    r.setAccounts(r.accounts.includes(id) ? r.accounts.filter((x) => x !== id) : [...r.accounts, id])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{label} ▾</button>
      {open && (
        <div className="popover">
          <button className="link-btn" onClick={() => r.setAccounts([])}>All accounts</button>
          {accts.map((a) => (
            <label key={a.account_id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 2px', fontSize: 14 }}>
              <input type="checkbox" checked={r.accounts.includes(a.account_id)} onChange={() => toggle(a.account_id)} />
              <span>{a.institution} · {a.name}{a.mask ? ` ••${a.mask}` : ''}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

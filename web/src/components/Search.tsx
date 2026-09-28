import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, qs, type Txn } from '../api'
import { money, niceDate } from '../format'
import { useRange } from '../hooks'
import { Icon } from './Icons'

type Item = { key: string; group: string; label: string; sub?: string; icon?: string; go: () => void }

/** Quick search over pages, categories, and transactions (names or amounts). Opens with Cmd/Ctrl+K or "/". */
export function QuickSearch({ pages, open, setOpen }: {
  pages: { to: string; label: string; icon: string }[]; open: boolean; setOpen: (v: boolean) => void
}) {
  const nav = useNavigate()
  const range = useRange()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [cats, setCats] = useState<string[]>([])
  const [txns, setTxns] = useState<Txn[]>([])
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName)
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  useEffect(() => {
    if (!open) return
    setQ(''); setSel(0); setTxns([])
    setTimeout(() => input.current?.focus(), 0)
    if (!cats.length) api<string[]>('/api/categories/all').then(setCats).catch(() => {})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || q.trim().length < 2) { setTxns([]); return }
    const h = setTimeout(() => {
      api<{ rows: Txn[] }>(`/api/transactions${qs({ q: q.trim(), limit: 6 })}`).then((d) => setTxns(d.rows)).catch(() => {})
    }, 180)
    return () => clearTimeout(h)
  }, [q, open])

  const close = () => setOpen(false)
  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase()
    const pageItems = pages.filter((p) => !s || p.label.toLowerCase().includes(s))
      .map((p) => ({ key: `p${p.to}`, group: 'Pages', label: p.label, icon: p.icon, go: () => nav(p.to) }))
    const catItems = s ? cats.filter((c) => c.toLowerCase().includes(s)).slice(0, 5).map((c) => ({
      key: `c${c}`, group: 'Categories', label: c, sub: 'all transactions in this category', icon: 'budget',
      go: () => nav(`/transactions${qs({ category: c })}`) })) : []
    const txnItems = txns.map((t) => ({
      key: `t${t.txn_id}`, group: 'Transactions', label: t.name, icon: 'transactions',
      sub: `${niceDate(t.date)} · ${t.category} · ${t.amount > 0 ? '−' : '+'}${money(Math.abs(t.amount))}`,
      go: () => { range.setPreset('all'); nav(`/transactions${qs({ q: q.trim() })}`) } }))
    return [...(s ? [] : pageItems), ...catItems, ...txnItems, ...(s ? pageItems : [])]
  }, [q, cats, txns, pages, nav, range])

  if (!open) return null
  const pick = (i: Item) => { close(); i.go() }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((v) => Math.min(v + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((v) => Math.max(v - 1, 0)) }
    else if (e.key === 'Enter' && items[sel]) pick(items[sel])
  }
  let lastGroup = ''
  return (
    <div className="overlay search-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search-box" role="dialog" aria-label="Search">
        <div className="search-input">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} onKeyDown={onKey}
                 placeholder="Search merchants, categories, amounts, pages…" aria-label="Search" />
          <kbd>esc</kbd>
        </div>
        <div className="search-results" role="listbox">
          {items.length === 0 && <div className="empty">No matches. Try a merchant name, a category, or an amount like 42.10.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null
            return (
              <div key={it.key}>
                {head && <div className="search-group">{head}</div>}
                <button role="option" aria-selected={i === sel} className={`search-item${i === sel ? ' on' : ''}`}
                        onMouseEnter={() => setSel(i)} onClick={() => pick(it)}>
                  <span className="nav-ico"><Icon name={it.icon || 'more'} /></span>
                  <span className="search-text"><span>{it.label}</span>{it.sub && <span className="muted small">{it.sub}</span>}</span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

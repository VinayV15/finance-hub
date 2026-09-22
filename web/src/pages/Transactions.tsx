import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { qs, type Txn } from '../api'
import { Filters } from '../components/Filters'
import { TxnDrawer, TxnRow } from '../components/Txns'
import { FLOW_LABEL } from '../format'
import { useFetch, useRange, useSummary } from '../hooks'

const PAGE = 100

export function Transactions({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const r = useRange()
  const [params, setParams] = useSearchParams()
  const { reload: reloadSummary } = useSummary()
  const [q, setQ] = useState(params.get('q') || '')
  const [debounced, setDebounced] = useState(q)
  const flow = params.get('flow') || ''
  const category = params.get('category') || ''
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<Txn | null>(null)
  useEffect(() => { const h = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(h) }, [q])

  const path = `/api/transactions${qs(reviewOnly
    ? { review: 1, limit }
    : { start: r.start, end: r.end, accounts: r.accounts, flow, category, q: debounced, limit })}`
  const { data, reload } = useFetch<{ total: number; rows: Txn[] }>(path)
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p) }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{reviewOnly ? 'Review' : 'Transactions'}</h1>
          {reviewOnly && <div className="muted small">The app wasn't sure about these. Tap one and say what it is — it only takes one tap each, and you can make a rule so it never asks again.</div>}
        </div>
      </div>
      {!reviewOnly && (
        <>
          <Filters />
          <div className="filters">
            <input className="input" style={{ maxWidth: 280 }} placeholder="Search name or category…" value={q}
                   onChange={(e) => { setQ(e.target.value); setParam('q', e.target.value) }} />
            <select className="input" style={{ width: 160 }} value={flow} onChange={(e) => setParam('flow', e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {Object.entries(FLOW_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {category && <span className="badge">{category} <button className="link-btn" onClick={() => setParam('category', '')} aria-label="Clear category">✕</button></span>}
            {data && <span className="muted small">{data.total.toLocaleString()} transactions</span>}
          </div>
        </>
      )}
      <div className="card">
        {!data ? <div className="empty">Loading…</div> : data.rows.length === 0 ? (
          <div className="empty">{reviewOnly ? '✓ Nothing to review. Your totals are clean.' : 'No transactions match.'}</div>
        ) : data.rows.map((t) => <TxnRow key={t.txn_id} t={t} onClick={() => setOpen(t)} />)}
        {data && data.total > data.rows.length && (
          <div style={{ textAlign: 'center', paddingTop: 10 }}>
            <button className="btn small" onClick={() => setLimit(limit + PAGE)}>Show more ({data.total - data.rows.length} left)</button>
          </div>
        )}
      </div>
      {open && <TxnDrawer t={open} onClose={() => setOpen(null)} onSaved={() => { reload(); reloadSummary() }} />}
    </>
  )
}

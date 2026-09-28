import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { qs, type Txn, type TxnTotals } from '../api'
import { Filters } from '../components/Filters'
import { CategoryBreakdown, CategoryOverTime, DailyPattern, TopMerchants, type TxnChartData } from '../components/TxnCharts'
import { TxnDrawer, TxnRow } from '../components/Txns'
import { FLOW_LABEL, money, periodRange } from '../format'
import { useFetch, useRange, useSummary } from '../hooks'

const PAGE = 100

export function Transactions({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const r = useRange()
  const [params, setParams] = useSearchParams()
  const { reload: reloadSummary } = useSummary()
  const [q, setQ] = useState(params.get('q') || '')
  const [debounced, setDebounced] = useState(q)
  const flow = params.get('flows') || params.get('flow') || ''
  const category = params.get('category') || ''
  const name = params.get('name') || ''
  const invested = params.get('invested') || ''
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<Txn | null>(null)
  useEffect(() => { const h = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(h) }, [q])

  const path = `/api/transactions${qs(reviewOnly
    ? { review: 1, limit }
    : { start: r.start, end: r.end, accounts: r.accounts, flows: flow, category, name, invested, q: debounced, limit })}`
  const { data, reload } = useFetch<{ total: number; totals: TxnTotals; rows: Txn[] }>(path)
  // Charts cover spending (or income, when that's the type picked); other types have nothing to chart.
  const chartable = !reviewOnly && !invested && ['', 'spend', 'refund', 'spend,refund', 'income'].includes(flow)
  const filters = { start: r.start, end: r.end, accounts: r.accounts, flows: flow, category, name, q: debounced }
  const charts = useFetch<TxnChartData>(chartable ? `/api/transactions/charts${qs(filters)}` : null).data
  const [showCharts, setShowCharts] = useState(() => { try { return localStorage.getItem('txnCharts') !== '0' } catch { return true } })
  const toggleCharts = () => { const v = !showCharts; setShowCharts(v); try { localStorage.setItem('txnCharts', v ? '1' : '0') } catch { /* private mode */ } }
  const chartMonths = new Set(charts?.by_month.map((m) => m.month)).size
  const what = charts?.measure === 'income' ? 'Income' : 'Spending'
  const t = data?.totals
  const isSpend = flow === 'spend,refund' || flow === 'spend'
  const flowLabel = flow === 'spend,refund' ? 'Spending (incl. money back)' : FLOW_LABEL[flow] || flow
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
            <select className="input" style={{ width: 200 }} value={flow} onChange={(e) => { const p = new URLSearchParams(params); p.delete('flow'); if (e.target.value) p.set('flows', e.target.value); else p.delete('flows'); setParams(p) }} aria-label="Type">
              <option value="">All types</option>
              <option value="spend,refund">Spending (incl. money back)</option>
              {Object.entries(FLOW_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {category && <span className="badge">{category} <button className="link-btn" onClick={() => setParam('category', '')} aria-label="Clear category">✕</button></span>}
            {name && <span className="badge">{name} <button className="link-btn" onClick={() => setParam('name', '')} aria-label="Clear merchant">✕</button></span>}
            {invested && <span className="badge">Invested <button className="link-btn" onClick={() => setParam('invested', '')} aria-label="Clear invested">✕</button></span>}
          </div>
          {t && (
            <div className="note" style={{ marginBottom: 12, display: 'flex', gap: '4px 14px', flexWrap: 'wrap' }}>
              <span><b>{t.n.toLocaleString()}</b> transactions{flow ? ` · ${flowLabel}` : ''}</span>
              {invested ? <span>Invested: <b>{money(t.invested)}</b></span> : <>
                <span>Money out <b>{money(t.money_out)}</b></span>
                <span>Money in <b>{money(t.money_in)}</b></span>
                {isSpend && <span>Counted as spending: <b>{money(t.net_spend)}</b></span>}
                {t.extra_principal > 0 && <span>{money(t.extra_principal)} of it is extra mortgage principal, counted as saving</span>}
              </>}
            </div>
          )}
          {chartable && (
            <div className="section" style={{ marginBottom: 14 }}>
              <button className="link-btn" onClick={toggleCharts}>{showCharts ? 'Hide charts' : 'Show charts'}</button>
              {showCharts && charts && (
                <>
                  <div className="card" style={{ marginTop: 8 }}>
                    <h2>{what} by category, per month</h2>
                    <CategoryOverTime data={charts} onPick={(m, c) => { const pr = periodRange(m); r.setCustom(pr.start, pr.end); setParam('category', c || '') }} />
                  </div>
                  <div className="grid two section" style={{ marginTop: 14 }}>
                    <div className="card">
                      <h2>{what} by category</h2>
                      <p className="muted small" style={{ marginTop: -4 }}>Tap a category to narrow every chart and the list to it.</p>
                      <CategoryBreakdown data={charts} months={chartMonths} onPick={(c) => setParam('category', c)} />
                    </div>
                    <div className="card">
                      <h2>Top merchants</h2>
                      <p className="muted small" style={{ marginTop: -4 }}>Tap one to see just its transactions.</p>
                      <TopMerchants data={charts} onPick={(n) => setParam('name', n)} />
                    </div>
                  </div>
                  <div className="card" style={{ marginTop: 14 }}>
                    <h2>When you {charts.measure === 'income' ? 'get paid' : 'spend'}</h2>
                    <DailyPattern data={charts} start={r.start} end={r.end} onPickDay={(d) => r.setCustom(d, d)} />
                  </div>
                </>
              )}
            </div>
          )}
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

import { useState } from 'react'
import { api, del, post, type Rule } from '../api'
import { FLOW_LABEL, ago, money } from '../format'
import { useFetch, useSummary, useToast } from '../hooks'

declare global {
  interface Window {
    Plaid?: { create: (o: {
      token: string
      onSuccess: (publicToken: string, meta: { institution?: { name?: string } }) => void
      onExit: (err: { display_message?: string; error_message?: string } | null) => void
    }) => { open: () => void } }
  }
}

function loadPlaid(): Promise<void> {
  if (window.Plaid) return Promise.resolve()
  return new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    s.onload = () => res(); s.onerror = () => rej(new Error("Couldn't load Plaid. Check your internet connection."))
    document.head.appendChild(s)
  })
}

export function Accounts() {
  const toast = useToast()
  const { summary: s, reload } = useSummary()
  const rules = useFetch<Rule[]>('/api/rules')
  const [syncing, setSyncing] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', institution: '', type: 'loan', balance: '' })
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const link = async (kind?: string, itemId?: string) => {
    try {
      await loadPlaid()
      const { link_token } = await post<{ link_token: string }>('/api/link_token', { kind, item_id: itemId })
      window.Plaid!.create({
        token: link_token,
        onSuccess: async (public_token, meta) => {
          toast('Connected — pulling your data…')
          try {
            await post('/api/exchange', { public_token, item_id: itemId, institution: meta.institution?.name })
            reload(); toast(itemId ? 'Fixed.' : `${meta.institution?.name || 'Account'} linked.`)
          } catch (e) { toast((e as Error).message, true) }
        },
        onExit: (err) => { if (err) toast(err.display_message || err.error_message || 'Linking cancelled.', true) },
      }).open()
    } catch (e) { toast((e as Error).message, true) }
  }

  const syncNow = async () => {
    setSyncing(true)
    try {
      const { results } = await post<{ results: Record<string, string> }>('/api/sync', {})
      const bad = Object.values(results).filter((v) => v !== 'ok').length
      reload(); toast(bad ? `${bad} account(s) need attention.` : 'Up to date.', !!bad)
    } catch (e) { toast((e as Error).message, true) } finally { setSyncing(false) }
  }

  const importVenmo = async (file: File | undefined) => {
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    try {
      const r = await api<{ imported: number }>('/api/venmo', { method: 'POST', body: fd })
      toast(`Imported ${r.imported} Venmo transactions.`); reload()
    } catch (e) { toast((e as Error).message, true) }
  }

  const saveManual = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await post('/api/manual', { ...form, account_id: editing })
      setForm({ name: '', institution: '', type: 'loan', balance: '' }); setEditing(null)
      toast('Saved.'); reload()
    } catch (err) { toast((err as Error).message, true) }
  }

  const removeManual = async (id: string) => {
    if (confirmDel !== id) { setConfirmDel(id); setTimeout(() => setConfirmDel(null), 3000); return }
    await del(`/api/manual/${encodeURIComponent(id)}`); setConfirmDel(null); reload()
  }

  if (!s) return <div className="empty">Loading…</div>
  const manual = s.accounts.filter((a) => a.source !== 'plaid')
  const byAcct = Object.fromEntries(s.accounts.map((a) => [a.account_id, a]))

  return (
    <>
      <div className="page-head">
        <div><h1>Accounts</h1><div className="muted small">Refreshed {ago(s.last_sync)}</div></div>
        <button className="btn" onClick={syncNow} disabled={syncing}>{syncing ? 'Refreshing…' : 'Refresh now'}</button>
      </div>

      <div className="card">
        <h2>Linked logins</h2>
        {s.items.map((i) => (
          <div className="row" key={i.item_id}>
            <div className="row-main">
              <div className="row-title">{i.institution}</div>
              <div className="muted small">{i.status === 'ok' ? `✓ Working · synced ${ago(i.last_synced)}` : `⚠ ${i.status}: ${i.error || ''}`}</div>
            </div>
            {i.status !== 'ok' && <button className="btn small" onClick={() => link(undefined, i.item_id)}>Sign in again</button>}
          </div>
        ))}
        <div className="note" style={{ marginTop: 12 }}>
          Add a new login from your Mac's browser. {s.env === 'production' && <b>Each new login uses 1 of your 10 free Plaid links, forever ({s.items.length} used).</b>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button className="btn primary" onClick={() => link('bank')}>+ Bank or credit card</button>
          <button className="btn primary" onClick={() => link('investment')}>+ Investing or 401k</button>
          <button className="btn primary" onClick={() => link('loan')}>+ Mortgage or loan</button>
        </div>
      </div>

      <div className="grid two section">
        <div className="card">
          <h2>Import Venmo</h2>
          <p className="muted small" style={{ marginTop: -4 }}>Venmo app → Me → Settings → Statements → pick a month → Download CSV. Re-importing a month is safe.</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { importVenmo(e.target.files?.[0]); e.target.value = '' }} />
        </div>

        <div className="card">
          <h2>{editing ? 'Update balance' : 'Add a manual balance'}</h2>
          <form className="form-grid" onSubmit={saveManual}>
            <label className="field">Name<input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Home mortgage" /></label>
            <label className="field">Company<input className="input" value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} placeholder="Servicer" /></label>
            <label className="field">Type
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="loan">Loan / mortgage (owed)</option><option value="credit">Credit card (owed)</option>
                <option value="depository">Cash account</option><option value="investment">Investment</option><option value="other">Other asset (home, car…)</option>
              </select>
            </label>
            <label className="field">Balance<input className="input" required inputMode="decimal" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} /></label>
            <button className="btn primary" type="submit">Save</button>
          </form>
          {manual.map((a) => (
            <div className="row" key={a.account_id}>
              <div className="row-main"><div className="row-title">{a.name}</div><div className="muted small">{a.institution} · updated {ago(a.updated_at)}</div></div>
              <div className="row-amt">{money(a.balance)}</div>
              {a.source === 'manual' && <button className="link-btn" onClick={() => { setEditing(a.account_id); setForm({ name: a.name, institution: a.institution || '', type: a.type, balance: String(a.balance ?? '') }) }}>Edit</button>}
              <button className="link-btn" onClick={() => removeManual(a.account_id)}>{confirmDel === a.account_id ? 'Tap again' : 'Remove'}</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card section">
        <h2>Your rules</h2>
        <p className="muted small" style={{ marginTop: -4 }}>Made from the transaction editor ("do this for every transaction like it").</p>
        {(rules.data || []).length === 0 ? <div className="empty">No rules yet.</div> : (rules.data || []).map((r) => (
          <div className="row" key={r.id}>
            <div className="row-main">
              <div className="row-title">Name contains "{r.pattern}"</div>
              <div className="muted small">{r.direction === 'out' ? 'Money out' : r.direction === 'in' ? 'Money in' : 'Either direction'} → {r.set_flow ? FLOW_LABEL[r.set_flow] : 'keep type'}{r.set_category ? ` · ${r.set_category}` : ''}</div>
            </div>
            <button className="link-btn" onClick={async () => { await del(`/api/rules/${r.id}`); rules.reload(); reload() }}>Delete</button>
          </div>
        ))}
      </div>

      <div className="card section">
        <h2>Holdings</h2>
        {s.holdings.length === 0 ? <div className="empty">No holdings.</div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Holding</th><th>Account</th><th className="r">Shares</th><th className="r">Value</th><th className="r">Gain</th></tr></thead>
              <tbody>
                {s.holdings.map((h) => {
                  const gain = h.cost_basis != null && h.value != null ? h.value - h.cost_basis : null
                  const a = byAcct[h.account_id]
                  return (
                    <tr key={`${h.account_id}-${h.ticker}-${h.name}`}>
                      <td><b>{h.ticker || h.name}</b><div className="muted small">{h.name}</div></td>
                      <td className="small">{a?.institution} {a?.name}</td>
                      <td className="r">{(+h.quantity).toLocaleString()}</td>
                      <td className="r">{money(h.value)}</td>
                      <td className={`r ${gain == null ? '' : gain < 0 ? 'neg' : 'pos'}`}>{gain == null ? '—' : money(gain, { sign: true })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

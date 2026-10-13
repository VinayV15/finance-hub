import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icons'
import { money, niceDate } from '../format'
import { useFetch } from '../hooks'

interface Check {
  id: string; level: 'ok' | 'info' | 'warn' | 'bad'; title: string; detail: string
  items?: { txn_id?: string; date?: string; name?: string; amount?: number; account?: string; other_date?: string }[]
  link?: { to: string; params?: Record<string, string> }
}
interface HealthData { checks: Check[]; score: { ok: number; total: number } }

const ICON: Record<Check['level'], string> = { ok: 'check', info: 'review', warn: 'review', bad: 'lock' }
const ORDER: Record<Check['level'], number> = { bad: 0, warn: 1, info: 2, ok: 3 }

export function Health() {
  const { data } = useFetch<HealthData>('/api/health')
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return <div className="empty">Checking your data…</div>
  const checks = [...data.checks].sort((a, b) => ORDER[a.level] - ORDER[b.level])
  const problems = checks.filter((c) => c.level === 'bad' || c.level === 'warn').length
  return (
    <>
      <div className="page-head">
        <div><h1>Data health</h1><div className="muted small">Is every number in this app built on clean data? These checks run each time you open this page.</div></div>
      </div>
      <div className={`health-banner ${problems ? 'warn' : 'ok'}`}>
        <b>{problems ? `${problems} thing${problems > 1 ? 's' : ''} could make your numbers wrong` : 'Your data looks clean'}</b>
        <span>{data.score.ok} of {data.score.total} checks passed</span>
      </div>
      <div className="card">
        {checks.map((c) => (
          <div key={c.id} className={`alert-row lv-${c.level}`}>
            <span className="alert-ico"><Icon name={ICON[c.level]} size={18} /></span>
            <div className="alert-main" style={{ cursor: 'default' }}>
              <b>{c.title}</b><span className="muted small">{c.detail}</span>
              {c.items && c.items.length > 0 && (
                <>
                  <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? 'Hide' : `Show ${c.items.length}`}
                  </button>
                  {open === c.id && (
                    <div className="health-items">
                      {c.items.map((t, i) => (
                        <div key={t.txn_id || i} className="row">
                          <div className="row-main"><div className="row-title">{t.name}</div>
                            <div className="muted small">{t.date && niceDate(t.date)}{t.other_date ? ` and ${niceDate(t.other_date)}` : ''}{t.account ? ` · ${t.account}` : ''}</div></div>
                          {t.amount != null && <div className="row-amt">{money(t.amount)}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {c.link && <Link className="btn small" to={`${c.link.to}${c.link.params?.q ? `?q=${encodeURIComponent(c.link.params.q)}` : ''}`}>Open</Link>}
          </div>
        ))}
      </div>
    </>
  )
}

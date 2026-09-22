import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type Summary } from './api'
import { iso } from './format'

/** Load JSON from the API; re-runs when `path` changes. `reload()` refetches. */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    setLoading(true)
    api<T>(path)
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e: Error) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [path, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}

// ---------- toast ----------
const ToastCtx = createContext<(msg: string, isError?: boolean) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; err: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((msg: string, err = false) => {
    setT({ msg, err })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setT(null), 4000)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast${t.err ? ' error' : ''}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

// ---------- shared date range + account filter (persists across pages) ----------
export type PresetKey = 'this_month' | 'last_month' | '3m' | '6m' | '12m' | 'ytd' | 'last_year' | 'all' | 'custom'
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '3m', label: '3 mo' },
  { key: '6m', label: '6 mo' },
  { key: '12m', label: '12 mo' },
  { key: 'ytd', label: 'YTD' },
  { key: 'last_year', label: 'Last year' },
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Custom' },
]

export function presetRange(key: PresetKey): { start?: string; end?: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const monthsBack = (n: number) => iso(new Date(y, m - n + 1, 1))
  switch (key) {
    case 'this_month': return { start: iso(new Date(y, m, 1)), end: iso(now) }
    case 'last_month': return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) }
    case '3m': return { start: monthsBack(3), end: iso(now) }
    case '6m': return { start: monthsBack(6), end: iso(now) }
    case '12m': return { start: monthsBack(12), end: iso(now) }
    case 'ytd': return { start: `${y}-01-01`, end: iso(now) }
    case 'last_year': return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` }
    default: return {}
  }
}

interface RangeState {
  preset: PresetKey
  start?: string
  end?: string
  accounts: string[]
  setPreset: (p: PresetKey) => void
  setCustom: (start?: string, end?: string) => void
  setAccounts: (a: string[]) => void
}
const RangeCtx = createContext<RangeState | null>(null)

const load = <T,>(k: string, d: T): T => {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d }
}
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

export function RangeProvider({ children }: { children: ReactNode }) {
  const saved = load<{ preset: PresetKey; start?: string; end?: string; accounts: string[] }>('fh.range', { preset: '6m', accounts: [] })
  const [preset, setPresetS] = useState<PresetKey>(saved.preset)
  const [custom, setCustomS] = useState<{ start?: string; end?: string }>({ start: saved.start, end: saved.end })
  const [accounts, setAccountsS] = useState<string[]>(saved.accounts || [])
  const r = preset === 'custom' ? custom : presetRange(preset)
  useEffect(() => { save('fh.range', { preset, ...custom, accounts }) }, [preset, custom, accounts])
  const value = useMemo<RangeState>(() => ({
    preset, start: r.start, end: r.end, accounts,
    setPreset: (p) => { setPresetS(p); if (p === 'custom' && !custom.start) setCustomS(presetRange('3m')) },
    setCustom: (start, end) => { setPresetS('custom'); setCustomS({ start, end }) },
    setAccounts: setAccountsS,
  }), [preset, r.start, r.end, accounts, custom.start])
  return <RangeCtx.Provider value={value}>{children}</RangeCtx.Provider>
}
export const useRange = () => useContext(RangeCtx)!

// ---------- summary (accounts etc.) shared app-wide ----------
const SummaryCtx = createContext<{ summary: Summary | null; reload: () => void }>({ summary: null, reload: () => {} })
export function SummaryProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useFetch<Summary>('/api/summary')
  return <SummaryCtx.Provider value={{ summary: data, reload }}>{children}</SummaryCtx.Provider>
}
export const useSummary = () => useContext(SummaryCtx)

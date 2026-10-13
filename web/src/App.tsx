import { Fragment, Suspense, lazy, useEffect, useState } from 'react'
import { cloud, signOut, supabase } from './cloud'
import { SignIn } from './pages/SignIn'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Icon } from './components/Icons'
import { QuickSearch } from './components/Search'
import { RangeProvider, SummaryProvider, ToastProvider, useSummary } from './hooks'
import { Home } from './pages/Home'

// Pages load on first visit, so the phone downloads only what's on screen.
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })))
const Budget = lazy(() => import('./pages/Budget').then((m) => ({ default: m.Budget })))
const Goals = lazy(() => import('./pages/Goals').then((m) => ({ default: m.Goals })))
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const Income = lazy(() => import('./pages/Income').then((m) => ({ default: m.Income })))
const Mortgage = lazy(() => import('./pages/Mortgage').then((m) => ({ default: m.Mortgage })))
const Forecast = lazy(() => import('./pages/Forecast').then((m) => ({ default: m.Forecast })))
const Recurring = lazy(() => import('./pages/Recurring').then((m) => ({ default: m.Recurring })))
const Taxes = lazy(() => import('./pages/Taxes').then((m) => ({ default: m.Taxes })))
const Projection = lazy(() => import('./pages/Projection').then((m) => ({ default: m.Projection })))
const Recap = lazy(() => import('./pages/Recap').then((m) => ({ default: m.Recap })))
const Transactions = lazy(() => import('./pages/Transactions').then((m) => ({ default: m.Transactions })))
const Cards = lazy(() => import('./pages/Cards').then((m) => ({ default: m.Cards })))
const Health = lazy(() => import('./pages/Health').then((m) => ({ default: m.Health })))

const NAV = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/recap', label: 'Monthly recap', icon: 'recap' },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/review', label: 'Review', icon: 'review' },
  { to: '/budget', label: 'Budget', icon: 'budget', section: 'Plan' },
  { to: '/goals', label: 'Goals', icon: 'goals' },
  { to: '/recurring', label: 'Bills', icon: 'recurring' },
  { to: '/forecast', label: 'Forecast', icon: 'forecast' },
  { to: '/projection', label: 'Plan & retire', icon: 'projection' },
  { to: '/income', label: 'Income', icon: 'income', section: 'Details' },
  { to: '/cards', label: 'Credit cards', icon: 'cards' },
  { to: '/taxes', label: 'Taxes', icon: 'taxes' },
  { to: '/mortgage', label: 'Mortgage', icon: 'mortgage' },
  { to: '/accounts', label: 'Accounts', icon: 'accounts' },
  { to: '/health', label: 'Data health', icon: 'health' },
] as { to: string; label: string; icon: string; section?: string }[]

// Dark by default; the choice is remembered on this device (index.html applies it before first paint).
function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode */ }
    setTheme(next)
  }
  return { theme, toggle }
}

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode'
  return (
    <button className={`nav-link theme-toggle${compact ? ' compact' : ''}`} onClick={toggle} aria-label={`Switch to ${label.toLowerCase()}`}>
      <span className="nav-ico"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></span><span>{label}</span>
    </button>
  )
}

// Phone bottom bar: the everyday pages, plus "More" for the rest.
const BOTTOM = ['/', '/budget', '/goals', '/transactions']

function More() {
  const { summary } = useSummary()
  return (
    <>
      <div className="page-head"><h1>More</h1></div>
      <div className="card">
        {NAV.filter((n) => !BOTTOM.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} className="nav-link" style={{ padding: '12px 4px' }}>
            <span className="nav-inline"><span className="nav-ico"><Icon name={n.icon} /></span>{n.label}</span>
            {n.to === '/review' && !!summary?.review_count ? <span className="badge warn">{summary.review_count}</span> : <span className="muted">›</span>}
          </NavLink>
        ))}
        <ThemeToggle />
        <button className="nav-link" onClick={signOut} style={{ padding: '12px 4px' }}><span className="nav-inline"><span className="nav-ico"><Icon name="lock" /></span>{cloud ? 'Sign out' : 'Lock'}</span></button>
      </div>
    </>
  )
}

function Nav({ bottom = false }: { bottom?: boolean }) {
  const { summary } = useSummary()
  const items = bottom ? [...NAV.filter((n) => BOTTOM.includes(n.to)), { to: '/more', label: 'More', icon: 'more' }] : NAV
  return (
    <>
      {items.map((n) => (
        <Fragment key={n.to}>
        {!bottom && 'section' in n && n.section && <div className="nav-section">{n.section}</div>}
        <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-ico"><Icon name={n.icon} /></span>
          <span className="nav-label">{n.label}</span>
          {n.to === '/review' && !!summary?.review_count && <span className="badge warn">{summary.review_count}</span>}
        </NavLink>
        </Fragment>
      ))}
    </>
  )
}

function Shell() {
  const { summary } = useSummary()
  const [search, setSearch] = useState(false)
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <div className="shell">
      <QuickSearch pages={NAV} open={search} setOpen={setSearch} />
      <button className="search-fab" onClick={() => setSearch(true)} aria-label="Search"><Icon name="search" /></button>
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span>Finance Hub</span>
          {summary && summary.env !== 'production' && <span className="badge warn">Test data</span>}
        </div>
        <button className="search-trigger" onClick={() => setSearch(true)}>
          <Icon name="search" size={18} /><span>Search</span><kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <Nav />
        <div className="spacer" />
        <ThemeToggle />
        <button className="nav-link" onClick={signOut}><span className="nav-ico"><Icon name="lock" /></span><span className="nav-label">{cloud ? 'Sign out' : 'Lock'}</span></button>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/more" element={<More />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/review" element={<Transactions reviewOnly />} />
          <Route path="/income" element={<Income />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/taxes" element={<Taxes />} />
          <Route path="/projection" element={<Projection />} />
          <Route path="/recap" element={<Recap />} />
          <Route path="/mortgage" element={<Mortgage />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="/health" element={<Health />} />
          <Route path="*" element={<Home />} />
        </Routes>
        </Suspense>
      </main>
      <nav className="bottom-nav"><Nav bottom /></nav>
    </div>
  )
}

/** Cloud mode: show the sign-in screen until there is a session (and again if it ends or is refused). */
function useSignedIn() {
  const [state, setState] = useState<'checking' | 'in' | 'out' | 'add-passkey'>(cloud ? 'checking' : 'in')
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return setState('out')
      // Signed in (e.g. from the emailed link) but this account has no passkey yet: offer one, once.
      let later = false
      try { later = localStorage.getItem('fh.passkeyLater') === '1' } catch { /* private mode */ }
      const { data: keys } = await supabase!.auth.passkey.list()
      setState(!later && keys && keys.length === 0 ? 'add-passkey' : 'in')
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) setState('out')
      else if (event === 'SIGNED_IN') setState((s) => (s === 'out' ? 'out' : 'in')) // SignIn decides when it's done (passkey step)
    })
    const refused = () => setState('out')
    window.addEventListener('fh:signed-out', refused)
    return () => { sub.subscription.unsubscribe(); window.removeEventListener('fh:signed-out', refused) }
  }, [])
  return [state, () => setState('in')] as const
}

export default function App() {
  const [signedIn, done] = useSignedIn()
  if (signedIn === 'checking') return <div className="empty" style={{ paddingTop: '30vh' }}>Loading…</div>
  if (signedIn === 'out') return <SignIn onDone={done} />
  if (signedIn === 'add-passkey') return <SignIn onDone={done} initialStep="add-passkey" />
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <ToastProvider>
        <SummaryProvider>
          <RangeProvider>
            <Shell />
          </RangeProvider>
        </SummaryProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}

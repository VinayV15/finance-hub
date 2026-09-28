import { Fragment, useEffect, useState } from 'react'
import { cloud, signOut, supabase } from './cloud'
import { SignIn } from './pages/SignIn'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Icon } from './components/Icons'
import { QuickSearch } from './components/Search'
import { RangeProvider, SummaryProvider, ToastProvider, useSummary } from './hooks'
import { Accounts } from './pages/Accounts'
import { Budget } from './pages/Budget'
import { Goals } from './pages/Goals'
import { Dashboard } from './pages/Dashboard'
import { Home } from './pages/Home'
import { Income } from './pages/Income'
import { Mortgage } from './pages/Mortgage'
import { Forecast } from './pages/Forecast'
import { Recurring } from './pages/Recurring'
import { Taxes } from './pages/Taxes'
import { Projection } from './pages/Projection'
import { Recap } from './pages/Recap'
import { Transactions } from './pages/Transactions'

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
  { to: '/taxes', label: 'Taxes', icon: 'taxes' },
  { to: '/mortgage', label: 'Mortgage', icon: 'mortgage' },
  { to: '/accounts', label: 'Accounts', icon: 'accounts' },
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
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <nav className="bottom-nav"><Nav bottom /></nav>
    </div>
  )
}

/** Cloud mode: show the sign-in screen until there is a session (and again if it ends or is refused). */
function useSignedIn() {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(cloud ? 'checking' : 'in')
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setState(data.session ? 'in' : 'out'))
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

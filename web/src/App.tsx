import { useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Icon } from './components/Icons'
import { RangeProvider, SummaryProvider, ToastProvider, useSummary } from './hooks'
import { Accounts } from './pages/Accounts'
import { Budget } from './pages/Budget'
import { Goals } from './pages/Goals'
import { Dashboard } from './pages/Dashboard'
import { Home } from './pages/Home'
import { Income } from './pages/Income'
import { Mortgage } from './pages/Mortgage'
import { Transactions } from './pages/Transactions'

const NAV = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/budget', label: 'Budget', icon: 'budget' },
  { to: '/goals', label: 'Goals', icon: 'goals' },
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/review', label: 'Review', icon: 'review' },
  { to: '/income', label: 'Income', icon: 'income' },
  { to: '/mortgage', label: 'Mortgage', icon: 'mortgage' },
  { to: '/accounts', label: 'Accounts', icon: 'accounts' },
]

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
        <a className="nav-link" href="/logout" style={{ padding: '12px 4px' }}><span className="nav-inline"><span className="nav-ico"><Icon name="lock" /></span>Lock</span></a>
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
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-ico"><Icon name={n.icon} /></span>
          <span className="nav-label">{n.label}</span>
          {n.to === '/review' && !!summary?.review_count && <span className="badge warn">{summary.review_count}</span>}
        </NavLink>
      ))}
    </>
  )
}

function Shell() {
  const { summary } = useSummary()
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span>Finance Hub</span>
          {summary && summary.env !== 'production' && <span className="badge warn">Test data</span>}
        </div>
        <Nav />
        <div className="spacer" />
        <ThemeToggle />
        <a className="nav-link" href="/logout"><span className="nav-ico"><Icon name="lock" /></span><span className="nav-label">Lock</span></a>
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
          <Route path="/mortgage" element={<Mortgage />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <nav className="bottom-nav"><Nav bottom /></nav>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
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

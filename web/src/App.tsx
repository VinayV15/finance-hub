import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
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
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/budget', label: 'Budget', icon: '◐' },
  { to: '/goals', label: 'Goals', icon: '⚑' },
  { to: '/dashboard', label: 'Dashboard', icon: '▤' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/review', label: 'Review', icon: '✓' },
  { to: '/income', label: 'Income', icon: '$' },
  { to: '/mortgage', label: 'Mortgage', icon: '⌂' },
  { to: '/accounts', label: 'Accounts', icon: '▣' },
]

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
            <span>{n.icon}&nbsp;&nbsp;{n.label}</span>
            {n.to === '/review' && !!summary?.review_count ? <span className="badge warn">{summary.review_count}</span> : <span className="muted">›</span>}
          </NavLink>
        ))}
        <a className="nav-link" href="/logout" style={{ padding: '12px 4px' }}><span>⏻&nbsp;&nbsp;Lock</span></a>
      </div>
    </>
  )
}

function Nav({ bottom = false }: { bottom?: boolean }) {
  const { summary } = useSummary()
  const items = bottom ? [...NAV.filter((n) => BOTTOM.includes(n.to)), { to: '/more', label: 'More', icon: '⋯' }] : NAV
  return (
    <>
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          {bottom && <span aria-hidden style={{ fontSize: 16 }}>{n.icon}</span>}
          <span>{n.label}</span>
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
        <div className="brand">Finance Hub {summary && summary.env !== 'production' && <span className="badge warn">TEST</span>}</div>
        <Nav />
        <div className="spacer" />
        <a className="nav-link" href="/logout">Lock</a>
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

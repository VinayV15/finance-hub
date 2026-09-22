import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import { RangeProvider, SummaryProvider, ToastProvider, useSummary } from './hooks'
import { Accounts } from './pages/Accounts'
import { Dashboard } from './pages/Dashboard'
import { Home } from './pages/Home'
import { Income } from './pages/Income'
import { Mortgage } from './pages/Mortgage'
import { Transactions } from './pages/Transactions'

const NAV = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/dashboard', label: 'Dashboard', icon: '▤' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/review', label: 'Review', icon: '✓' },
  { to: '/income', label: 'Income', icon: '$' },
  { to: '/mortgage', label: 'Mortgage', icon: '⌂' },
  { to: '/accounts', label: 'Accounts', icon: '▣' },
]

function Nav({ bottom = false }: { bottom?: boolean }) {
  const { summary } = useSummary()
  return (
    <>
      {NAV.filter((n) => !bottom || n.to !== '/review').map((n) => (
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

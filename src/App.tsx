import { NavLink, Route, Routes, Navigate } from 'react-router-dom'
import type { JSX } from 'react'
import { useStore } from './store'
import { Toasts } from './components/ui'
import { can } from './lib/auth'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Sales from './pages/Sales'
import Restock from './pages/Restock'
import Reports from './pages/Reports'
import Firms from './pages/Firms'
import FirmDetail from './pages/FirmDetail'
import Orders from './pages/Orders'
import Staff from './pages/Staff'
import Kassa from './pages/Kassa'
import Login from './pages/Login'
import type { Capability } from './lib/types'

const NAV: { to: string; label: string; icon: string; end?: boolean; cap?: Capability }[] = [
  { to: '/', label: 'Boshqaruv', icon: '📊', end: true, cap: 'view-dashboard' },
  { to: '/sotuv', label: 'Sotuv', icon: '🛒' },
  { to: '/kirim', label: 'Kirim', icon: '📥', cap: 'receive-stock' },
  { to: '/mahsulotlar', label: 'Mahsulotlar', icon: '📦' },
  { to: '/firmalar', label: 'Firmalar', icon: '💼', cap: 'view-firms' },
  { to: '/hisobot', label: 'Hisobot', icon: '📈', cap: 'view-reports' },
  { to: '/kassa', label: 'Kassa', icon: '💵', cap: 'view-kassa' },
  { to: '/xodimlar', label: 'Xodimlar', icon: '👥', cap: 'manage-staff' },
]

/** Redirects to Sotuv anyone who reaches a route their role can't use. */
function RequireCap({ cap, children }: { cap: Capability; children: JSX.Element }) {
  const { account } = useStore()
  if (!account || !can(account.role, cap)) return <Navigate to="/sotuv" replace />
  return children
}

export default function App() {
  const { ready, error, account, needsSetup, actor, logout } = useStore()

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="card p-6 max-w-md text-center">
          <div className="text-3xl mb-3">⚠️</div>
          <h1 className="font-semibold mb-1">Ma'lumotlar bazasini ochib bo'lmadi</h1>
          <p className="text-sm text-ink-500">{error}</p>
          <p className="text-xs text-ink-400 mt-3">
            Brauzer maxfiy (inkognito) rejimda bo'lsa yoki saytlar uchun ma'lumot
            saqlash o'chirilgan bo'lsa shunday bo'ladi. Oddiy oynada oching.
          </p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-ink-200 border-t-ink-900 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-ink-400 mt-3">Yuklanmoqda…</p>
        </div>
      </div>
    )
  }

  // Everything past here requires a signed-in account.
  if (needsSetup || !account) return <Login />

  // Only the tabs this role may use. A cashier sees two; an admin sees them all.
  const nav = NAV.filter((n) => !n.cap || can(account.role, n.cap))
  const home = can(account.role, 'view-dashboard') ? '/' : '/sotuv'

  return (
    <div className="min-h-screen flex flex-col sm:flex-row">
      {/* Sidebar — desktop */}
      <aside className="hidden sm:flex sm:w-56 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="px-5 py-5">
          <div className="font-bold tracking-tight">Tamaki Savdo</div>
          <div className="text-xs text-ink-400 mt-0.5">Ombor va sotuv tizimi</div>
        </div>
        <nav className="flex-1 px-3 space-y-0.5">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? 'bg-ink-950 text-white' : 'text-ink-600 hover:bg-ink-100'
                }`
              }
            >
              <span className="text-base">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={logout}
          className="m-3 p-3 rounded-lg text-left hover:bg-ink-100 transition-colors"
        >
          <div className="text-sm font-semibold truncate">{actor.name}</div>
          <div className="text-xs text-ink-400">
            {actor.role === 'admin' ? 'Administrator' : 'Kassir'} · chiqish
          </div>
        </button>
      </aside>

      {/* Top bar — mobile */}
      <header className="sm:hidden sticky top-0 z-30 bg-white border-b border-ink-200 px-4 h-14 flex items-center justify-between">
        <div className="font-bold tracking-tight">Tamaki Savdo</div>
        <button onClick={logout} className="text-xs font-semibold text-ink-500">
          {actor.name} · chiqish
        </button>
      </header>

      <main className="flex-1 min-w-0 pb-20 sm:pb-0">
        <Routes>
          <Route path="/" element={<RequireCap cap="view-dashboard"><Dashboard /></RequireCap>} />
          <Route path="/sotuv" element={<Sales />} />
          <Route path="/kirim" element={<RequireCap cap="receive-stock"><Restock /></RequireCap>} />
          <Route path="/mahsulotlar" element={<Products />} />
          <Route path="/firmalar" element={<RequireCap cap="view-firms"><Firms /></RequireCap>} />
          <Route path="/firmalar/:id" element={<RequireCap cap="view-firms"><FirmDetail /></RequireCap>} />
          <Route path="/buyurtmalar" element={<RequireCap cap="view-firms"><Orders /></RequireCap>} />
          <Route path="/hisobot" element={<RequireCap cap="view-reports"><Reports /></RequireCap>} />
          <Route path="/kassa" element={<RequireCap cap="view-kassa"><Kassa /></RequireCap>} />
          <Route path="/xodimlar" element={<RequireCap cap="manage-staff"><Staff /></RequireCap>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>

      {/* Bottom nav — mobile */}
      <nav
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-ink-200 grid pb-[env(safe-area-inset-bottom)]"
        style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}
      >
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 h-16 text-[10px] font-semibold transition-colors ${
                isActive ? 'text-ink-950' : 'text-ink-400'
              }`
            }
          >
            <span className="text-lg">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>

      <Toasts />
    </div>
  )
}

import { NavLink, Route, Routes, Navigate } from 'react-router-dom'
import { useState } from 'react'
import { useStore } from './store'
import { Toasts, Modal } from './components/ui'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Sales from './pages/Sales'
import Restock from './pages/Restock'
import Reports from './pages/Reports'
import Firms from './pages/Firms'
import FirmDetail from './pages/FirmDetail'
import Orders from './pages/Orders'
import type { Role } from './lib/types'

const NAV = [
  { to: '/', label: 'Boshqaruv', icon: '📊', end: true },
  { to: '/sotuv', label: 'Sotuv', icon: '🛒' },
  { to: '/kirim', label: 'Kirim', icon: '📥' },
  { to: '/mahsulotlar', label: 'Mahsulotlar', icon: '📦' },
  { to: '/firmalar', label: 'Firmalar', icon: '💼' },
  { to: '/hisobot', label: 'Hisobot', icon: '📈' },
]

export default function App() {
  const { ready, error, actor, setActor } = useStore()
  const [userOpen, setUserOpen] = useState(false)

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

  return (
    <div className="min-h-screen flex flex-col sm:flex-row">
      {/* Sidebar — desktop */}
      <aside className="hidden sm:flex sm:w-56 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="px-5 py-5">
          <div className="font-bold tracking-tight">Tamaki Savdo</div>
          <div className="text-xs text-ink-400 mt-0.5">Ombor va sotuv tizimi</div>
        </div>
        <nav className="flex-1 px-3 space-y-0.5">
          {NAV.map((n) => (
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
          onClick={() => setUserOpen(true)}
          className="m-3 p-3 rounded-lg text-left hover:bg-ink-100 transition-colors"
        >
          <div className="text-sm font-semibold truncate">{actor.name}</div>
          <div className="text-xs text-ink-400">
            {actor.role === 'admin' ? 'Administrator' : 'Kassir'} · almashtirish
          </div>
        </button>
      </aside>

      {/* Top bar — mobile */}
      <header className="sm:hidden sticky top-0 z-30 bg-white border-b border-ink-200 px-4 h-14 flex items-center justify-between">
        <div className="font-bold tracking-tight">Tamaki Savdo</div>
        <button onClick={() => setUserOpen(true)} className="text-xs font-semibold text-ink-500">
          {actor.name}
        </button>
      </header>

      <main className="flex-1 min-w-0 pb-20 sm:pb-0">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sotuv" element={<Sales />} />
          <Route path="/kirim" element={<Restock />} />
          <Route path="/mahsulotlar" element={<Products />} />
          <Route path="/firmalar" element={<Firms />} />
          <Route path="/firmalar/:id" element={<FirmDetail />} />
          <Route path="/buyurtmalar" element={<Orders />} />
          <Route path="/hisobot" element={<Reports />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Bottom nav — mobile */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-ink-200 grid grid-cols-6 pb-[env(safe-area-inset-bottom)]">
        {NAV.map((n) => (
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

      <Modal open={userOpen} onClose={() => setUserOpen(false)} title="Xodim">
        <p className="text-sm text-ink-500 mb-4">
          Har bir sotuv va kirim yozuvi shu nom bilan saqlanadi.
        </p>
        <label className="label">Ism</label>
        <input
          className="field mb-4"
          value={actor.name}
          onChange={(e) => setActor({ ...actor, name: e.target.value })}
          placeholder="Ism"
        />
        <label className="label">Lavozim</label>
        <div className="grid grid-cols-2 gap-2">
          {(['admin', 'cashier'] as Role[]).map((r) => (
            <button
              key={r}
              onClick={() => setActor({ ...actor, role: r })}
              className={`btn ${actor.role === r ? 'btn-primary' : 'btn-ghost'}`}
            >
              {r === 'admin' ? 'Administrator' : 'Kassir'}
            </button>
          ))}
        </div>
        <button className="btn-primary w-full mt-5" onClick={() => setUserOpen(false)}>
          Saqlash
        </button>
      </Modal>

      <Toasts />
    </div>
  )
}

import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '../store'
import { moneyShort, num, pct } from '../lib/format'
import type { StockLevel } from '../lib/analytics'

export function Page({ title, subtitle, actions, children }: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="px-4 sm:px-6 py-5 sm:py-6 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-ink-500 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

export function Kpi({ label, value, sub, tone = 'default' }: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const toneCls = {
    default: 'text-ink-950',
    good: 'text-emerald-600',
    warn: 'text-amber-600',
    bad: 'text-red-600',
  }[tone]
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold text-ink-500">{label}</div>
      <div className={`mt-1.5 text-2xl font-bold tracking-tight num ${toneCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-400 num">{sub}</div>}
    </div>
  )
}

const STOCK_STYLE: Record<StockLevel, { cls: string; label: string }> = {
  ok: { cls: 'bg-emerald-50 text-emerald-700', label: 'yetarli' },
  low: { cls: 'bg-amber-50 text-amber-700', label: 'kam qoldi' },
  out: { cls: 'bg-red-50 text-red-700', label: 'tugagan' },
}

export function StockBadge({ level, stock }: { level: StockLevel; stock: number }) {
  const s = STOCK_STYLE[level]
  return (
    <span className={`chip ${s.cls} num`} title={s.label}>
      {num(stock)}
    </span>
  )
}

export function Empty({ icon = '📦', title, hint, action }: {
  icon?: string
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="card p-10 text-center">
      <div className="text-4xl mb-3">{icon}</div>
      <div className="font-semibold">{title}</div>
      {hint && <p className="text-sm text-ink-500 mt-1 max-w-md mx-auto">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function Modal({ open, onClose, title, children, wide }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-ink-950/40 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4"
      onMouseDown={(e) => { if (e.target === ref.current) onClose() }}
      ref={ref}
    >
      <div className={`bg-white w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'} rounded-t-2xl sm:rounded-xl shadow-xl max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-200">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-900 text-xl leading-none px-1" aria-label="Yopish">
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts } = useStore()
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 w-[min(92vw,26rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg px-4 py-3 text-sm font-medium shadow-lg text-white ${
            t.kind === 'err' ? 'bg-red-600' : 'bg-ink-950'
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}

export function MarginChip({ value }: { value: number }) {
  const tone =
    value <= 0 ? 'bg-red-50 text-red-700'
      : value < 10 ? 'bg-amber-50 text-amber-700'
        : 'bg-ink-100 text-ink-700'
  return <span className={`chip ${tone} num`}>{pct(value)}</span>
}

export function MoneyCell({ value, tone }: { value: number; tone?: 'good' | 'bad' }) {
  const cls = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : ''
  return <span className={`num font-medium ${cls}`}>{moneyShort(value)}</span>
}

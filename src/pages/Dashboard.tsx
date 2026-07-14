import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store'
import { watchTransactions } from '../lib/db'
import { totals, bestSellers, reorderList, inventoryValue, stockLevel } from '../lib/analytics'
import {
  supplierBalance, unpaidDeliveries, forSupplier, orderStatus,
} from '../lib/payables'
import { money, moneyShort, num, pct, startOfDay, endOfDay, isoDay, daysAgo, dateTimeLabel } from '../lib/format'
import { Page, Kpi, StockBadge } from '../components/ui'
import { BestSellersChart } from '../components/charts'
import type { Transaction } from '../lib/types'

const WEEK = 7 * 86_400_000

const RANGES = [
  { key: 'today', label: 'Bugun', from: () => isoDay(Date.now()) },
  { key: '7d', label: '7 kun', from: () => daysAgo(6) },
  { key: '30d', label: '30 kun', from: () => daysAgo(29) },
] as const

export default function Dashboard() {
  const { products, recent, suppliers, deliveries, payments, orders } = useStore()
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]['key']>('today')
  const [txs, setTxs] = useState<Transaction[]>([])

  const range = RANGES.find((r) => r.key === rangeKey)!

  useEffect(() => {
    const from = startOfDay(range.from())
    const to = endOfDay(isoDay(Date.now()))
    return watchTransactions(from, to, setTxs)
  }, [rangeKey, range])

  const t = useMemo(() => totals(txs), [txs])
  const best = useMemo(() => bestSellers(txs, 6), [txs])
  const reorder = useMemo(() => reorderList(products), [products])
  const inv = useMemo(() => inventoryValue(products), [products])

  const outCount = reorder.filter((p) => p.current_stock <= 0).length
  const lastSales = recent.filter((x) => x.type === 'SALE' && !x.voided && !x.reversal_of).slice(0, 6)

  // What we owe the firms. Only positive balances count towards the total — a firm we have
  // prepaid is not a debt, and netting it against another firm's debt would understate what
  // actually has to be paid out.
  const payables = useMemo(() => {
    let totalDebt = 0
    let overdueCount = 0

    for (const f of suppliers) {
      const ds = forSupplier(deliveries, f.id)
      const ps = forSupplier(payments, f.id)
      totalDebt += Math.max(0, supplierBalance(ds, ps))
      overdueCount += unpaidDeliveries(ds, ps, f.payment_terms_days ?? 0)
        .filter((u) => u.daysOverdue > 0).length
    }

    const soon = Date.now() + WEEK
    const incoming = orders.filter((o) => {
      const st = orderStatus(o, deliveries)
      return (st === 'waiting' || st === 'partial' || st === 'overdue')
        && o.expected_at != null && o.expected_at <= soon
    }).length

    return { totalDebt, overdueCount, incoming }
  }, [suppliers, deliveries, payments, orders])

  return (
    <Page
      title="Boshqaruv paneli"
      subtitle={`${range.label} uchun ko'rsatkichlar`}
      actions={
        <div className="flex gap-1 p-1 bg-ink-100 rounded-lg">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${
                rangeKey === r.key ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-500'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Kpi label="Tushum" value={moneyShort(t.revenue)} sub={`${num(t.saleCount)} ta sotuv`} />
        <Kpi
          label="Foyda"
          value={moneyShort(t.profit)}
          sub={`marja ${pct(t.margin)}`}
          tone={t.profit > 0 ? 'good' : t.profit < 0 ? 'bad' : 'default'}
        />
        <Kpi label="Sotilgan" value={`${num(t.unitsSold)} dona`} sub={`kirim: ${moneyShort(t.restockCost)}`} />
        <Kpi
          label="Kam qolgan"
          value={`${num(reorder.length)} ta`}
          sub={
            outCount
              ? `${num(outCount)} tasi tugagan`
              : reorder.length
                ? 'buyurtma bering'
                : 'zaxira yetarli'
          }
          tone={outCount ? 'bad' : reorder.length ? 'warn' : 'good'}
        />
      </div>

      {/* Payables. Hidden until there is at least one firm, so a shop that doesn't buy on
          credit never sees three widgets reading zero. */}
      {!!suppliers.length && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mt-3 sm:mt-4">
          <Link to="/firmalar" className="contents">
            <Kpi
              label="Firmalarga qarz"
              value={moneyShort(payables.totalDebt)}
              sub={
                payables.overdueCount
                  ? `${num(payables.overdueCount)} ta kechikkan to'lov`
                  : payables.totalDebt
                    ? 'muddati yetmagan'
                    : 'qarz yo\'q'
              }
              tone={payables.overdueCount ? 'bad' : payables.totalDebt ? 'warn' : 'good'}
            />
          </Link>
          <Link to="/buyurtmalar" className="contents">
            <Kpi
              label="Kutilayotgan yetkazib berish"
              value={`${num(payables.incoming)} ta`}
              sub="shu hafta ichida"
            />
          </Link>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <section className="card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Eng ko'p sotilganlar</h2>
            <span className="text-xs text-ink-400">{range.label}</span>
          </div>
          <BestSellersChart data={best.map((b) => ({ name: b.name, units: b.units }))} />
        </section>

        <section className="card p-4">
          <h2 className="font-semibold mb-3">Ombor qiymati</h2>
          <div className="space-y-3">
            <Row label="Tan narxda" value={money(inv.atCost)} />
            <Row label="Sotuv narxida" value={money(inv.atRetail)} />
            <Row label="Kutilayotgan foyda" value={money(inv.potentialProfit)} accent />
          </div>

          <h3 className="font-semibold mt-6 mb-2 text-sm">Oxirgi sotuvlar</h3>
          {lastSales.length ? (
            <ul className="divide-y divide-ink-100">
              {lastSales.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2 gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.product_name}</div>
                    <div className="text-xs text-ink-400">
                      {num(s.quantity)} dona · {dateTimeLabel(s.ts)}
                    </div>
                  </div>
                  <span className="text-sm font-semibold num shrink-0">{money(s.total_amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-400 py-4">Hali sotuv yo'q</p>
          )}
        </section>
      </div>

      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-200">
          <div>
            <h2 className="font-semibold">Buyurtma berish kerak</h2>
            <p className="text-xs text-ink-400 mt-0.5">
              Qoldiq minimal zaxiradan kam yoki teng bo'lgan mahsulotlar
            </p>
          </div>
          <Link to="/kirim" className="btn-ghost h-9 text-xs">Kirim qilish</Link>
        </div>

        {reorder.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink-50 border-b border-ink-200">
                <tr>
                  <th className="th">Mahsulot</th>
                  <th className="th">Brend</th>
                  <th className="th text-right">Qoldiq</th>
                  <th className="th text-right">Minimal</th>
                  <th className="th text-right">Kerak</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {reorder.map((p) => {
                  const level = stockLevel(p)
                  const need = Math.max(p.reorder_threshold * 2 - p.current_stock, 1)
                  return (
                    <tr key={p.id} className={level === 'out' ? 'bg-red-50/60' : 'bg-amber-50/40'}>
                      <td className="td font-medium">{p.name}</td>
                      <td className="td text-ink-500">{p.brand}</td>
                      <td className="td text-right">
                        <StockBadge level={level} stock={p.current_stock} />
                      </td>
                      <td className="td text-right num text-ink-500">{num(p.reorder_threshold)}</td>
                      <td className="td text-right num font-semibold">~{num(need)} dona</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-ink-400">
            ✅ Hamma mahsulot yetarli — buyurtma kerak emas
          </p>
        )}
      </section>
    </Page>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm text-ink-500">{label}</span>
      <span className={`num font-semibold ${accent ? 'text-emerald-600' : ''}`}>{value}</span>
    </div>
  )
}

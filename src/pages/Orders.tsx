import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import OrderForm from '../components/OrderForm'
import { money, dateLabel } from '../lib/format'
import { orderStatus, receivedQty, linesTotal, ORDER_STATUS_LABEL } from '../lib/payables'
import { cancelPurchaseOrder } from '../lib/procurement'
import type { OrderStatus } from '../lib/types'

const TONE: Record<OrderStatus, string> = {
  waiting: 'bg-ink-100 text-ink-600',
  partial: 'bg-amber-50 text-amber-700',
  received: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-ink-100 text-ink-400',
}

export default function Orders() {
  const { orders, deliveries, suppliers, toast } = useStore()
  const [adding, setAdding] = useState(false)

  const rows = useMemo(
    () =>
      orders.map((order) => ({
        order,
        status: orderStatus(order, deliveries),
        got: receivedQty(order, deliveries),
        firm: suppliers.find((f) => f.id === order.supplier_id),
      })),
    [orders, deliveries, suppliers],
  )

  const cancel = async (id: string) => {
    if (!confirm('Buyurtma bekor qilinsinmi?')) return
    try {
      await cancelPurchaseOrder(id)
      toast('Buyurtma bekor qilindi')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    }
  }

  return (
    <Page
      title="Buyurtmalar"
      subtitle="Nima buyurtma qilindi, qachon kutilmoqda, keldimi."
      actions={
        <>
          <Link to="/firmalar" className="btn-ghost">← Firmalar</Link>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Buyurtma</button>
        </>
      }
    >
      {!orders.length ? (
        <Empty
          icon="📋"
          title="Hali buyurtma yo'q"
          hint="Firmaga buyurtma bering — tovar kelganda Kirim bo'limida qabul qilasiz."
          action={
            <button className="btn-primary" onClick={() => setAdding(true)}>
              + Buyurtma berish
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map(({ order, status, got, firm }) => (
            <div key={order.id} className="card p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold num">{order.number}</span>
                    <span className={`chip ${TONE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>
                  </div>
                  <div className="text-sm text-ink-500 mt-0.5 truncate">{firm?.name ?? '—'}</div>
                  {order.expected_at && (
                    <div className="text-xs text-ink-400">
                      Kutilmoqda: {dateLabel(order.expected_at)}
                    </div>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <div className="font-bold num">{money(linesTotal(order.lines))}</div>
                  {status !== 'received' && status !== 'cancelled' && (
                    <div className="flex gap-2 mt-1 justify-end">
                      <Link
                        to={`/kirim?buyurtma=${order.id}`}
                        className="text-xs font-semibold text-ink-900 underline"
                      >
                        Qabul qilish
                      </Link>
                      <button
                        onClick={() => cancel(order.id)}
                        className="text-xs font-semibold text-ink-400 hover:text-red-600"
                      >
                        Bekor
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Ordered vs. what actually arrived, per product — a short delivery must be visible. */}
              <div className="space-y-1">
                {order.lines.map((l) => {
                  const received = got.get(l.product_id) ?? 0
                  const short = received < l.quantity
                  return (
                    <div key={l.product_id} className="flex justify-between text-sm">
                      <span className="text-ink-600 truncate">{l.product_name}</span>
                      <span
                        className={`num shrink-0 ml-3 ${
                          short ? 'text-amber-700 font-semibold' : 'text-ink-400'
                        }`}
                      >
                        {received} / {l.quantity}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <OrderForm open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}

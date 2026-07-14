import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import FirmForm from '../components/FirmForm'
import { money } from '../lib/format'
import { supplierBalance, worstOverdue, forSupplier } from '../lib/payables'

export default function Firms() {
  const { suppliers, deliveries, payments } = useStore()
  const [adding, setAdding] = useState(false)

  // Positive = we owe them (qarz). Negative = we prepaid, so they owe us goods (avans).
  // Both fall out of the same sum; neither is a special case.
  const rows = useMemo(
    () =>
      suppliers
        .map((firm) => {
          const ds = forSupplier(deliveries, firm.id)
          const ps = forSupplier(payments, firm.id)
          return {
            firm,
            balance: supplierBalance(ds, ps),
            overdue: worstOverdue(ds, ps, firm.payment_terms_days ?? 0),
          }
        })
        .sort((a, b) => b.balance - a.balance),
    [suppliers, deliveries, payments],
  )

  const totalDebt = rows.reduce((s, r) => s + Math.max(0, r.balance), 0)

  return (
    <Page
      title="Firmalar"
      subtitle="Tovar oladigan firmalar, qarzlar va to'lovlar."
      actions={
        <>
          <Link to="/buyurtmalar" className="btn-ghost">Buyurtmalar</Link>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Firma</button>
        </>
      }
    >
      {!suppliers.length ? (
        <Empty
          icon="💼"
          title="Hali firma qo'shilmagan"
          hint="Tovar oladigan firmangizni qo'shing — qarz, yetkazib berish va to'lovlar shu yerda ko'rinadi."
          action={
            <button className="btn-primary" onClick={() => setAdding(true)}>
              + Firma qo'shish
            </button>
          }
        />
      ) : (
        <>
          <div className="card p-4 mb-4">
            <div className="text-xs font-semibold text-ink-500">Jami qarzimiz</div>
            <div
              className={`mt-1.5 text-3xl font-bold num tracking-tight ${
                totalDebt > 0 ? 'text-red-600' : 'text-ink-950'
              }`}
            >
              {money(totalDebt)}
            </div>
          </div>

          <div className="card divide-y divide-ink-100 overflow-hidden">
            {rows.map(({ firm, balance, overdue }) => (
              <Link
                key={firm.id}
                to={`/firmalar/${firm.id}`}
                className="flex items-center gap-3 p-4 hover:bg-ink-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{firm.name}</div>
                  <div className="text-xs text-ink-400 truncate">
                    {firm.inn ? `STIR ${firm.inn}` : firm.contact || '—'}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  {balance > 0 ? (
                    <div className="font-semibold num text-red-600">{money(balance)}</div>
                  ) : balance < 0 ? (
                    <div className="font-semibold num text-emerald-600">
                      Avans {money(-balance)}
                    </div>
                  ) : (
                    <div className="text-sm text-ink-400">Qarz yo'q</div>
                  )}
                  {overdue > 0 && (
                    <div className="chip bg-amber-50 text-amber-700 mt-1">
                      ⚠️ {overdue} kun kechikkan
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <FirmForm open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}

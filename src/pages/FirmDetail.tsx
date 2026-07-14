import { useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import FirmForm from '../components/FirmForm'
import PaymentForm from '../components/PaymentForm'
import { money, dateLabel } from '../lib/format'
import { statement, supplierBalance, unpaidDeliveries, forSupplier } from '../lib/payables'
import { voidDelivery, voidPayment } from '../lib/procurement'

/** One field of the bank block. Kept dumb, so the block reads as data rather than markup. */
function Detail({ label, value }: { label: string; value?: string | number }) {
  if (!value) return null
  return (
    <div>
      <div className="text-xs text-ink-400">{label}</div>
      <div className="text-sm font-medium num break-all">{value}</div>
    </div>
  )
}

export default function FirmDetail() {
  const { id = '' } = useParams()
  const { suppliers, deliveries, payments, actor, toast } = useStore()
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)

  const firm = suppliers.find((f) => f.id === id)

  const view = useMemo(() => {
    if (!firm) return null
    const ds = forSupplier(deliveries, firm.id)
    const ps = forSupplier(payments, firm.id)
    return {
      balance: supplierBalance(ds, ps),
      rows: statement(ds, ps).reverse(), // newest first on screen; the running balance is already computed
      unpaid: unpaidDeliveries(ds, ps, firm.payment_terms_days ?? 0),
    }
  }, [firm, deliveries, payments])

  if (!firm || !view) return <Navigate to="/firmalar" replace />

  const { balance, rows, unpaid } = view
  const worstOverdue = unpaid.reduce((w, u) => Math.max(w, u.daysOverdue), 0)
  const hasBankDetails = Boolean(firm.inn || firm.bank_account || firm.contact || firm.address)

  const undo = async (kind: 'delivery' | 'payment', rowId: string) => {
    const what = kind === 'delivery' ? 'Yetkazib berish' : "To'lov"
    if (!confirm(`${what} bekor qilinsinmi?\n\nYozuv o'chmaydi — teskari yozuv qo'shiladi.`)) return
    try {
      if (kind === 'delivery') await voidDelivery(rowId, actor)
      else await voidPayment(rowId, actor)
      toast('Bekor qilindi')
    } catch (e) {
      toast(e instanceof Error ? e.message : "Bekor qilib bo'lmadi", 'err')
    }
  }

  return (
    <Page
      title={firm.name}
      subtitle={firm.director ? `Direktor: ${firm.director}` : undefined}
      actions={
        <>
          <Link to="/firmalar" className="btn-ghost">← Firmalar</Link>
          <button className="btn-ghost" onClick={() => setEditing(true)}>Tahrirlash</button>
          <button className="btn-primary" onClick={() => setPaying(true)}>To'lov qilish</button>
        </>
      }
    >
      {/* Balance */}
      <div className="card p-5 mb-4">
        <div className="text-xs font-semibold text-ink-500">
          {balance > 0
            ? 'Qarzimiz'
            : balance < 0
              ? 'Avans — firma bizga qarzdor'
              : 'Hisob-kitob teng'}
        </div>
        <div
          className={`mt-1 text-4xl font-bold num tracking-tight ${
            balance > 0 ? 'text-red-600' : balance < 0 ? 'text-emerald-600' : 'text-ink-950'
          }`}
        >
          {money(Math.abs(balance))}
        </div>

        {worstOverdue > 0 && (
          <div className="chip bg-amber-50 text-amber-700 mt-2">
            ⚠️ Eng eski to'lanmagan yetkazib berish — {worstOverdue} kun kechikkan
          </div>
        )}
        {firm.payment_terms_days ? (
          <p className="text-xs text-ink-400 mt-2">
            To'lov muddati: {firm.payment_terms_days} kun
          </p>
        ) : null}
      </div>

      {/* Bank block — the details you read out over the phone */}
      <div className="card p-5 mb-4">
        <h2 className="font-semibold mb-3">Rekvizitlar</h2>
        {hasBankDetails ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Detail label="STIR (INN)" value={firm.inn} />
            <Detail label="Hisob raqam" value={firm.bank_account} />
            <Detail label="Bank" value={firm.bank_name} />
            <Detail label="MFO" value={firm.bank_mfo} />
            <Detail label="Telefon" value={firm.contact} />
            <Detail label="Manzil" value={firm.address} />
          </div>
        ) : (
          <p className="text-sm text-ink-400">
            Rekvizitlar kiritilmagan.{' '}
            <button className="underline font-medium" onClick={() => setEditing(true)}>
              Qo'shish
            </button>
          </p>
        )}
      </div>

      {/* Statement — this IS the akt sverki */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-ink-200">
          <h2 className="font-semibold">Hisob-kitob</h2>
          <p className="text-xs text-ink-400 mt-0.5">
            Har bir yetkazib berish va to'lov — sana bo'yicha, qoldiq bilan.
          </p>
        </div>

        {!rows.length ? (
          <div className="p-2">
            <Empty
              icon="📄"
              title="Hali yozuv yo'q"
              hint="Kirim bo'limida shu firmani tanlab tovar qabul qiling — qarz shu yerda paydo bo'ladi."
            />
          </div>
        ) : (
          <div className="divide-y divide-ink-100">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">
                    {r.kind === 'delivery' ? 'Yetkazib berish' : "To'lov"}
                    {r.doc_number && (
                      <span className="text-ink-400 font-normal"> · №{r.doc_number}</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-400">{dateLabel(r.ts)}</div>
                </div>

                <div
                  className={`text-sm font-semibold num shrink-0 ${
                    r.delta > 0 ? 'text-red-600' : 'text-emerald-600'
                  }`}
                >
                  {r.delta > 0 ? '+' : '−'}
                  {money(Math.abs(r.delta))}
                </div>

                <div className="hidden sm:block text-sm font-bold num shrink-0 w-32 text-right">
                  {money(r.balance)}
                </div>

                <button
                  onClick={() => undo(r.kind, r.id)}
                  className="text-ink-300 hover:text-red-600 text-xs font-semibold shrink-0"
                  title="Bekor qilish"
                >
                  Bekor
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <FirmForm firm={firm} open={editing} onClose={() => setEditing(false)} />
      <PaymentForm
        firm={firm}
        owed={Math.max(0, balance)}
        open={paying}
        onClose={() => setPaying(false)}
      />
    </Page>
  )
}

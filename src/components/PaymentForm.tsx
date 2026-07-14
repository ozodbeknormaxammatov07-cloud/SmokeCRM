import { useState } from 'react'
import { useStore } from '../store'
import { recordPayment } from '../lib/procurement'
import { Modal } from './ui'
import { parseNum, money, isoDay, startOfDay } from '../lib/format'
import type { PaymentMethod, Supplier } from '../lib/types'

const METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'bank', label: "Bank o'tkazmasi" },
  { key: 'cash', label: 'Naqd' },
  { key: 'card', label: 'Plastik' },
  { key: 'other', label: 'Boshqa' },
]

export default function PaymentForm({ firm, owed, open, onClose }: {
  firm: Supplier
  /** What we currently owe. 0 when the firm is settled or we are in credit. */
  owed: number
  open: boolean
  onClose: () => void
}) {
  const { actor, toast } = useStore()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('bank')
  const [day, setDay] = useState(isoDay(Date.now()))
  const [doc, setDoc] = useState('')
  const [busy, setBusy] = useState(false)

  const value = parseNum(amount)

  const submit = async () => {
    if (!(value > 0)) {
      toast("To'lov summasini kiriting", 'err')
      return
    }
    setBusy(true)
    try {
      await recordPayment({
        supplier_id: firm.id,
        amount: value,
        // The real-world date the money moved. `created_at` is stamped inside recordPayment and
        // is what sync pages on — see the two-date rule on the Payment type.
        paid_at: startOfDay(day),
        method,
        doc_number: doc.trim() || undefined,
      }, actor)
      toast(`To'lov saqlandi — ${money(value)}`)
      setAmount('')
      setDoc('')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`To'lov — ${firm.name}`}>
      <div className="flex items-baseline justify-between mb-4 text-sm">
        <span className="text-ink-500">Hozirgi qarz</span>
        <span className="font-semibold num text-red-600">{money(owed)}</span>
      </div>

      <label className="label">Summa *</label>
      <input
        className="field num text-lg h-12"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric"
        placeholder="0"
        autoFocus
      />
      {owed > 0 && (
        <button
          className="text-xs font-semibold text-ink-500 hover:text-ink-900 mt-1.5"
          onClick={() => setAmount(String(owed))}
        >
          Butun qarzni to'lash ({money(owed)})
        </button>
      )}

      <label className="label mt-4">To'lov turi</label>
      <div className="grid grid-cols-2 gap-2">
        {METHODS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMethod(m.key)}
            className={`btn ${method === m.key ? 'btn-primary' : 'btn-ghost'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div>
          <label className="label">Sana</label>
          <input
            type="date"
            className="field"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Hujjat №</label>
          <input
            className="field"
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            placeholder="TT-19"
          />
        </div>
      </div>

      <button
        className="btn-primary w-full mt-5"
        onClick={submit}
        disabled={busy || !(value > 0)}
      >
        {busy ? 'Saqlanmoqda…' : `To'lovni saqlash — ${money(value)}`}
      </button>
    </Modal>
  )
}

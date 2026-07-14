import { useEffect, useState, type ChangeEvent } from 'react'
import { saveSupplier } from '../lib/db'
import { useStore } from '../store'
import { Modal } from './ui'
import { parseNum } from '../lib/format'
import type { Supplier } from '../lib/types'

/** Everything you need in order to actually transfer money to a firm, in one block. */
export default function FirmForm({ firm, open, onClose }: {
  firm?: Supplier
  open: boolean
  onClose: () => void
}) {
  const { toast } = useStore()
  const [f, setF] = useState<Partial<Supplier>>(firm ?? {})
  const [busy, setBusy] = useState(false)

  // Reopening the modal on a different firm must not show the previous one's details.
  useEffect(() => {
    if (open) setF(firm ?? {})
  }, [open, firm])

  const set = (k: keyof Supplier) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    if (!f.name?.trim()) {
      toast('Firma nomini kiriting', 'err')
      return
    }
    setBusy(true)
    try {
      await saveSupplier({ ...f, id: firm?.id, name: f.name.trim() } as Supplier)
      toast(firm ? 'Firma yangilandi' : "Firma qo'shildi")
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={firm ? 'Firmani tahrirlash' : 'Yangi firma'} wide>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="label">Firma nomi *</label>
          <input
            className="field"
            value={f.name ?? ''}
            onChange={set('name')}
            placeholder="Fayz Tamaki MChJ"
          />
        </div>

        <div>
          <label className="label">STIR (INN)</label>
          <input className="field num" value={f.inn ?? ''} onChange={set('inn')} inputMode="numeric" />
        </div>
        <div>
          <label className="label">Telefon</label>
          <input className="field" value={f.contact ?? ''} onChange={set('contact')} inputMode="tel" />
        </div>

        <div>
          <label className="label">Direktor</label>
          <input className="field" value={f.director ?? ''} onChange={set('director')} />
        </div>
        <div>
          <label className="label">Manzil</label>
          <input className="field" value={f.address ?? ''} onChange={set('address')} />
        </div>

        <div className="sm:col-span-2">
          <label className="label">Hisob raqam</label>
          <input
            className="field num"
            value={f.bank_account ?? ''}
            onChange={set('bank_account')}
            inputMode="numeric"
          />
        </div>

        <div>
          <label className="label">Bank</label>
          <input className="field" value={f.bank_name ?? ''} onChange={set('bank_name')} />
        </div>
        <div>
          <label className="label">MFO</label>
          <input
            className="field num"
            value={f.bank_mfo ?? ''}
            onChange={set('bank_mfo')}
            inputMode="numeric"
          />
        </div>

        <div>
          <label className="label">To'lov muddati (kun)</label>
          <input
            className="field num"
            value={f.payment_terms_days ?? ''}
            onChange={(e) =>
              setF((p) => ({
                ...p,
                payment_terms_days: e.target.value.trim() ? parseNum(e.target.value) : undefined,
              }))
            }
            inputMode="numeric"
            placeholder="30"
          />
          <p className="text-xs text-ink-400 mt-1">
            Shu muddatdan keyin to'lanmagan qarz "kechikkan" hisoblanadi.
          </p>
        </div>
        <div>
          <label className="label">Izoh</label>
          <input className="field" value={f.note ?? ''} onChange={set('note')} />
        </div>
      </div>

      <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}

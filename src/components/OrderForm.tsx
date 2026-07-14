import { useState } from 'react'
import { useStore } from '../store'
import { savePurchaseOrder } from '../lib/procurement'
import { linesTotal } from '../lib/payables'
import { Modal } from './ui'
import { money, parseNum, isoDay, startOfDay } from '../lib/format'
import type { OrderLine } from '../lib/types'

const WEEK = 7 * 86_400_000

export default function OrderForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { suppliers, products, actor, toast } = useStore()
  const [firmId, setFirmId] = useState('')
  const [expected, setExpected] = useState(isoDay(Date.now() + WEEK))
  const [lines, setLines] = useState<OrderLine[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  const needle = q.trim().toLowerCase()
  const results = needle
    ? products
        .filter((p) => p.active && !lines.some((l) => l.product_id === p.id))
        .filter(
          (p) =>
            p.name.toLowerCase().includes(needle) || p.brand.toLowerCase().includes(needle),
        )
        .slice(0, 8)
    : []

  const add = (id: string) => {
    const p = products.find((x) => x.id === id)
    if (!p) return
    setLines((prev) => [
      ...prev,
      {
        product_id: p.id,
        product_name: p.name,
        brand: p.brand,
        quantity: 1,
        unit_cost: p.cost_price,
      },
    ])
    setQ('')
  }

  const patch = (id: string, k: 'quantity' | 'unit_cost', v: number) =>
    setLines((prev) => prev.map((l) => (l.product_id === id ? { ...l, [k]: v } : l)))

  const submit = async () => {
    if (!firmId) {
      toast('Firmani tanlang', 'err')
      return
    }
    if (!lines.length) {
      toast("Mahsulot qo'shing", 'err')
      return
    }
    setBusy(true)
    try {
      await savePurchaseOrder({
        supplier_id: firmId,
        ordered_at: Date.now(),
        expected_at: expected ? startOfDay(expected) : undefined,
        lines,
      }, actor)
      toast('Buyurtma saqlandi')
      setLines([])
      setFirmId('')
      setQ('')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Yangi buyurtma" wide>
      <p className="text-sm text-ink-500 mb-4">
        Buyurtma — bu niyat. Qoldiq ham, qarz ham o'zgarmaydi: tovar kelganda Kirim bo'limida
        qabul qilasiz.
      </p>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="label">Firma *</label>
          <select className="field" value={firmId} onChange={(e) => setFirmId(e.target.value)}>
            <option value="">Tanlang…</option>
            {suppliers.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Kutilayotgan sana</label>
          <input
            type="date"
            className="field"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>
      </div>

      <label className="label">Mahsulot qo'shish</label>
      <input
        className="field"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Mahsulot nomi…"
      />
      {!!results.length && (
        <div className="card divide-y divide-ink-100 mt-2 overflow-hidden">
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => add(p.id)}
              className="w-full text-left px-3 py-2 hover:bg-ink-50 transition-colors"
            >
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-xs text-ink-400"> · {p.brand}</span>
            </button>
          ))}
        </div>
      )}

      {!!lines.length && (
        <div className="space-y-2 mt-3 max-h-64 overflow-y-auto">
          {lines.map((l) => (
            <div
              key={l.product_id}
              className="flex items-center gap-2 rounded-lg border border-ink-200 p-2"
            >
              <div className="min-w-0 flex-1 text-sm font-medium truncate">{l.product_name}</div>
              <input
                className="field h-9 w-16 num text-center"
                value={l.quantity}
                onChange={(e) =>
                  patch(l.product_id, 'quantity', Math.max(1, Math.round(parseNum(e.target.value))))
                }
                inputMode="numeric"
                title="Soni"
              />
              <span className="text-xs text-ink-400">×</span>
              <input
                className="field h-9 w-28 num text-right"
                value={l.unit_cost}
                onChange={(e) => patch(l.product_id, 'unit_cost', parseNum(e.target.value))}
                inputMode="numeric"
                title="Kelish narxi"
              />
              <button
                onClick={() => setLines((prev) => prev.filter((x) => x.product_id !== l.product_id))}
                className="text-ink-300 hover:text-red-600 text-lg leading-none px-1"
                aria-label="O'chirish"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-between items-baseline border-t border-ink-200 mt-4 pt-3">
        <span className="text-sm text-ink-500">Jami</span>
        <span className="text-2xl font-bold num tracking-tight">{money(linesTotal(lines))}</span>
      </div>

      <button className="btn-primary w-full mt-4" onClick={submit} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Buyurtmani saqlash'}
      </button>
    </Modal>
  )
}

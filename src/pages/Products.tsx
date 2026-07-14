import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { createProduct, updateProduct, deleteProduct, adjustStock } from '../lib/db'
import { exportProducts } from '../lib/excel'
import { money, num, parseNum, marginPct } from '../lib/format'
import { stockLevel, productMargin } from '../lib/analytics'
import { Page, StockBadge, MarginChip, Modal, Empty } from '../components/ui'
import ImportWizard from '../components/ImportWizard'
import type { NewProduct, Product } from '../lib/types'

const BLANK: NewProduct = {
  name: '', brand: 'UzBat', cost_price: 0, selling_price: 0,
  current_stock: 0, reorder_threshold: 10, barcode: '', active: true,
}

export default function Products() {
  const { products, brands, actor, toast } = useStore()

  const [q, setQ] = useState('')
  const [brand, setBrand] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return products
      .filter((p) => !brand || p.brand === brand)
      .filter((p) => !onlyLow || stockLevel(p) !== 'ok')
      .filter((p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.brand.toLowerCase().includes(needle) ||
        (p.barcode ?? '').includes(needle),
      )
  }, [products, q, brand, onlyLow])

  const lowCount = products.filter((p) => p.active && stockLevel(p) !== 'ok').length

  return (
    <Page
      title="Mahsulotlar"
      subtitle={`${num(products.length)} ta mahsulot · ${num(lowCount)} tasi kam qolgan`}
      actions={
        <>
          <button className="btn-ghost" onClick={() => setImportOpen(true)}>📄 Excel import</button>
          <button className="btn-ghost" onClick={() => exportProducts(products)} disabled={!products.length}>
            ⬇ Eksport
          </button>
          <button className="btn-primary" onClick={() => setEditing('new')}>+ Mahsulot</button>
        </>
      }
    >
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <input
          className="field flex-1 min-w-[12rem]"
          placeholder="Nomi yoki shtrix-kod bo'yicha qidirish…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="field w-40" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">Barcha brendlar</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <button
          onClick={() => setOnlyLow((v) => !v)}
          className={`btn ${onlyLow ? 'btn-primary' : 'btn-ghost'}`}
        >
          Faqat kam qolganlar
        </button>
      </div>

      {!products.length ? (
        <Empty
          title="Hali mahsulot yo'q"
          hint="Excel faylingizni import qiling — har bir varaq (UzBat, Parliament, Winston, Esse) brend sifatida o'qiladi."
          action={<button className="btn-primary" onClick={() => setImportOpen(true)}>Excel'dan import qilish</button>}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink-50 border-b border-ink-200">
                <tr>
                  <th className="th">Mahsulot</th>
                  <th className="th">Brend</th>
                  <th className="th text-right">Kelish</th>
                  <th className="th text-right">Sotish</th>
                  <th className="th text-right">Foyda/dona</th>
                  <th className="th text-right">Marja</th>
                  <th className="th text-right">Qoldiq</th>
                  <th className="th text-right">Qiymati</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((p) => {
                  const level = stockLevel(p)
                  const unitProfit = p.selling_price - p.cost_price
                  return (
                    <tr key={p.id} className={`hover:bg-ink-50 ${!p.active ? 'opacity-45' : ''}`}>
                      <td className="td font-medium max-w-[16rem] truncate" title={p.name}>
                        {p.name}
                        {!p.active && <span className="ml-2 chip bg-ink-100 text-ink-500">nofaol</span>}
                      </td>
                      <td className="td text-ink-500">{p.brand}</td>
                      <td className="td text-right num">{money(p.cost_price)}</td>
                      <td className="td text-right num">{money(p.selling_price)}</td>
                      <td className={`td text-right num font-medium ${unitProfit <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {money(unitProfit)}
                      </td>
                      <td className="td text-right"><MarginChip value={productMargin(p)} /></td>
                      <td className="td text-right">
                        <button onClick={() => setAdjusting(p)} title="Qoldiqni tuzatish">
                          <StockBadge level={level} stock={p.current_stock} />
                        </button>
                      </td>
                      <td className="td text-right num text-ink-500">{money(p.cost_price * p.current_stock)}</td>
                      <td className="td text-right">
                        <button
                          onClick={() => setEditing(p)}
                          className="text-xs font-semibold text-ink-500 hover:text-ink-900"
                        >
                          Tahrirlash
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="p-8 text-center text-sm text-ink-400">Filtrga mos mahsulot topilmadi</p>
          )}
        </div>
      )}

      {editing && (
        <ProductForm
          initial={editing === 'new' ? null : editing}
          brands={brands}
          actor={actor}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { toast(msg); setEditing(null) }}
          onError={(msg) => toast(msg, 'err')}
        />
      )}

      {adjusting && (
        <AdjustForm
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={(msg) => { toast(msg); setAdjusting(null) }}
          onError={(msg) => toast(msg, 'err')}
          actor={actor}
        />
      )}

      <ImportWizard open={importOpen} onClose={() => setImportOpen(false)} />
    </Page>
  )
}

function ProductForm({ initial, brands, actor, onClose, onSaved, onError }: {
  initial: Product | null
  brands: string[]
  actor: { name: string; role: 'admin' | 'cashier' }
  onClose: () => void
  onSaved: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [f, setF] = useState<NewProduct>(
    initial
      ? { ...initial }
      : BLANK,
  )
  const [newBrand, setNewBrand] = useState('')
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof NewProduct>(k: K, v: NewProduct[K]) => setF((p) => ({ ...p, [k]: v }))

  const brand = newBrand.trim() || f.brand
  const margin = marginPct(f.cost_price, f.selling_price)
  const unitProfit = f.selling_price - f.cost_price

  const save = async () => {
    if (!f.name.trim()) return onError('Mahsulot nomini kiriting')
    if (f.selling_price <= 0) return onError('Sotish narxini kiriting')
    setBusy(true)
    try {
      const payload = { ...f, name: f.name.trim(), brand, barcode: f.barcode?.trim() || '' }
      if (initial) {
        // current_stock stays out of the patch on purpose — stock moves only via the ledger.
        const { current_stock: _s, ...rest } = payload
        await updateProduct(initial.id, rest)
        onSaved('Mahsulot yangilandi')
      } else {
        await createProduct(payload, actor)
        onSaved("Mahsulot qo'shildi")
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!initial) return
    if (!confirm(`"${initial.name}" o'chirilsinmi? Amallar tarixi saqlanib qoladi.`)) return
    try {
      await deleteProduct(initial.id)
      onSaved("Mahsulot o'chirildi")
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Xatolik')
    }
  }

  return (
    <Modal open onClose={onClose} title={initial ? 'Mahsulotni tahrirlash' : "Yangi mahsulot"}>
      <div className="space-y-4">
        <div>
          <label className="label">Mahsulot nomi *</label>
          <input className="field" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </div>

        <div>
          <label className="label">Brend</label>
          <div className="flex gap-2">
            <select
              className="field flex-1"
              value={newBrand ? '' : f.brand}
              onChange={(e) => { set('brand', e.target.value); setNewBrand('') }}
              disabled={!!newBrand}
            >
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <input
              className="field flex-1"
              placeholder="yoki yangi brend…"
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Kelish narxi (so'm)</label>
            <input
              className="field num" inputMode="numeric" value={f.cost_price || ''}
              onChange={(e) => set('cost_price', parseNum(e.target.value))}
            />
          </div>
          <div>
            <label className="label">Sotish narxi (so'm) *</label>
            <input
              className="field num" inputMode="numeric" value={f.selling_price || ''}
              onChange={(e) => set('selling_price', parseNum(e.target.value))}
            />
          </div>
        </div>

        {/* The derived numbers, shown live — never typed. */}
        <div className="rounded-lg bg-ink-50 border border-ink-200 p-3 flex justify-between text-sm">
          <span className="text-ink-500">Foyda (dona)</span>
          <span className={`num font-semibold ${unitProfit <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
            {money(unitProfit)} · marja {margin.toFixed(1)}%
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">
              Boshlang'ich qoldiq {initial && <span className="text-ink-400 font-normal">(qulf)</span>}
            </label>
            <input
              className="field num" inputMode="numeric"
              value={f.current_stock || ''}
              disabled={!!initial}
              onChange={(e) => set('current_stock', Math.max(0, Math.round(parseNum(e.target.value))))}
            />
            {initial && (
              <p className="text-xs text-ink-400 mt-1">
                Qoldiq faqat kirim/sotuv orqali o'zgaradi.
              </p>
            )}
          </div>
          <div>
            <label className="label">Minimal zaxira</label>
            <input
              className="field num" inputMode="numeric" value={f.reorder_threshold || ''}
              onChange={(e) => set('reorder_threshold', Math.max(0, Math.round(parseNum(e.target.value))))}
            />
          </div>
        </div>

        <div>
          <label className="label">Shtrix-kod (ixtiyoriy)</label>
          <input className="field" value={f.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
          Faol (sotuvda ko'rinadi)
        </label>

        <div className="flex gap-2 pt-2">
          {initial && (
            <button className="btn-ghost text-red-600 hover:bg-red-50" onClick={remove}>O'chirish</button>
          )}
          <div className="flex-1" />
          <button className="btn-ghost" onClick={onClose}>Bekor</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saqlanmoqda…' : 'Saqlash'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function AdjustForm({ product, onClose, onDone, onError, actor }: {
  product: Product
  onClose: () => void
  onDone: (msg: string) => void
  onError: (msg: string) => void
  actor: { name: string; role: 'admin' | 'cashier' }
}) {
  const [stock, setStock] = useState(product.current_stock)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const delta = stock - product.current_stock

  const save = async () => {
    if (!reason.trim()) return onError('Sababni yozing (masalan: qayta sanaldi)')
    setBusy(true)
    try {
      await adjustStock(product, stock, actor, reason.trim())
      onDone('Qoldiq tuzatildi')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Qoldiqni tuzatish">
      <p className="text-sm text-ink-500 mb-4">
        <b>{product.name}</b> — hozirgi qoldiq: <b className="num">{num(product.current_stock)}</b> dona.
        Tuzatish amallar tarixida ko'rinadi.
      </p>
      <label className="label">Haqiqiy qoldiq</label>
      <input
        className="field num mb-1" inputMode="numeric" autoFocus
        value={stock}
        onChange={(e) => setStock(Math.max(0, Math.round(parseNum(e.target.value))))}
      />
      {delta !== 0 && (
        <p className={`text-xs font-semibold mb-3 ${delta > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          {delta > 0 ? '+' : ''}{num(delta)} dona
        </p>
      )}
      <label className="label mt-3">Sabab *</label>
      <input
        className="field" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="qayta sanaldi / shikastlangan / yo'qolgan"
      />
      <div className="flex gap-2 justify-end pt-5">
        <button className="btn-ghost" onClick={onClose}>Bekor</button>
        <button className="btn-primary" onClick={save} disabled={busy || delta === 0}>
          {busy ? 'Saqlanmoqda…' : 'Tuzatish'}
        </button>
      </div>
    </Modal>
  )
}

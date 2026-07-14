import { useMemo, useRef, useState, useEffect } from 'react'
import { useStore } from '../store'
import { commitCart, StockError } from '../lib/db'
import { money, num, parseNum } from '../lib/format'
import { stockLevel } from '../lib/analytics'
import { Page, StockBadge, Empty } from './ui'
import type { CartLine, Product, TxType } from '../lib/types'

interface Props {
  type: TxType
}

/**
 * The till. Sales and restocks are the same interaction — pick a product, set a
 * quantity, confirm — so they share one screen with different pricing defaults and
 * a different stock guard.
 */
export default function Counter({ type }: Props) {
  const { products, brands, actor, toast } = useStore()
  const isSale = type === 'SALE'

  const [q, setQ] = useState('')
  const [brand, setBrand] = useState('')
  const [lines, setLines] = useState<CartLine[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // What's literally typed in each quantity box, while it's being typed. Without this
  // the box is bound straight to the number, so clearing it to type a new one reads as
  // "quantity 0" and deletes the line out from under the cashier mid-keystroke.
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    // Barcode scanners type into whatever is focused, so keep the search box hot.
    searchRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return products
      .filter((p) => p.active)
      .filter((p) => !brand || p.brand === brand)
      .filter((p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.brand.toLowerCase().includes(needle) ||
        (p.barcode ?? '').includes(needle),
      )
      .slice(0, 40)
  }, [products, q, brand])

  // Stock shown in the picker must account for what's already sitting in the cart,
  // otherwise you can add the last carton twice and only find out on confirm.
  const inCart = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of lines) m.set(l.product.id, (m.get(l.product.id) ?? 0) + l.quantity)
    return m
  }, [lines])

  const add = (p: Product) => {
    const already = inCart.get(p.id) ?? 0
    if (isSale && already + 1 > p.current_stock) {
      toast(`"${p.name}" — omborda faqat ${p.current_stock} dona bor`, 'err')
      return
    }
    setLines((prev) => {
      const i = prev.findIndex((l) => l.product.id === p.id)
      if (i >= 0) {
        const next = [...prev]
        next[i] = { ...next[i], quantity: next[i].quantity + 1 }
        return next
      }
      return [
        ...prev,
        { product: p, quantity: 1, unit_price: isSale ? p.selling_price : p.cost_price },
      ]
    })
    setQ('')
    searchRef.current?.focus()
  }

  const setQty = (id: string, qty: number) => {
    setLines((prev) =>
      prev.flatMap((l) => {
        if (l.product.id !== id) return [l]
        if (qty <= 0) return []
        return [{ ...l, quantity: qty }]
      }),
    )
  }

  /** Typing in the quantity box. An empty or half-typed value leaves the line alone. */
  const typeQty = (id: string, raw: string) => {
    setQtyDraft((d) => ({ ...d, [id]: raw }))
    const n = Math.max(0, Math.round(parseNum(raw)))
    if (raw.trim() && n > 0) setQty(id, n)
  }

  /** Leaving the box: drop the draft so it snaps back to the real quantity. */
  const commitQty = (id: string) => {
    setQtyDraft((d) => {
      const { [id]: _gone, ...rest } = d
      return rest
    })
  }

  const clearCart = () => {
    setLines([])
    setQtyDraft({})
  }

  const setPrice = (id: string, price: number) => {
    setLines((prev) => prev.map((l) => (l.product.id === id ? { ...l, unit_price: price } : l)))
  }

  const total = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const expectedProfit = isSale
    ? lines.reduce((s, l) => s + (l.unit_price - l.product.cost_price) * l.quantity, 0)
    : 0
  const units = lines.reduce((s, l) => s + l.quantity, 0)

  const overStock = isSale
    ? lines.filter((l) => l.quantity > l.product.current_stock)
    : []

  const submit = async () => {
    if (!lines.length || busy) return
    setBusy(true)
    try {
      const res = await commitCart(type, lines, actor, note.trim())
      toast(
        isSale
          ? `Sotuv saqlandi — ${money(res.total)} (foyda ${money(res.profit)})`
          : `Kirim saqlandi — ${money(res.total)}`,
      )
      clearCart()
      setNote('')
      setQ('')
      searchRef.current?.focus()
    } catch (e) {
      const msg =
        e instanceof StockError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Saqlashda xatolik'
      toast(msg, 'err')
    } finally {
      setBusy(false)
    }
  }

  if (!products.length) {
    return (
      <Page title={isSale ? 'Sotuv' : 'Kirim'}>
        <Empty
          title="Avval mahsulot qo'shing"
          hint="Mahsulotlar bo'limiga o'ting yoki Excel faylingizni import qiling."
        />
      </Page>
    )
  }

  return (
    <Page
      title={isSale ? 'Sotuv' : 'Kirim'}
      subtitle={
        isSale
          ? "Mahsulotni tanlang, sonini kiriting va tasdiqlang. Qoldiq avtomatik kamayadi."
          : "Yangi kelgan tovarni kiriting. Qoldiq avtomatik oshadi."
      }
    >
      <div className="grid lg:grid-cols-[1fr_22rem] gap-5 items-start">
        {/* Picker */}
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-ink-200 space-y-2">
            <input
              ref={searchRef}
              className="field h-12 text-base"
              placeholder="Mahsulot nomi yoki shtrix-kod…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // A scanner ends its burst with Enter — take the single match.
                if (e.key === 'Enter' && results.length) add(results[0])
              }}
              inputMode="search"
              autoComplete="off"
            />
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              <button
                onClick={() => setBrand('')}
                className={`chip shrink-0 h-7 px-2.5 ${!brand ? 'bg-ink-950 text-white' : 'bg-ink-100 text-ink-600'}`}
              >
                Hammasi
              </button>
              {brands.map((b) => (
                <button
                  key={b}
                  onClick={() => setBrand(b === brand ? '' : b)}
                  className={`chip shrink-0 h-7 px-2.5 ${brand === b ? 'bg-ink-950 text-white' : 'bg-ink-100 text-ink-600'}`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[26rem] overflow-y-auto divide-y divide-ink-100">
            {results.map((p) => {
              // What's left on the shelf once the cart is accounted for. Clamped at 0:
              // the cart can ask for more than exists (we block that on confirm), but
              // showing a negative stock count would contradict the whole model.
              const left = Math.max(0, p.current_stock - (inCart.get(p.id) ?? 0))
              const blocked = isSale && left <= 0
              return (
                <button
                  key={p.id}
                  onClick={() => add(p)}
                  disabled={blocked}
                  className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-ink-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{p.name}</div>
                    <div className="text-xs text-ink-400">{p.brand}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold num">
                      {money(isSale ? p.selling_price : p.cost_price)}
                    </div>
                    <div className="text-xs text-ink-400 num">
                      qoldiq: <StockBadge level={stockLevel({ ...p, current_stock: left })} stock={left} />
                    </div>
                  </div>
                </button>
              )
            })}
            {!results.length && (
              <div className="p-8 text-center text-sm text-ink-400">Hech narsa topilmadi</div>
            )}
          </div>
        </div>

        {/* Cart */}
        <div className="card p-4 lg:sticky lg:top-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Savat</h2>
            {!!lines.length && (
              <button onClick={clearCart} className="text-xs font-semibold text-ink-400 hover:text-red-600">
                Tozalash
              </button>
            )}
          </div>

          {!lines.length ? (
            <p className="text-sm text-ink-400 py-6 text-center">
              Ro'yxatdan mahsulot tanlang
            </p>
          ) : (
            <div className="space-y-3 max-h-[22rem] overflow-y-auto -mx-1 px-1">
              {lines.map((l) => {
                const over = isSale && l.quantity > l.product.current_stock
                return (
                  <div key={l.product.id} className={`rounded-lg border p-2.5 ${over ? 'border-red-300 bg-red-50' : 'border-ink-200'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{l.product.name}</div>
                        <div className="text-xs text-ink-400">{l.product.brand}</div>
                      </div>
                      <button
                        onClick={() => setQty(l.product.id, 0)}
                        className="text-ink-300 hover:text-red-600 text-lg leading-none"
                        aria-label="O'chirish"
                      >
                        ×
                      </button>
                    </div>

                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex items-center rounded-lg border border-ink-200 bg-white h-9">
                        <button
                          onClick={() => setQty(l.product.id, l.quantity - 1)}
                          className="w-9 h-full text-ink-500 hover:text-ink-900 font-bold"
                        >
                          −
                        </button>
                        <input
                          className="w-12 h-full text-center text-sm font-semibold num outline-none"
                          value={qtyDraft[l.product.id] ?? String(l.quantity)}
                          onChange={(e) => typeQty(l.product.id, e.target.value)}
                          onBlur={() => commitQty(l.product.id)}
                          onFocus={(e) => e.target.select()}
                          inputMode="numeric"
                        />
                        <button
                          onClick={() => setQty(l.product.id, l.quantity + 1)}
                          className="w-9 h-full text-ink-500 hover:text-ink-900 font-bold"
                        >
                          +
                        </button>
                      </div>
                      <span className="text-xs text-ink-400">×</span>
                      <input
                        className="field h-9 flex-1 num text-right"
                        value={l.unit_price}
                        onChange={(e) => setPrice(l.product.id, parseNum(e.target.value))}
                        inputMode="numeric"
                        title={isSale ? 'Sotish narxi' : 'Kelish narxi'}
                      />
                    </div>

                    <div className="flex items-center justify-between mt-2 text-xs">
                      <span className={over ? 'text-red-600 font-semibold' : 'text-ink-400'}>
                        {over
                          ? `omborda ${num(l.product.current_stock)} dona bor`
                          : `qoldiq: ${num(l.product.current_stock)}`}
                      </span>
                      <span className="font-semibold num">{money(l.unit_price * l.quantity)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-ink-200 space-y-2">
            <input
              className="field"
              placeholder="Izoh (ixtiyoriy)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <div className="flex justify-between text-sm">
              <span className="text-ink-500">Soni</span>
              <span className="font-semibold num">{num(units)} dona</span>
            </div>
            {isSale && (
              <div className="flex justify-between text-sm">
                <span className="text-ink-500">Kutilayotgan foyda</span>
                <span className={`font-semibold num ${expectedProfit < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {money(expectedProfit)}
                </span>
              </div>
            )}
            <div className="flex justify-between items-baseline">
              <span className="text-sm text-ink-500">Jami</span>
              <span className="text-2xl font-bold num tracking-tight">{money(total)}</span>
            </div>

            {!!overStock.length && (
              <p className="text-xs text-red-600 font-semibold">
                Qoldiqdan ko'p sotib bo'lmaydi. Miqdorni kamaytiring yoki kirim qiling.
              </p>
            )}

            <button
              onClick={submit}
              disabled={!lines.length || busy || !!overStock.length}
              className={`w-full btn-lg ${isSale ? 'btn-primary' : 'btn bg-emerald-600 text-white hover:bg-emerald-700'}`}
            >
              {busy ? 'Saqlanmoqda…' : isSale ? 'Sotuvni tasdiqlash' : 'Kirimni tasdiqlash'}
            </button>
          </div>
        </div>
      </div>
    </Page>
  )
}

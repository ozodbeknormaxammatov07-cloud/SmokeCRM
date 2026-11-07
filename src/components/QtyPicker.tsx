import { useEffect, useRef, useState } from 'react'
import { money, num } from '../lib/format'
import { cleanCode } from '../lib/scanner'
import type { Product } from '../lib/types'

/**
 * "How many?" after a scan. Customers buy 5 or 10 packs at once; scanning each one is silly.
 *
 * Keys (no box needs to be clicked):
 *   digits      type the quantity (replaces it)      +  =  ↑   one more
 *   Backspace   delete a digit                        -  ↓      one less
 *   Enter       add to basket                         Esc       cancel
 * Scanning the next pack while this is open adds this one first and moves on; scanning the
 * SAME pack again just counts one more.
 *
 * The scanner and the keyboard both arrive as typed characters, so they're told apart by
 * shape: a quantity is at most 3 digits, a scan is a long code ending in Enter. If the cashier
 * types "10" and then scans without pressing Enter, the run is "10" + a barcode — split it so
 * the 10 isn't lost.
 */
export default function QtyPicker({
  product, unitPrice, isSale, left, isKnownCode, onConfirm, onCancel, onNextScan,
}: {
  product: Product
  unitPrice: number
  isSale: boolean
  /** Sale: packs still available after what's already in the basket. Restock: Infinity. */
  left: number
  isKnownCode: (code: string) => boolean
  onConfirm: (qty: number) => void
  onCancel: () => void
  /** Another code arrived: add this product with `qty`, then handle `code`. */
  onNextScan: (code: string, qty: number) => void
}) {
  const [qty, setQty] = useState(1)
  const [typed, setTyped] = useState('') // current run of typed characters
  const before = useRef(1)               // qty when the current typed run started
  const inputRef = useRef<HTMLInputElement>(null)

  const clamp = (n: number) => Math.max(1, Math.min(9999, Math.round(n) || 1))
  const over = isSale && qty > left

  // The key handler reads and writes these refs directly, NOT the React state: a scanner sends
  // characters faster than React re-renders, and state read inside the handler would be stale —
  // two fast keys both looked like "the first key", and the second replaced the first.
  const st = useRef({ qty: 1, typed: '' })
  const setRun = (typedNext: string, qtyNext: number) => {
    st.current = { qty: qtyNext, typed: typedNext }
    setTyped(typedNext)
    setQty(qtyNext)
  }

  const step = (d: number) => setRun('', clamp(st.current.qty + d))

  /** Split a typed run that turned out to contain a scan: [quantity or null, code]. */
  const splitRun = (run: string): [number | null, string] => {
    for (let k = 0; k <= 3 && k < run.length; k++) {
      const rest = run.slice(k)
      if (isKnownCode(rest) && /^\d*$/.test(run.slice(0, k))) {
        return [k ? Number(run.slice(0, k)) : null, rest]
      }
    }
    return [null, run]
  }

  const finish = () => {
    const { qty: q, typed: run } = st.current
    if (run.length >= 6) {
      // The run was a scan of the next product.
      const [typedQty, code] = splitRun(run)
      const thisQty = typedQty ?? before.current
      if (cleanCode(code) === cleanCode(product.barcode ?? '')) {
        // Same pack scanned again → one more.
        setRun('', clamp(thisQty + 1))
        return
      }
      onNextScan(code, thisQty)
      return
    }
    if (isSale && q > left) return
    onConfirm(q)
  }

  useEffect(() => {
    // Nothing behind the popup should receive the keys (the search box often still has focus).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== inputRef.current) {
      document.activeElement.blur()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const inBox = document.activeElement === inputRef.current
      const run = st.current.typed

      if (e.key === 'Enter' || e.code === 'NumpadEnter' || (e.key === 'Tab' && run.length >= 6)) {
        e.preventDefault(); e.stopPropagation(); finish(); return
      }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return }
      if (inBox) return // typing in the number box: let the box handle it

      // + / - only mean "step" outside a scan (a DataMatrix code can contain them).
      if (run.length < 4 && (e.key === '+' || e.key === '=' || e.key === 'ArrowUp' || e.code === 'NumpadAdd')) {
        e.preventDefault(); step(1); return
      }
      if (run.length < 4 && (e.key === '-' || e.key === 'ArrowDown' || e.code === 'NumpadSubtract')) {
        e.preventDefault(); step(-1); return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        const next = run.slice(0, -1)
        setRun(next, next && next.length <= 3 ? clamp(Number(next)) : before.current)
        return
      }
      const ch = e.key.length === 1 ? e.key
        : (/^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? '')
      if (!ch) return
      e.preventDefault()
      if (!run) before.current = st.current.qty
      const next = run + ch
      // Up to 3 digits it's a quantity; longer, it's a scan and the quantity stays put.
      setRun(next, next.length <= 3 && /^\d+$/.test(next) ? clamp(Number(next)) : before.current)
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-ink-950/40 flex items-end sm:items-center justify-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-xl shadow-xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold leading-snug">{product.name}</div>
            <div className="text-xs text-ink-400 mt-0.5">
              {product.brand} · {money(unitPrice)}
              {isSale && <> · omborda {num(left)}</>}
            </div>
          </div>
          <button onClick={onCancel} className="text-ink-400 hover:text-ink-900 text-2xl leading-none px-1 -mt-1" aria-label="Bekor">×</button>
        </div>

        <div className="flex items-center justify-center gap-3 mt-5">
          <button onClick={() => step(-1)} disabled={qty <= 1}
            className="w-16 h-16 rounded-2xl bg-ink-100 text-3xl font-bold text-ink-700 active:bg-ink-200 disabled:opacity-30">−</button>
          <input
            ref={inputRef}
            value={typed && typed.length <= 3 && Number(typed) > 0 ? typed : String(qty)}
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, '').slice(0, 4)
              setRun('', d ? clamp(Number(d)) : 1)
            }}
            onFocus={(e) => e.target.select()}
            inputMode="numeric"
            aria-label="Soni"
            className={`w-28 h-16 text-center text-4xl font-bold num rounded-2xl border-2 outline-none ${over ? 'border-red-400 text-red-600' : 'border-ink-200 focus:border-ink-900'}`}
          />
          <button onClick={() => step(1)} disabled={isSale && qty >= left}
            className="w-16 h-16 rounded-2xl bg-ink-100 text-3xl font-bold text-ink-700 active:bg-ink-200 disabled:opacity-30">+</button>
        </div>

        <div className="grid grid-cols-5 gap-2 mt-4">
          {[1, 2, 5, 10, 20].map((n) => (
            <button key={n} onClick={() => setRun('', n)}
              disabled={isSale && n > left}
              className={`h-11 rounded-xl text-sm font-semibold disabled:opacity-30 ${qty === n ? 'bg-ink-950 text-white' : 'bg-ink-50 border border-ink-200 text-ink-700'}`}>
              {n}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mt-4 text-sm">
          <span className={over ? 'text-red-600 font-semibold' : 'text-ink-500'}>
            {over ? `Omborda faqat ${num(left)} dona` : `${num(qty)} × ${money(unitPrice)}`}
          </span>
          <span className="font-bold num">{money(qty * unitPrice)}</span>
        </div>

        <button onClick={finish} disabled={over}
          className={`w-full btn-lg mt-4 ${isSale ? 'btn-primary' : 'btn bg-emerald-600 text-white hover:bg-emerald-700'}`}>
          Savatga qo'shish
        </button>
        <p className="hidden sm:block text-center text-xs text-ink-400 mt-2">
          Raqam yozing · <b>+</b> / <b>−</b> · <b>Enter</b> — qo'shish · <b>Esc</b> — bekor · keyingisini skanerlasangiz o'zi qo'shiladi
        </p>
      </div>
    </div>
  )
}

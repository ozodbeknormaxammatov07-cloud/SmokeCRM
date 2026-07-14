import {
  STORES, tx, get, put, del, getAll, getAllByRange, subscribe, notify, newId, openDb, DB_NAME,
} from './idb'
import type { Product, NewProduct, Transaction, TxType, Supplier, CartLine, User } from './types'

interface Actor {
  name: string
  role: User['role']
}

export class StockError extends Error {
  constructor(public product: string, public available: number, public wanted: number) {
    super(`"${product}" — omborda ${available} dona bor, ${wanted} dona so'ralmoqda`)
    this.name = 'StockError'
  }
}

/**
 * IndexedDB has no live queries, so a "watch" is: run the query now, then re-run it
 * whenever a write commits. Cheap at shop scale (hundreds of products, thousands of rows).
 */
function watch<T>(query: () => Promise<T>, cb: (rows: T) => void): () => void {
  let alive = true
  const run = () => {
    void query().then((r) => { if (alive) cb(r) })
  }
  run()
  const off = subscribe(run)
  return () => { alive = false; off() }
}

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

const allProducts = (): Promise<Product[]> =>
  tx([STORES.products], 'readonly', (t) => getAll<Product>(t, STORES.products)).then((rows) =>
    rows.sort((a, b) => a.name.localeCompare(b.name)),
  )

export function watchProducts(cb: (rows: Product[]) => void): () => void {
  return watch(allProducts, cb)
}

/**
 * Opening stock is posted as a RESTOCK row, exactly as `importProducts` does it — otherwise
 * this path could conjure inventory that no ledger row accounts for, and the shelf would be
 * worth more than anything the shop was ever recorded as buying.
 */
export async function createProduct(p: NewProduct, actor: Actor): Promise<string> {
  const id = newId()
  const now = Date.now()

  await tx([STORES.products, STORES.transactions], 'readwrite', async (t) => {
    await put(t, STORES.products, { ...p, id, created_at: now, updated_at: now })

    if (p.current_stock > 0) {
      await put(t, STORES.transactions, {
        id: newId(),
        ts: now,
        type: 'RESTOCK' as TxType,
        product_id: id,
        product_name: p.name,
        brand: p.brand,
        quantity: p.current_stock,
        unit_price: p.cost_price,
        cost_price: p.cost_price,
        total_amount: p.current_stock * p.cost_price,
        profit: 0,
        note: "Boshlang'ich qoldiq",
        user_name: actor.name,
        user_role: actor.role,
        ref_id: newId(),
        voided: false,
      } satisfies Transaction)
    }
  })

  notify()
  return id
}

/**
 * `current_stock` is not editable here. Stock only ever moves through the ledger, so
 * a typo — or a careless caller — can't silently invent inventory.
 * Use `adjustStock` for corrections; it writes an auditable row.
 *
 * The type already forbids it, but types are erased at runtime and this function is
 * the last line of defence for the invariant the whole system rests on, so strip the
 * field for real rather than trusting every future caller to.
 */
export async function updateProduct(
  id: string,
  patch: Partial<Omit<Product, 'id' | 'current_stock'>>,
): Promise<void> {
  await tx([STORES.products], 'readwrite', async (t) => {
    const cur = await get<Product>(t, STORES.products, id)
    if (!cur) throw new Error('Mahsulot topilmadi')

    const { id: _id, current_stock: _stock, created_at: _created, ...safe } =
      patch as Partial<Product>

    await put(t, STORES.products, { ...cur, ...safe, updated_at: Date.now() })
  })
  notify()
}

export async function deleteProduct(id: string): Promise<void> {
  await tx([STORES.products], 'readwrite', (t) => del(t, STORES.products, id))
  notify()
}

/* ------------------------------------------------------------------ */
/* Transactions (append-only ledger)                                   */
/* ------------------------------------------------------------------ */

/**
 * Commits a whole basket (sale or restock) in one atomic IndexedDB transaction:
 * either every line posts and every stock count moves, or nothing does.
 *
 * For a SALE this re-reads stock inside the transaction and throws StockError if a
 * line would drive stock negative, so a double-tapped confirm cannot oversell.
 */
export async function commitCart(
  type: TxType,
  lines: CartLine[],
  actor: Actor,
  note = '',
): Promise<{ ref_id: string; total: number; profit: number }> {
  if (!lines.length) throw new Error("Savat bo'sh")

  const ref_id = newId()
  const ts = Date.now()

  const result = await tx([STORES.products, STORES.transactions], 'readwrite', async (t) => {
    // Merge duplicate lines so a product picked twice is validated against its
    // combined quantity, not each line independently.
    const wanted = new Map<string, number>()
    for (const l of lines) {
      if (l.quantity <= 0) throw new Error(`"${l.product.name}" — miqdor 0 dan katta bo'lishi kerak`)
      wanted.set(l.product.id, (wanted.get(l.product.id) ?? 0) + l.quantity)
    }

    const fresh = new Map<string, Product>()
    for (const pid of wanted.keys()) {
      const p = await get<Product>(t, STORES.products, pid)
      if (!p) throw new Error("Mahsulot topilmadi (o'chirilgan bo'lishi mumkin)")
      fresh.set(pid, p)
    }

    for (const [pid, qty] of wanted) {
      const p = fresh.get(pid)!
      const next = p.current_stock + (type === 'SALE' ? -qty : qty)
      if (next < 0) throw new StockError(p.name, p.current_stock, qty)

      const updated: Product = { ...p, current_stock: next, updated_at: ts }
      // A restock at a new cost becomes the product's cost going forward.
      if (type === 'RESTOCK') {
        const line = lines.find((l) => l.product.id === pid)!
        if (line.unit_price > 0 && line.unit_price !== p.cost_price) {
          updated.cost_price = line.unit_price
        }
      }
      await put(t, STORES.products, updated)
    }

    let total = 0
    let profit = 0
    for (const l of lines) {
      const p = fresh.get(l.product.id)!
      const lineTotal = l.unit_price * l.quantity
      // Profit is derived here and nowhere else — it is never user-entered.
      // cost_price is snapshotted so repricing later can't rewrite past profit.
      const lineProfit = type === 'SALE' ? (l.unit_price - p.cost_price) * l.quantity : 0
      total += lineTotal
      profit += lineProfit

      await put(t, STORES.transactions, {
        id: newId(),
        ts,
        type,
        product_id: p.id,
        product_name: p.name,
        brand: p.brand,
        quantity: l.quantity,
        unit_price: l.unit_price,
        cost_price: p.cost_price,
        total_amount: lineTotal,
        profit: lineProfit,
        note,
        user_name: actor.name,
        user_role: actor.role,
        ref_id,
        voided: false,
      } satisfies Transaction)
    }

    return { ref_id, total, profit }
  })

  notify()
  return result
}

/**
 * History is append-only: a mistake is corrected by posting an opposite entry and
 * flagging the original, never by deleting it. The audit trail always shows what
 * was entered, what was reversed, and by whom.
 */
export async function voidTransaction(t0: Transaction, actor: Actor): Promise<void> {
  if (t0.voided) throw new Error('Bu amal allaqachon bekor qilingan')

  await tx([STORES.products, STORES.transactions], 'readwrite', async (t) => {
    const original = await get<Transaction>(t, STORES.transactions, t0.id)
    if (!original) throw new Error('Yozuv topilmadi')
    if (original.voided) throw new Error('Bu amal allaqachon bekor qilingan')

    // Reversing a SALE returns stock; reversing a RESTOCK removes it.
    const delta = original.type === 'SALE' ? original.quantity : -original.quantity
    const p = await get<Product>(t, STORES.products, original.product_id)
    if (p) {
      const next = p.current_stock + delta
      if (next < 0) throw new StockError(original.product_name, p.current_stock, original.quantity)
      await put(t, STORES.products, { ...p, current_stock: next, updated_at: Date.now() })
    }

    await put(t, STORES.transactions, { ...original, voided: true })
    await put(t, STORES.transactions, {
      id: newId(),
      ts: Date.now(),
      type: original.type,
      product_id: original.product_id,
      product_name: original.product_name,
      brand: original.brand,
      quantity: -original.quantity,
      unit_price: original.unit_price,
      cost_price: original.cost_price,
      total_amount: -original.total_amount,
      profit: -original.profit,
      note: `BEKOR QILINDI: ${original.note || '—'}`,
      user_name: actor.name,
      user_role: actor.role,
      ref_id: original.ref_id,
      voided: false,
      reversal_of: original.id,
    } satisfies Transaction)
  })

  notify()
}

/** Manual stock correction (breakage, recount). Posts a visible ledger row. */
export async function adjustStock(
  product: Product,
  newStock: number,
  actor: Actor,
  reason: string,
): Promise<void> {
  await tx([STORES.products, STORES.transactions], 'readwrite', async (t) => {
    const p = await get<Product>(t, STORES.products, product.id)
    if (!p) throw new Error('Mahsulot topilmadi')
    const delta = newStock - p.current_stock
    if (delta === 0) return

    await put(t, STORES.products, { ...p, current_stock: newStock, updated_at: Date.now() })
    await put(t, STORES.transactions, {
      id: newId(),
      ts: Date.now(),
      type: 'RESTOCK' as TxType,
      product_id: p.id,
      product_name: p.name,
      brand: p.brand,
      quantity: delta,
      unit_price: p.cost_price,
      cost_price: p.cost_price,
      total_amount: delta * p.cost_price,
      profit: 0,
      note: `Qoldiq tuzatildi: ${reason}`,
      user_name: actor.name,
      user_role: actor.role,
      ref_id: newId(),
      voided: false,
    } satisfies Transaction)
  })

  notify()
}

const rangeQuery = (fromTs: number, toTs: number): Promise<Transaction[]> =>
  tx([STORES.transactions], 'readonly', (t) =>
    getAllByRange<Transaction>(t, STORES.transactions, 'ts', IDBKeyRange.bound(fromTs, toTs)),
  ).then((rows) => rows.sort((a, b) => b.ts - a.ts))

export function watchTransactions(
  fromTs: number,
  toTs: number,
  cb: (rows: Transaction[]) => void,
): () => void {
  return watch(() => rangeQuery(fromTs, toTs), cb)
}

export function watchRecentTransactions(n: number, cb: (rows: Transaction[]) => void): () => void {
  return watch(() => fetchAllTransactions().then((rows) => rows.slice(0, n)), cb)
}

export const fetchTransactions = rangeQuery

export const fetchAllTransactions = (): Promise<Transaction[]> =>
  tx([STORES.transactions], 'readonly', (t) => getAll<Transaction>(t, STORES.transactions)).then(
    (rows) => rows.sort((a, b) => b.ts - a.ts),
  )

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export function watchSuppliers(cb: (rows: Supplier[]) => void): () => void {
  return watch(
    () =>
      tx([STORES.suppliers], 'readonly', (t) => getAll<Supplier>(t, STORES.suppliers)).then((rows) =>
        rows.sort((a, b) => a.name.localeCompare(b.name)),
      ),
    cb,
  )
}

export async function saveSupplier(s: Omit<Supplier, 'id'> & { id?: string }): Promise<void> {
  await tx([STORES.suppliers], 'readwrite', (t) =>
    put(t, STORES.suppliers, { ...s, id: s.id ?? newId() }),
  )
  notify()
}

export async function deleteSupplier(id: string): Promise<void> {
  await tx([STORES.suppliers], 'readwrite', (t) => del(t, STORES.suppliers, id))
  notify()
}

/* ------------------------------------------------------------------ */
/* Bulk import                                                         */
/* ------------------------------------------------------------------ */

/**
 * Imports the initial product list. Opening stock is posted as a RESTOCK row per
 * product rather than written straight onto the product, so day-one inventory has
 * the same audit trail as everything after it.
 */
export async function importProducts(
  rows: NewProduct[],
  actor: Actor,
): Promise<{ imported: number }> {
  const ts = Date.now()

  const imported = await tx([STORES.products, STORES.transactions], 'readwrite', async (t) => {
    let n = 0
    for (const r of rows) {
      const id = newId()
      await put(t, STORES.products, { ...r, id, created_at: ts, updated_at: ts } satisfies Product)

      if (r.current_stock > 0) {
        await put(t, STORES.transactions, {
          id: newId(),
          ts,
          type: 'RESTOCK' as TxType,
          product_id: id,
          product_name: r.name,
          brand: r.brand,
          quantity: r.current_stock,
          unit_price: r.cost_price,
          cost_price: r.cost_price,
          total_amount: r.current_stock * r.cost_price,
          profit: 0,
          note: "Excel import — boshlang'ich qoldiq",
          user_name: actor.name,
          user_role: actor.role,
          ref_id: 'import',
          voided: false,
        } satisfies Transaction)
      }
      n++
    }
    return n
  })

  notify()
  return { imported }
}

/* ------------------------------------------------------------------ */
/* Backup / restore                                                    */
/* ------------------------------------------------------------------ */

export interface Backup {
  format: 'tamaki-savdo'
  version: 1
  exported_at: number
  products: Product[]
  transactions: Transaction[]
  suppliers: Supplier[]
}

export async function exportBackup(): Promise<Backup> {
  const [products, transactions, suppliers] = await Promise.all([
    allProducts(),
    fetchAllTransactions(),
    tx([STORES.suppliers], 'readonly', (t) => getAll<Supplier>(t, STORES.suppliers)),
  ])
  return {
    format: 'tamaki-savdo',
    version: 1,
    exported_at: Date.now(),
    products,
    transactions,
    suppliers,
  }
}

/**
 * Replaces everything with the contents of a backup file. Destructive by design —
 * this is the "my laptop died" path, so callers must confirm first.
 */
export async function restoreBackup(b: Backup): Promise<{ products: number; transactions: number }> {
  if (b?.format !== 'tamaki-savdo' || !Array.isArray(b.products) || !Array.isArray(b.transactions)) {
    throw new Error("Bu fayl zaxira nusxa emas (noto'g'ri format)")
  }

  await tx([STORES.products, STORES.transactions, STORES.suppliers], 'readwrite', async (t) => {
    for (const s of [STORES.products, STORES.transactions, STORES.suppliers]) {
      await new Promise<void>((res, rej) => {
        const r = t.objectStore(s).clear()
        r.onsuccess = () => res()
        r.onerror = () => rej(r.error)
      })
    }
    for (const p of b.products) await put(t, STORES.products, p)
    for (const x of b.transactions) await put(t, STORES.transactions, x)
    for (const s of b.suppliers ?? []) await put(t, STORES.suppliers, s)
  })

  notify()
  return { products: b.products.length, transactions: b.transactions.length }
}

/** Confirms the browser can actually persist. Called once at startup. */
export async function initDb(): Promise<void> {
  await openDb()
  // Ask the browser not to evict us under storage pressure. Best-effort: Chrome
  // grants it silently for installed//frequently-used origins, others just say no.
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported — data still persists, it's just evictable in theory */
  }
}

export { DB_NAME }

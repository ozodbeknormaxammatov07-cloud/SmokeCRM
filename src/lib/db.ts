import {
  STORES, tx, get, put, getAll, getAllByRange, subscribe, notify, newId, openDb, DB_NAME,
  clearAllStores, bulkPut, type Txn,
} from './idb'
import type {
  Product, NewProduct, Transaction, TxType, Supplier, CartLine, User,
  PurchaseOrder, Delivery, Payment, SalePaymentMethod, CashMovement,
} from './types'

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

/**
 * The signed effect of one ledger row on stock.
 *
 * Voided rows are NOT skipped: a void writes an opposite-signed twin, so original and twin
 * cancel to zero on their own. Skipping the original would apply the twin alone and silently
 * invent stock — the same double-counting trap the reports fell into.
 */
const stockDelta = (t: Transaction): number => (t.type === 'SALE' ? -t.quantity : t.quantity)

/**
 * Recomputes a product's stock from its ledger rows. This is the ONLY thing allowed to write
 * `current_stock`: it is a cache of the ledger, and the ledger is the truth.
 *
 * Must be called inside a transaction that already covers both stores, so the recomputed
 * value cannot be read between the ledger write and the cache update.
 */
export async function recomputeStock(t: Txn, productId: string): Promise<number> {
  const rows = await getAllByRange<Transaction>(
    t, STORES.transactions, 'product_id', IDBKeyRange.only(productId),
  )
  const stock = rows.reduce((s, r) => s + stockDelta(r), 0)

  const p = await get<Product>(t, STORES.products, productId)
  if (p && p.current_stock !== stock) {
    await put(t, STORES.products, { ...p, current_stock: stock })
  }
  return stock
}

const allProducts = (): Promise<Product[]> =>
  tx([STORES.products], 'readonly', (t) => getAll<Product>(t, STORES.products)).then((rows) =>
    rows
      .filter((p) => !p.deleted_at) // tombstones stay in the store, out of the UI
      .sort((a, b) => a.name.localeCompare(b.name)),
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
    // Stock starts at zero and is derived from the opening RESTOCK row below.
    await put(t, STORES.products, { ...p, id, current_stock: 0, created_at: now, updated_at: now })

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

      await recomputeStock(t, id)
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

/**
 * Soft delete. The row survives as a tombstone so the deletion can replicate: a hard delete
 * is indistinguishable, to the other device, from a product it created and we haven't pulled
 * yet — and "it's missing, so remove it" is how two devices delete each other's work.
 */
export async function deleteProduct(id: string): Promise<void> {
  await tx([STORES.products], 'readwrite', async (t) => {
    const cur = await get<Product>(t, STORES.products, id)
    if (!cur) return
    const now = Date.now()
    await put(t, STORES.products, { ...cur, deleted_at: now, updated_at: now })
  })
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
  payment: SalePaymentMethod = 'cash',
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

    // Guard against overselling BEFORE anything is written. The cached stock is read inside
    // this transaction, so a double-tapped confirm cannot slip between the check and the write.
    for (const [pid, qty] of wanted) {
      const p = fresh.get(pid)!
      if (p.current_stock + (type === 'SALE' ? -qty : qty) < 0) {
        throw new StockError(p.name, p.current_stock, qty)
      }

      // A restock at a new cost becomes the product's cost going forward.
      if (type === 'RESTOCK') {
        const line = lines.find((l) => l.product.id === pid)!
        if (line.unit_price > 0 && line.unit_price !== p.cost_price) {
          await put(t, STORES.products, { ...p, cost_price: line.unit_price, updated_at: ts })
        }
      }
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
        // Only a SALE carries a payment method; a RESTOCK's money doesn't hit the drawer.
        payment_method: type === 'SALE' ? payment : undefined,
      } satisfies Transaction)
    }

    // Stock is derived: now that the ledger rows exist, the cache follows from them.
    for (const pid of wanted.keys()) await recomputeStock(t, pid)

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

    // Reversing a SALE returns stock; reversing a RESTOCK removes it — and removing it must
    // not drive the shelf negative.
    const delta = original.type === 'SALE' ? original.quantity : -original.quantity
    const p = await get<Product>(t, STORES.products, original.product_id)
    if (p && p.current_stock + delta < 0) {
      throw new StockError(original.product_name, p.current_stock, original.quantity)
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

    await recomputeStock(t, original.product_id)
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

    // The correction is posted as a ledger row and the stock follows from it — writing the
    // count straight onto the product would put it back out of step with its own history.
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

    await recomputeStock(t, p.id)
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
        rows.filter((s) => !s.deleted_at).sort((a, b) => a.name.localeCompare(b.name)),
      ),
    cb,
  )
}

export async function saveSupplier(s: Omit<Supplier, 'id'> & { id?: string }): Promise<void> {
  await tx([STORES.suppliers], 'readwrite', (t) =>
    put(t, STORES.suppliers, { ...s, id: s.id ?? newId(), updated_at: Date.now() }),
  )
  notify()
}

/** Soft delete, for the same reason products are: see `deleteProduct`. */
export async function deleteSupplier(id: string): Promise<void> {
  await tx([STORES.suppliers], 'readwrite', async (t) => {
    const cur = await get<Supplier>(t, STORES.suppliers, id)
    if (!cur) return
    const now = Date.now()
    await put(t, STORES.suppliers, { ...cur, deleted_at: now, updated_at: now })
  })
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
      await put(t, STORES.products, {
        ...r, id, current_stock: 0, created_at: ts, updated_at: ts,
      } satisfies Product)

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

        await recomputeStock(t, id)
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
  version: 2
  exported_at: number
  products: Product[]
  transactions: Transaction[]
  suppliers: Supplier[]
  purchase_orders: PurchaseOrder[]
  deliveries: Delivery[]
  payments: Payment[]
  cash_movements: CashMovement[]
}

export async function exportBackup(): Promise<Backup> {
  const [products, transactions, rest] = await Promise.all([
    allProducts(),
    fetchAllTransactions(),
    tx(
      [STORES.suppliers, STORES.purchase_orders, STORES.deliveries, STORES.payments,
        STORES.cash_movements],
      'readonly',
      async (t) => ({
        suppliers: await getAll<Supplier>(t, STORES.suppliers),
        purchase_orders: await getAll<PurchaseOrder>(t, STORES.purchase_orders),
        deliveries: await getAll<Delivery>(t, STORES.deliveries),
        payments: await getAll<Payment>(t, STORES.payments),
        cash_movements: await getAll<CashMovement>(t, STORES.cash_movements),
      }),
    ),
  ])
  return {
    format: 'tamaki-savdo',
    version: 2,
    exported_at: Date.now(),
    products,
    transactions,
    ...rest,
  }
}

const BACKUP_STORES = [
  STORES.products, STORES.transactions, STORES.suppliers,
  STORES.purchase_orders, STORES.deliveries, STORES.payments, STORES.cash_movements,
]

/**
 * Wipes every business store — products, the whole ledger, firms, orders, deliveries,
 * payments — leaving staff accounts (the `users` store) untouched so the admin doing the reset
 * stays signed in.
 *
 * Destructive and irreversible, and it clears the shared cloud database for the WHOLE shop, not
 * just this device: callers MUST confirm first. Intended for "start a fresh test", so it
 * deliberately does not export a backup first.
 */
export async function resetAllData(): Promise<void> {
  await clearAllStores(BACKUP_STORES)
}

/**
 * Replaces everything with the contents of a backup file. Destructive by design —
 * this is the "my laptop died" path, so callers must confirm first.
 *
 * A version-1 file restores too: it simply carries no procurement arrays, and those stores come
 * back empty (`?? []` below is what makes that work rather than throwing on a missing key).
 * Refusing an old backup would mean this upgrade stranded the owner's only copy of their data.
 */
export async function restoreBackup(b: Backup): Promise<{
  products: number
  transactions: number
  deliveries: number
  payments: number
}> {
  if (b?.format !== 'tamaki-savdo' || !Array.isArray(b.products) || !Array.isArray(b.transactions)) {
    throw new Error("Bu fayl zaxira nusxa emas (noto'g'ri format)")
  }

  await clearAllStores(BACKUP_STORES)
  await bulkPut(STORES.products, b.products)
  await bulkPut(STORES.transactions, b.transactions)
  await bulkPut(STORES.suppliers, b.suppliers ?? [])
  await bulkPut(STORES.purchase_orders, b.purchase_orders ?? [])
  await bulkPut(STORES.deliveries, b.deliveries ?? [])
  await bulkPut(STORES.payments, b.payments ?? [])
  await bulkPut(STORES.cash_movements, b.cash_movements ?? [])

  return {
    products: b.products.length,
    transactions: b.transactions.length,
    deliveries: (b.deliveries ?? []).length,
    payments: (b.payments ?? []).length,
  }
}

/* ------------------------------------------------------------------ */
/* Sync: snapshot out, merge in                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything this device holds, tombstones included. `exportBackup` hides deleted products
 * because a human reading a backup shouldn't see them; sync must see them, or a deletion made
 * here would never reach the other device.
 */
export interface SyncSnapshot {
  products: Product[]
  transactions: Transaction[]
  suppliers: Supplier[]
  purchase_orders: PurchaseOrder[]
  deliveries: Delivery[]
  payments: Payment[]
  cash_movements: CashMovement[]
}

export async function snapshotForSync(): Promise<SyncSnapshot> {
  return tx(BACKUP_STORES, 'readonly', async (t) => ({
    products: await getAll<Product>(t, STORES.products),
    transactions: await getAll<Transaction>(t, STORES.transactions),
    suppliers: await getAll<Supplier>(t, STORES.suppliers),
    purchase_orders: await getAll<PurchaseOrder>(t, STORES.purchase_orders),
    deliveries: await getAll<Delivery>(t, STORES.deliveries),
    payments: await getAll<Payment>(t, STORES.payments),
    cash_movements: await getAll<CashMovement>(t, STORES.cash_movements),
  }))
}

/**
 * Merges rows from another device into this one. Returns how many rows actually changed, so
 * a no-op sync doesn't wake the whole UI up.
 *
 * The merge rules are what make two devices safe to run at once:
 *
 * - Transactions are append-only and immutable, so an id that already exists is the same row.
 *   The one mutable bit is `voided`, and it only ever goes false -> true — so it merges with
 *   OR. Last-write-wins on a void would let a stale device un-cancel a cancelled sale.
 *
 * - Products are last-write-wins on `updated_at`. A tombstone is just another update, so a
 *   delete propagates like any other edit rather than by absence.
 *
 * - `current_stock` on an incoming product is IGNORED. It's a cache of that device's view of
 *   the ledger, and this device's ledger is about to differ. Stock is recomputed from the
 *   merged rows instead, which is the whole reason it's derived.
 *
 * - Deliveries and payments are MONEY, so they follow the transaction rules exactly: append-only,
 *   with `voided` merging by OR. Orders are intentions, not money, so they follow the product
 *   rules: last-write-wins with a tombstone.
 */
export async function mergeRemote(remote: SyncSnapshot): Promise<number> {
  let changed = 0

  await tx(BACKUP_STORES, 'readwrite', async (t) => {
    const touched = new Set<string>()

    for (const r of remote.transactions) {
      const cur = await get<Transaction>(t, STORES.transactions, r.id)
      // Once voided, always voided — never let an older copy resurrect a cancelled sale.
      const voided = Boolean(cur?.voided) || Boolean(r.voided)
      if (cur && Boolean(cur.voided) === voided) continue

      await put(t, STORES.transactions, { ...r, voided })
      touched.add(r.product_id)
      changed++
    }

    for (const r of remote.products) {
      const cur = await get<Product>(t, STORES.products, r.id)
      if (cur && (cur.updated_at ?? 0) >= (r.updated_at ?? 0)) continue

      // Keep OUR stock cache; it is rebuilt from the ledger below regardless.
      await put(t, STORES.products, { ...r, current_stock: cur?.current_stock ?? 0 })
      touched.add(r.id)
      changed++
    }

    for (const r of remote.suppliers ?? []) {
      const cur = await get<Supplier>(t, STORES.suppliers, r.id)
      if (cur && (cur.updated_at ?? 0) >= (r.updated_at ?? 0)) continue
      await put(t, STORES.suppliers, r)
      changed++
    }

    // An order is a mutable intention, not money: last-write-wins, exactly like a product.
    // A lost concurrent edit to an order is annoying; it cannot corrupt a balance.
    for (const r of remote.purchase_orders ?? []) {
      const cur = await get<PurchaseOrder>(t, STORES.purchase_orders, r.id)
      if (cur && (cur.updated_at ?? 0) >= (r.updated_at ?? 0)) continue
      await put(t, STORES.purchase_orders, r)
      changed++
    }

    // Deliveries and payments ARE money, so they get the ledger treatment: append-only, so an
    // id that already exists is the same row. The one mutable bit is `voided`, and it only ever
    // goes false -> true — hence OR. Last-write-wins on a void would let a stale device
    // un-cancel a cancelled delivery and silently re-create a debt the shop already settled.
    for (const r of remote.deliveries ?? []) {
      const cur = await get<Delivery>(t, STORES.deliveries, r.id)
      const voided = Boolean(cur?.voided) || Boolean(r.voided)
      if (cur && Boolean(cur.voided) === voided) continue

      await put(t, STORES.deliveries, { ...r, voided })
      // A delivery carries stock as well as debt, so its products need recomputing too.
      for (const l of r.lines ?? []) touched.add(l.product_id)
      changed++
    }

    for (const r of remote.payments ?? []) {
      const cur = await get<Payment>(t, STORES.payments, r.id)
      const voided = Boolean(cur?.voided) || Boolean(r.voided)
      if (cur && Boolean(cur.voided) === voided) continue

      await put(t, STORES.payments, { ...r, voided })
      changed++
    }

    // Cash movements are money too — same append-only + OR-on-voided rule as payments.
    for (const r of remote.cash_movements ?? []) {
      const cur = await get<CashMovement>(t, STORES.cash_movements, r.id)
      const voided = Boolean(cur?.voided) || Boolean(r.voided)
      if (cur && Boolean(cur.voided) === voided) continue

      await put(t, STORES.cash_movements, { ...r, voided })
      changed++
    }

    // Any product whose ledger or record moved gets its stock rebuilt from the merged truth.
    for (const pid of touched) await recomputeStock(t, pid)
  })

  if (changed) notify()
  return changed
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

/**
 * Firms: what we ordered, what arrived, and what we paid.
 *
 * Deliveries and payments are MONEY, so they follow the same discipline the sales ledger
 * already does: append-only, never edited, corrected only by an opposite-signed twin. That is
 * what lets two offline devices merge them with a plain idempotent upsert.
 *
 * Orders are not money. They are intentions, and they are mutable.
 */
import { STORES, tx, get, put, getAll, subscribe, notify, newId } from './idb'
import { recomputeStock, StockError } from './db'
import { linesTotal } from './payables'
import type {
  Delivery, Payment, PurchaseOrder, OrderLine, Transaction, TxType, Product, User,
} from './types'

export interface Actor {
  name: string
  role: User['role']
}

/** Same pattern as db.ts: IndexedDB has no live queries, so re-run the query on every write. */
function watch<T>(query: () => Promise<T>, cb: (rows: T) => void): () => void {
  let alive = true
  const run = () => { void query().then((r) => { if (alive) cb(r) }) }
  run()
  const off = subscribe(run)
  return () => { alive = false; off() }
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

export interface NewDelivery {
  supplier_id: string
  order_id?: string
  delivered_at: number
  doc_number?: string
  doc_date?: number
  lines: OrderLine[]
  note?: string
}

/**
 * Accepting a delivery. This is the ONE event that moves stock and money at the same time, and
 * it writes both inside a single IndexedDB transaction — so the shelf and the debt can never
 * end up disagreeing about what arrived.
 *
 *   stock  <- RESTOCK rows in the existing ledger, tagged ref_id = delivery.id
 *   debt   <- the delivery header, whose total_amount is snapshotted here
 *
 * The stock half goes through the existing ledger rather than a new mechanism, because that
 * ledger is already the single source of truth for stock and a second one would drift from it.
 */
export async function createDelivery(
  input: NewDelivery, actor: Actor,
): Promise<{ id: string; total: number }> {
  if (!input.lines.length) throw new Error("Yetkazib berish bo'sh")
  for (const l of input.lines) {
    if (l.quantity <= 0) throw new Error(`"${l.product_name}" — miqdor 0 dan katta bo'lishi kerak`)
  }

  const id = newId()
  const now = Date.now()
  const total = linesTotal(input.lines)

  await tx([STORES.products, STORES.transactions, STORES.deliveries], 'readwrite', async (t) => {
    await put(t, STORES.deliveries, {
      ...input,
      id,
      created_at: now,       // write time — the sync watermark. Never delivered_at.
      total_amount: total,   // snapshotted, so a later reprice cannot rewrite this debt
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
    } satisfies Delivery)

    for (const l of input.lines) {
      const p = await get<Product>(t, STORES.products, l.product_id)
      if (!p) throw new Error("Mahsulot topilmadi (o'chirilgan bo'lishi mumkin)")

      // A delivery at a new cost becomes the product's cost going forward — the same rule
      // `commitCart` already applies to a plain RESTOCK.
      if (l.unit_cost > 0 && l.unit_cost !== p.cost_price) {
        await put(t, STORES.products, { ...p, cost_price: l.unit_cost, updated_at: now })
      }

      await put(t, STORES.transactions, {
        id: newId(),
        ts: now,
        type: 'RESTOCK' as TxType,
        product_id: l.product_id,
        product_name: l.product_name,
        brand: l.brand,
        quantity: l.quantity,
        unit_price: l.unit_cost,
        cost_price: l.unit_cost,
        total_amount: l.quantity * l.unit_cost,
        profit: 0,
        note: input.doc_number
          ? `Yetkazib berish — faktura №${input.doc_number}`
          : 'Yetkazib berish',
        user_name: actor.name,
        user_role: actor.role,
        ref_id: id,   // ties the stock movement back to the delivery, in both directions
        voided: false,
      } satisfies Transaction)
    }

    // Stock is derived: now that the ledger rows exist, the cache follows from them.
    for (const l of input.lines) await recomputeStock(t, l.product_id)
  })

  notify()
  return { id, total }
}

/**
 * Append-only correction, exactly as `voidTransaction` does it: flag the original, append an
 * opposite-signed twin. Nothing is deleted, so the audit trail always shows what was entered
 * and what was reversed, and by whom.
 *
 * Refused outright if the goods have already been sold on — reversing the receipt would drive
 * the shelf negative, i.e. claim the shop holds stock it does not. The check runs over the whole
 * basket before anything is written, because a half-unwound delivery is worse than none.
 */
export async function voidDelivery(id: string, actor: Actor): Promise<void> {
  await tx([STORES.products, STORES.transactions, STORES.deliveries], 'readwrite', async (t) => {
    const original = await get<Delivery>(t, STORES.deliveries, id)
    if (!original) throw new Error('Yetkazib berish topilmadi')
    if (original.voided) throw new Error('Bu yetkazib berish allaqachon bekor qilingan')

    for (const l of original.lines) {
      const p = await get<Product>(t, STORES.products, l.product_id)
      if (p && p.current_stock - l.quantity < 0) {
        throw new StockError(l.product_name, p.current_stock, l.quantity)
      }
    }

    const twinId = newId()
    const now = Date.now()

    await put(t, STORES.deliveries, { ...original, voided: true })
    await put(t, STORES.deliveries, {
      ...original,
      id: twinId,
      created_at: now,
      total_amount: -original.total_amount,
      lines: original.lines.map((l) => ({ ...l, quantity: -l.quantity })),
      note: `BEKOR QILINDI: ${original.note || '—'}`,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
      reversal_of: original.id,
    } satisfies Delivery)

    for (const l of original.lines) {
      await put(t, STORES.transactions, {
        id: newId(),
        ts: now,
        type: 'RESTOCK' as TxType,
        product_id: l.product_id,
        product_name: l.product_name,
        brand: l.brand,
        quantity: -l.quantity,
        unit_price: l.unit_cost,
        cost_price: l.unit_cost,
        total_amount: -(l.quantity * l.unit_cost),
        profit: 0,
        note: 'Yetkazib berish bekor qilindi',
        user_name: actor.name,
        user_role: actor.role,
        ref_id: twinId,
        voided: false,
      } satisfies Transaction)
    }

    for (const l of original.lines) await recomputeStock(t, l.product_id)
  })

  notify()
}

export const fetchDeliveries = (): Promise<Delivery[]> =>
  tx([STORES.deliveries], 'readonly', (t) => getAll<Delivery>(t, STORES.deliveries))

export function watchDeliveries(cb: (rows: Delivery[]) => void): () => void {
  return watch(fetchDeliveries, cb)
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface NewPayment {
  supplier_id: string
  amount: number
  paid_at: number
  method: Payment['method']
  doc_number?: string
  note?: string
}

/**
 * Money out. Append-only and immutable, like a delivery.
 *
 * A payment is deliberately NOT linked to a delivery: a firm sends one transfer against three
 * fakturas and nobody records which. Settlement is derived FIFO on read — see
 * `unpaidDeliveries` in payables.ts.
 */
export async function recordPayment(input: NewPayment, actor: Actor): Promise<string> {
  if (!(input.amount > 0)) throw new Error("To'lov summasi 0 dan katta bo'lishi kerak")

  const id = newId()
  const now = Date.now()

  await tx([STORES.payments], 'readwrite', (t) =>
    put(t, STORES.payments, {
      ...input,
      id,
      created_at: now,   // write time — the sync watermark. Never paid_at.
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
    } satisfies Payment),
  )

  notify()
  return id
}

/** Flag the original, append the opposite twin. The same rule as everything else that is money. */
export async function voidPayment(id: string, actor: Actor): Promise<void> {
  await tx([STORES.payments], 'readwrite', async (t) => {
    const original = await get<Payment>(t, STORES.payments, id)
    if (!original) throw new Error("To'lov topilmadi")
    if (original.voided) throw new Error("Bu to'lov allaqachon bekor qilingan")

    const now = Date.now()
    await put(t, STORES.payments, { ...original, voided: true })
    await put(t, STORES.payments, {
      ...original,
      id: newId(),
      created_at: now,
      amount: -original.amount,
      note: `BEKOR QILINDI: ${original.note || '—'}`,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
      reversal_of: original.id,
    } satisfies Payment)
  })

  notify()
}

export const fetchPayments = (): Promise<Payment[]> =>
  tx([STORES.payments], 'readonly', (t) => getAll<Payment>(t, STORES.payments))

export function watchPayments(cb: (rows: Payment[]) => void): () => void {
  return watch(fetchPayments, cb)
}

/* ------------------------------------------------------------------ */
/* Purchase orders                                                     */
/* ------------------------------------------------------------------ */

/**
 * A human label for talking to the firm ("buyurtma #007"), never a key — `id` is the key.
 *
 * Two devices creating an order offline can therefore both mint #007. That is cosmetic and
 * accepted: making it collision-free needs a coordinating counter, which is precisely the
 * shared mutable state this design avoids everywhere else.
 */
export function nextOrderNumber(existing: PurchaseOrder[]): string {
  const max = existing.reduce((m, o) => {
    const n = Number((o.number ?? '').replace(/\D/g, ''))
    return Number.isFinite(n) ? Math.max(m, n) : m
  }, 0)
  return `#${String(max + 1).padStart(3, '0')}`
}

export type NewPurchaseOrder =
  Omit<PurchaseOrder, 'id' | 'created_at' | 'updated_at' | 'number' | 'user_name' | 'user_role'>
  & { id?: string; number?: string }

/**
 * Create or edit an order. Mutable and last-write-wins, unlike deliveries and payments — an
 * order is an intention, not money, so a lost concurrent edit is annoying but never corrupting.
 */
export async function savePurchaseOrder(o: NewPurchaseOrder, actor: Actor): Promise<string> {
  if (!o.lines.length) throw new Error("Buyurtma bo'sh")

  const now = Date.now()
  const id = o.id ?? newId()

  await tx([STORES.purchase_orders], 'readwrite', async (t) => {
    const existing = o.id ? await get<PurchaseOrder>(t, STORES.purchase_orders, o.id) : undefined
    const all = await getAll<PurchaseOrder>(t, STORES.purchase_orders)

    await put(t, STORES.purchase_orders, {
      ...existing,
      ...o,
      id,
      number: o.number ?? existing?.number ?? nextOrderNumber(all),
      user_name: existing?.user_name ?? actor.name,
      user_role: existing?.user_role ?? actor.role,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    } satisfies PurchaseOrder)
  })

  notify()
  return id
}

/** Cancelling is the ONE stored status — it is a human decision, not arithmetic. */
export async function cancelPurchaseOrder(id: string): Promise<void> {
  await tx([STORES.purchase_orders], 'readwrite', async (t) => {
    const cur = await get<PurchaseOrder>(t, STORES.purchase_orders, id)
    if (!cur) throw new Error('Buyurtma topilmadi')
    const now = Date.now()
    await put(t, STORES.purchase_orders, { ...cur, cancelled_at: now, updated_at: now })
  })
  notify()
}

/** Soft delete, for the same reason products are: see `deleteProduct` in db.ts. */
export async function deletePurchaseOrder(id: string): Promise<void> {
  await tx([STORES.purchase_orders], 'readwrite', async (t) => {
    const cur = await get<PurchaseOrder>(t, STORES.purchase_orders, id)
    if (!cur) return
    const now = Date.now()
    await put(t, STORES.purchase_orders, { ...cur, deleted_at: now, updated_at: now })
  })
  notify()
}

export const fetchPurchaseOrders = (): Promise<PurchaseOrder[]> =>
  tx([STORES.purchase_orders], 'readonly', (t) => getAll<PurchaseOrder>(t, STORES.purchase_orders))
    .then((rows) => rows.filter((o) => !o.deleted_at).sort((a, b) => b.ordered_at - a.ordered_at))

export function watchPurchaseOrders(cb: (rows: PurchaseOrder[]) => void): () => void {
  return watch(fetchPurchaseOrders, cb)
}

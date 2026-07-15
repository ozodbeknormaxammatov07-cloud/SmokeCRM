/**
 * The store. One shared cloud database (Supabase), mirrored in memory on each device.
 *
 * There is no local database and no background sync. When the shop signs in, `startCloud`
 * loads every row once into an in-memory cache and opens a Realtime subscription; from then on
 * a write goes straight to Supabase and every other device hears it in about a second. On
 * reload the cache is thrown away and re-hydrated from the cloud — the cloud is the single
 * source of truth, not a replica.
 *
 * The public surface (`STORES`, `tx`, `get`, `put`, `getAll`, `getAllByRange`, `subscribe`,
 * `notify`) is kept identical to the old IndexedDB wrapper on purpose: every rule about stock
 * and money in db.ts / procurement.ts / kassa.ts / auth.ts is unchanged and still runs against
 * this cache, so the same test suite validates it.
 *
 * Atomicity, as before: a read-modify-write `tx` buffers its writes and only touches the shared
 * cache once `fn` returns — a thrown StockError discards the buffer, so nothing half-commits.
 * Read-write transactions are serialized on this device, so the oversell check and the write it
 * guards cannot interleave. (Two DIFFERENT devices selling the last packet in the same instant
 * is the one race no client can win; it surfaces as negative stock, exactly as it always did.)
 */
import { supabase } from './supabase'
import type { Product, Transaction, Payment, OrderLine, Role, CashMovement, Account } from './types'

export const DB_NAME = 'tamaki-savdo'

export const STORES = {
  products: 'products',
  transactions: 'transactions',
  suppliers: 'suppliers',
  purchase_orders: 'purchase_orders',
  deliveries: 'deliveries',
  payments: 'payments',
  users: 'users',
  cash_movements: 'cash_movements',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

const ALL_STORES = Object.values(STORES) as StoreName[]

/** The `users` store lives in the `staff` table; every other store maps to its own name. */
const TABLE: Record<StoreName, string> = {
  products: 'products',
  transactions: 'transactions',
  suppliers: 'suppliers',
  purchase_orders: 'purchase_orders',
  deliveries: 'deliveries',
  payments: 'payments',
  users: 'staff',
  cash_movements: 'cash_movements',
}

/* ------------------------------------------------------------------ */
/* In-memory cache                                                     */
/* ------------------------------------------------------------------ */

type Row = { id: string } & Record<string, unknown>

const cache: Record<StoreName, Map<string, Row>> = Object.fromEntries(
  ALL_STORES.map((s) => [s, new Map<string, Row>()]),
) as Record<StoreName, Map<string, Row>>

/** The signed-in shop. Null until `startCloud`; while null, writes stay in memory only. */
let shopUid: string | null = null

/* ------------------------------------------------------------------ */
/* Change notification                                                 */
/* ------------------------------------------------------------------ */

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Call after any committed write so every live view re-queries. */
export function notify(): void {
  listeners.forEach((l) => l())
}

/* ------------------------------------------------------------------ */
/* Derived stock — the cache of the ledger, kept on every product      */
/* ------------------------------------------------------------------ */

/**
 * Rebuilds `current_stock` on every product from the transaction ledger. Stock is derived, never
 * stored in the database, so this is what makes a freshly-hydrated or remotely-updated cache
 * agree with the ledger. Voided rows are summed, not skipped — a void's opposite-signed twin
 * cancels the original on its own.
 */
function recomputeAllStock(): void {
  const sums = new Map<string, number>()
  for (const t of cache.transactions.values()) {
    const row = t as unknown as Transaction
    sums.set(row.product_id, (sums.get(row.product_id) ?? 0) + (row.type === 'SALE' ? -row.quantity : row.quantity))
  }
  for (const p of cache.products.values()) {
    ;(p as unknown as Product).current_stock = sums.get(p.id) ?? 0
  }
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

const TOMB = Symbol('delete')
type Buffered = Row | typeof TOMB

export interface Txn {
  mode: IDBTransactionMode
  writes: Map<StoreName, Map<string, Buffered>>
}

/** The cache for one store, with a transaction's un-committed writes overlaid on top. */
function overlay(store: StoreName, writes: Map<StoreName, Map<string, Buffered>>): Row[] {
  const merged = new Map(cache[store])
  const w = writes.get(store)
  if (w) for (const [id, v] of w) (v === TOMB ? merged.delete(id) : merged.set(id, v))
  return [...merged.values()]
}

export function get<T>(t: Txn, store: StoreName, key: string): Promise<T | undefined> {
  const w = t.writes.get(store)
  if (w && w.has(key)) {
    const v = w.get(key)
    return Promise.resolve((v === TOMB ? undefined : v) as T | undefined)
  }
  return Promise.resolve(cache[store].get(key) as T | undefined)
}

export function put(t: Txn, store: StoreName, value: unknown): Promise<string> {
  const row = value as Row
  let w = t.writes.get(store)
  if (!w) { w = new Map(); t.writes.set(store, w) }
  w.set(row.id, row)
  return Promise.resolve(row.id)
}

export function del(t: Txn, store: StoreName, key: string): Promise<void> {
  let w = t.writes.get(store)
  if (!w) { w = new Map(); t.writes.set(store, w) }
  w.set(key, TOMB)
  return Promise.resolve()
}

export function getAll<T>(t: Txn, store: StoreName): Promise<T[]> {
  return Promise.resolve(overlay(store, t.writes) as T[])
}

export function getAllByRange<T>(
  t: Txn, store: StoreName, index: string, range: IDBKeyRange,
): Promise<T[]> {
  // `index` is a column name; IDBKeyRange.includes works natively in the browser and via
  // fake-indexeddb under the test harness, so the two range shapes db.ts uses (`only`, `bound`)
  // both just work.
  return Promise.resolve(
    overlay(store, t.writes).filter((r) => range.includes((r as Record<string, IDBValidKey>)[index])) as T[],
  )
}

/* ------------------------------------------------------------------ */
/* Commit                                                              */
/* ------------------------------------------------------------------ */

type Undo = { store: StoreName; id: string; prev: Row | undefined; existed: boolean }

function applyWrites(writes: Map<StoreName, Map<string, Buffered>>): Undo[] {
  const undo: Undo[] = []
  for (const [store, w] of writes) {
    for (const [id, v] of w) {
      undo.push({ store, id, prev: cache[store].get(id), existed: cache[store].has(id) })
      if (v === TOMB) cache[store].delete(id)
      else cache[store].set(id, v)
    }
  }
  return undo
}

function revert(undo: Undo[]): void {
  for (const u of undo) {
    if (u.existed) cache[u.store].set(u.id, u.prev!)
    else cache[u.store].delete(u.id)
  }
}

/** Writes a transaction's buffer through to Supabase. A no-op when signed out (tests, logged-out). */
async function flush(writes: Map<StoreName, Map<string, Buffered>>): Promise<void> {
  if (!supabase || !shopUid) return
  for (const [store, w] of writes) {
    const upserts: Row[] = []
    const deletes: string[] = []
    for (const [id, v] of w) (v === TOMB ? deletes.push(id) : upserts.push(v))

    if (upserts.length) {
      const rows = upserts.map((v) => pick(store, v, shopUid!))
      const { error } = await supabase.from(TABLE[store]).upsert(rows, { onConflict: 'user_id,id' })
      if (error) throw new Error(`${TABLE[store]}: ${error.message}`)
    }
    for (const id of deletes) {
      const { error } = await supabase.from(TABLE[store]).delete().eq('user_id', shopUid).eq('id', id)
      if (error) throw new Error(`${TABLE[store]}: ${error.message}`)
    }
  }
}

// One read-write transaction at a time on this device, so a read-modify-write can't interleave.
let writeChain: Promise<unknown> = Promise.resolve()

export function tx<T>(
  _stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (t: Txn) => Promise<T> | T,
): Promise<T> {
  const exec = async (): Promise<T> => {
    await ready
    const t: Txn = { mode, writes: new Map() }
    const result = await fn(t) // a throw here discards the buffer — nothing is applied
    if (t.writes.size) {
      const undo = applyWrites(t.writes) // cache first, so the UI updates immediately…
      notify()
      try {
        await flush(t.writes) // …then the cloud. On failure, roll the cache back and surface it.
      } catch (e) {
        revert(undo)
        notify()
        throw e
      }
    }
    return result
  }

  if (mode === 'readonly') return exec()
  const p = writeChain.then(exec, exec)
  writeChain = p.then(() => {}, () => {})
  return p
}

/* ------------------------------------------------------------------ */
/* Column whitelists — what actually goes to the database              */
/* ------------------------------------------------------------------ */
// A whitelist per table strips the fields the database deliberately does NOT store: a product's
// derived `current_stock`, a transaction's client-only `void_of`. `user_id` is stamped here so
// callers never have to. Undefined becomes null so clearing a field (e.g. removing a barcode)
// actually clears it on update.

const COLUMNS: Record<StoreName, string[]> = {
  products: ['id', 'name', 'brand', 'cost_price', 'selling_price', 'reorder_threshold',
    'barcode', 'supplier_id', 'active', 'created_at', 'updated_at', 'deleted_at'],
  transactions: ['id', 'ts', 'type', 'product_id', 'product_name', 'brand', 'quantity',
    'unit_price', 'cost_price', 'total_amount', 'profit', 'note', 'user_name', 'user_role',
    'ref_id', 'voided', 'reversal_of', 'payment_method'],
  suppliers: ['id', 'name', 'contact', 'note', 'inn', 'bank_account', 'bank_name', 'bank_mfo',
    'address', 'director', 'payment_terms_days', 'updated_at', 'deleted_at'],
  purchase_orders: ['id', 'supplier_id', 'number', 'ordered_at', 'expected_at', 'lines',
    'cancelled_at', 'note', 'user_name', 'user_role', 'created_at', 'updated_at', 'deleted_at'],
  deliveries: ['id', 'supplier_id', 'order_id', 'created_at', 'delivered_at', 'doc_number',
    'doc_date', 'lines', 'total_amount', 'note', 'user_name', 'user_role', 'voided', 'reversal_of'],
  payments: ['id', 'supplier_id', 'amount', 'created_at', 'paid_at', 'method', 'doc_number',
    'note', 'user_name', 'user_role', 'voided', 'reversal_of'],
  cash_movements: ['id', 'ts', 'created_at', 'amount', 'kind', 'reason', 'note', 'user_name',
    'user_role', 'voided', 'reversal_of'],
  users: ['id', 'name', 'role', 'salt', 'password_hash', 'created_at', 'updated_at', 'deleted_at'],
}

function pick(store: StoreName, value: Row, uid: string): Record<string, unknown> {
  const out: Record<string, unknown> = { user_id: uid }
  for (const c of COLUMNS[store]) out[c] = (value as Record<string, unknown>)[c] ?? null
  return out
}

/* ------------------------------------------------------------------ */
/* Row mapping — database row -> app object                            */
/* ------------------------------------------------------------------ */
// The database speaks nulls and, for numeric/bigint columns, sometimes strings; the app speaks
// undefined and numbers. These normalize on the way in, so the rest of the code never sees a
// null or a stringified amount. (Ported from the old sync layer, where they were already proven.)

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const nOrU = (v: unknown): number | undefined => (v == null ? undefined : n(v))
const role = (v: unknown): Role => (v === 'cashier' ? 'cashier' : 'admin')
const METHODS = ['cash', 'bank', 'card', 'other'] as const
const CASH_KINDS = ['deposit', 'expense', 'withdrawal', 'correction'] as const

function mapRow(store: StoreName, r: Record<string, unknown>): Row {
  switch (store) {
    case 'products':
      return {
        id: String(r.id), name: String(r.name ?? ''), brand: String(r.brand ?? ''),
        cost_price: n(r.cost_price), selling_price: n(r.selling_price),
        current_stock: 0, // derived by recomputeAllStock from the ledger
        reorder_threshold: n(r.reorder_threshold), barcode: (r.barcode as string) ?? undefined,
        supplier_id: (r.supplier_id as string) ?? undefined, active: Boolean(r.active),
        created_at: nOrU(r.created_at), updated_at: nOrU(r.updated_at), deleted_at: nOrU(r.deleted_at),
      } as unknown as Row
    case 'transactions':
      return {
        id: String(r.id), ts: n(r.ts), type: r.type === 'RESTOCK' ? 'RESTOCK' : 'SALE',
        product_id: String(r.product_id), product_name: String(r.product_name ?? ''),
        brand: String(r.brand ?? ''), quantity: n(r.quantity), unit_price: n(r.unit_price),
        cost_price: n(r.cost_price), total_amount: n(r.total_amount), profit: n(r.profit),
        note: (r.note as string) ?? undefined, user_name: String(r.user_name ?? ''),
        user_role: role(r.user_role), ref_id: String(r.ref_id ?? ''), voided: Boolean(r.voided),
        reversal_of: (r.reversal_of as string) ?? undefined,
        payment_method: (r.payment_method as Transaction['payment_method']) ?? undefined,
      } as unknown as Row
    case 'suppliers':
      return {
        id: String(r.id), name: String(r.name ?? ''), contact: (r.contact as string) ?? undefined,
        note: (r.note as string) ?? undefined, inn: (r.inn as string) ?? undefined,
        bank_account: (r.bank_account as string) ?? undefined, bank_name: (r.bank_name as string) ?? undefined,
        bank_mfo: (r.bank_mfo as string) ?? undefined, address: (r.address as string) ?? undefined,
        director: (r.director as string) ?? undefined, payment_terms_days: nOrU(r.payment_terms_days),
        updated_at: nOrU(r.updated_at), deleted_at: nOrU(r.deleted_at),
      } as unknown as Row
    case 'purchase_orders':
      return {
        id: String(r.id), supplier_id: String(r.supplier_id), number: String(r.number ?? ''),
        ordered_at: n(r.ordered_at), expected_at: nOrU(r.expected_at),
        lines: (r.lines as OrderLine[]) ?? [], cancelled_at: nOrU(r.cancelled_at),
        note: (r.note as string) ?? undefined, user_name: String(r.user_name ?? ''),
        user_role: role(r.user_role), created_at: n(r.created_at), updated_at: n(r.updated_at),
        deleted_at: nOrU(r.deleted_at),
      } as unknown as Row
    case 'deliveries':
      return {
        id: String(r.id), supplier_id: String(r.supplier_id), order_id: (r.order_id as string) ?? undefined,
        created_at: n(r.created_at), delivered_at: n(r.delivered_at),
        doc_number: (r.doc_number as string) ?? undefined, doc_date: nOrU(r.doc_date),
        lines: (r.lines as OrderLine[]) ?? [], total_amount: n(r.total_amount),
        note: (r.note as string) ?? undefined, user_name: String(r.user_name ?? ''),
        user_role: role(r.user_role), voided: Boolean(r.voided),
        reversal_of: (r.reversal_of as string) ?? undefined,
      } as unknown as Row
    case 'payments':
      return {
        id: String(r.id), supplier_id: String(r.supplier_id), amount: n(r.amount),
        created_at: n(r.created_at), paid_at: n(r.paid_at),
        method: METHODS.includes(r.method as never) ? (r.method as Payment['method']) : 'cash',
        doc_number: (r.doc_number as string) ?? undefined, note: (r.note as string) ?? undefined,
        user_name: String(r.user_name ?? ''), user_role: role(r.user_role),
        voided: Boolean(r.voided), reversal_of: (r.reversal_of as string) ?? undefined,
      } as unknown as Row
    case 'cash_movements':
      return {
        id: String(r.id), ts: n(r.ts), created_at: n(r.created_at), amount: n(r.amount),
        kind: CASH_KINDS.includes(r.kind as never) ? (r.kind as CashMovement['kind']) : 'expense',
        reason: String(r.reason ?? ''), note: (r.note as string) ?? undefined,
        user_name: String(r.user_name ?? ''), user_role: role(r.user_role),
        voided: Boolean(r.voided), reversal_of: (r.reversal_of as string) ?? undefined,
      } as unknown as Row
    case 'users':
      return {
        id: String(r.id), name: String(r.name ?? ''), role: role(r.role),
        salt: String(r.salt ?? ''), password_hash: String(r.password_hash ?? ''),
        created_at: n(r.created_at), updated_at: n(r.updated_at), deleted_at: nOrU(r.deleted_at),
      } as unknown as Account as unknown as Row
    default:
      return r as Row
  }
}

/* ------------------------------------------------------------------ */
/* Hydrate + Realtime                                                  */
/* ------------------------------------------------------------------ */

const PAGE = 1000

async function fetchAll(table: string, uid: string): Promise<Record<string, unknown>[]> {
  if (!supabase) return []
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select('*').eq('user_id', uid).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

// `ready` gates every `tx` until the first hydrate has finished, so no query ever runs against
// a half-loaded cache. It resolves immediately when there is no cloud (the test harness).
let ready: Promise<void> = Promise.resolve()
let channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null

/** Loads the whole shop into memory and starts listening for other devices' writes. */
export async function startCloud(uid: string): Promise<void> {
  if (!supabase) return
  shopUid = uid
  ready = (async () => {
    for (const store of ALL_STORES) {
      const rows = await fetchAll(TABLE[store], uid)
      const map = cache[store]
      map.clear()
      for (const raw of rows) {
        const row = mapRow(store, raw)
        map.set(row.id, row)
      }
    }
    recomputeAllStock()
    notify()
  })()
  await ready

  channel = supabase.channel('shop')
  for (const store of ALL_STORES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE[store] },
      (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) =>
        applyRemote(store, payload),
    )
  }
  channel.subscribe()
}

/** Drops the cache and the subscription — on sign-out, so the next shop starts clean. */
export async function stopCloud(): Promise<void> {
  shopUid = null
  ready = Promise.resolve()
  if (channel) { await supabase?.removeChannel(channel); channel = null }
  for (const store of ALL_STORES) cache[store].clear()
  notify()
}

function applyRemote(
  store: StoreName,
  payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> },
): void {
  const map = cache[store]
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id
    if (id) map.delete(String(id))
  } else {
    const row = mapRow(store, payload.new)
    map.set(row.id, row)
  }
  if (store === 'products' || store === 'transactions') recomputeAllStock()
  notify()
}

/* ------------------------------------------------------------------ */
/* Bulk operations — backup restore and reset                          */
/* ------------------------------------------------------------------ */
// These bypass the per-transaction buffer because they replace or wipe whole tables at once.

/** Removes every row of the given stores, locally and in the cloud. */
export async function clearAllStores(stores: StoreName[]): Promise<void> {
  for (const s of stores) cache[s].clear()
  recomputeAllStock()
  notify()
  if (!supabase || !shopUid) return
  for (const s of stores) {
    const { error } = await supabase.from(TABLE[s]).delete().eq('user_id', shopUid)
    if (error) throw new Error(`${TABLE[s]}: ${error.message}`)
  }
}

const CHUNK = 500

/** Writes many rows into one store at once (a restore), locally and in the cloud. */
export async function bulkPut(store: StoreName, rows: unknown[]): Promise<void> {
  for (const r of rows) {
    const row = r as Row
    cache[store].set(row.id, row)
  }
  recomputeAllStock()
  notify()
  if (!supabase || !shopUid || !rows.length) return
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => pick(store, r as Row, shopUid!))
    const { error } = await supabase.from(TABLE[store]).upsert(chunk, { onConflict: 'user_id,id' })
    if (error) throw new Error(`${TABLE[store]}: ${error.message}`)
  }
}

/** Kept for API compatibility with the old wrapper; a `tx` awaits hydration on its own. */
export function openDb(): Promise<void> {
  return ready
}

export const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

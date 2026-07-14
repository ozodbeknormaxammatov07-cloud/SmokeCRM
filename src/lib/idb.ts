/**
 * Minimal IndexedDB wrapper. No cloud, no account — the data lives in this browser.
 *
 * IndexedDB gives us genuinely atomic multi-store transactions, which is what the
 * negative-stock guard relies on: stock is re-read and checked inside the same
 * transaction that writes the ledger row, so a double-submit can't oversell.
 */

export const DB_NAME = 'tamaki-savdo'
const DB_VERSION = 2

export const STORES = {
  products: 'products',
  transactions: 'transactions',
  suppliers: 'suppliers',
  purchase_orders: 'purchase_orders',
  deliveries: 'deliveries',
  payments: 'payments',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.products)) {
        const s = db.createObjectStore(STORES.products, { keyPath: 'id' })
        s.createIndex('brand', 'brand')
        s.createIndex('name', 'name')
      }
      if (!db.objectStoreNames.contains(STORES.transactions)) {
        const s = db.createObjectStore(STORES.transactions, { keyPath: 'id' })
        s.createIndex('ts', 'ts')
        s.createIndex('product_id', 'product_id')
      }
      if (!db.objectStoreNames.contains(STORES.suppliers)) {
        db.createObjectStore(STORES.suppliers, { keyPath: 'id' })
      }

      // v2 — procurement. An existing database keeps every row it already holds: this handler
      // runs for the version delta only, and each block is guarded by a `contains` check.
      if (!db.objectStoreNames.contains(STORES.purchase_orders)) {
        const s = db.createObjectStore(STORES.purchase_orders, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        s.createIndex('updated_at', 'updated_at')
      }
      if (!db.objectStoreNames.contains(STORES.deliveries)) {
        const s = db.createObjectStore(STORES.deliveries, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        // Indexed on created_at, NOT delivered_at: sync pages on the write time, so that a
        // delivery typed in today for goods that arrived last week still replicates.
        s.createIndex('created_at', 'created_at')
      }
      if (!db.objectStoreNames.contains(STORES.payments)) {
        const s = db.createObjectStore(STORES.payments, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        s.createIndex('created_at', 'created_at')
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () =>
      reject(new Error("Brauzer ma'lumotlar bazasini ocholmadi (IndexedDB o'chirilgan bo'lishi mumkin)"))
  })

  return dbPromise
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB xatoligi'))
  })
}

/**
 * Runs `fn` inside one readwrite transaction over `stores` and resolves only once
 * the transaction has actually committed — so callers can't observe a half-write.
 * Throwing inside `fn` aborts the whole transaction.
 */
export async function tx<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode)
    let result: T
    let failed: unknown = null

    t.oncomplete = () => (failed ? reject(failed) : resolve(result))
    t.onerror = () => reject(failed ?? t.error ?? new Error('Tranzaksiya xatoligi'))
    t.onabort = () => reject(failed ?? t.error ?? new Error('Tranzaksiya bekor qilindi'))

    Promise.resolve()
      .then(() => fn(t))
      .then((r) => { result = r })
      .catch((e) => {
        failed = e
        try { t.abort() } catch { /* already settled */ }
      })
  })
}

export const get = <T>(t: IDBTransaction, store: StoreName, key: string): Promise<T | undefined> =>
  wrap(t.objectStore(store).get(key) as IDBRequest<T | undefined>)

export const put = (t: IDBTransaction, store: StoreName, value: unknown): Promise<IDBValidKey> =>
  wrap(t.objectStore(store).put(value) as IDBRequest<IDBValidKey>)

export const del = (t: IDBTransaction, store: StoreName, key: string): Promise<undefined> =>
  wrap(t.objectStore(store).delete(key) as IDBRequest<undefined>)

export const getAll = <T>(t: IDBTransaction, store: StoreName): Promise<T[]> =>
  wrap(t.objectStore(store).getAll() as IDBRequest<T[]>)

export const getAllByRange = <T>(
  t: IDBTransaction,
  store: StoreName,
  index: string,
  range: IDBKeyRange,
): Promise<T[]> => wrap(t.objectStore(store).index(index).getAll(range) as IDBRequest<T[]>)

/* ------------------------------------------------------------------ */
/* Change notification                                                 */
/* ------------------------------------------------------------------ */

type Listener = () => void
const listeners = new Set<Listener>()

/** Cross-tab: a second tab open on the same shop should see the same numbers. */
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DB_NAME) : null

if (channel) channel.onmessage = () => listeners.forEach((l) => l())

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Call after any committed write so every live view re-queries. */
export function notify(): void {
  listeners.forEach((l) => l())
  channel?.postMessage('changed')
}

export const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

import { supabase, currentSession } from './supabase'
import { exportBackup, restoreBackup } from './db'
import { subscribe } from './idb'
import type { Product, Transaction, Supplier } from './types'

/**
 * Cloud replication. IndexedDB is the source of truth; this pushes a copy to Supabase so a
 * dead laptop or a cleared browser isn't the end of the shop's history.
 *
 * The till never waits on any of this. A sale commits to IndexedDB and returns; the push
 * happens afterwards, and if it fails — no internet, server down — the data is already safe
 * locally and the next push catches up. Selling must never stop because the network did.
 */

const CHUNK = 500
const PAGE = 1000
/** Re-push a few seconds either side of the watermark. Upserts are idempotent, so overlapping
 *  is free — whereas a row lost to a clock skew of one millisecond is lost for good. */
const OVERLAP_MS = 10_000

export type SyncPhase = 'off' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncState {
  phase: SyncPhase
  lastSyncedAt: number | null
  error: string | null
  email: string | null
  /** This device is empty but the cloud is not: a restore is waiting to happen. */
  needsRestore: boolean
}

let state: SyncState = {
  phase: 'off', lastSyncedAt: null, error: null, email: null, needsRestore: false,
}
const listeners = new Set<(s: SyncState) => void>()

export function syncState(): SyncState {
  return state
}

export function onSyncState(fn: (s: SyncState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l(state))
}

const LAST_KEY = (uid: string) => `ts.sync.last.${uid}`
const WM_KEY = (uid: string) => `ts.sync.wm.${uid}`

/* ------------------------------------------------------------------ */
/* Row <-> app-object mapping                                          */
/* ------------------------------------------------------------------ */

// PostgREST hands back `numeric` as a JSON number, but a driver or a schema tweak turning it
// into a string would corrupt every total silently. Coerce rather than trust.
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

const rowToProduct = (r: Record<string, unknown>): Product => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  brand: String(r.brand ?? ''),
  cost_price: n(r.cost_price),
  selling_price: n(r.selling_price),
  current_stock: n(r.current_stock),
  reorder_threshold: n(r.reorder_threshold),
  barcode: (r.barcode as string) ?? undefined,
  supplier_id: (r.supplier_id as string) ?? undefined,
  active: Boolean(r.active),
  created_at: r.created_at == null ? undefined : n(r.created_at),
  updated_at: r.updated_at == null ? undefined : n(r.updated_at),
})

const rowToTx = (r: Record<string, unknown>): Transaction => ({
  id: String(r.id),
  ts: n(r.ts),
  type: r.type === 'RESTOCK' ? 'RESTOCK' : 'SALE',
  product_id: String(r.product_id),
  product_name: String(r.product_name ?? ''),
  brand: String(r.brand ?? ''),
  quantity: n(r.quantity),
  unit_price: n(r.unit_price),
  cost_price: n(r.cost_price),
  total_amount: n(r.total_amount),
  profit: n(r.profit),
  note: (r.note as string) ?? undefined,
  user_name: String(r.user_name ?? ''),
  user_role: r.user_role === 'cashier' ? 'cashier' : 'admin',
  ref_id: String(r.ref_id ?? ''),
  voided: Boolean(r.voided),
  reversal_of: (r.reversal_of as string) ?? undefined,
})

const rowToSupplier = (r: Record<string, unknown>): Supplier => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  contact: (r.contact as string) ?? undefined,
  note: (r.note as string) ?? undefined,
})

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

async function upsertChunked(table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase!
      .from(table)
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,id' })
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

/**
 * Pushes everything that changed since the last successful sync.
 *
 * Ledger rows are append-only, so "changed" is almost always "new" — cheap. The one exception
 * is a void, which flips `voided` on an OLD row while writing a NEW reversal row. That old row
 * is older than the watermark and would otherwise never be re-pushed, leaving the cloud copy
 * showing a sale the shop cancelled. So any row a new reversal points at is dragged along too.
 */
export async function pushChanges(): Promise<{ pushed: number }> {
  if (!supabase) return { pushed: 0 }
  const session = await currentSession()
  if (!session) {
    setState({ phase: 'signed-out', email: null })
    return { pushed: 0 }
  }
  if (!navigator.onLine) {
    setState({ phase: 'offline' })
    return { pushed: 0 }
  }

  const uid = session.user.id
  const started = Date.now()
  const wm = Number(localStorage.getItem(WM_KEY(uid)) ?? 0)

  setState({ phase: 'syncing', error: null, email: session.user.email ?? null })

  try {
    const local = await exportBackup()

    // A brand-new device — or one whose browser data was just wiped — has nothing worth
    // backing up. Pushing from here would replicate the emptiness upward and reconcile the
    // cloud copy away, destroying the backup at the exact moment it's needed. Never push an
    // empty device; offer a restore instead.
    if (!local.products.length && !local.transactions.length) {
      const remote = await cloudCounts()
      const hasCloudData = Boolean(remote && (remote.products || remote.transactions))
      setState({
        phase: 'idle',
        needsRestore: hasCloudData,
        email: session.user.email ?? null,
        error: null,
      })
      return { pushed: 0 }
    }

    const products = local.products.filter((p) => (p.updated_at ?? 0) >= wm)

    const fresh = local.transactions.filter((t) => t.ts >= wm)
    const voidedIds = new Set(fresh.filter((t) => t.reversal_of).map((t) => t.reversal_of!))
    const revived = local.transactions.filter((t) => voidedIds.has(t.id) && t.ts < wm)
    const txs = [...fresh, ...revived]

    await upsertChunked('products', products.map((p) => ({ ...p, user_id: uid })))
    await upsertChunked('transactions', txs.map((t) => ({ ...t, user_id: uid })))
    // Suppliers have no timestamps and there are only ever a handful — just push them all.
    await upsertChunked('suppliers', local.suppliers.map((s) => ({ ...s, user_id: uid })))

    // A product deleted locally must not come back from the dead on the next restore. The
    // ledger is never deleted from, so only these two small tables need reconciling.
    await reconcileDeletes('products', uid, local.products.map((p) => p.id))
    await reconcileDeletes('suppliers', uid, local.suppliers.map((s) => s.id))

    localStorage.setItem(WM_KEY(uid), String(started - OVERLAP_MS))
    localStorage.setItem(LAST_KEY(uid), String(started))
    setState({ phase: 'idle', lastSyncedAt: started, error: null, needsRestore: false })
    return { pushed: products.length + txs.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sinxronlash xatoligi'
    setState({ phase: navigator.onLine ? 'error' : 'offline', error: msg })
    throw new Error(msg)
  }
}

/**
 * Deletes remote rows the shop no longer has locally, so a deleted product doesn't come back
 * from the dead on the next restore.
 *
 * The empty-local case is deliberately refused rather than obeyed. "Delete everything in the
 * cloud" is never a legitimate thing for a sync to conclude on its own — it is what an empty
 * or half-initialised device looks like, and obeying it would shred the backup. The caller
 * already guards this; the check is repeated here because the cost of being wrong is the
 * shop's entire history, and a future caller won't know that.
 */
async function reconcileDeletes(table: string, uid: string, localIds: string[]): Promise<void> {
  if (!localIds.length) return

  const { data, error } = await supabase!.from(table).select('id').eq('user_id', uid)
  if (error) throw new Error(`${table}: ${error.message}`)

  const keep = new Set(localIds)
  const stale = (data ?? []).map((r) => String(r.id)).filter((id) => !keep.has(id))
  if (!stale.length) return

  for (let i = 0; i < stale.length; i += CHUNK) {
    const { error: delErr } = await supabase!
      .from(table)
      .delete()
      .eq('user_id', uid)
      .in('id', stale.slice(i, i + CHUNK))
    if (delErr) throw new Error(`${table}: ${delErr.message}`)
  }
}

/* ------------------------------------------------------------------ */
/* Pull (restore)                                                      */
/* ------------------------------------------------------------------ */

async function fetchAll(table: string, uid: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase!
      .from(table)
      .select('*')
      .eq('user_id', uid)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/**
 * Pulls the cloud copy down and REPLACES local data with it. This is the "my laptop died"
 * path — destructive by design, so the caller must confirm first.
 */
export async function pullFromCloud(): Promise<{ products: number; transactions: number }> {
  if (!supabase) throw new Error('Bulut sozlanmagan')
  const session = await currentSession()
  if (!session) throw new Error('Avval hisobingizga kiring')

  const uid = session.user.id
  setState({ phase: 'syncing', error: null })

  try {
    const [p, t, s] = await Promise.all([
      fetchAll('products', uid),
      fetchAll('transactions', uid),
      fetchAll('suppliers', uid),
    ])

    const res = await restoreBackup({
      format: 'tamaki-savdo',
      version: 1,
      exported_at: Date.now(),
      products: p.map(rowToProduct),
      transactions: t.map(rowToTx),
      suppliers: s.map(rowToSupplier),
    })

    // Local now equals the cloud, so there is nothing to push back up.
    const now = Date.now()
    localStorage.setItem(WM_KEY(uid), String(now - OVERLAP_MS))
    localStorage.setItem(LAST_KEY(uid), String(now))
    setState({ phase: 'idle', lastSyncedAt: now, error: null, needsRestore: false })
    return res
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Tiklashda xatolik'
    setState({ phase: 'error', error: msg })
    throw new Error(msg)
  }
}

/** How many rows the cloud is holding, without touching local data. */
export async function cloudCounts(): Promise<{ products: number; transactions: number } | null> {
  if (!supabase) return null
  const session = await currentSession()
  if (!session) return null

  const [p, t] = await Promise.all([
    supabase.from('products').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id),
  ])
  return { products: p.count ?? 0, transactions: t.count ?? 0 }
}

/* ------------------------------------------------------------------ */
/* Auto-sync                                                           */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout> | null = null
let started = false

/** Coalesce a burst of writes (a 12-line basket) into one push. */
function schedulePush(delay = 3000) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void pushChanges().catch(() => {
      /* already reflected in state; the next write or reconnect retries */
    })
  }, delay)
}

export function startAutoSync(): () => void {
  if (!supabase || started) return () => {}
  started = true

  void currentSession().then((s) => {
    if (!s) return setState({ phase: 'signed-out' })
    const last = Number(localStorage.getItem(LAST_KEY(s.user.id)) ?? 0) || null
    setState({ phase: 'idle', email: s.user.email ?? null, lastSyncedAt: last })
    schedulePush(1500)
  })

  const offAuth = supabase.auth.onAuthStateChange((_e, s) => {
    if (!s) return setState({ phase: 'signed-out', email: null, lastSyncedAt: null, needsRestore: false })
    const last = Number(localStorage.getItem(LAST_KEY(s.user.id)) ?? 0) || null
    setState({ phase: 'idle', email: s.user.email ?? null, lastSyncedAt: last })
    schedulePush(500)
  })

  const offDb = subscribe(() => schedulePush())
  const onOnline = () => schedulePush(500)
  const onOffline = () => setState({ phase: 'offline' })
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  if (!navigator.onLine) setState({ phase: 'offline' })

  return () => {
    started = false
    if (timer) clearTimeout(timer)
    offAuth.data.subscription.unsubscribe()
    offDb()
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}

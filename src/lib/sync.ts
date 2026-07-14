import { supabase, currentSession } from './supabase'
import { snapshotForSync, mergeRemote } from './db'
import { subscribe } from './idb'
import type { Product, Transaction, Supplier } from './types'

/**
 * Two-way sync between this device's IndexedDB and the shop's Supabase row.
 *
 * IndexedDB is still where a sale is committed — the till never waits on the network, and it
 * keeps working with the wifi down. Supabase is the meeting point: each device pushes what it
 * wrote and pulls what the others wrote.
 *
 * Everyone signs into the SAME shop account, so `user_id` identifies the shop, not the person.
 * Who rang up a sale is already recorded on the ledger row itself (`user_name`).
 *
 * Why this is safe to run on two devices at once:
 *
 *  - The ledger is append-only with UUID keys, so it is a grow-only set: two devices appending
 *    sales can never overwrite each other, in any order, online or off.
 *  - Stock is DERIVED from that ledger, not stored. There is no counter for two devices to
 *    race on — the sum simply includes both their rows once they meet.
 *  - Deletes are tombstones. Nothing is ever removed because it is "missing", which is what
 *    made the previous backup-only design delete the other device's products.
 *
 * The one thing it cannot prevent: two devices, both offline, both selling the last packet.
 * Nothing can, short of requiring the network for every sale. When they reconnect, the ledger
 * adds up to a negative stock — which is surfaced rather than hidden, so the shop recounts.
 */

const CHUNK = 500
const PAGE = 1000
/** Overlap the watermark: an upsert is idempotent, so re-sending is free, whereas a row lost
 *  to a millisecond of clock skew between two devices is lost for good. */
const OVERLAP_MS = 30_000

export type SyncPhase = 'off' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncState {
  phase: SyncPhase
  lastSyncedAt: number | null
  error: string | null
  email: string | null
  /** Stock went below zero: two devices sold the same packet while apart. Needs a recount. */
  oversold: string[]
}

let state: SyncState = {
  phase: 'off', lastSyncedAt: null, error: null, email: null, oversold: [],
}
const listeners = new Set<(s: SyncState) => void>()

export const syncState = (): SyncState => state

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
const PULL_KEY = (uid: string) => `ts.sync.pulled.${uid}`
const PUSH_KEY = (uid: string) => `ts.sync.pushed.${uid}`

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const nOrU = (v: unknown): number | undefined => (v == null ? undefined : n(v))

const rowToProduct = (r: Record<string, unknown>): Product => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  brand: String(r.brand ?? ''),
  cost_price: n(r.cost_price),
  selling_price: n(r.selling_price),
  current_stock: 0, // derived locally; the sender's cache is meaningless here
  reorder_threshold: n(r.reorder_threshold),
  barcode: (r.barcode as string) ?? undefined,
  supplier_id: (r.supplier_id as string) ?? undefined,
  active: Boolean(r.active),
  created_at: nOrU(r.created_at),
  updated_at: nOrU(r.updated_at),
  deleted_at: nOrU(r.deleted_at),
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
  updated_at: nOrU(r.updated_at),
  deleted_at: nOrU(r.deleted_at),
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

async function pushChanges(uid: string): Promise<number> {
  const started = Date.now()
  const wm = Number(localStorage.getItem(PUSH_KEY(uid)) ?? 0)
  const local = await snapshotForSync()

  const products = local.products.filter((p) => (p.updated_at ?? 0) >= wm)
  const suppliers = local.suppliers.filter((s) => (s.updated_at ?? 0) >= wm)

  // A void flips `voided` on an OLD row while writing a NEW reversal row. The old row sits
  // behind the watermark and would never be re-sent, leaving the other devices showing a sale
  // this one cancelled — so drag along whatever a new reversal points at.
  const fresh = local.transactions.filter((t) => t.ts >= wm)
  const voidedIds = new Set(fresh.filter((t) => t.reversal_of).map((t) => t.reversal_of!))
  const revived = local.transactions.filter((t) => voidedIds.has(t.id) && t.ts < wm)
  const txs = [...fresh, ...revived]

  // `current_stock` is deliberately not sent: it is this device's cache of the ledger, and
  // every device derives its own from the rows it has.
  await upsertChunked('products', products.map(({ current_stock: _s, ...p }) => ({ ...p, user_id: uid })))
  await upsertChunked('transactions', txs.map((t) => ({ ...t, user_id: uid })))
  await upsertChunked('suppliers', suppliers.map((s) => ({ ...s, user_id: uid })))

  localStorage.setItem(PUSH_KEY(uid), String(started - OVERLAP_MS))
  return products.length + txs.length + suppliers.length
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

async function fetchSince(
  table: string, uid: string, column: string, since: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase!
      .from(table)
      .select('*')
      .eq('user_id', uid)
      .gte(column, since)
      .order(column, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

async function pullChanges(uid: string): Promise<number> {
  const started = Date.now()
  const wm = Number(localStorage.getItem(PULL_KEY(uid)) ?? 0)

  const [p, t, s] = await Promise.all([
    fetchSince('products', uid, 'updated_at', wm),
    fetchSince('transactions', uid, 'ts', wm),
    fetchSince('suppliers', uid, 'updated_at', wm),
  ])

  // A void updates an OLD ledger row in place; its `ts` never moves, so a ts-based pull would
  // never see it. Fetch anything flagged voided so the cancellation reaches this device too.
  const { data: voided, error } = await supabase!
    .from('transactions').select('*').eq('user_id', uid).eq('voided', true)
  if (error) throw new Error(`transactions: ${error.message}`)

  const changed = await mergeRemote({
    products: p.map(rowToProduct),
    transactions: [...t, ...(voided ?? [])].map(rowToTx),
    suppliers: s.map(rowToSupplier),
  })

  localStorage.setItem(PULL_KEY(uid), String(started - OVERLAP_MS))
  return changed
}

/* ------------------------------------------------------------------ */
/* The sync cycle                                                      */
/* ------------------------------------------------------------------ */

let running = false
let again = false

export async function syncNow(): Promise<{ pushed: number; pulled: number }> {
  if (!supabase) return { pushed: 0, pulled: 0 }

  const session = await currentSession()
  if (!session) {
    setState({ phase: 'signed-out', email: null })
    return { pushed: 0, pulled: 0 }
  }
  if (!navigator.onLine) {
    setState({ phase: 'offline' })
    return { pushed: 0, pulled: 0 }
  }
  // One cycle at a time: two overlapping cycles would race on the watermarks.
  if (running) {
    again = true
    return { pushed: 0, pulled: 0 }
  }

  running = true
  const uid = session.user.id
  setState({ phase: 'syncing', error: null, email: session.user.email ?? null })

  try {
    // Push first: our rows must be up there before we pull, or a pull that arrives between
    // the two would look like the truth and our unsent sale would sit unseen for a cycle.
    const pushed = await pushChanges(uid)
    const pulled = await pullChanges(uid)

    const now = Date.now()
    localStorage.setItem(LAST_KEY(uid), String(now))
    setState({ phase: 'idle', lastSyncedAt: now, error: null, oversold: await findOversold() })
    return { pushed, pulled }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sinxronlash xatoligi'
    setState({ phase: navigator.onLine ? 'error' : 'offline', error: msg })
    throw new Error(msg)
  } finally {
    running = false
    if (again) { again = false; void syncNow().catch(() => {}) }
  }
}

/**
 * Negative stock means two devices sold the same packet while they couldn't see each other.
 * The ledger is still correct — it faithfully records both sales — but the shelf disagrees,
 * so this must be shown to a human rather than quietly clamped to zero.
 */
async function findOversold(): Promise<string[]> {
  const { products } = await snapshotForSync()
  return products.filter((p) => !p.deleted_at && p.current_stock < 0).map((p) => p.name)
}

/* ------------------------------------------------------------------ */
/* Auto-sync                                                           */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout> | null = null
let started = false

function schedule(delay = 2000) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void syncNow().catch(() => {
      /* reflected in state; the next write, tick, or reconnect retries */
    })
  }, delay)
}

export function startAutoSync(): () => void {
  if (!supabase || started) return () => {}
  started = true

  const boot = (uid: string | null, email: string | null) => {
    if (!uid) return setState({ phase: 'signed-out', email: null, lastSyncedAt: null, oversold: [] })
    setState({
      phase: 'idle',
      email,
      lastSyncedAt: Number(localStorage.getItem(LAST_KEY(uid)) ?? 0) || null,
    })
    schedule(500)
  }

  void currentSession().then((s) => boot(s?.user.id ?? null, s?.user.email ?? null))

  const offAuth = supabase.auth.onAuthStateChange((_e, s) =>
    boot(s?.user.id ?? null, s?.user.email ?? null),
  )

  // Push whatever this device just wrote.
  const offDb = subscribe(() => schedule())

  // Pull whatever the other devices just wrote, the moment they write it.
  const channel = supabase
    .channel('shop-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => schedule(300))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => schedule(300))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'suppliers' }, () => schedule(300))
    .subscribe()

  // Realtime can drop a message on a flaky shop connection, so a slow heartbeat backs it up:
  // worst case the other till's sale shows up a minute late, rather than never.
  const beat = setInterval(() => schedule(0), 60_000)

  const onOnline = () => schedule(300)
  const onOffline = () => setState({ phase: 'offline' })
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  if (!navigator.onLine) setState({ phase: 'offline' })

  return () => {
    started = false
    if (timer) clearTimeout(timer)
    clearInterval(beat)
    offAuth.data.subscription.unsubscribe()
    offDb()
    void supabase?.removeChannel(channel)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}

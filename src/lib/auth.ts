/**
 * Staff accounts, local to this browser.
 *
 * Passwords are hashed with PBKDF2-SHA-256 and a per-account salt, via the Web Crypto API that
 * both the browser and the Node test harness provide. The plain password is only ever held in a
 * local variable long enough to derive the hash; it is never stored and never logged.
 *
 * This is a UX gate on a trusted till, not server-enforced security — the hashes live in
 * IndexedDB, which a determined person with dev-tools could read. That is the right level for a
 * shop POS, and nothing here pretends to more.
 */
import { STORES, tx, get, put, getAll, newId, notify, subscribe } from './idb'
import type { Account, Capability, Role } from './types'

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder()
const ITERATIONS = 100_000

const toB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  // Backed by an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>, which the Web
  // Crypto signatures require (TS distinguishes it from a SharedArrayBuffer-backed view).
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256,
  )
  return toB64(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)))
  return { salt: toB64(salt), hash: await derive(password, salt) }
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  return (await derive(password, fromB64(salt))) === hash
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

const allAccounts = (): Promise<Account[]> =>
  tx([STORES.users], 'readonly', (t) => getAll<Account>(t, STORES.users))

export const listAccounts = (): Promise<Account[]> =>
  allAccounts().then((rows) =>
    rows.filter((a) => !a.deleted_at).sort((a, b) => a.name.localeCompare(b.name)),
  )

export const hasAnyAccount = (): Promise<boolean> =>
  listAccounts().then((rows) => rows.length > 0)

export const countAdmins = (): Promise<number> =>
  listAccounts().then((rows) => rows.filter((a) => a.role === 'admin').length)

export const getAccount = (id: string): Promise<Account | null> =>
  tx([STORES.users], 'readonly', (t) => get<Account>(t, STORES.users, id)).then((a) =>
    a && !a.deleted_at ? a : null,
  )

const norm = (name: string) => name.trim().toLowerCase()

export async function createAccount(
  input: { name: string; role: Role; password: string },
): Promise<Account> {
  const name = input.name.trim()
  if (!name) throw new Error('Ism kiritilmadi')
  if (!input.password) throw new Error('Parol kiritilmadi')

  const existing = await listAccounts()
  if (existing.some((a) => norm(a.name) === norm(name))) {
    throw new Error('Bu nom band')
  }

  const { salt, hash } = await hashPassword(input.password)
  const now = Date.now()
  const account: Account = {
    id: newId(), name, role: input.role,
    salt, password_hash: hash, created_at: now, updated_at: now,
  }
  await tx([STORES.users], 'readwrite', (t) => put(t, STORES.users, account))
  notify()
  return account
}

export async function updateAccountPassword(id: string, password: string): Promise<void> {
  if (!password) throw new Error('Parol kiritilmadi')
  const { salt, hash } = await hashPassword(password)
  await tx([STORES.users], 'readwrite', async (t) => {
    const cur = await get<Account>(t, STORES.users, id)
    if (!cur) throw new Error('Hisob topilmadi')
    await put(t, STORES.users, { ...cur, salt, password_hash: hash, updated_at: Date.now() })
  })
  notify()
}

/** Soft delete. Refuses the last admin — that would lock everyone out of the admin screens. */
export async function removeAccount(id: string): Promise<void> {
  await tx([STORES.users], 'readwrite', async (t) => {
    const cur = await get<Account>(t, STORES.users, id)
    if (!cur || cur.deleted_at) return
    if (cur.role === 'admin') {
      const all = await getAll<Account>(t, STORES.users)
      const admins = all.filter((a) => !a.deleted_at && a.role === 'admin')
      if (admins.length <= 1) throw new Error("Oxirgi administratorni o'chirib bo'lmaydi")
    }
    const now = Date.now()
    await put(t, STORES.users, { ...cur, deleted_at: now, updated_at: now })
  })
  notify()
}

/** Returns the account on a correct name+password, else null. One generic failure, on purpose. */
export async function login(name: string, password: string): Promise<Account | null> {
  const account = (await listAccounts()).find((a) => norm(a.name) === norm(name))
  if (!account) return null
  return (await verifyPassword(password, account.salt, account.password_hash)) ? account : null
}

export function watchAccounts(cb: (rows: Account[]) => void): () => void {
  let alive = true
  const run = () => { void listAccounts().then((r) => { if (alive) cb(r) }) }
  run()
  const off = subscribe(run)
  return () => { alive = false; off() }
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

/**
 * The single source of truth for who may do what. Every capability is admin-only today; a
 * cashier just sells and browses products. Widening one to cashiers later is one edit here.
 */
const CAPABILITIES: Record<Capability, Role[]> = {
  'view-dashboard': ['admin'],
  'receive-stock': ['admin'],
  'view-firms': ['admin'],
  'view-reports': ['admin'],
  'manage-products': ['admin'],
  void: ['admin'],
  'manage-staff': ['admin'],
}

export const can = (role: Role, cap: Capability): boolean => CAPABILITIES[cap].includes(role)

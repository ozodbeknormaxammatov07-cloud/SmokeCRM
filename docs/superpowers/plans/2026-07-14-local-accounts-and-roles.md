# Local Accounts & Role Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-typed roles and Supabase sync with per-person local accounts (hashed passwords), where an admin sees everything and a cashier can only sell and look up products.

**Architecture:** Accounts live in a new IndexedDB `users` store, passwords hashed with PBKDF2 via `crypto.subtle`. A single `can(role, capability)` helper drives every gate — nav, route guard, and in-screen controls. The Supabase sync layer is deleted; data lives only in this browser.

**Tech Stack:** TypeScript, React 18, IndexedDB (raw, via `src/lib/idb.ts`), Web Crypto (`crypto.subtle`), Tailwind, Vite, HashRouter. Tests are plain scripts bundled by esbuild — no framework.

## Global Constraints

- **All UI copy is Uzbek (Latin).** Match the existing tone.
- **IDs are `newId()`** from `src/lib/idb.ts`. Timestamps are `Date.now()` epoch ms.
- **Passwords are never stored in plain text and never logged.** Only `{ salt, password_hash }` (both base64) are persisted, via PBKDF2-SHA-256.
- **`can(role, capability)` is the ONLY authority for gating.** No scattered `role === 'admin'` in components.
- **The role gate is a UX boundary, not server-enforced security** (client-side, per the spec). Do not claim otherwise in copy or comments.
- **The `users` store is never written to an Excel backup and never cleared by restore.** A backup file must not carry password hashes.
- Run `npm run check` (unit) and `npx tsc -b` (types) before every commit; `npm run build` before the final one.

---

### Task 1: Remove the Supabase sync layer

Isolate the app from the cloud first, so nothing new is built on a layer that's going away.

**Files:**
- Delete: `src/lib/sync.ts`, `src/lib/supabase.ts`, `src/components/CloudBackup.tsx`, `supabase/schema.sql`
- Modify: `src/store.tsx` (drop `startAutoSync`), `src/pages/Reports.tsx` (drop `CloudBackup`), `src/lib/db.ts` (drop `snapshotForSync`, `mergeRemote`, `SyncSnapshot`), `package.json` (drop dependency)
- Modify: `tests/procurement.check.ts` (remove the merge-only tests)

**Interfaces:**
- Consumes: nothing.
- Produces: an app with no Supabase references. `db.ts` still exports `recomputeStock`, `exportBackup`, `restoreBackup`.

- [ ] **Step 1: Delete the four cloud files**

```bash
git rm src/lib/sync.ts src/lib/supabase.ts src/components/CloudBackup.tsx supabase/schema.sql
```

- [ ] **Step 2: Drop `startAutoSync` from the store**

In `src/store.tsx`, remove the import line `import { startAutoSync } from './lib/sync'` and remove `startAutoSync(),` from the `stops` array (the line and its comment about cloud backup being additive).

- [ ] **Step 3: Drop `CloudBackup` from Reports**

In `src/pages/Reports.tsx`, remove `import CloudBackup from '../components/CloudBackup'` and the `<CloudBackup />` element (around line 251).

- [ ] **Step 4: Remove the sync-only functions from `db.ts`**

In `src/lib/db.ts`, delete the entire "Sync: snapshot out, merge in" section — the `SyncSnapshot` interface, `snapshotForSync`, and `mergeRemote`. Keep `exportBackup`, `restoreBackup`, `recomputeStock`, `initDb`, and everything else. After deleting, if `recomputeStock` is now referenced only within `db.ts`, leave its `export` — Task-later code doesn't need it, but `procurement.ts` still imports it, so it MUST stay exported.

- [ ] **Step 5: Remove the merge tests from the procurement suite**

In `tests/procurement.check.ts`: remove the import of `snapshotForSync, mergeRemote` from `../src/lib/db` (keep `exportBackup, restoreBackup, createProduct, commitCart, fetchAllTransactions`). Delete the three test blocks that call them: `=== merge is idempotent ===`, `=== a stale device cannot un-void a delivery or a payment ===`, and `=== a BACKDATED delivery still replicates ===`, plus the `=== merging a delivery rebuilds the stock it carries ===` block. Keep everything else (deliveries, payments, orders, balances, backup round-trip, v1 restore).

- [ ] **Step 6: Drop the dependency**

In `package.json`, remove the line `"@supabase/supabase-js": "2.110.5",` from `dependencies`. Then:

```bash
npm install
```

- [ ] **Step 7: Verify nothing references the cloud**

Run: `git grep -n "supabase\|startAutoSync\|CloudBackup\|snapshotForSync\|mergeRemote" -- src tests`
Expected: no matches.

Run: `npm run check` → all suites pass. `npx tsc -b` → no errors. `npm run build` → succeeds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Remove the Supabase sync layer; data lives only in this browser"
```

---

### Task 2: Accounts store, hashing, and the `can` helper

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/idb.ts` (DB v2 → v3, add `users` store)
- Create: `src/lib/auth.ts`
- Test: `tests/auth.check.ts` (create)

**Interfaces:**
- Consumes: `tx, get, put, getAll, newId, notify, subscribe` from `idb.ts`.
- Produces:
  - types `Account`, `Capability`
  - `hashPassword(password: string): Promise<{ salt: string; hash: string }>`
  - `verifyPassword(password: string, salt: string, hash: string): Promise<boolean>`
  - `hasAnyAccount(): Promise<boolean>`
  - `listAccounts(): Promise<Account[]>` (non-deleted, sorted by name)
  - `countAdmins(): Promise<number>`
  - `createAccount(input: { name: string; role: Role; password: string }): Promise<Account>`
  - `updateAccountPassword(id: string, password: string): Promise<void>`
  - `removeAccount(id: string): Promise<void>`
  - `login(name: string, password: string): Promise<Account | null>`
  - `getAccount(id: string): Promise<Account | null>`
  - `watchAccounts(cb: (rows: Account[]) => void): () => void`
  - `can(role: Role, cap: Capability): boolean`

- [ ] **Step 1: Add the types**

Append to `src/lib/types.ts`:

```ts
/** A staff login. Password is stored only as a PBKDF2 hash + per-account salt (both base64). */
export interface Account {
  id: string
  /** The login handle. Unique case-insensitively. */
  name: string
  role: Role
  salt: string
  password_hash: string
  created_at: number
  updated_at: number
  /** Soft delete: a removed cashier can't log in, but their name stays on past ledger rows. */
  deleted_at?: number
}

/**
 * A gated ability. Every one is admin-only today; the map in auth.ts is the single place that
 * decides, so widening a capability to cashiers later is one edit, not a hunt through the UI.
 */
export type Capability =
  | 'view-dashboard'
  | 'receive-stock'
  | 'view-firms'
  | 'view-reports'
  | 'manage-products'
  | 'void'
  | 'manage-staff'
```

- [ ] **Step 2: Add the `users` store at DB version 3**

In `src/lib/idb.ts`, change `const DB_VERSION = 2` to `const DB_VERSION = 3`, add `users: 'users',` to the `STORES` map, and inside `req.onupgradeneeded`, after the payments block, add:

```ts
      // v3 — staff accounts. Guarded like the rest, so upgrading keeps every existing row.
      if (!db.objectStoreNames.contains(STORES.users)) {
        const s = db.createObjectStore(STORES.users, { keyPath: 'id' })
        s.createIndex('name', 'name')
      }
```

(The existing store-existence check in `openDb` reads `Object.values(STORES)`, so it now also verifies `users` — no change needed there.)

- [ ] **Step 3: Write the failing test**

Create `tests/auth.check.ts`:

```ts
import 'fake-indexeddb/auto'
import {
  hashPassword, verifyPassword, hasAnyAccount, listAccounts, countAdmins,
  createAccount, updateAccountPassword, removeAccount, login, can,
} from '../src/lib/auth'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

async function main() {
  console.log('\n=== password hashing ===')
  const a = await hashPassword('parol123')
  const b = await hashPassword('parol123')
  ok('same password, different salts -> different hashes', a.hash !== b.hash)
  ok('correct password verifies', await verifyPassword('parol123', a.salt, a.hash))
  ok('wrong password rejected', !(await verifyPassword('boshqa', a.salt, a.hash)))

  console.log('\n=== first account bootstraps as admin ===')
  ok('no accounts yet', !(await hasAnyAccount()))
  const admin = await createAccount({ name: 'Ahmadjon', role: 'admin', password: 'admin1' })
  eq('admin created', admin.role, 'admin')
  ok('now there is an account', await hasAnyAccount())
  ok('password is not stored in plain text', !JSON.stringify(admin).includes('admin1'))

  console.log('\n=== login ===')
  ok('login with correct password', !!(await login('Ahmadjon', 'admin1')))
  ok('login is case-insensitive on name', !!(await login('ahmadjon', 'admin1')))
  ok('login with wrong password fails', !(await login('Ahmadjon', 'nope')))
  ok('login unknown user fails', !(await login('Nobody', 'admin1')))

  console.log('\n=== duplicate names refused ===')
  let threw: unknown = null
  try { await createAccount({ name: 'ahmadjon', role: 'cashier', password: 'x' }) } catch (e) { threw = e }
  ok('duplicate name (case-insensitive) refused', threw instanceof Error)

  console.log('\n=== the last admin cannot be removed ===')
  const cashier = await createAccount({ name: 'Dilnoza', role: 'cashier', password: 'kassa1' })
  eq('two accounts listed', (await listAccounts()).length, 2)
  eq('one admin', await countAdmins(), 1)
  threw = null
  try { await removeAccount(admin.id) } catch (e) { threw = e }
  ok('removing the only admin is refused', threw instanceof Error)

  await removeAccount(cashier.id)
  eq('cashier removed (soft) -> one account listed', (await listAccounts()).length, 1)
  ok('a removed account cannot log in', !(await login('Dilnoza', 'kassa1')))

  console.log('\n=== password reset ===')
  await updateAccountPassword(admin.id, 'yangi1')
  ok('old password no longer works', !(await login('Ahmadjon', 'admin1')))
  ok('new password works', !!(await login('Ahmadjon', 'yangi1')))

  console.log('\n=== the capability matrix ===')
  const caps = ['view-dashboard','receive-stock','view-firms','view-reports','manage-products','void','manage-staff'] as const
  ok('admin can do everything', caps.every((c) => can('admin', c)))
  ok('cashier can do none of the gated things', caps.every((c) => !can('cashier', c)))

  console.log(fail === 0 ? '\n✅ ALL AUTH CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `../src/lib/auth` cannot be resolved.

- [ ] **Step 5: Write `src/lib/auth.ts`**

```ts
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
const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256,
  )
  return toB64(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run check` → `✅ ALL AUTH CHECKS PASSED`, other suites still green.
Run: `npx tsc -b` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/idb.ts src/lib/auth.ts tests/auth.check.ts
git commit -m "Local staff accounts: hashed passwords, login, and a can() gate"
```

---

### Task 3: Session in the store, first-admin & login screens, logout

**Files:**
- Modify: `src/store.tsx`
- Create: `src/pages/Login.tsx`
- Modify: `src/App.tsx`
- Test: manual (browser) — auth UI isn't covered by the unit harness; the e2e in Task 6 covers it.

**Interfaces:**
- Consumes: `hasAnyAccount`, `getAccount`, `login`, `createAccount`, `can`, `Account` (Task 2).
- Produces: on the store — `account: Account | null`, `needsSetup: boolean`, `login(name, password): Promise<boolean>`, `logout(): void`, `createFirstAdmin(name, password): Promise<boolean>`; `actor` is now derived from `account`.

- [ ] **Step 1: Replace the free-typed actor with a session in the store**

In `src/store.tsx`:

Remove `loadActor`, `ACTOR_KEY`, the `actor`/`setActor` state, and their entries in the `Store` interface and `value`. Add these imports (the auth functions, plus `Account` on the existing types import):

```ts
import { hasAnyAccount, getAccount, login as authLogin, createAccount } from './lib/auth'
import type { Product, Transaction, Supplier, Delivery, Payment, PurchaseOrder, Account } from './lib/types'
```

Add to the `Store` interface:

```ts
  account: Account | null
  needsSetup: boolean
  actor: { name: string; role: Account['role'] }
  login: (name: string, password: string) => Promise<boolean>
  logout: () => void
  createFirstAdmin: (name: string, password: string) => Promise<boolean>
```

Add state and a session key:

```ts
const SESSION_KEY = 'ts.session'

// ...inside StoreProvider:
  const [account, setAccount] = useState<Account | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
```

Resolve the session once the db is ready. Inside the existing `initDb().then(...)`, after wiring the watchers, add:

```ts
        // Resolve who is logged in, if anyone. A stored session id that no longer maps to a
        // live account (deleted, or a wiped browser) falls back to the login screen.
        void (async () => {
          const anyAccount = await hasAnyAccount()
          setNeedsSetup(!anyAccount)
          const sid = localStorage.getItem(SESSION_KEY)
          if (sid) {
            const a = await getAccount(sid)
            if (a) setAccount(a)
            else localStorage.removeItem(SESSION_KEY)
          }
        })()
```

Add the actions:

```ts
  const login = useCallback(async (name: string, password: string) => {
    const a = await authLogin(name, password)
    if (!a) return false
    localStorage.setItem(SESSION_KEY, a.id)
    setAccount(a)
    setNeedsSetup(false)
    return true
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setAccount(null)
  }, [])

  const createFirstAdmin = useCallback(async (name: string, password: string) => {
    if (await hasAnyAccount()) return false // never create a second "first" admin
    const a = await createAccount({ name, role: 'admin', password })
    localStorage.setItem(SESSION_KEY, a.id)
    setAccount(a)
    setNeedsSetup(false)
    return true
  }, [])

  // Every ledger write is stamped with whoever is signed in. Falls back to a harmless placeholder
  // when signed out — but the app never renders a write path while signed out (see App.tsx).
  const actor = account
    ? { name: account.name, role: account.role }
    : { name: '', role: 'cashier' as const }
```

Add `account, needsSetup, actor, login, logout, createFirstAdmin` to the `value` object.

- [ ] **Step 2: Write the login / first-admin screen**

Create `src/pages/Login.tsx`:

```tsx
import { useState } from 'react'
import { useStore } from '../store'

/**
 * Two faces of the same screen: when the shop has no accounts yet it creates the first
 * administrator; otherwise it signs someone in. No password recovery — a single-owner shop that
 * loses the admin password clears the browser data and starts over (see the design's non-goals).
 */
export default function Login() {
  const { needsSetup, login, createFirstAdmin } = useStore()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    if (!name.trim() || !password) {
      setErr('Ism va parolni kiriting')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const okAuth = needsSetup
        ? await createFirstAdmin(name.trim(), password)
        : await login(name.trim(), password)
      if (!okAuth) setErr("Noto'g'ri ism yoki parol")
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="card p-6 w-full max-w-sm">
        <div className="text-center mb-5">
          <div className="font-bold text-lg tracking-tight">Tamaki Savdo</div>
          <div className="text-sm text-ink-500 mt-0.5">
            {needsSetup ? 'Birinchi administrator hisobini yarating' : 'Tizimga kirish'}
          </div>
        </div>

        <label className="label">Ism</label>
        <input
          className="field mb-3"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          autoComplete="username"
        />

        <label className="label">Parol</label>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
        />

        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}

        <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy}>
          {busy ? '…' : needsSetup ? 'Yaratish va kirish' : 'Kirish'}
        </button>

        {needsSetup && (
          <p className="text-xs text-ink-400 mt-4 text-center">
            Bu hisob administrator bo'ladi — keyin xodimlar qo'shishingiz mumkin.
          </p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Gate the app on the session and replace the switch-role modal with logout**

In `src/App.tsx`:

Add imports:

```tsx
import Login from './pages/Login'
import { can } from './lib/auth'
```

After the existing `error` and `!ready` guards, add — before the main `return`:

```tsx
  if (needsSetup || !account) return <Login />
```

Pull the new fields from the store: change `const { ready, error, actor, setActor } = useStore()` to

```tsx
  const { ready, error, account, needsSetup, actor, logout } = useStore()
```

Delete the whole `<Modal open={userOpen} …>` staff modal and its `userOpen` state and the `setActor` usage. Replace the sidebar user button's `onClick={() => setUserOpen(true)}` with `onClick={logout}` and its label:

```tsx
        <button
          onClick={logout}
          className="m-3 p-3 rounded-lg text-left hover:bg-ink-100 transition-colors"
        >
          <div className="text-sm font-semibold truncate">{actor.name}</div>
          <div className="text-xs text-ink-400">
            {actor.role === 'admin' ? 'Administrator' : 'Kassir'} · chiqish
          </div>
        </button>
```

And the mobile header button similarly: `onClick={logout}` with text `{actor.name}` (leave as-is, just swap the handler). Remove the now-unused `useState`/`Modal`/`Role` imports if nothing else needs them (keep `Modal` only if still used elsewhere in the file — it is not, so remove it and `Toasts` stays).

- [ ] **Step 4: Verify**

Run: `npx tsc -b` → no errors.
Manually: `npm run dev`. First load shows "Birinchi administrator hisobini yarating". Create one → the app appears. Reload → still logged in. Click your name (sidebar) → logged out, login screen. Log back in.

- [ ] **Step 5: Commit**

```bash
git add src/store.tsx src/pages/Login.tsx src/App.tsx
git commit -m "Session-based login: first-admin bootstrap, login screen, logout"
```

---

### Task 4: Role gating — nav, routes, and product controls

**Files:**
- Modify: `src/App.tsx` (nav filter + route guard)
- Modify: `src/pages/Products.tsx` (read-only for cashier)

**Interfaces:**
- Consumes: `can`, `account.role` (Tasks 2–3).
- Produces: a `RequireCap` guard component; nav filtered by capability; Products hides admin-only controls and cost/margin for cashiers.

- [ ] **Step 1: Tag nav items with capabilities and filter them**

In `src/App.tsx`, give the blocked tabs a `cap` and filter the list by the signed-in role:

```tsx
const NAV: { to: string; label: string; icon: string; end?: boolean; cap?: Capability }[] = [
  { to: '/', label: 'Boshqaruv', icon: '📊', end: true, cap: 'view-dashboard' },
  { to: '/sotuv', label: 'Sotuv', icon: '🛒' },
  { to: '/kirim', label: 'Kirim', icon: '📥', cap: 'receive-stock' },
  { to: '/mahsulotlar', label: 'Mahsulotlar', icon: '📦' },
  { to: '/firmalar', label: 'Firmalar', icon: '💼', cap: 'view-firms' },
  { to: '/hisobot', label: 'Hisobot', icon: '📈', cap: 'view-reports' },
]
```

Add the `Capability` type import (`import type { Role, Capability } from './lib/types'`). Where the nav is rendered (both the desktop `<nav>` and the mobile bottom `<nav>`), filter first:

```tsx
  const nav = NAV.filter((n) => !n.cap || can(account.role, n.cap))
```

Use `nav` instead of `NAV` in both `.map` calls. Change the mobile grid to size to the count: replace `grid-cols-6` with a style `style={{ gridTemplateColumns: \`repeat(${nav.length}, minmax(0, 1fr))\` }}` and drop the fixed `grid-cols-*` class. (A cashier sees two tabs; an admin six.)

- [ ] **Step 2: Add a route guard and land cashiers on Sotuv**

In `src/App.tsx`, add a small guard component near the top of the file (below imports):

```tsx
function RequireCap({ cap, children }: { cap: Capability; children: JSX.Element }) {
  const { account } = useStore()
  if (!account || !can(account.role, cap)) return <Navigate to="/sotuv" replace />
  return children
}
```

Wrap the gated routes and fix the catch-all so a cashier's default landing is Sotuv, not the blocked dashboard:

```tsx
        <Routes>
          <Route path="/" element={<RequireCap cap="view-dashboard"><Dashboard /></RequireCap>} />
          <Route path="/sotuv" element={<Sales />} />
          <Route path="/kirim" element={<RequireCap cap="receive-stock"><Restock /></RequireCap>} />
          <Route path="/mahsulotlar" element={<Products />} />
          <Route path="/firmalar" element={<RequireCap cap="view-firms"><Firms /></RequireCap>} />
          <Route path="/firmalar/:id" element={<RequireCap cap="view-firms"><FirmDetail /></RequireCap>} />
          <Route path="/buyurtmalar" element={<RequireCap cap="view-firms"><Orders /></RequireCap>} />
          <Route path="/hisobot" element={<RequireCap cap="view-reports"><Reports /></RequireCap>} />
          <Route path="/xodimlar" element={<RequireCap cap="manage-staff"><Staff /></RequireCap>} />
          <Route path="*" element={<Navigate to={can(account.role, 'view-dashboard') ? '/' : '/sotuv'} replace />} />
        </Routes>
```

Add `import Staff from './pages/Staff'` (created in Task 5 — add the import now; the file exists by the time this task's commit builds only if Task 5 precedes it, so **add the `/xodimlar` route and the `Staff` import in Task 5**, not here). For THIS task, omit the `/xodimlar` line and the `Staff` import; add them in Task 5.

- [ ] **Step 3: Make the product list read-only for a cashier**

In `src/pages/Products.tsx`, import the gate and compute it once:

```tsx
import { can } from '../lib/auth'
// ...
export default function Products() {
  const { products, brands, actor, toast } = useStore()
  const manage = can(actor.role, 'manage-products')
```

Hide the mutating header actions for a cashier — wrap the `actions` prop content:

```tsx
      actions={
        manage ? (
          <>
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>📄 Excel import</button>
            <button className="btn-ghost" onClick={() => exportProducts(products)} disabled={!products.length}>⬇ Eksport</button>
            <button className="btn-primary" onClick={() => setEditing('new')}>+ Mahsulot</button>
          </>
        ) : undefined
      }
```

Hide the cost / unit-profit / margin / value columns and the edit control from a cashier. In the `<thead>`, guard those `<th>`s:

```tsx
                  <th className="th">Mahsulot</th>
                  <th className="th">Brend</th>
                  {manage && <th className="th text-right">Kelish</th>}
                  <th className="th text-right">Sotish</th>
                  {manage && <th className="th text-right">Foyda/dona</th>}
                  {manage && <th className="th text-right">Marja</th>}
                  <th className="th text-right">Qoldiq</th>
                  {manage && <th className="th text-right">Qiymati</th>}
                  {manage && <th className="th"></th>}
```

And the matching `<td>`s in the row — guard the same five cells with `{manage && (...)}`. For the stock cell, a cashier should see the badge but not be able to open the adjust dialog:

```tsx
                      <td className="td text-right">
                        {manage ? (
                          <button onClick={() => setAdjusting(p)} title="Qoldiqni tuzatish">
                            <StockBadge level={level} stock={p.current_stock} />
                          </button>
                        ) : (
                          <StockBadge level={level} stock={p.current_stock} />
                        )}
                      </td>
```

The `{editing && (...)}` and `{adjusting && (...)}` modals can stay — a cashier can never set those states now that the triggers are hidden.

- [ ] **Step 4: Verify**

Run: `npx tsc -b` → no errors. `npm run build` → succeeds.
Manually: log in as the admin, create a cashier via… (Staff screen is Task 5, so for now test the guard by temporarily visiting as admin). Confirm admin still sees all six tabs and the full product table. Full cashier verification happens in Task 6's e2e once Staff exists.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/pages/Products.tsx
git commit -m "Gate nav, routes, and product controls on the signed-in role"
```

---

### Task 5: Xodimlar — staff management (admin only)

**Files:**
- Create: `src/pages/Staff.tsx`
- Modify: `src/App.tsx` (add the `/xodimlar` route + `Staff` import + a nav entry)

**Interfaces:**
- Consumes: `watchAccounts`, `createAccount`, `updateAccountPassword`, `removeAccount`, `countAdmins`, `Account` (Task 2); `RequireCap` (Task 4).
- Produces: the `/xodimlar` screen.

- [ ] **Step 1: Write the staff screen**

Create `src/pages/Staff.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Page, Empty, Modal } from '../components/ui'
import { watchAccounts, createAccount, updateAccountPassword, removeAccount } from '../lib/auth'
import { dateLabel } from '../lib/format'
import type { Account, Role } from '../lib/types'

export default function Staff() {
  const { account, toast } = useStore()
  const [rows, setRows] = useState<Account[]>([])
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<Account | null>(null)

  useEffect(() => watchAccounts(setRows), [])

  const adminCount = rows.filter((a) => a.role === 'admin').length

  const remove = async (a: Account) => {
    if (!confirm(`"${a.name}" hisobi o'chirilsinmi?`)) return
    try {
      await removeAccount(a.id)
      toast("Hisob o'chirildi")
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    }
  }

  return (
    <Page
      title="Xodimlar"
      subtitle="Kim tizimga kira oladi va qanday huquq bilan."
      actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ Xodim</button>}
    >
      {!rows.length ? (
        <Empty icon="👥" title="Xodim yo'q" hint="Yangi xodim qo'shing." />
      ) : (
        <div className="card divide-y divide-ink-100 overflow-hidden">
          {rows.map((a) => (
            <div key={a.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">
                  {a.name}
                  {a.id === account?.id && <span className="ml-2 chip bg-ink-100 text-ink-500">siz</span>}
                </div>
                <div className="text-xs text-ink-400">
                  {a.role === 'admin' ? 'Administrator' : 'Kassir'} · {dateLabel(a.created_at)}
                </div>
              </div>
              <button
                className="text-xs font-semibold text-ink-500 hover:text-ink-900"
                onClick={() => setResetting(a)}
              >
                Parolni almashtirish
              </button>
              {/* The last admin has no remove button — losing it locks everyone out. */}
              {!(a.role === 'admin' && adminCount <= 1) && (
                <button
                  className="text-xs font-semibold text-ink-400 hover:text-red-600"
                  onClick={() => remove(a)}
                >
                  O'chirish
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && <AddStaff onClose={() => setAdding(false)} onDone={(m) => { toast(m); setAdding(false) }} onErr={(m) => toast(m, 'err')} />}
      {resetting && (
        <ResetPassword
          account={resetting}
          onClose={() => setResetting(null)}
          onDone={(m) => { toast(m); setResetting(null) }}
          onErr={(m) => toast(m, 'err')}
        />
      )}
    </Page>
  )
}

function AddStaff({ onClose, onDone, onErr }: {
  onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('cashier')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim() || !password) return onErr('Ism va parolni kiriting')
    setBusy(true)
    try {
      await createAccount({ name: name.trim(), role, password })
      onDone("Xodim qo'shildi")
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Yangi xodim">
      <label className="label">Ism</label>
      <input className="field mb-3" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />

      <label className="label">Lavozim</label>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {(['admin', 'cashier'] as Role[]).map((r) => (
          <button key={r} className={`btn ${role === r ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRole(r)}>
            {r === 'admin' ? 'Administrator' : 'Kassir'}
          </button>
        ))}
      </div>

      <label className="label">Parol</label>
      <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />

      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}

function ResetPassword({ account, onClose, onDone, onErr }: {
  account: Account; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!password) return onErr('Yangi parolni kiriting')
    setBusy(true)
    try {
      await updateAccountPassword(account.id, password)
      onDone('Parol almashtirildi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Parol — ${account.name}`}>
      <label className="label">Yangi parol</label>
      <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Almashtirish'}
      </button>
    </Modal>
  )
}
```

- [ ] **Step 2: Add the route and a nav entry**

In `src/App.tsx`: add `import Staff from './pages/Staff'`. Add the guarded route inside `<Routes>` (as shown in Task 4, Step 2):

```tsx
          <Route path="/xodimlar" element={<RequireCap cap="manage-staff"><Staff /></RequireCap>} />
```

Add a nav entry so an admin can reach it, after Hisobot:

```tsx
  { to: '/xodimlar', label: 'Xodimlar', icon: '👥', cap: 'manage-staff' },
```

- [ ] **Step 3: Verify**

Run: `npx tsc -b` → no errors. `npm run build` → succeeds.
Manually: as admin, open Xodimlar, add a cashier "Dilnoza". Log out, log in as Dilnoza — you should land on Sotuv and see only Sotuv + Mahsulotlar; the product table shows no cost/margin and no edit. Visit `#/hisobot` in the URL bar → redirected to Sotuv.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Staff.tsx src/App.tsx
git commit -m "Xodimlar: admin-only staff management"
```

---

### Task 6: Keep accounts out of backups, and prove the flow end-to-end

**Files:**
- Test: `tests/auth.check.ts` (extend — backup carries no accounts)
- Modify: `tests/e2e.mjs`

**Interfaces:**
- Consumes: everything above; `exportBackup` from `db.ts`.

- [ ] **Step 1: Assert a backup never carries password hashes**

The `users` store is already outside `BACKUP_STORES` in `db.ts`, so `exportBackup` omits it and `restoreBackup` never clears it. Pin that with a test so a future edit can't quietly add accounts to a shared backup file. Append to `tests/auth.check.ts`, before the final summary (add `import { exportBackup } from '../src/lib/db'` at the top):

```ts
  console.log('\n=== a backup never carries accounts or password hashes ===')
  await createAccount({ name: 'BackupAdmin', role: 'admin', password: 'secretpw' })
  const backup = await exportBackup()
  const serialized = JSON.stringify(backup)
  ok('backup has no users array', !('users' in (backup as Record<string, unknown>)))
  ok('backup does not contain the password anywhere', !serialized.includes('secretpw'))
  ok('backup does not contain any password_hash field', !serialized.includes('password_hash'))
```

- [ ] **Step 2: Run it**

Run: `npm run check` → all suites pass, including the new backup assertions.

- [ ] **Step 3: Extend the e2e with the auth + role flow**

In `tests/e2e.mjs`, the suite starts by loading the app. The app now opens on the first-admin screen, so the very first thing the script must do is create the admin — otherwise every existing step fails at a login wall. Add this right after the browser navigates to the app for the first time (immediately after the initial `page.goto`, before the import-wizard step):

```js
  // The app now opens behind a login. On a fresh browser that means "create the first admin".
  await page.waitForTimeout(800)
  if (await page.getByText('Birinchi administrator').isVisible().catch(() => false)) {
    await page.getByLabel('Ism').fill('Boss')
    await page.getByLabel('Parol').fill('boss123')
    await page.getByRole('button', { name: /Yaratish va kirish/ }).click()
    await page.waitForTimeout(800)
    log('✅', 'create the first administrator', 'landed in the app as Boss (admin)')
  }
```

(If `getByLabel` doesn't resolve — the inputs use `<label>` siblings, not `htmlFor` — target them positionally instead: `page.locator('input').first()` for Ism and `page.locator('input[type=password]')` for Parol.)

Then append a role scenario after the procurement steps (before the mobile-viewport probe):

```js
  // --- roles: an admin creates a cashier, who sees only selling --------------
  await nav('Xodimlar')
  await page.getByRole('button', { name: '+ Xodim' }).click()
  await page.locator('input').first().fill('Dilnoza')
  await page.getByRole('button', { name: 'Kassir' }).click()
  await page.locator('input[type=password]').fill('kassa123')
  await page.getByRole('button', { name: 'Saqlash' }).click()
  await page.waitForTimeout(600)
  log('✅', 'admin creates a cashier account', 'Dilnoza (Kassir) added in Xodimlar')

  // Log out, log in as the cashier.
  await page.getByText('Boss').first().click()          // sidebar user -> logout
  await page.waitForTimeout(500)
  await page.locator('input').first().fill('Dilnoza')
  await page.locator('input[type=password]').fill('kassa123')
  await page.getByRole('button', { name: 'Kirish' }).click()
  await page.waitForTimeout(800)

  const cashierNav = await page.locator('aside nav').innerText().catch(() => await page.locator('body').innerText())
  const hidesAdmin = !/Firmalar|Hisobot|Kirim|Boshqaruv/.test(cashierNav)
  log(hidesAdmin ? '🔍' : '❌', 'PROBE: the cashier nav hides admin areas',
    'only Sotuv and Mahsulotlar are offered')
  if (!hidesAdmin) problems.push(`Cashier saw admin tabs: ${cashierNav.slice(0, 160)}`)

  // The route guard: typing a blocked URL bounces the cashier back to Sotuv.
  await page.goto(`${URL}#/hisobot`)
  await page.waitForTimeout(600)
  const bounced = page.url().endsWith('#/sotuv') || /Sotuv/.test(await page.locator('main').innerText())
  log(bounced ? '🔍' : '❌', 'PROBE: a blocked URL redirects the cashier',
    '#/hisobot bounced back to Sotuv')
  if (!bounced) problems.push(`Cashier reached a blocked route: ${page.url()}`)

  // Cost price must not be visible to the cashier on the product list.
  await nav('Mahsulotlar')
  await page.waitForTimeout(500)
  const noCostColumn = !/Kelish|Marja|Foyda\/dona/.test(await page.locator('table thead').innerText().catch(() => ''))
  log(noCostColumn ? '🔍' : '❌', 'PROBE: the cashier cannot see cost or margin',
    'the product table hides Kelish / Foyda / Marja')
  if (!noCostColumn) problems.push('Cashier saw cost/margin columns')
```

- [ ] **Step 4: Run the full gate**

```bash
npm run check     # auth, db, logic, payables, procurement
npx tsc -b
npm run build
# start a fresh dev server on an unused port, then:
E2E_URL=http://localhost:<port>/ node tests/e2e.mjs
```

Expected: all green. The e2e now creates an admin, walks the sale/procurement flow, then proves the cashier is boxed into selling.

- [ ] **Step 5: Commit**

```bash
git add tests/auth.check.ts tests/e2e.mjs
git commit -m "Prove accounts stay out of backups and cashiers are gated end-to-end"
```

---

## Self-review notes

Checked against the spec:

- **Accounts model / hashing / store** → Task 2. **Bootstrap / login / session / logout** → Task 3. **Role matrix (nav + route + controls)** → Task 4. **Xodimlar** → Task 5. **Remove Supabase incl. merge tests** → Task 1. **Backup excludes accounts** → Task 6. **`can()` as sole authority** → Task 2 defines it; Tasks 4–5 consume it; no `role === 'admin'` outside the CAPABILITIES map (Products/Staff use `can`/derived counts).
- **Naming is consistent:** `Account`, `Capability`, `can(role, cap)`, `hasAnyAccount`, `createAccount`, `login`, `removeAccount`, `updateAccountPassword`, `watchAccounts`, `createFirstAdmin`, `needsSetup`, `account`, `logout` — each defined once and referenced with the same signature after.
- **Ordering dependency handled:** the `/xodimlar` route and `Staff` import are added in Task 5 (where the file exists), explicitly deferred from Task 4 to keep every commit building.
- **Cashier default landing:** the catch-all route and `RequireCap` both send a cashier to `/sotuv`, so the blocked dashboard is never their entry point.

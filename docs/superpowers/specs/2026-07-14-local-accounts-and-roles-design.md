# Local accounts, role gating, and removing cloud sync

Design doc. 2026-07-14.

## Problem

The app has no real access control. Anyone who opens it picks a name and freely flips between
"Administrator" and "Kassir" in a modal — the role is a label stamped on ledger rows, nothing
more. It gates no screen. A cashier can open the reports, see every firm's debt and the shop's
profit, void sales, and edit prices.

Separately, the multi-device Supabase sync has become more machinery than the shop wants. The
owner would rather the data simply live on the till, behind a login, than be mirrored to a
cloud account.

## Goal

- Staff sign in with a **personal account** (name + password). The account, not a free-typed
  string, is who stamps each ledger row.
- An **admin sees everything**. A **cashier is restricted** to selling and looking up products.
- **No cloud.** Data lives only in this browser, as it already does; the Supabase mirror is
  removed entirely.

## Non-goals, and an honest limitation

- **This is not cryptographic security.** Accounts and password hashes live in IndexedDB in the
  browser. The login keeps staff out of the admin screens on a shared till; it does not stop
  someone who opens dev-tools. That is the correct level for a POS on a trusted device, and this
  document does not pretend otherwise. The role gate is a UX boundary, not a server-enforced one.
- **No multi-device anything.** Removing sync means accounts and data are per-browser. Two tills
  would each have their own accounts and their own data. That is the accepted trade.
- **No password recovery flow.** If the sole admin forgets the password, recovery is "clear the
  browser data and start over". A shop with one owner does not need email resets.
- **No per-account audit beyond what the ledger already records** (`user_name`, `user_role` on
  every row).

## Accounts

A new IndexedDB store, `users`:

```
id            string      // newId()
name          string      // the login handle; unique (case-insensitive)
role          'admin' | 'cashier'
salt          string      // random, per account, base64
password_hash string      // PBKDF2(password, salt), base64
created_at    number
updated_at    number
deleted_at?   number      // soft delete, so a removed cashier can't log in but history keeps their name
```

Passwords are hashed with **PBKDF2 (SHA-256) via `crypto.subtle`**, which is present in both the
browser and the Node test harness. A random salt per account means two people with the same
password get different hashes. The plain password is never stored and never leaves the function
that hashes it.

`name` is unique case-insensitively, so "Ali" and "ali" can't both be created and login isn't
ambiguous.

## Authentication flow

**Session** = the logged-in account's `id`, kept in `localStorage` under `ts.session`. A reload
restores it, so a busy till isn't re-entering passwords all day. Logout clears it.

Three states the app can be in at boot:

1. **No accounts exist** → the **first-admin screen**: create the first administrator (name +
   password). This is the only way the first admin is created; there is no seeded default. On
   success the admin is created and logged in.
2. **Accounts exist, no valid session** → the **login screen** (name + password). Wrong name or
   password shows one generic "noto'g'ri" message (never "no such user" vs "wrong password" —
   that only helps someone guessing).
3. **Accounts exist, valid session** → the app, as the session's account.

The current "almashtirish" (switch role) modal in `App.tsx` is **removed**. Its replacement is a
**Logout** action showing the current account's name and role. Changing who you are means
logging out and back in — which is the point of having accounts.

The logged-in account supplies the `actor` (`{ name, role }`) that already flows into every
`createProduct`, `commitCart`, `voidTransaction`, `createDelivery`, `recordPayment`, etc. Those
call sites don't change; only the source of `actor` does — from a free-typed modal to the
session account.

## What each role sees

| Area | Admin | Kassir |
|---|---|---|
| Sotuv (sell) | full | full |
| Mahsulotlar (products) | full — edit, prices, delete | read-only; **cost price and margin hidden**; no add/edit/delete |
| Kirim (receive stock) | full | hidden + route-guarded |
| Firmalar (firms & debt) | full | hidden + route-guarded |
| Hisobot (reports/profit) | full | hidden + route-guarded |
| Boshqaruv (dashboard) | full | hidden + route-guarded |
| Void / delete (anywhere) | yes | no (controls hidden) |
| Xodimlar (manage staff) | full | hidden + route-guarded |

A cashier lands on **Sotuv** after login. Enforcement is two layers, both required:

- **Navigation** hides the tabs a cashier may not use, so the blocked areas aren't offered.
- **Route guard** redirects a cashier who reaches a blocked path any other way (typed URL, a
  stale link, the back button) to `/sotuv`. Hiding a nav item is not access control on its own.

Within the cashier's allowed screens, admin-only *controls* are also hidden: the void button in
sales history, and add/edit/delete/price controls plus the cost and margin columns on the product
list. The cashier sees the selling price (they need it to sell) but not what the shop paid.

The gate is centralised so it can't drift: one `can(actor, capability)` helper (e.g.
`can(actor, 'view-reports')`, `can(actor, 'void')`, `can(actor, 'manage-staff')`), used by both
the nav filter and the route guard and the in-screen controls. Adding a capability later is one
edit, and there is no scattered `role === 'admin'` to fall out of step.

## Staff management (admin only)

A new **Xodimlar** screen where an admin:

- adds an account (name, role, password),
- resets an account's password,
- removes an account (soft delete — the name stays on past ledger rows),
- cannot remove or demote the **last remaining admin** (that would lock everyone out of the
  admin screens with no way back).

## Removing Supabase

Delete, and remove every reference to:

- `src/lib/sync.ts`
- `src/lib/supabase.ts`
- `src/components/CloudBackup.tsx`
- the `@supabase/supabase-js` dependency in `package.json`
- `startAutoSync()` wiring in `src/store.tsx`
- `supabase/schema.sql` (now dead)
- any sync-status UI and the `.env.local` Supabase keys' usage

Local **Excel backup/restore stays** — it's the shop's only backup once the cloud is gone, so it
becomes more important, not less. In `db.ts`, `exportBackup`/`restoreBackup` stay (backup);
`snapshotForSync`/`mergeRemote` existed only for sync and are removed. The `SyncSnapshot` type
goes with them.

Because `mergeRemote`/`snapshotForSync` are removed, the sync-only tests that exercise them in
`tests/procurement.check.ts` — the merge-idempotency, un-void, and backdated-replication cases —
are removed in the same step. They test cloud-merge behaviour that no longer exists. The
delivery, payment, order, balance, and backup tests stay; only the merge block goes. Removing the
backdated-**replication** test does not weaken the backdating guarantee that still matters (that
`created_at` is the write time and `delivered_at` is preserved) — that is covered by the delivery
tests, which stay.

The `users` store must be **excluded from Excel backup/restore** — a backup file is shared and
must never carry password hashes, and restoring one must not silently replace the shop's accounts.
The backup file format is otherwise **unchanged** (it never carried sync fields), so it stays
version 2 and existing backups restore as-is; `users` is simply neither exported nor cleared on
restore, leaving the shop's accounts intact across a restore.

## Files

- `src/lib/auth.ts` (new) — hashing, account CRUD, login/verify, the `users` store access, and
  `can(actor, capability)`.
- `src/lib/types.ts` — add `Account`, `Capability`.
- `src/lib/idb.ts` — add the `users` store; DB version 2 → 3.
- `src/store.tsx` — session state (current account), replaces the free-typed actor; drop
  `startAutoSync`.
- `src/App.tsx` — gate on session: first-admin / login / app; nav filtered by role; route guard;
  Logout replaces the switch-role modal.
- `src/pages/Login.tsx` (new) — first-admin + login screens.
- `src/pages/Staff.tsx` (new) — Xodimlar management.
- `src/pages/Products.tsx`, sales history, dashboard — hide admin-only controls/columns via `can`.
- Delete the Supabase files listed above.

## Testing

**Unit (`tests/auth.check.ts`, fake-indexeddb + `crypto.subtle`):**

- A password hashes and verifies; the same password with different salts gives different hashes.
- A wrong password is rejected; a correct one accepted.
- The first created account bootstraps as admin and logs in.
- A duplicate login name (case-insensitive) is refused.
- Removing the last admin is refused.
- `can()` returns the expected matrix for admin vs cashier.
- A backup export contains no `users` / password hashes.

**E2e (`tests/e2e.mjs`):**

- First run shows the create-first-admin screen; creating it lands in the app.
- An admin creates a cashier account.
- Logging in as the cashier shows only Sotuv; the nav hides Firmalar/Hisobot/Kirim/Boshqaruv.
- Visiting `/hisobot` or `/firmalar` as the cashier redirects to `/sotuv`.
- Logging back in as admin shows everything.

## Implementation order

1. Remove Supabase sync (isolate the app from the cloud first, so nothing new is built on it).
2. `users` store + `auth.ts` (hashing, accounts, login, `can`) with unit tests.
3. Session in the store; first-admin + login screens; logout.
4. Nav filter + route guard + in-screen control hiding via `can`.
5. Xodimlar staff-management screen.
6. Exclude `users` from Excel backup; e2e pass.

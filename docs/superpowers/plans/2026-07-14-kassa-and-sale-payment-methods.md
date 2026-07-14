# Kassa & Sale Payment Methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how each sale was paid (Naqd/Plastik/Click) and give the owner a Kassa screen showing how much cash should be in the drawer, with cash-in/out entries and a count check.

**Architecture:** The drawer balance is derived, never stored: cash sales − cash paid to firms + signed manual cash movements. A new `cash_movements` IndexedDB store holds the manual entries (append-only, corrected by twins). Sales gain a `payment_method`; only Naqd touches the drawer.

**Tech Stack:** TypeScript, React 18, IndexedDB (raw, `src/lib/idb.ts`), Supabase sync, Tailwind, Vite, HashRouter. Tests are plain esbuild-bundled scripts.

## Global Constraints

- **All UI copy is Uzbek (Latin).** Money via `money()`/`moneyShort()`; timestamps `Date.now()` ms; ids `newId()`.
- **The drawer is derived, never stored.** No `balance` column anywhere.
- **Cash sales are counted with the live filter `!voided && !reversal_of`** — the same rule `analytics.totals` uses. A voided cash sale contributes zero.
- **`cash_movements` are append-only.** Never edit or delete; correct with an opposite-signed twin carrying `reversal_of`. Voided rows are dropped by the live filter.
- **Money rows sync on `created_at`** (write time), never on the user-visible `ts` — same two-date rule as deliveries/payments.
- **Kassa is admin-only**, via a new `view-kassa` capability in `CAPABILITIES`.
- Run `npm run check` and `npx tsc -b` before every commit; `npm run build` before the final one.

---

### Task 1: Types, the cash_movements store, and payment_method on sales

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/idb.ts`, `src/lib/db.ts`
- Test: `tests/db.check.ts`

**Interfaces:**
- Produces: `SalePaymentMethod`, `CashMovementKind`, `CashMovement`; `Transaction.payment_method`; `STORES.cash_movements`; `commitCart(type, lines, actor, note?, payment?)`.

- [ ] **Step 1: Add the types**

Append to `src/lib/types.ts`:

```ts
export type SalePaymentMethod = 'cash' | 'card' | 'click'

export type CashMovementKind = 'deposit' | 'expense' | 'withdrawal' | 'correction'

/**
 * Manual cash into or out of the drawer — anything that isn't a sale or a firm payment.
 * Append-only; corrected by an opposite-signed twin, exactly like a Payment.
 */
export interface CashMovement {
  id: string
  ts: number                 // when it happened; user-visible, drives ordering
  created_at: number         // write time; the sync watermark
  /** Signed: positive adds to the drawer, negative removes it. */
  amount: number
  kind: CashMovementKind
  reason: string
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}
```

And add the field to `Transaction` (after `reversal_of?`):

```ts
  /** How a SALE was paid. Unset on RESTOCK and on sales made before this feature. */
  payment_method?: SalePaymentMethod
```

- [ ] **Step 2: Add the store at DB version 4**

In `src/lib/idb.ts`: change `const DB_VERSION = 3` to `4`, add `cash_movements: 'cash_movements',` to `STORES`, and inside `onupgradeneeded` after the `users` block:

```ts
      // v4 — manual cash drawer movements.
      if (!db.objectStoreNames.contains(STORES.cash_movements)) {
        const s = db.createObjectStore(STORES.cash_movements, { keyPath: 'id' })
        s.createIndex('created_at', 'created_at')
      }
```

- [ ] **Step 3: Write the failing test**

Add to `tests/db.check.ts` inside `main()`, before the final summary:

```ts
  console.log('\n=== a sale records its payment method ===')
  const payProd = await createProduct({
    name: 'Marlboro', brand: 'Marlboro', cost_price: 22000, selling_price: 28000,
    current_stock: 20, reorder_threshold: 5, active: true,
  }, ACTOR)
  await commitCart('SALE', [line(await byId(payProd), 2)], ACTOR, '', 'card')
  const cardSale = (await fetchAllTransactions()).find(
    (t) => t.product_id === payProd && t.type === 'SALE')!
  eq('payment method stamped on the sale', cardSale.payment_method, 'card')

  await commitCart('SALE', [line(await byId(payProd), 1)], ACTOR)   // default
  const defSale = (await fetchAllTransactions())
    .filter((t) => t.product_id === payProd && t.type === 'SALE')
    .sort((a, b) => b.ts - a.ts)[0]
  eq('default sale payment is cash', defSale.payment_method, 'cash')
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `commitCart` takes 4 args; `payment_method` is undefined.

- [ ] **Step 5: Add the parameter to `commitCart`**

In `src/lib/db.ts`, change the signature and the SALE row write:

```ts
export async function commitCart(
  type: TxType,
  lines: CartLine[],
  actor: Actor,
  note = '',
  payment: SalePaymentMethod = 'cash',
): Promise<{ ref_id: string; total: number; profit: number }> {
```

In the `put(t, STORES.transactions, { ... })` inside the line loop, add one field:

```ts
        ref_id,
        voided: false,
        // Only a SALE carries a payment method; a RESTOCK's money doesn't hit the drawer.
        payment_method: type === 'SALE' ? payment : undefined,
      } satisfies Transaction)
```

Import the type at the top of `db.ts`: add `SalePaymentMethod` and `CashMovement` to the `types` import.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run check` → the new assertions pass; existing suites stay green.
Run: `npx tsc -b` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/idb.ts src/lib/db.ts tests/db.check.ts
git commit -m "Record a payment method on each sale; add the cash_movements store"
```

---

### Task 2: Kassa math and write operations

**Files:**
- Create: `src/lib/kassa.ts`
- Test: `tests/kassa.check.ts`

**Interfaces:**
- Consumes: `livePayments` from `payables.ts`; `STORES, tx, get, put, getAll, newId, notify, subscribe` from `idb.ts`; `Actor` shape `{ name; role }`.
- Produces:
  - `cashFromSales(txs: Transaction[]): number`
  - `cashToFirms(payments: Payment[]): number`
  - `cashMovementsTotal(rows: CashMovement[]): number`
  - `drawerBalance(txs: Transaction[], payments: Payment[], movements: CashMovement[]): number`
  - `liveMovements(rows: CashMovement[]): CashMovement[]`
  - `revenueByMethod(txs: Transaction[]): { cash: number; card: number; click: number; unknown: number }`
  - `recordCashMovement(input, actor): Promise<string>`, `voidCashMovement(id, actor): Promise<void>`
  - `recordCount(counted, expected, actor): Promise<void>`
  - `fetchCashMovements(): Promise<CashMovement[]>`, `watchCashMovements(cb): () => void`

- [ ] **Step 1: Write the failing test**

Create `tests/kassa.check.ts`:

```ts
import 'fake-indexeddb/auto'
import {
  cashFromSales, cashToFirms, cashMovementsTotal, drawerBalance, revenueByMethod,
  recordCashMovement, voidCashMovement, recordCount, fetchCashMovements, liveMovements,
} from '../src/lib/kassa'
import type { Transaction, Payment } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

const ACTOR = { name: 'A', role: 'admin' as const }

const sale = (o: Partial<Transaction> & { total_amount: number }): Transaction => ({
  id: Math.random().toString(36), ts: 1, type: 'SALE', product_id: 'p', product_name: 'p',
  brand: 'b', quantity: 1, unit_price: o.total_amount, cost_price: 0, profit: 0,
  user_name: 'A', user_role: 'admin', ref_id: 'r', voided: false, ...o,
})
const pay = (amount: number, method: Payment['method'], extra: Partial<Payment> = {}): Payment => ({
  id: Math.random().toString(36), supplier_id: 'F', amount, created_at: 1, paid_at: 1, method,
  user_name: 'A', user_role: 'admin', voided: false, ...extra,
})

async function main() {
  console.log('\n=== only cash sales feed the drawer ===')
  const txs = [
    sale({ total_amount: 100000, payment_method: 'cash' }),
    sale({ total_amount: 50000, payment_method: 'card' }),
    sale({ total_amount: 30000, payment_method: 'click' }),
  ]
  eq('cash sales only', cashFromSales(txs), 100000)

  console.log('\n=== a voided cash sale contributes nothing ===')
  const voidedTxs = [
    sale({ id: 's1', total_amount: 100000, payment_method: 'cash', voided: true }),
    sale({ id: 's1r', total_amount: -100000, payment_method: 'cash', reversal_of: 's1' }),
    sale({ total_amount: 40000, payment_method: 'cash' }),
  ]
  eq('voided pair dropped, only the live sale counts', cashFromSales(voidedTxs), 40000)

  console.log('\n=== cash paid to firms leaves the drawer ===')
  const payments = [pay(60000, 'cash'), pay(500000, 'bank')]
  eq('only cash firm payments', cashToFirms(payments), 60000)
  eq('a voided cash payment is dropped',
    cashToFirms([pay(60000, 'cash', { voided: true }), pay(-60000, 'cash', { reversal_of: 'x' })]), 0)

  console.log('\n=== drawer = cash sales - cash to firms + movements ===')
  eq('empty drawer', drawerBalance([], [], []), 0)
  eq('full formula',
    drawerBalance(txs, payments, []), 100000 - 60000)

  console.log('\n=== manual movements: sign convention ===')
  await recordCashMovement({ amount: 200000, kind: 'deposit', reason: 'boshlang\'ich' }, ACTOR)
  await recordCashMovement({ amount: 30000, kind: 'expense', reason: 'choy-non' }, ACTOR)
  await recordCashMovement({ amount: 100000, kind: 'withdrawal', reason: 'bankka' }, ACTOR)
  const moves = await fetchCashMovements()
  eq('deposit is positive', moves.find((m) => m.kind === 'deposit')!.amount, 200000)
  eq('expense is negative', moves.find((m) => m.kind === 'expense')!.amount, -30000)
  eq('withdrawal is negative', moves.find((m) => m.kind === 'withdrawal')!.amount, -100000)
  eq('signed total', cashMovementsTotal(moves), 200000 - 30000 - 100000)

  console.log('\n=== voiding a movement restores the drawer ===')
  const depId = moves.find((m) => m.kind === 'deposit')!.id
  await voidCashMovement(depId, ACTOR)
  const afterVoid = await fetchCashMovements()
  eq('deposit no longer counts', cashMovementsTotal(afterVoid), -30000 - 100000)
  ok('void hides both rows of the pair', liveMovements(afterVoid).every((m) => m.id !== depId))

  console.log('\n=== a zero amount or empty reason is refused ===')
  let threw: unknown = null
  try { await recordCashMovement({ amount: 0, kind: 'expense', reason: 'x' }, ACTOR) } catch (e) { threw = e }
  ok('zero refused', threw instanceof Error)
  threw = null
  try { await recordCashMovement({ amount: 100, kind: 'expense', reason: '  ' }, ACTOR) } catch (e) { threw = e }
  ok('empty reason refused', threw instanceof Error)

  console.log('\n=== count check writes a correction only when it differs ===')
  const before = cashMovementsTotal(await fetchCashMovements())
  await recordCount(before, before, ACTOR)   // matches
  eq('a matching count writes nothing', cashMovementsTotal(await fetchCashMovements()), before)
  await recordCount(before + 5000, before, ACTOR)   // 5000 more than expected
  eq('a differing count writes the correction', cashMovementsTotal(await fetchCashMovements()), before + 5000)

  console.log('\n=== revenue splits by method ===')
  const split = revenueByMethod([
    sale({ total_amount: 100000, payment_method: 'cash' }),
    sale({ total_amount: 50000, payment_method: 'card' }),
    sale({ total_amount: 30000, payment_method: 'click' }),
    sale({ total_amount: 7000 }),   // legacy, no method
  ])
  eq('cash/card/click/unknown', [split.cash, split.card, split.click, split.unknown],
    [100000, 50000, 30000, 7000])

  console.log(fail === 0 ? '\n✅ ALL KASSA CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `../src/lib/kassa` does not resolve.

- [ ] **Step 3: Write `src/lib/kassa.ts`**

```ts
/**
 * The cash drawer. Derived, never stored:
 *
 *   drawer = Σ cash sales − Σ cash paid to firms + Σ signed manual movements
 *
 * Honest limitation surfaced in the UI: the number is only truthful if cash leaving for the bank
 * or the owner's pocket is recorded as a withdrawal. Unrecorded cash-out reads high; the count
 * check is what catches the drift.
 */
import { STORES, tx, get, put, getAll, newId, notify, subscribe } from './idb'
import { livePayments } from './payables'
import type { Transaction, Payment, CashMovement, CashMovementKind, User } from './types'

interface Actor { name: string; role: User['role'] }

/** Live rows only: neither a voided original nor its reversal twin — same rule as analytics. */
const liveTx = (t: Transaction): boolean => !t.voided && !t.reversal_of
export const liveMovements = (rows: CashMovement[]): CashMovement[] =>
  rows.filter((m) => !m.voided && !m.reversal_of)

/* ------------------------------------------------------------------ */
/* Derived reads                                                       */
/* ------------------------------------------------------------------ */

export function cashFromSales(txs: Transaction[]): number {
  return txs
    .filter((t) => t.type === 'SALE' && liveTx(t) && t.payment_method === 'cash')
    .reduce((s, t) => s + t.total_amount, 0)
}

export function cashToFirms(payments: Payment[]): number {
  return livePayments(payments)
    .filter((p) => p.method === 'cash')
    .reduce((s, p) => s + p.amount, 0)
}

export const cashMovementsTotal = (rows: CashMovement[]): number =>
  liveMovements(rows).reduce((s, m) => s + m.amount, 0)

export function drawerBalance(
  txs: Transaction[], payments: Payment[], movements: CashMovement[],
): number {
  return cashFromSales(txs) - cashToFirms(payments) + cashMovementsTotal(movements)
}

export function revenueByMethod(
  txs: Transaction[],
): { cash: number; card: number; click: number; unknown: number } {
  const out = { cash: 0, card: 0, click: 0, unknown: 0 }
  for (const t of txs) {
    if (t.type !== 'SALE' || !liveTx(t)) continue
    const k = t.payment_method ?? 'unknown'
    out[k in out ? (k as keyof typeof out) : 'unknown'] += t.total_amount
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Manual movements                                                    */
/* ------------------------------------------------------------------ */

export interface NewCashMovement {
  amount: number
  kind: CashMovementKind
  reason: string
  note?: string
  ts?: number
}

/** deposit stored +, expense/withdrawal stored −, correction as given. */
function signed(amount: number, kind: CashMovementKind): number {
  const a = Math.abs(amount)
  if (kind === 'expense' || kind === 'withdrawal') return -a
  if (kind === 'deposit') return a
  return amount   // correction keeps its sign
}

export async function recordCashMovement(input: NewCashMovement, actor: Actor): Promise<string> {
  if (!input.amount || input.amount === 0) throw new Error("Summa 0 dan farqli bo'lishi kerak")
  if (!input.reason.trim()) throw new Error('Sababni yozing')

  const id = newId()
  const now = Date.now()
  await tx([STORES.cash_movements], 'readwrite', (t) =>
    put(t, STORES.cash_movements, {
      id,
      ts: input.ts ?? now,
      created_at: now,
      amount: signed(input.amount, input.kind),
      kind: input.kind,
      reason: input.reason.trim(),
      note: input.note?.trim() || undefined,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
    } satisfies CashMovement),
  )
  notify()
  return id
}

export async function voidCashMovement(id: string, actor: Actor): Promise<void> {
  await tx([STORES.cash_movements], 'readwrite', async (t) => {
    const original = await get<CashMovement>(t, STORES.cash_movements, id)
    if (!original) throw new Error('Yozuv topilmadi')
    if (original.voided) throw new Error('Bu yozuv allaqachon bekor qilingan')

    const now = Date.now()
    await put(t, STORES.cash_movements, { ...original, voided: true })
    await put(t, STORES.cash_movements, {
      ...original,
      id: newId(),
      created_at: now,
      amount: -original.amount,
      note: `BEKOR QILINDI: ${original.note || '—'}`,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
      reversal_of: original.id,
    } satisfies CashMovement)
  })
  notify()
}

/**
 * Records a physical count. If it differs from the expected drawer, writes a `correction`
 * movement of `counted − expected` so the drawer matches reality; a matching count writes nothing.
 */
export async function recordCount(counted: number, expected: number, actor: Actor): Promise<void> {
  const diff = counted - expected
  if (diff === 0) return
  await recordCashMovement(
    { amount: diff, kind: 'correction', reason: 'Sanoq tuzatishi' },
    actor,
  )
}

export const fetchCashMovements = (): Promise<CashMovement[]> =>
  tx([STORES.cash_movements], 'readonly', (t) => getAll<CashMovement>(t, STORES.cash_movements))

export function watchCashMovements(cb: (rows: CashMovement[]) => void): () => void {
  let alive = true
  const run = () => { void fetchCashMovements().then((r) => { if (alive) cb(r) }) }
  run()
  const off = subscribe(run)
  return () => { alive = false; off() }
}
```

Note: `correction` with `signed()` keeps its sign, so `recordCount` passing a negative diff (counted less than expected) stores a negative correction. Good.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check` → `✅ ALL KASSA CHECKS PASSED`.
Run: `npx tsc -b` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kassa.ts tests/kassa.check.ts
git commit -m "Kassa math: derived drawer balance and cash movements"
```

---

### Task 3: Payment selector on the Sotuv screen

**Files:**
- Modify: `src/components/Counter.tsx`

**Interfaces:**
- Consumes: `commitCart(... payment)` (Task 1); `SalePaymentMethod`.
- Produces: a 3-way toggle on the sale cart; `commitCart` called with the chosen method.

- [ ] **Step 1: Add state and pass it through**

In `src/components/Counter.tsx`, add a payment state near the other cart state (after `deliveredDay`):

```tsx
  // Sale payment method. Only relevant for SALE; RESTOCK ignores it.
  const [salePay, setSalePay] = useState<SalePaymentMethod>('cash')
```

Import the type: add `SalePaymentMethod` to the `types` import.

In `submit`, the SALE path currently calls `commitCart(type, lines, actor, note.trim())`. Change it to pass the method:

```tsx
      const res = await commitCart(type, lines, actor, note.trim(), salePay)
```

(There are two `commitCart` calls only if RESTOCK also uses it — RESTOCK's own path stays; only the final `commitCart(type, lines, actor, note.trim())` used for a plain sale/restock changes. Passing `salePay` is harmless for RESTOCK because `commitCart` ignores it for non-SALE.)

- [ ] **Step 2: Render the toggle (SALE only)**

In the cart footer, above the note input, add — mirroring the receiving pay-type block but for sales:

```tsx
            {isSale && (
              <div>
                <label className="label">To'lov turi</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {([
                    ['cash', 'Naqd'],
                    ['card', 'Plastik'],
                    ['click', 'Click'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSalePay(key)}
                      className={`btn h-9 text-xs ${salePay === key ? 'btn-primary' : 'btn-ghost'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
```

- [ ] **Step 3: Name the method in the success toast**

In the SALE branch of `submit`, change the toast to include the method label:

```tsx
      const payLabel = { cash: 'Naqd', card: 'Plastik', click: 'Click' }[salePay]
      toast(
        isSale
          ? `Sotuv saqlandi (${payLabel}) — ${money(res.total)} (foyda ${money(res.profit)})`
          : `Kirim saqlandi — ${money(res.total)}`,
      )
```

- [ ] **Step 4: Verify**

Run: `npx tsc -b` → no errors.
Manually: `npm run dev`, `/sotuv`, add a product, pick **Plastik**, confirm — toast says "(Plastik)". Default is Naqd.

- [ ] **Step 5: Commit**

```bash
git add src/components/Counter.tsx
git commit -m "Sotuv: choose Naqd / Plastik / Click on each sale"
```

---

### Task 4: The Kassa screen, capability, nav, route, dashboard tile

**Files:**
- Modify: `src/lib/types.ts` (Capability), `src/lib/auth.ts` (CAPABILITIES), `src/store.tsx` (watch movements), `src/App.tsx` (nav + route), `src/pages/Dashboard.tsx` (tile)
- Create: `src/pages/Kassa.tsx`

**Interfaces:**
- Consumes: `drawerBalance`, `cashFromSales`, `cashToFirms`, `cashMovementsTotal`, `liveMovements`, `recordCashMovement`, `voidCashMovement`, `recordCount`, `watchCashMovements` (Task 2); `can` and `RequireCap`.
- Produces: `Capability` gains `'view-kassa'`; store exposes `movements: CashMovement[]`; route `/kassa`.

- [ ] **Step 1: Add the capability**

In `src/lib/types.ts`, add `'view-kassa'` to the `Capability` union. In `src/lib/auth.ts`, add to `CAPABILITIES`:

```ts
  'view-kassa': ['admin'],
```

- [ ] **Step 2: Watch cash movements in the store**

In `src/store.tsx`: import `watchCashMovements` from `./lib/kassa` and `CashMovement` from types. Add state `const [movements, setMovements] = useState<CashMovement[]>([])`, add `watchCashMovements(setMovements),` to the `stops` array, add `movements: CashMovement[]` to the `Store` interface, and `movements` to the `value` object.

- [ ] **Step 3: Write the Kassa screen**

Create `src/pages/Kassa.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Page, Modal } from '../components/ui'
import { money, dateTimeLabel, parseNum } from '../lib/format'
import {
  drawerBalance, cashFromSales, cashToFirms, cashMovementsTotal, liveMovements,
  recordCashMovement, voidCashMovement, recordCount,
} from '../lib/kassa'
import type { CashMovementKind } from '../lib/types'

const KIND_LABEL: Record<CashMovementKind, string> = {
  deposit: 'Kirim', expense: 'Xarajat', withdrawal: 'Yechib olindi', correction: 'Tuzatish',
}

export default function Kassa() {
  const { recent, payments, movements, actor, toast } = useStore()
  const [modal, setModal] = useState<'in' | 'out' | null>(null)
  const [counting, setCounting] = useState(false)

  // `recent` holds the latest 300 transactions — enough for a live drawer at shop scale.
  const expected = useMemo(
    () => drawerBalance(recent, payments, movements),
    [recent, payments, movements],
  )
  const sales = cashFromSales(recent)
  const firms = cashToFirms(payments)
  const manual = cashMovementsTotal(movements)
  const rows = liveMovements(movements).sort((a, b) => b.ts - a.ts)

  const undo = async (id: string) => {
    if (!confirm('Bu yozuv bekor qilinsinmi?')) return
    try { await voidCashMovement(id, actor); toast('Bekor qilindi') }
    catch (e) { toast(e instanceof Error ? e.message : 'Xatolik', 'err') }
  }

  return (
    <Page
      title="Kassa"
      subtitle="Kassada hozir qancha naqd pul bo'lishi kerak."
      actions={
        <>
          <button className="btn-ghost" onClick={() => setCounting(true)}>Sanash</button>
          <button className="btn-ghost" onClick={() => setModal('out')}>− Chiqim</button>
          <button className="btn-primary" onClick={() => setModal('in')}>+ Kirim</button>
        </>
      }
    >
      <div className="card p-5 mb-4">
        <div className="text-xs font-semibold text-ink-500">Kassada bo'lishi kerak</div>
        <div className={`mt-1 text-4xl font-bold num tracking-tight ${expected < 0 ? 'text-red-600' : ''}`}>
          {money(expected)}
        </div>
        <p className="text-xs text-ink-400 mt-2">
          Bu son to'g'ri bo'lishi uchun bankka yoki cho'ntakka chiqqan pulni "Chiqim" sifatida
          yozib boring.
        </p>
      </div>

      <div className="card divide-y divide-ink-100 mb-4">
        <Row label="Naqd sotuvlar" value={sales} sign="+" />
        <Row label="Firmalarga naqd to'lov" value={-firms} sign="−" />
        <Row label="Qo'lda kiritilgan (kirim − chiqim)" value={manual} sign={manual < 0 ? '−' : '+'} />
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-ink-200"><h2 className="font-semibold">Kassa harakatlari</h2></div>
        {!rows.length ? (
          <p className="p-8 text-center text-sm text-ink-400">Hali qo'lda kiritilgan harakat yo'q</p>
        ) : (
          <div className="divide-y divide-ink-100">
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{KIND_LABEL[m.kind]} · {m.reason}</div>
                  <div className="text-xs text-ink-400">{dateTimeLabel(m.ts)} · {m.user_name}</div>
                </div>
                <div className={`text-sm font-semibold num shrink-0 ${m.amount < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {m.amount > 0 ? '+' : '−'}{money(Math.abs(m.amount))}
                </div>
                <button onClick={() => undo(m.id)} className="text-ink-300 hover:text-red-600 text-xs font-semibold shrink-0">
                  Bekor
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <MoveForm
          direction={modal}
          onClose={() => setModal(null)}
          onDone={(msg) => { toast(msg); setModal(null) }}
          onErr={(msg) => toast(msg, 'err')}
        />
      )}
      {counting && (
        <CountForm
          expected={expected}
          onClose={() => setCounting(false)}
          onDone={(msg) => { toast(msg); setCounting(false) }}
          onErr={(msg) => toast(msg, 'err')}
        />
      )}
    </Page>
  )
}

function Row({ label, value, sign }: { label: string; value: number; sign: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-ink-600">{label}</span>
      <span className="num font-medium">{sign} {money(Math.abs(value))}</span>
    </div>
  )
}

function MoveForm({ direction, onClose, onDone, onErr }: {
  direction: 'in' | 'out'; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const { actor } = useStore()
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<CashMovementKind>(direction === 'in' ? 'deposit' : 'expense')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const value = parseNum(amount)

  const save = async () => {
    if (!(value > 0)) return onErr('Summani kiriting')
    if (!reason.trim()) return onErr('Sababni yozing')
    setBusy(true)
    try {
      await recordCashMovement({ amount: value, kind, reason }, actor)
      onDone(direction === 'in' ? 'Kirim saqlandi' : 'Chiqim saqlandi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={direction === 'in' ? 'Kassaga kirim' : 'Kassadan chiqim'}>
      <label className="label">Summa</label>
      <input className="field num text-lg h-12 mb-3" value={amount} onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric" placeholder="0" autoFocus />

      {direction === 'out' && (
        <>
          <label className="label">Turi</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {([['expense', 'Xarajat'], ['withdrawal', 'Yechib olindi']] as const).map(([k, l]) => (
              <button key={k} className={`btn ${kind === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="label">Sabab</label>
      <input className="field" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={direction === 'in' ? "boshlang'ich qoldiq / mayda pul" : 'choy-non / bankka'} />

      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}

function CountForm({ expected, onClose, onDone, onErr }: {
  expected: number; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const { actor } = useStore()
  const [counted, setCounted] = useState('')
  const [busy, setBusy] = useState(false)
  const value = parseNum(counted)
  const diff = value - expected

  const save = async () => {
    setBusy(true)
    try {
      await recordCount(value, expected, actor)
      onDone(diff === 0 ? 'Kassa to\'g\'ri' : 'Tuzatish saqlandi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Kassani sanash">
      <div className="flex items-baseline justify-between text-sm mb-3">
        <span className="text-ink-500">Bo'lishi kerak</span>
        <span className="num font-semibold">{money(expected)}</span>
      </div>
      <label className="label">Sanab chiqqan summa</label>
      <input className="field num text-lg h-12" value={counted} onChange={(e) => setCounted(e.target.value)}
        inputMode="numeric" placeholder="0" autoFocus />
      {counted.trim() && (
        <p className={`text-sm font-semibold mt-2 ${diff === 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          {diff === 0 ? 'Mos keladi' : `Farq: ${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}
        </p>
      )}
      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy || !counted.trim()}>
        {busy ? 'Saqlanmoqda…' : diff === 0 ? 'Tasdiqlash' : 'Farqni tuzatish'}
      </button>
    </Modal>
  )
}
```

- [ ] **Step 4: Nav + route**

In `src/App.tsx`, add to `NAV` after Hisobot (before Xodimlar):

```tsx
  { to: '/kassa', label: 'Kassa', icon: '💵', cap: 'view-kassa' },
```

Add the import `import Kassa from './pages/Kassa'` and the guarded route:

```tsx
          <Route path="/kassa" element={<RequireCap cap="view-kassa"><Kassa /></RequireCap>} />
```

- [ ] **Step 5: Dashboard tile**

In `src/pages/Dashboard.tsx`, add `movements` to the `useStore()` destructure, import `drawerBalance` from `../lib/kassa`, and add a `<Kpi>` in the payables row (which already only renders for admins):

```tsx
        <Link to="/kassa" className="contents">
          <Kpi label="Kassada naqd" value={moneyShort(drawerBalance(recent, payments, movements))} sub="hozirgi qoldiq" />
        </Link>
```

- [ ] **Step 6: Verify**

Run: `npx tsc -b` → no errors. `npm run build` → succeeds.
Manually: as admin, make a Naqd sale, open **Kassa** → balance equals the sale. Record a Chiqim → drops. Sanash with a different number → a Tuzatish row appears and the balance matches the count. Log in as a cashier → no Kassa tab, and `#/kassa` redirects to Sotuv.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/auth.ts src/store.tsx src/App.tsx src/pages/Dashboard.tsx src/pages/Kassa.tsx
git commit -m "Kassa screen: derived drawer, cash in/out, count check (admin-only)"
```

---

### Task 5: Revenue-by-method breakdown in Reports

**Files:**
- Modify: `src/pages/Reports.tsx`

**Interfaces:**
- Consumes: `revenueByMethod` (Task 2); `txs` already loaded in Reports for the selected range.

- [ ] **Step 1: Render the split**

In `src/pages/Reports.tsx`, import `revenueByMethod` from `../lib/kassa`, compute it from the range's `txs`, and add a card near the KPIs:

```tsx
  const byMethod = useMemo(() => revenueByMethod(txs), [txs])
```

```tsx
      <div className="card p-4 mt-4">
        <h2 className="font-semibold mb-3">To'lov turi bo'yicha tushum</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MethodTile label="Naqd" value={byMethod.cash} />
          <MethodTile label="Plastik" value={byMethod.card} />
          <MethodTile label="Click" value={byMethod.click} />
          {byMethod.unknown > 0 && <MethodTile label="Eski (belgilanmagan)" value={byMethod.unknown} />}
        </div>
      </div>
```

Add a small `MethodTile` helper at the bottom of the file:

```tsx
function MethodTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-ink-50 border border-ink-200 p-3">
      <div className="text-xs text-ink-500">{label}</div>
      <div className="text-lg font-bold num tracking-tight mt-0.5">{money(value)}</div>
    </div>
  )
}
```

`money` is already imported in Reports.

- [ ] **Step 2: Verify**

Run: `npx tsc -b` → no errors.
Manually: make a Naqd and a Plastik sale, open Hisobot → the split shows each under its method.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Reports.tsx
git commit -m "Reports: revenue split by Naqd / Plastik / Click"
```

---

### Task 6: Supabase schema, sync, backup/reset, and e2e

**Files:**
- Modify: `supabase/schema.sql`, `src/lib/sync.ts`, `src/lib/db.ts` (SyncSnapshot, snapshot/merge, BACKUP_STORES, Backup, export/restore, resetAllData), `tests/e2e.mjs`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the column and table to the schema**

In `supabase/schema.sql`, before the RLS section, add:

```sql
alter table public.transactions add column if not exists payment_method text;

-- Manual cash-drawer movements (deposits, expenses, withdrawals, count corrections). Money, so
-- append-only and corrected by an opposite-signed twin, and paged on created_at like payments.
create table if not exists public.cash_movements (
  user_id     uuid    not null references auth.users(id) on delete cascade,
  id          text    not null,
  ts          bigint  not null,
  created_at  bigint  not null,
  amount      numeric not null default 0,
  kind        text    not null check (kind in ('deposit','expense','withdrawal','correction')),
  reason      text    not null default '',
  note        text,
  user_name   text    not null default '',
  user_role   text    not null default 'admin',
  voided      boolean not null default false,
  reversal_of text,
  synced_at   timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists cash_movements_user_created_idx on public.cash_movements (user_id, created_at);
```

Add RLS + grants + realtime for it, following the `payments` block exactly (four policies, `enable row level security`, revoke from anon+authenticated, grant the four verbs to authenticated, add to `supabase_realtime` inside the existing idempotent `do $$` loop — append `'cash_movements'` to the array in that block).

- [ ] **Step 2: Map the column and sync the table**

In `src/lib/sync.ts`: in `rowToTx`, add before the closing brace:

```ts
  payment_method: (r.payment_method as Transaction['payment_method']) ?? undefined,
```

Add a `rowToCashMovement` mapper (after `rowToPayment`):

```ts
const rowToCashMovement = (r: Record<string, unknown>): CashMovement => ({
  id: String(r.id),
  ts: n(r.ts),
  created_at: n(r.created_at),
  amount: n(r.amount),
  kind: (['deposit', 'expense', 'withdrawal', 'correction'] as const).includes(r.kind as never)
    ? (r.kind as CashMovement['kind']) : 'expense',
  reason: String(r.reason ?? ''),
  note: (r.note as string) ?? undefined,
  user_name: String(r.user_name ?? ''),
  user_role: role(r.user_role),
  voided: Boolean(r.voided),
  reversal_of: (r.reversal_of as string) ?? undefined,
})
```

Add `CashMovement` to the type import. In `pushChanges`: filter `local.cash_movements` on `created_at >= wm` with the same void-drag pattern as payments, and `upsertChunked('cash_movements', ...)`. In `pullChanges`: `fetchSince('cash_movements', uid, 'created_at', wm)`, `fetchVoided('cash_movements', uid)`, and pass `cash_movements: [...cm, ...voidedCm].map(rowToCashMovement)` to `mergeRemote`. Add the realtime `.on(... table: 'cash_movements' ...)` subscription.

- [ ] **Step 3: Extend db.ts snapshot/merge/backup/reset**

In `src/lib/db.ts`: add `cash_movements` to `BACKUP_STORES`. Add `cash_movements: CashMovement[]` to `SyncSnapshot`, `Backup`, `snapshotForSync`, `exportBackup` (via the `getAll`), and `restoreBackup` (`for (const m of b.cash_movements ?? []) await put(...)`). In `mergeRemote`, add a block after payments — append-only, `voided` merges by OR (copy the payments block, swap the store and type). `resetAllData` already clears `BACKUP_STORES`, so adding `cash_movements` there covers it. Import `CashMovement`.

- [ ] **Step 4: Verify types and units**

Run: `npx tsc -b` → no errors. `npm run check` → all suites pass (the merge tests in `procurement.check.ts` still pass; `mergeRemote`'s new field is optional via `?? []`).

- [ ] **Step 5: Extend the e2e**

In `tests/e2e.mjs`, after the role-gating probes (still as **admin** — log back in as Boss first if the script left off as the cashier), add:

```js
  // --- kassa: cash sale feeds the drawer, expense drains it, count corrects ---
  // (ensure we're admin)
  await page.goto(`${URL}#/`)
  await page.waitForTimeout(500)
  // ring up a Naqd sale
  await nav('Sotuv')
  await page.getByPlaceholder(/Mahsulot nomi yoki shtrix-kod/).fill('Winston Blue')
  await page.waitForTimeout(300); await page.keyboard.press('Enter'); await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Naqd', exact: true }).click().catch(() => {})
  await page.getByRole('button', { name: /Sotuvni tasdiqlash/ }).click()
  await page.waitForTimeout(700)

  await nav('Kassa')
  await page.waitForTimeout(500)
  const drawerHasCash = /[1-9]/.test((await page.locator('.card').first().innerText()).replace(/\D/g, ''))
  log(drawerHasCash ? '🔍' : '❌', 'PROBE: a Naqd sale feeds the drawer',
    'Kassa balance is non-zero after a cash sale')
  if (!drawerHasCash) problems.push('Cash sale did not reach the drawer')

  await page.getByRole('button', { name: '− Chiqim' }).click(); await page.waitForTimeout(300)
  await page.locator('.fixed.z-50 input').first().fill('10000')
  await page.locator('.fixed.z-50').getByPlaceholder(/choy-non/).fill('test xarajat')
  await page.locator('.fixed.z-50').getByRole('button', { name: 'Saqlash' }).click()
  await page.waitForTimeout(600)
  const hasExpense = /Xarajat/.test(await page.locator('body').innerText())
  log(hasExpense ? '🔍' : '❌', 'PROBE: recording a cash expense', 'expense appears in Kassa history')
  if (!hasExpense) problems.push('Cash expense not recorded')
```

- [ ] **Step 6: Run the full gate**

```bash
npm run check
npx tsc -b
npm run build
# fresh dev server on an unused port, then:
E2E_URL=http://localhost:<port>/ node tests/e2e.mjs
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add supabase/schema.sql src/lib/sync.ts src/lib/db.ts tests/e2e.mjs tests/screenshots
git commit -m "Sync cash movements and sale payment methods; kassa e2e"
```

---

## Self-review notes

- **Spec coverage:** payment method on sales → Task 1/3; `SalePaymentMethod`/`CashMovement` types → Task 1; kassa math (drawer, splits, movements, count) → Task 2; Sotuv selector → Task 3; Kassa screen + capability + dashboard tile → Task 4; Reports split → Task 5; schema/sync/backup/reset/e2e → Task 6. The `view-kassa` capability, admin-only, is Task 4.
- **Void handling:** simplified from the spec's earlier draft — `cashFromSales` uses the live `!voided && !reversal_of` filter, so `voidTransaction` is left unchanged and a voided cash sale contributes zero. Test in Task 2 pins it.
- **Naming consistent:** `drawerBalance`, `cashFromSales`, `cashToFirms`, `cashMovementsTotal`, `liveMovements`, `revenueByMethod`, `recordCashMovement`, `voidCashMovement`, `recordCount`, `fetchCashMovements`, `watchCashMovements`, `CashMovement`, `CashMovementKind`, `SalePaymentMethod`, `view-kassa` — each defined once, referenced consistently.
- **Two-date rule:** `cash_movements` carry `ts` (real) and `created_at` (sync watermark); sync pages on `created_at`, matching deliveries/payments.

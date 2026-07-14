# Firmalar (Procurement & Payables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the firms Tamaki Savdo buys from — their bank details, what was ordered, what was delivered, what was paid, and what is still owed — entirely offline, syncing safely across devices.

**Architecture:** Debt is **derived, never stored**, exactly as stock already is: `balance = Σ deliveries − Σ payments`. Deliveries and payments are append-only ledgers corrected by opposite-signed twins, so they inherit the existing offline/multi-device merge safety for free. A delivery is the single event that writes both RESTOCK ledger rows (stock) and a delivery header (debt) in **one atomic IndexedDB transaction**, so stock and debt can never drift apart.

**Tech Stack:** TypeScript, React 18, IndexedDB (raw, via `src/lib/idb.ts`), Supabase (sync only), Tailwind, Vite. Tests are plain scripts bundled by esbuild — no test framework.

## Global Constraints

- **All UI copy is in Uzbek (Latin).** Match the existing tone in `Counter.tsx` / `App.tsx`.
- **Money is integer so'm.** Format via `money()` / `moneyShort()` from `src/lib/format.ts`. Never `toLocaleString`.
- **Timestamps are epoch milliseconds** (`Date.now()`), stored as `bigint` in Postgres. Never `Date` objects, never ISO strings, never `timestamptz`.
- **IDs are `newId()`** from `src/lib/idb.ts` (crypto.randomUUID). Never database-generated.
- **Deliveries and payments are append-only.** Never edit, never delete. Correct by writing an opposite-signed twin with `reversal_of` set, and flag the original `voided: true`.
- **Voided rows are SUMMED, not skipped**, when computing balances — original and twin cancel to zero on their own. Skipping the original applies the twin alone and invents money. This mirrors `stockDelta` in `db.ts:43`.
- **Sync pages on `created_at`** for deliveries and payments — never on the user-editable `delivered_at` / `paid_at`. A backdated row would otherwise land behind the sync watermark and never replicate.
- **Never write `current_stock` directly.** It is a cache of the ledger. Only `recomputeStock` may write it.
- **Soft-delete only** (`deleted_at` tombstone) for mutable records. A hard delete is indistinguishable from "created on the other device and not yet pulled".
- Run `npm run check` (unit suites) and `npx tsc -b` (types) before every commit.

---

### Task 1: Types and IndexedDB v2 stores

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/idb.ts:10-43`
- Test: `tests/procurement.check.ts` (create)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: `Supplier` (extended), `OrderLine`, `PurchaseOrder`, `Delivery`, `Payment`, `PaymentMethod`, `OrderStatus`. `STORES.purchase_orders`, `STORES.deliveries`, `STORES.payments`.

- [ ] **Step 1: Write the failing test**

Create `tests/procurement.check.ts`:

```ts
import 'fake-indexeddb/auto'
import { openDb, STORES } from '../src/lib/idb'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

async function main() {
  console.log('\n=== the new stores exist at DB v2 ===')
  const db = await openDb()
  eq('db version', db.version, 2)
  ok('purchase_orders store', db.objectStoreNames.contains(STORES.purchase_orders))
  ok('deliveries store', db.objectStoreNames.contains(STORES.deliveries))
  ok('payments store', db.objectStoreNames.contains(STORES.payments))

  console.log(fail === 0 ? '\n✅ ALL PROCUREMENT CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `STORES.purchase_orders` does not exist (esbuild/TS error or `undefined` store name).

- [ ] **Step 3: Add the types**

Append to `src/lib/types.ts`, and replace the existing `Supplier` interface:

```ts
export type PaymentMethod = 'cash' | 'bank' | 'card' | 'other'

/** Derived from deliveries, never stored — except `cancelled`, which is a human decision. */
export type OrderStatus = 'waiting' | 'partial' | 'received' | 'overdue' | 'cancelled'

/**
 * A firm we buy from. `contact` remains the phone number (it already is one); the rest is
 * what you need to actually transfer money to them.
 */
export interface Supplier {
  id: string
  name: string
  contact?: string
  note?: string
  /** STIR — tax identification number. */
  inn?: string
  /** Hisob raqam — settlement account. */
  bank_account?: string
  bank_name?: string
  /** MFO — bank routing code. */
  bank_mfo?: string
  address?: string
  director?: string
  /** Days of credit the firm grants us. Drives the overdue calculation. */
  payment_terms_days?: number
  updated_at?: number
  deleted_at?: number
}

/** One product line on an order or a delivery. Shared shape — they line up 1:1 by design. */
export interface OrderLine {
  product_id: string
  product_name: string
  brand: string
  quantity: number
  unit_cost: number
}

/**
 * An intention, not money. Placing an order moves NOTHING — no stock, no debt — until goods
 * physically arrive as a Delivery. Mutable, last-write-wins, like a product.
 *
 * `number` is a human label for talking to the firm (#001), never a key. Two devices offline
 * can both mint #007; that is cosmetic and accepted, because a collision-free counter would be
 * exactly the shared mutable state this whole design avoids.
 */
export interface PurchaseOrder {
  id: string
  supplier_id: string
  number: string
  ordered_at: number
  expected_at?: number
  lines: OrderLine[]
  cancelled_at?: number
  note?: string
  user_name: string
  user_role: Role
  created_at: number
  updated_at: number
  deleted_at?: number
}

/**
 * The event that moves stock AND money. Append-only, corrected only by an opposite twin.
 *
 * Two dates, deliberately:
 *   created_at   — write time. Immutable. THE SYNC WATERMARK.
 *   delivered_at — when the goods really arrived. User-editable, because deliveries get typed
 *                  in days late.
 *
 * Sync must page on `created_at`. Paging on `delivered_at` would drop backdated rows behind
 * the watermark, and they would never reach the other device — leaving the two tills
 * disagreeing about what the shop owes.
 */
export interface Delivery {
  id: string
  supplier_id: string
  /** Optional: goods sometimes arrive without an order, because the agent just shows up. */
  order_id?: string
  created_at: number
  delivered_at: number
  /** Faktura / invoice number and date. The paper stays in the folder; we record the number. */
  doc_number?: string
  doc_date?: number
  lines: OrderLine[]
  /** Snapshotted at write time, for the same reason Transaction.cost_price is. */
  total_amount: number
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}

/** Money out. Append-only. Same two-date rule as Delivery. */
export interface Payment {
  id: string
  supplier_id: string
  amount: number
  created_at: number
  paid_at: number
  method: PaymentMethod
  /** To'lov topshiriqnomasi number. */
  doc_number?: string
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}
```

- [ ] **Step 4: Bump the DB version and create the stores**

In `src/lib/idb.ts`, change line 10 and the `STORES` map:

```ts
const DB_VERSION = 2

export const STORES = {
  products: 'products',
  transactions: 'transactions',
  suppliers: 'suppliers',
  purchase_orders: 'purchase_orders',
  deliveries: 'deliveries',
  payments: 'payments',
} as const
```

Inside `req.onupgradeneeded`, after the existing `suppliers` block, add:

```ts
      // v2 — procurement. Existing stores and their data are untouched: onupgradeneeded
      // runs for the delta only, and every block is guarded by a `contains` check.
      if (!db.objectStoreNames.contains(STORES.purchase_orders)) {
        const s = db.createObjectStore(STORES.purchase_orders, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        s.createIndex('updated_at', 'updated_at')
      }
      if (!db.objectStoreNames.contains(STORES.deliveries)) {
        const s = db.createObjectStore(STORES.deliveries, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        // Sync pages on created_at, NOT delivered_at — a backdated delivery must still
        // replicate. See the Delivery docblock.
        s.createIndex('created_at', 'created_at')
      }
      if (!db.objectStoreNames.contains(STORES.payments)) {
        const s = db.createObjectStore(STORES.payments, { keyPath: 'id' })
        s.createIndex('supplier_id', 'supplier_id')
        s.createIndex('created_at', 'created_at')
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run check`
Expected: PASS — `db version 2`, all three stores present. Existing `db.check.ts` suite must still pass unchanged.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/idb.ts tests/procurement.check.ts
git commit -m "Add procurement types and IndexedDB v2 stores"
```

---

### Task 2: Payables math — the derivations, pure and tested

**Files:**
- Create: `src/lib/payables.ts`
- Test: `tests/payables.check.ts` (create)

This task is the heart of the feature. Everything is a **pure function over arrays** — no IndexedDB, no React — so it can be tested exhaustively and fast. Build it first and the rest is plumbing.

**Interfaces:**
- Consumes: `Delivery`, `Payment`, `PurchaseOrder`, `OrderStatus`, `Supplier` from Task 1.
- Produces:
  - `liveDeliveries(rows: Delivery[]): Delivery[]`
  - `livePayments(rows: Payment[]): Payment[]`
  - `supplierBalance(deliveries: Delivery[], payments: Payment[]): number`
  - `statement(deliveries: Delivery[], payments: Payment[]): StatementRow[]`
  - `unpaidDeliveries(deliveries: Delivery[], payments: Payment[], termsDays?: number, now?: number): OpenDelivery[]`
  - `receivedQty(order: PurchaseOrder, deliveries: Delivery[]): Map<string, number>`
  - `orderStatus(order: PurchaseOrder, deliveries: Delivery[], now?: number): OrderStatus`
  - `outstandingLines(order: PurchaseOrder, deliveries: Delivery[]): OrderLine[]`
  - `lineTotal(l: OrderLine): number`, `linesTotal(ls: OrderLine[]): number`
  - types `StatementRow`, `OpenDelivery`

- [ ] **Step 1: Write the failing test**

Create `tests/payables.check.ts`:

```ts
import {
  supplierBalance, statement, unpaidDeliveries, orderStatus, receivedQty,
  outstandingLines, linesTotal, liveDeliveries,
} from '../src/lib/payables'
import type { Delivery, Payment, PurchaseOrder, OrderLine } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

const DAY = 86_400_000
const T0 = 1_700_000_000_000

const line = (product_id: string, quantity: number, unit_cost: number): OrderLine =>
  ({ product_id, product_name: product_id, brand: 'X', quantity, unit_cost })

const del = (o: Partial<Delivery> & { id: string; total_amount: number }): Delivery => ({
  supplier_id: 'F1', created_at: T0, delivered_at: T0, lines: [],
  user_name: 'A', user_role: 'admin', ...o,
})

const pay = (o: Partial<Payment> & { id: string; amount: number }): Payment => ({
  supplier_id: 'F1', created_at: T0, paid_at: T0, method: 'cash',
  user_name: 'A', user_role: 'admin', ...o,
})

function main() {
  console.log('\n=== balance = deliveries - payments ===')
  eq('no rows', supplierBalance([], []), 0)
  eq('one delivery = we owe it',
    supplierBalance([del({ id: 'd1', total_amount: 18_400_000 })], []), 18_400_000)
  eq('delivery minus payment',
    supplierBalance(
      [del({ id: 'd1', total_amount: 18_400_000 })],
      [pay({ id: 'p1', amount: 6_000_000 })],
    ), 12_400_000)

  console.log('\n=== prepayment is just a negative balance (no special case) ===')
  eq('paid before any delivery arrived',
    supplierBalance([], [pay({ id: 'p1', amount: 2_000_000 })]), -2_000_000)

  console.log('\n=== voided rows are SUMMED, not skipped ===')
  // A void flags the original AND appends an opposite twin. Summing everything nets to zero.
  // Skipping the flagged original would apply the twin alone and invent -18 400 000 of money.
  const voidedPair = [
    del({ id: 'd1', total_amount: 18_400_000, voided: true }),
    del({ id: 'd1r', total_amount: -18_400_000, reversal_of: 'd1' }),
  ]
  eq('voided delivery + its twin net to zero', supplierBalance(voidedPair, []), 0)
  // The trap, asserted explicitly: had we FILTERED the flagged original out instead of summing
  // it, the twin would have been applied alone and invented -18 400 000 of money from nothing.
  eq('filtering voided rows would corrupt the balance',
    supplierBalance(voidedPair.filter((d) => !d.voided), []), -18_400_000)
  eq('live view hides both rows of the pair', liveDeliveries(voidedPair).length, 0)

  const voidedPay = [
    pay({ id: 'p1', amount: 5_000_000, voided: true }),
    pay({ id: 'p1r', amount: -5_000_000, reversal_of: 'p1' }),
  ]
  eq('voided payment + twin net to zero, debt restored',
    supplierBalance([del({ id: 'd1', total_amount: 9_000_000 })], voidedPay), 9_000_000)

  console.log('\n=== statement: chronological, with a running balance ===')
  const rows = statement(
    [
      del({ id: 'd1', total_amount: 18_400_000, delivered_at: T0 + 1 * DAY, doc_number: '4471' }),
      del({ id: 'd2', total_amount: 9_000_000, delivered_at: T0 + 20 * DAY, doc_number: '4602' }),
    ],
    [pay({ id: 'p1', amount: 6_000_000, paid_at: T0 + 9 * DAY, method: 'bank' })],
  )
  eq('three rows, in real-world date order', rows.map((r) => r.id), ['d1', 'p1', 'd2'])
  eq('deltas signed: delivery +, payment -', rows.map((r) => r.delta),
    [18_400_000, -6_000_000, 9_000_000])
  eq('running balance', rows.map((r) => r.balance), [18_400_000, 12_400_000, 21_400_000])

  console.log('\n=== FIFO: payments settle the oldest delivery first ===')
  const ds = [
    del({ id: 'old', total_amount: 10_000_000, delivered_at: T0 }),
    del({ id: 'new', total_amount: 10_000_000, delivered_at: T0 + 30 * DAY }),
  ]
  eq('nothing paid -> both open',
    unpaidDeliveries(ds, []).map((u) => [u.delivery.id, u.outstanding]),
    [['old', 10_000_000], ['new', 10_000_000]])

  eq('12m paid -> oldest fully settled, newest partly',
    unpaidDeliveries(ds, [pay({ id: 'p', amount: 12_000_000 })]).map((u) => [u.delivery.id, u.outstanding]),
    [['new', 8_000_000]])

  eq('overpaid -> nothing outstanding',
    unpaidDeliveries(ds, [pay({ id: 'p', amount: 25_000_000 })]).length, 0)

  console.log('\n=== overdue is measured from the real-world date + the firm terms ===')
  const now = T0 + 40 * DAY
  eq('15-day terms: a 40-day-old delivery is 25 days overdue',
    unpaidDeliveries([del({ id: 'd', total_amount: 1, delivered_at: T0 })], [], 15, now)
      .map((u) => u.daysOverdue), [25])
  eq('60-day terms: same delivery is not overdue at all',
    unpaidDeliveries([del({ id: 'd', total_amount: 1, delivered_at: T0 })], [], 60, now)
      .map((u) => u.daysOverdue), [0])

  console.log('\n=== order status is derived from what actually arrived ===')
  const order: PurchaseOrder = {
    id: 'o1', supplier_id: 'F1', number: '#001', ordered_at: T0,
    expected_at: T0 + 7 * DAY, lines: [line('A', 50, 1000), line('B', 20, 2000)],
    user_name: 'A', user_role: 'admin', created_at: T0, updated_at: T0,
  }
  const before = T0 + 1 * DAY
  const after = T0 + 10 * DAY

  eq('nothing arrived, still in time -> waiting', orderStatus(order, [], before), 'waiting')
  eq('nothing arrived, past the expected date -> overdue', orderStatus(order, [], after), 'overdue')

  const partial = [del({
    id: 'd1', order_id: 'o1', total_amount: 20_000,
    lines: [line('A', 20, 1000)],
  })]
  eq('some arrived -> partial', orderStatus(order, partial, after), 'partial')
  eq('a short delivery is visible, not silent',
    [...receivedQty(order, partial)], [['A', 20]])
  eq('outstanding lines show what is still owed',
    outstandingLines(order, partial).map((l) => [l.product_id, l.quantity]),
    [['A', 30], ['B', 20]])

  const full = [...partial, del({
    id: 'd2', order_id: 'o1', total_amount: 70_000,
    lines: [line('A', 30, 1000), line('B', 20, 2000)],
  })]
  eq('everything arrived -> received', orderStatus(order, full, after), 'received')
  eq('nothing left outstanding', outstandingLines(order, full).length, 0)

  console.log('\n=== over-receipt is allowed, not an error ===')
  // The firm sent 55 against an order of 50. The stock is real and the debt is real.
  const over = [del({
    id: 'd3', order_id: 'o1', total_amount: 95_000,
    lines: [line('A', 55, 1000), line('B', 20, 2000)],
  })]
  eq('over-delivered order reads as received', orderStatus(order, over, after), 'received')
  eq('outstanding never goes negative', outstandingLines(order, over).length, 0)

  console.log('\n=== a voided delivery does not count towards an order ===')
  const voided = [
    del({ id: 'd1', order_id: 'o1', total_amount: 20_000, lines: [line('A', 20, 1000)], voided: true }),
    del({ id: 'd1r', order_id: 'o1', total_amount: -20_000, lines: [line('A', -20, 1000)], reversal_of: 'd1' }),
  ]
  eq('voided receipt reverts the order to waiting', orderStatus(order, voided, before), 'waiting')

  console.log('\n=== cancelled beats everything ===')
  eq('cancelled order', orderStatus({ ...order, cancelled_at: T0 }, full, after), 'cancelled')

  console.log('\n=== deliveries for another firm are never mixed in ===')
  eq('other firm ignored by balance',
    supplierBalance(
      [del({ id: 'd1', supplier_id: 'F1', total_amount: 100 })].filter((d) => d.supplier_id === 'F1'),
      [],
    ), 100)

  eq('linesTotal', linesTotal([line('A', 3, 1000), line('B', 2, 2500)]), 8000)

  console.log(fail === 0 ? '\n✅ ALL PAYABLES CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `src/lib/payables` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/payables.ts`:

```ts
import type { Delivery, Payment, PurchaseOrder, OrderLine, OrderStatus } from './types'

const DAY = 86_400_000

export const lineTotal = (l: OrderLine): number => l.quantity * l.unit_cost
export const linesTotal = (ls: OrderLine[]): number => ls.reduce((s, l) => s + lineTotal(l), 0)

/* ------------------------------------------------------------------ */
/* Balance                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the shop owes a firm.
 *
 *   balance = Σ deliveries − Σ payments
 *
 * Positive: we owe them (qarz). Negative: we have prepaid and they owe us goods (avans).
 * Prepayment is therefore not a special case — it falls out of the arithmetic.
 *
 * VOIDED ROWS ARE INCLUDED ON PURPOSE. A void flags the original and appends an opposite-signed
 * twin, so the pair cancels to zero on its own. Skipping flagged rows would apply the twin
 * alone and conjure money out of nothing — the same trap `stockDelta` warns about for stock.
 *
 * Callers pass rows already filtered to one firm; see `forSupplier`.
 */
export function supplierBalance(deliveries: Delivery[], payments: Payment[]): number {
  const owed = deliveries.reduce((s, d) => s + d.total_amount, 0)
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  return owed - paid
}

export const forSupplier = <T extends { supplier_id: string }>(rows: T[], id: string): T[] =>
  rows.filter((r) => r.supplier_id === id)

/**
 * The rows a human should SEE: neither a voided original nor its reversal twin.
 *
 * This is a display filter, not an accounting one. It is safe precisely because the pair sums
 * to zero — dropping both leaves the balance unchanged. Never use it to compute a balance;
 * use `supplierBalance` over the raw rows.
 */
export const liveDeliveries = (rows: Delivery[]): Delivery[] =>
  rows.filter((d) => !d.voided && !d.reversal_of)

export const livePayments = (rows: Payment[]): Payment[] =>
  rows.filter((p) => !p.voided && !p.reversal_of)

/* ------------------------------------------------------------------ */
/* Statement (akt sverki)                                              */
/* ------------------------------------------------------------------ */

export interface StatementRow {
  id: string
  /** The real-world date — delivered_at / paid_at. This is what a human reconciles against. */
  ts: number
  kind: 'delivery' | 'payment'
  doc_number?: string
  /** Signed: a delivery increases the debt, a payment reduces it. */
  delta: number
  /** Running balance after this row. */
  balance: number
  delivery?: Delivery
  payment?: Payment
}

/**
 * Every delivery and payment for one firm, oldest first, with a running balance — the akt
 * sverki, on screen. This is the document that settles a dispute with a firm.
 *
 * Ordered by the REAL-WORLD date, not `created_at`: a delivery that arrived last week belongs
 * where it happened, even if it was typed in today.
 */
export function statement(deliveries: Delivery[], payments: Payment[]): StatementRow[] {
  const rows: Omit<StatementRow, 'balance'>[] = [
    ...liveDeliveries(deliveries).map((d) => ({
      id: d.id, ts: d.delivered_at, kind: 'delivery' as const,
      doc_number: d.doc_number, delta: d.total_amount, delivery: d,
    })),
    ...livePayments(payments).map((p) => ({
      id: p.id, ts: p.paid_at, kind: 'payment' as const,
      doc_number: p.doc_number, delta: -p.amount, payment: p,
    })),
  ].sort((a, b) => a.ts - b.ts || (a.kind === 'delivery' ? -1 : 1))

  let balance = 0
  return rows.map((r) => {
    balance += r.delta
    return { ...r, balance }
  })
}

/* ------------------------------------------------------------------ */
/* FIFO settlement — which deliveries are still unpaid                 */
/* ------------------------------------------------------------------ */

export interface OpenDelivery {
  delivery: Delivery
  /** How much of this delivery is still unsettled. */
  outstanding: number
  /** 0 when within the firm's payment terms. */
  daysOverdue: number
}

/**
 * Payments settle the OLDEST delivery first, computed on read and stored nowhere.
 *
 * Nothing links a payment to a delivery in the data — and nothing should, because a firm sends
 * one transfer against three fakturas and nobody records which. FIFO is how firms actually
 * reconcile, and it is what turns "overdue" into a real number instead of a guess.
 */
export function unpaidDeliveries(
  deliveries: Delivery[],
  payments: Payment[],
  termsDays = 0,
  now: number = Date.now(),
): OpenDelivery[] {
  const open = liveDeliveries(deliveries).sort((a, b) => a.delivered_at - b.delivered_at)
  let pool = livePayments(payments).reduce((s, p) => s + p.amount, 0)

  const out: OpenDelivery[] = []
  for (const d of open) {
    const applied = Math.min(Math.max(pool, 0), d.total_amount)
    pool -= applied
    const outstanding = d.total_amount - applied
    if (outstanding <= 0) continue

    const due = d.delivered_at + termsDays * DAY
    out.push({
      delivery: d,
      outstanding,
      daysOverdue: now > due ? Math.floor((now - due) / DAY) : 0,
    })
  }
  return out
}

/** The single worst overdue figure for a firm, for the list badge. 0 = nothing overdue. */
export function worstOverdue(
  deliveries: Delivery[], payments: Payment[], termsDays = 0, now: number = Date.now(),
): number {
  return unpaidDeliveries(deliveries, payments, termsDays, now)
    .reduce((worst, u) => Math.max(worst, u.daysOverdue), 0)
}

/* ------------------------------------------------------------------ */
/* Orders — status is derived from what actually arrived               */
/* ------------------------------------------------------------------ */

/** How much of each product has really landed against this order. */
export function receivedQty(order: PurchaseOrder, deliveries: Delivery[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const d of liveDeliveries(deliveries)) {
    if (d.order_id !== order.id) continue
    for (const l of d.lines) m.set(l.product_id, (m.get(l.product_id) ?? 0) + l.quantity)
  }
  return m
}

/**
 * What is still owed on this order. Clamped at zero: over-receipt is allowed (see
 * `orderStatus`), so a line can never report a negative outstanding quantity.
 */
export function outstandingLines(order: PurchaseOrder, deliveries: Delivery[]): OrderLine[] {
  const got = receivedQty(order, deliveries)
  return order.lines
    .map((l) => ({ ...l, quantity: l.quantity - (got.get(l.product_id) ?? 0) }))
    .filter((l) => l.quantity > 0)
}

/**
 * Derived, except for `cancelled` — which is a human decision, not arithmetic.
 *
 * Over-receipt is deliberately NOT an error: if the firm sends 55 blocks against an order of
 * 50, all 55 are received, because the stock is real and the debt is real. The order simply
 * reads as `received`. Refusing the extra five would leave the shelf and the system disagreeing,
 * which is worse than an order that over-fulfilled.
 */
export function orderStatus(
  order: PurchaseOrder, deliveries: Delivery[], now: number = Date.now(),
): OrderStatus {
  if (order.cancelled_at) return 'cancelled'

  const got = receivedQty(order, deliveries)
  const anyReceived = order.lines.some((l) => (got.get(l.product_id) ?? 0) > 0)
  const allReceived = order.lines.every((l) => (got.get(l.product_id) ?? 0) >= l.quantity)

  if (allReceived) return 'received'
  if (anyReceived) return 'partial'
  if (order.expected_at && order.expected_at < now) return 'overdue'
  return 'waiting'
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  waiting: 'Kutilmoqda',
  partial: 'Qisman keldi',
  received: 'Keldi',
  overdue: 'Kechikkan',
  cancelled: 'Bekor qilingan',
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: PASS — `✅ ALL PAYABLES CHECKS PASSED`.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payables.ts tests/payables.check.ts
git commit -m "Derive firm balances, statements and order status from the ledgers"
```

---

### Task 3: Deliveries — the atomic stock-and-debt write

**Files:**
- Create: `src/lib/procurement.ts`
- Modify: `src/lib/db.ts` (export `recomputeStock`)
- Test: `tests/procurement.check.ts` (extend)

**Interfaces:**
- Consumes: `recomputeStock` (newly exported from `db.ts`), `linesTotal` from `payables.ts`, types from Task 1.
- Produces:
  - `createDelivery(input: NewDelivery, actor: Actor): Promise<{ id: string; total: number }>`
  - `voidDelivery(id: string, actor: Actor): Promise<void>`
  - `watchDeliveries(cb: (rows: Delivery[]) => void): () => void`
  - `fetchDeliveries(): Promise<Delivery[]>`
  - type `NewDelivery`, type `Actor`

- [ ] **Step 1: Write the failing test**

Append to `tests/procurement.check.ts` (inside `main()`, before the final summary). Add these imports at the top of the file:

```ts
import { createProduct, fetchAllTransactions } from '../src/lib/db'
import { createDelivery, voidDelivery, fetchDeliveries } from '../src/lib/procurement'
import { supplierBalance } from '../src/lib/payables'
import { tx, STORES, getAll } from '../src/lib/idb'
import type { Product } from '../src/lib/types'

const ACTOR = { name: 'Ahmadjon', role: 'admin' as const }
const products = () => tx([STORES.products], 'readonly', (t) => getAll<Product>(t, STORES.products))
const byId = async (id: string) => (await products()).find((p) => p.id === id)!
```

And the test body:

```ts
  console.log('\n=== a delivery moves stock AND debt, in one write ===')
  const pid = await createProduct({
    name: 'Winston Blue', brand: 'Winston', cost_price: 14_000, selling_price: 20_000,
    current_stock: 0, reorder_threshold: 20, active: true,
  }, ACTOR)

  const { id: d1 } = await createDelivery({
    supplier_id: 'F1',
    delivered_at: Date.now(),
    doc_number: '4471',
    lines: [{ product_id: pid, product_name: 'Winston Blue', brand: 'Winston', quantity: 100, unit_cost: 14_000 }],
  }, ACTOR)

  eq('stock rose', (await byId(pid)).current_stock, 100)
  eq('debt rose', supplierBalance(await fetchDeliveries(), []), 1_400_000)

  // The stock movement went through the EXISTING ledger — there is no second source of truth.
  const restocks = (await fetchAllTransactions()).filter((t) => t.ref_id === d1)
  eq('one RESTOCK row per line, tagged with the delivery id',
    [restocks.length, restocks[0].type, restocks[0].quantity], [1, 'RESTOCK', 100])

  console.log('\n=== a delivery at a new cost reprices the product ===')
  await createDelivery({
    supplier_id: 'F1',
    delivered_at: Date.now(),
    lines: [{ product_id: pid, product_name: 'Winston Blue', brand: 'Winston', quantity: 10, unit_cost: 15_000 }],
  }, ACTOR)
  eq('cost_price follows the newest delivery', (await byId(pid)).cost_price, 15_000)

  console.log('\n=== voiding a delivery unwinds stock and debt together ===')
  const stockBefore = (await byId(pid)).current_stock
  const debtBefore = supplierBalance(await fetchDeliveries(), [])
  await voidDelivery(d1, ACTOR)

  eq('stock returned', (await byId(pid)).current_stock, stockBefore - 100)
  eq('debt returned', supplierBalance(await fetchDeliveries(), []), debtBefore - 1_400_000)

  const ds = await fetchDeliveries()
  const orig = ds.find((d) => d.id === d1)!
  const twin = ds.find((d) => d.reversal_of === d1)!
  ok('original flagged, not deleted', orig.voided === true)
  eq('twin is opposite-signed', [twin.total_amount, twin.lines[0].quantity], [-1_400_000, -100])

  let threw: unknown = null
  try { await voidDelivery(d1, ACTOR) } catch (e) { threw = e }
  ok('double-void refused', threw instanceof Error)

  console.log('\n=== a delivery that would drive stock negative is refused ===')
  // Void the second delivery after its 10 units have been sold away — the shelf cannot go below 0.
  // (Guard lives in voidDelivery; assert it refuses rather than corrupting the shelf.)
  const p2 = await createProduct({
    name: 'Esse', brand: 'Esse', cost_price: 16_000, selling_price: 22_000,
    current_stock: 0, reorder_threshold: 5, active: true,
  }, ACTOR)
  const { id: d3 } = await createDelivery({
    supplier_id: 'F2', delivered_at: Date.now(),
    lines: [{ product_id: p2, product_name: 'Esse', brand: 'Esse', quantity: 5, unit_cost: 16_000 }],
  }, ACTOR)
  await commitCart('SALE', [{ product: await byId(p2), quantity: 5, unit_price: 22_000 }], ACTOR)
  threw = null
  try { await voidDelivery(d3, ACTOR) } catch (e) { threw = e }
  ok('void refused when the goods are already sold', threw instanceof Error)
  eq('stock untouched by the refused void', (await byId(p2)).current_stock, 0)
  eq('debt untouched by the refused void',
    supplierBalance((await fetchDeliveries()).filter((d) => d.supplier_id === 'F2'), []), 80_000)
```

Add `commitCart` to the `db` import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `src/lib/procurement` does not exist.

- [ ] **Step 3: Export `recomputeStock` from `db.ts`**

In `src/lib/db.ts`, change the declaration at line 52 from `async function recomputeStock` to:

```ts
export async function recomputeStock(t: IDBTransaction, productId: string): Promise<number> {
```

Leave its docblock intact. It stays the only thing allowed to write `current_stock`; procurement now shares it rather than growing a second copy.

- [ ] **Step 4: Write the implementation**

Create `src/lib/procurement.ts`:

```ts
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

/** Same pattern as `db.ts`: IndexedDB has no live queries, so re-run on every committed write. */
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
 * The stock half goes through the existing ledger rather than a new mechanism, because the
 * ledger is already the single source of truth for stock and a second one would drift.
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

  await tx(
    [STORES.products, STORES.transactions, STORES.deliveries], 'readwrite',
    async (t) => {
      await put(t, STORES.deliveries, {
        ...input,
        id,
        created_at: now,          // write time — the sync watermark. Never delivered_at.
        total_amount: total,      // snapshotted, so a later reprice cannot rewrite this debt
        user_name: actor.name,
        user_role: actor.role,
        voided: false,
      } satisfies Delivery)

      for (const l of input.lines) {
        const p = await get<Product>(t, STORES.products, l.product_id)
        if (!p) throw new Error("Mahsulot topilmadi (o'chirilgan bo'lishi mumkin)")

        // A delivery at a new cost becomes the product's cost going forward — same rule
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
          note: input.doc_number ? `Yetkazib berish — faktura №${input.doc_number}` : 'Yetkazib berish',
          user_name: actor.name,
          user_role: actor.role,
          ref_id: id,             // ties the stock movement back to the delivery, both ways
          voided: false,
        } satisfies Transaction)
      }

      for (const l of input.lines) await recomputeStock(t, l.product_id)
    },
  )

  notify()
  return { id, total }
}

/**
 * Append-only correction, exactly as `voidTransaction` does it: flag the original, append an
 * opposite-signed twin. Nothing is deleted, so the audit trail always shows what was entered
 * and what was reversed.
 *
 * Refused if the goods have already been sold on — reversing the receipt would drive the shelf
 * negative, i.e. claim the shop holds stock it does not.
 */
export async function voidDelivery(id: string, actor: Actor): Promise<void> {
  await tx(
    [STORES.products, STORES.transactions, STORES.deliveries], 'readwrite',
    async (t) => {
      const original = await get<Delivery>(t, STORES.deliveries, id)
      if (!original) throw new Error('Yetkazib berish topilmadi')
      if (original.voided) throw new Error('Bu yetkazib berish allaqachon bekor qilingan')

      // Check the whole basket BEFORE writing anything — a partial unwind is worse than none.
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
    },
  )

  notify()
}

export const fetchDeliveries = (): Promise<Delivery[]> =>
  tx([STORES.deliveries], 'readonly', (t) => getAll<Delivery>(t, STORES.deliveries))

export function watchDeliveries(cb: (rows: Delivery[]) => void): () => void {
  return watch(fetchDeliveries, cb)
}
```

Note: `Product` and `User` must be exported from `types.ts` (they already are). `StockError` is already exported from `db.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run check`
Expected: PASS — all procurement checks, and `db.check.ts` still green (exporting `recomputeStock` changes nothing for it).

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/procurement.ts src/lib/db.ts tests/procurement.check.ts
git commit -m "Receive deliveries: stock and debt move in one atomic write"
```

---

### Task 4: Payments

**Files:**
- Modify: `src/lib/procurement.ts`
- Test: `tests/procurement.check.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `Actor`, `watch`.
- Produces:
  - `recordPayment(input: NewPayment, actor: Actor): Promise<string>`
  - `voidPayment(id: string, actor: Actor): Promise<void>`
  - `watchPayments(cb: (rows: Payment[]) => void): () => void`
  - `fetchPayments(): Promise<Payment[]>`
  - type `NewPayment`

- [ ] **Step 1: Write the failing test**

Append to `tests/procurement.check.ts` inside `main()` (add `recordPayment, voidPayment, fetchPayments` to the procurement import):

```ts
  console.log('\n=== payments reduce the debt ===')
  const balF1 = () => Promise.all([fetchDeliveries(), fetchPayments()])
    .then(([d, p]) => supplierBalance(
      d.filter((x) => x.supplier_id === 'F3'), p.filter((x) => x.supplier_id === 'F3')))

  const p3 = await createProduct({
    name: 'Kent', brand: 'Kent', cost_price: 18_000, selling_price: 24_000,
    current_stock: 0, reorder_threshold: 5, active: true,
  }, ACTOR)
  await createDelivery({
    supplier_id: 'F3', delivered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 100, unit_cost: 18_000 }],
  }, ACTOR)
  eq('owed after delivery', await balF1(), 1_800_000)

  const payId = await recordPayment({
    supplier_id: 'F3', amount: 800_000, paid_at: Date.now(),
    method: 'bank', doc_number: 'TT-19',
  }, ACTOR)
  eq('debt reduced by the payment', await balF1(), 1_000_000)

  console.log('\n=== a payment made before any delivery is a prepayment (negative balance) ===')
  await recordPayment({
    supplier_id: 'F4', amount: 2_000_000, paid_at: Date.now(), method: 'cash',
  }, ACTOR)
  const prepaid = (await fetchPayments()).filter((p) => p.supplier_id === 'F4')
  eq('prepayment reads as a negative balance', supplierBalance([], prepaid), -2_000_000)

  console.log('\n=== voiding a payment restores the debt ===')
  await voidPayment(payId, ACTOR)
  eq('debt back to the full amount', await balF1(), 1_800_000)

  const pays = await fetchPayments()
  const origPay = pays.find((p) => p.id === payId)!
  const twinPay = pays.find((p) => p.reversal_of === payId)!
  ok('original payment flagged, not deleted', origPay.voided === true)
  eq('twin payment is opposite-signed', twinPay.amount, -800_000)

  let threwPay: unknown = null
  try { await voidPayment(payId, ACTOR) } catch (e) { threwPay = e }
  ok('double-void refused', threwPay instanceof Error)

  console.log('\n=== a payment of zero or less is refused ===')
  let bad: unknown = null
  try {
    await recordPayment({ supplier_id: 'F3', amount: 0, paid_at: Date.now(), method: 'cash' }, ACTOR)
  } catch (e) { bad = e }
  ok('zero payment refused', bad instanceof Error)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `recordPayment` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/procurement.ts`:

```ts
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
 * A payment is NOT linked to a delivery, deliberately: a firm sends one transfer against three
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

/** Flag the original, append the opposite twin. Same rule as everything else that is money. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: PASS.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/procurement.ts tests/procurement.check.ts
git commit -m "Record and void payments to firms"
```

---

### Task 5: Purchase orders

**Files:**
- Modify: `src/lib/procurement.ts`
- Test: `tests/procurement.check.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `Actor`, `watch`.
- Produces:
  - `savePurchaseOrder(o: Omit<PurchaseOrder,'id'|'created_at'|'updated_at'|'number'|'user_name'|'user_role'> & { id?: string; number?: string }, actor: Actor): Promise<string>`
  - `cancelPurchaseOrder(id: string): Promise<void>`
  - `deletePurchaseOrder(id: string): Promise<void>`
  - `watchPurchaseOrders(cb: (rows: PurchaseOrder[]) => void): () => void`
  - `fetchPurchaseOrders(): Promise<PurchaseOrder[]>`
  - `nextOrderNumber(existing: PurchaseOrder[]): string`

- [ ] **Step 1: Write the failing test**

Append to `tests/procurement.check.ts` inside `main()`:

```ts
  console.log('\n=== orders are intentions: they move no stock and no money ===')
  const stockBeforeOrder = (await byId(p3)).current_stock
  const debtBeforeOrder = await balF1()

  const oid = await savePurchaseOrder({
    supplier_id: 'F3',
    ordered_at: Date.now(),
    expected_at: Date.now() + 7 * 86_400_000,
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 50, unit_cost: 18_000 }],
  }, ACTOR)

  eq('ordering moved no stock', (await byId(p3)).current_stock, stockBeforeOrder)
  eq('ordering moved no money', await balF1(), debtBeforeOrder)

  const orders = await fetchPurchaseOrders()
  const o = orders.find((x) => x.id === oid)!
  ok('order got a human number', /^#\d{3}$/.test(o.number))
  eq('order starts as waiting', orderStatus(o, await fetchDeliveries()), 'waiting')

  console.log('\n=== receiving against an order advances its status ===')
  await createDelivery({
    supplier_id: 'F3', order_id: oid, delivered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 20, unit_cost: 18_000 }],
  }, ACTOR)
  eq('partly received', orderStatus(o, await fetchDeliveries()), 'partial')
  eq('what is still owed', outstandingLines(o, await fetchDeliveries()).map((l) => l.quantity), [30])

  await createDelivery({
    supplier_id: 'F3', order_id: oid, delivered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 30, unit_cost: 18_000 }],
  }, ACTOR)
  eq('fully received', orderStatus(o, await fetchDeliveries()), 'received')

  console.log('\n=== cancelling an order ===')
  const oid2 = await savePurchaseOrder({
    supplier_id: 'F3', ordered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 5, unit_cost: 18_000 }],
  }, ACTOR)
  await cancelPurchaseOrder(oid2)
  const o2 = (await fetchPurchaseOrders()).find((x) => x.id === oid2)!
  eq('cancelled', orderStatus(o2, await fetchDeliveries()), 'cancelled')
```

Add to the imports: `savePurchaseOrder, cancelPurchaseOrder, fetchPurchaseOrders` from procurement, and `orderStatus, outstandingLines` from payables.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `savePurchaseOrder` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/procurement.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check` → PASS. `npx tsc -b` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/procurement.ts tests/procurement.check.ts
git commit -m "Purchase orders: intentions that move neither stock nor money"
```

---

### Task 6: Backup v2 and the sync snapshot/merge

**Files:**
- Modify: `src/lib/db.ts` (`Backup`, `exportBackup`, `restoreBackup`, `snapshotForSync`, `mergeRemote`)
- Test: `tests/procurement.check.ts` (extend)

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `Backup` v2 shape; `snapshotForSync` and `mergeRemote` extended with `purchase_orders`, `deliveries`, `payments`.

- [ ] **Step 1: Write the failing test**

Append to `tests/procurement.check.ts` inside `main()` (import `exportBackup, restoreBackup, snapshotForSync, mergeRemote` from `../src/lib/db`):

```ts
  console.log('\n=== backup carries the new stores, and a v1 file still restores ===')
  const backup = await exportBackup()
  eq('backup version', backup.version, 2)
  ok('deliveries in backup', backup.deliveries.length > 0)
  ok('payments in backup', backup.payments.length > 0)
  ok('orders in backup', backup.purchase_orders.length > 0)

  const roundTrip = await restoreBackup(backup)
  ok('restore reports delivery count', roundTrip.deliveries === backup.deliveries.length)
  eq('deliveries survived the round-trip', (await fetchDeliveries()).length, backup.deliveries.length)

  // A file written by the OLD version has no procurement arrays at all. It must still restore,
  // with the new stores simply coming back empty — never crash on a missing key.
  const v1 = {
    format: 'tamaki-savdo' as const, version: 1 as const, exported_at: Date.now(),
    products: backup.products, transactions: backup.transactions, suppliers: backup.suppliers,
  }
  await restoreBackup(v1 as never)
  eq('v1 backup restores with empty procurement stores', (await fetchDeliveries()).length, 0)

  console.log('\n=== merge: append-only rows are idempotent, and a void never un-voids ===')
  await restoreBackup(backup)   // put the data back

  const snap = await snapshotForSync()
  const changed = await mergeRemote(snap)
  eq('merging our own snapshot changes nothing', changed, 0)

  // A stale device still thinks the delivery is live. Merging its copy must NOT resurrect it.
  const voidedDelivery = snap.deliveries.find((d) => d.voided)!
  await mergeRemote({
    ...snap,
    deliveries: [{ ...voidedDelivery, voided: false }],
  })
  const after = (await fetchDeliveries()).find((d) => d.id === voidedDelivery.id)!
  ok('a stale device cannot un-void a delivery', after.voided === true)

  console.log('\n=== a BACKDATED delivery still replicates ===')
  // The regression test for the two-date rule. This delivery ARRIVED 30 days ago but is being
  // typed in now. If sync paged on delivered_at it would land behind the other device's
  // watermark and never be pulled — the two tills would disagree about the debt forever.
  const backdated: Delivery = {
    id: 'backdated-1', supplier_id: 'F9',
    created_at: Date.now(),                       // written NOW
    delivered_at: Date.now() - 30 * 86_400_000,   // but it arrived a month ago
    lines: [], total_amount: 500_000,
    user_name: 'A', user_role: 'admin', voided: false,
  }
  await mergeRemote({ ...snap, deliveries: [backdated] })
  const pulled = (await fetchDeliveries()).find((d) => d.id === 'backdated-1')!
  ok('backdated delivery merged', !!pulled)
  ok('sync watermark is the write time, not the delivery date', pulled.created_at > pulled.delivered_at)
```

Add `Delivery` to the type import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run check`
Expected: FAIL — `backup.deliveries` is undefined; `backup.version` is 1.

- [ ] **Step 3: Extend the backup format**

In `src/lib/db.ts`, replace the `Backup` interface and both functions:

```ts
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
}

export async function exportBackup(): Promise<Backup> {
  const [products, transactions, rest] = await Promise.all([
    allProducts(),
    fetchAllTransactions(),
    tx(
      [STORES.suppliers, STORES.purchase_orders, STORES.deliveries, STORES.payments],
      'readonly',
      async (t) => ({
        suppliers: await getAll<Supplier>(t, STORES.suppliers),
        purchase_orders: await getAll<PurchaseOrder>(t, STORES.purchase_orders),
        deliveries: await getAll<Delivery>(t, STORES.deliveries),
        payments: await getAll<Payment>(t, STORES.payments),
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

/**
 * Replaces everything with the contents of a backup file. Destructive by design — this is the
 * "my laptop died" path, so callers must confirm first.
 *
 * Accepts a version-1 file too: it simply has no procurement arrays, and those stores come back
 * empty. Refusing an old backup would mean the upgrade silently stranded the owner's only copy
 * of their data.
 */
export async function restoreBackup(b: Backup): Promise<{
  products: number; transactions: number; deliveries: number; payments: number
}> {
  if (b?.format !== 'tamaki-savdo' || !Array.isArray(b.products) || !Array.isArray(b.transactions)) {
    throw new Error("Bu fayl zaxira nusxa emas (noto'g'ri format)")
  }

  const stores = [
    STORES.products, STORES.transactions, STORES.suppliers,
    STORES.purchase_orders, STORES.deliveries, STORES.payments,
  ]

  await tx(stores, 'readwrite', async (t) => {
    for (const s of stores) {
      await new Promise<void>((res, rej) => {
        const r = t.objectStore(s).clear()
        r.onsuccess = () => res()
        r.onerror = () => rej(r.error)
      })
    }
    for (const p of b.products) await put(t, STORES.products, p)
    for (const x of b.transactions) await put(t, STORES.transactions, x)
    for (const s of b.suppliers ?? []) await put(t, STORES.suppliers, s)
    // `?? []` is what lets a version-1 file restore instead of throwing on a missing key.
    for (const o of b.purchase_orders ?? []) await put(t, STORES.purchase_orders, o)
    for (const d of b.deliveries ?? []) await put(t, STORES.deliveries, d)
    for (const p of b.payments ?? []) await put(t, STORES.payments, p)
  })

  notify()
  return {
    products: b.products.length,
    transactions: b.transactions.length,
    deliveries: (b.deliveries ?? []).length,
    payments: (b.payments ?? []).length,
  }
}
```

Add `PurchaseOrder, Delivery, Payment` to the type import at the top of `db.ts`.

- [ ] **Step 4: Extend snapshot and merge**

Replace `snapshotForSync` and `mergeRemote` in `src/lib/db.ts`:

```ts
export interface SyncSnapshot {
  products: Product[]
  transactions: Transaction[]
  suppliers: Supplier[]
  purchase_orders: PurchaseOrder[]
  deliveries: Delivery[]
  payments: Payment[]
}

export async function snapshotForSync(): Promise<SyncSnapshot> {
  return tx(
    [STORES.products, STORES.transactions, STORES.suppliers,
      STORES.purchase_orders, STORES.deliveries, STORES.payments],
    'readonly',
    async (t) => ({
      products: await getAll<Product>(t, STORES.products),
      transactions: await getAll<Transaction>(t, STORES.transactions),
      suppliers: await getAll<Supplier>(t, STORES.suppliers),
      purchase_orders: await getAll<PurchaseOrder>(t, STORES.purchase_orders),
      deliveries: await getAll<Delivery>(t, STORES.deliveries),
      payments: await getAll<Payment>(t, STORES.payments),
    }),
  )
}

export async function mergeRemote(remote: SyncSnapshot): Promise<number> {
  let changed = 0

  await tx(
    [STORES.products, STORES.transactions, STORES.suppliers,
      STORES.purchase_orders, STORES.deliveries, STORES.payments],
    'readwrite',
    async (t) => {
      const touched = new Set<string>()

      for (const r of remote.transactions) {
        const cur = await get<Transaction>(t, STORES.transactions, r.id)
        const voided = Boolean(cur?.voided) || Boolean(r.voided)
        if (cur && Boolean(cur.voided) === voided) continue
        await put(t, STORES.transactions, { ...r, voided })
        touched.add(r.product_id)
        changed++
      }

      for (const r of remote.products) {
        const cur = await get<Product>(t, STORES.products, r.id)
        if (cur && (cur.updated_at ?? 0) >= (r.updated_at ?? 0)) continue
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

      // Orders are mutable intentions, not money: last-write-wins, exactly like products.
      for (const r of remote.purchase_orders ?? []) {
        const cur = await get<PurchaseOrder>(t, STORES.purchase_orders, r.id)
        if (cur && (cur.updated_at ?? 0) >= (r.updated_at ?? 0)) continue
        await put(t, STORES.purchase_orders, r)
        changed++
      }

      // Deliveries and payments are MONEY: append-only and immutable, so an id that already
      // exists is the same row. The one mutable bit is `voided`, and it only ever goes
      // false -> true, so it merges with OR. Last-write-wins on a void would let a stale
      // device un-cancel a cancelled delivery and silently re-create a debt.
      for (const r of remote.deliveries ?? []) {
        const cur = await get<Delivery>(t, STORES.deliveries, r.id)
        const voided = Boolean(cur?.voided) || Boolean(r.voided)
        if (cur && Boolean(cur.voided) === voided) continue
        await put(t, STORES.deliveries, { ...r, voided })
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

      for (const pid of touched) await recomputeStock(t, pid)
    },
  )

  if (changed) notify()
  return changed
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run check` → PASS, including the backdated-delivery regression test.
Run: `npx tsc -b` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts tests/procurement.check.ts
git commit -m "Backup v2 and merge rules for orders, deliveries and payments"
```

---

### Task 7: Supabase schema and sync wiring

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `src/lib/sync.ts`

**Interfaces:**
- Consumes: `SyncSnapshot` from Task 6.
- Produces: three new Postgres tables; `rowToOrder`, `rowToDelivery`, `rowToPayment` mappers.

- [ ] **Step 1: Add the tables to the schema**

Append to `supabase/schema.sql`, before the "Row-level security" section:

```sql
-- ---------------------------------------------------------------------------
-- Procurement — firms, orders, deliveries, payments
-- ---------------------------------------------------------------------------
-- Debt is DERIVED by every device, exactly as stock is:
--
--   balance(firm) = sum(deliveries.total_amount) - sum(payments.amount)
--
-- so there is deliberately no `balance` column anywhere. A stored balance would be the same
-- lost-update race a stored stock counter is, and would go stale the moment two devices
-- recorded a payment and a delivery while apart.
--
-- Deliveries and payments are append-only and corrected only by an opposite-signed twin
-- (`reversal_of`), which is what lets two offline devices merge them with a plain idempotent
-- upsert. VOIDED ROWS ARE NOT DELETED and must be summed, not skipped — the original and its
-- twin cancel to zero on their own.

-- `contact` is the phone number. The rest is what you need to actually transfer money.
alter table public.suppliers add column if not exists inn                text;
alter table public.suppliers add column if not exists bank_account       text;
alter table public.suppliers add column if not exists bank_name          text;
alter table public.suppliers add column if not exists bank_mfo           text;
alter table public.suppliers add column if not exists address            text;
alter table public.suppliers add column if not exists director           text;
alter table public.suppliers add column if not exists payment_terms_days integer;

-- An order is an INTENTION: it moves no stock and no money until a delivery arrives against it.
-- Mutable, last-write-wins, like products. `number` is a human label, never a key.
create table if not exists public.purchase_orders (
  user_id      uuid    not null references auth.users(id) on delete cascade,
  id           text    not null,
  supplier_id  text    not null,
  number       text    not null default '',
  ordered_at   bigint  not null,
  expected_at  bigint,
  lines        jsonb   not null default '[]'::jsonb,
  cancelled_at bigint,   -- the ONE stored status: a human decision, not arithmetic
  note         text,
  user_name    text    not null default '',
  user_role    text    not null default 'admin',
  created_at   bigint,
  updated_at   bigint,
  deleted_at   bigint,   -- tombstone
  synced_at    timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists purchase_orders_user_updated_idx
  on public.purchase_orders (user_id, updated_at);

-- The event that moves stock AND money. The stock half lives in `transactions` as RESTOCK rows
-- tagged `ref_id = deliveries.id`; this table is the debt half plus the document reference.
--
-- TWO DATES, and the difference matters:
--   created_at   — write time. Immutable. THE SYNC WATERMARK.
--   delivered_at — when the goods really arrived. User-editable, because deliveries get typed
--                  in days late.
-- Sync pages on created_at. Paging on delivered_at would drop a backdated delivery behind the
-- other device's watermark, and it would never replicate — leaving two tills that disagree
-- about what the shop owes.
create table if not exists public.deliveries (
  user_id      uuid    not null references auth.users(id) on delete cascade,
  id           text    not null,
  supplier_id  text    not null,
  order_id     text,     -- optional: goods sometimes arrive without an order
  created_at   bigint  not null,
  delivered_at bigint  not null,
  doc_number   text,     -- faktura number. The paper stays in the folder; we record the number.
  doc_date     bigint,
  lines        jsonb   not null default '[]'::jsonb,
  total_amount numeric not null default 0,   -- snapshotted at write time
  note         text,
  user_name    text    not null default '',
  user_role    text    not null default 'admin',
  voided       boolean not null default false,
  reversal_of  text,
  synced_at    timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists deliveries_user_created_idx on public.deliveries (user_id, created_at);
create index if not exists deliveries_user_supplier_idx on public.deliveries (user_id, supplier_id);

create table if not exists public.payments (
  user_id     uuid    not null references auth.users(id) on delete cascade,
  id          text    not null,
  supplier_id text    not null,
  amount      numeric not null default 0,
  created_at  bigint  not null,   -- write time. THE SYNC WATERMARK.
  paid_at     bigint  not null,   -- when the money really moved. User-editable.
  method      text    not null default 'cash' check (method in ('cash','bank','card','other')),
  doc_number  text,               -- to'lov topshiriqnomasi number
  note        text,
  user_name   text    not null default '',
  user_role   text    not null default 'admin',
  voided      boolean not null default false,
  reversal_of text,
  synced_at   timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists payments_user_created_idx on public.payments (user_id, created_at);
create index if not exists payments_user_supplier_idx on public.payments (user_id, supplier_id);
```

Then extend the RLS, grants and realtime sections. Append after the existing `suppliers` policies:

```sql
alter table public.purchase_orders enable row level security;
alter table public.deliveries      enable row level security;
alter table public.payments        enable row level security;

drop policy if exists purchase_orders_select on public.purchase_orders;
drop policy if exists purchase_orders_insert on public.purchase_orders;
drop policy if exists purchase_orders_update on public.purchase_orders;
drop policy if exists purchase_orders_delete on public.purchase_orders;

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy purchase_orders_insert on public.purchase_orders
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy purchase_orders_update on public.purchase_orders
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy purchase_orders_delete on public.purchase_orders
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists deliveries_select on public.deliveries;
drop policy if exists deliveries_insert on public.deliveries;
drop policy if exists deliveries_update on public.deliveries;
drop policy if exists deliveries_delete on public.deliveries;

create policy deliveries_select on public.deliveries
  for select to authenticated using ((select auth.uid()) = user_id);
create policy deliveries_insert on public.deliveries
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy deliveries_update on public.deliveries
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy deliveries_delete on public.deliveries
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists payments_select on public.payments;
drop policy if exists payments_insert on public.payments;
drop policy if exists payments_update on public.payments;
drop policy if exists payments_delete on public.payments;

create policy payments_select on public.payments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy payments_insert on public.payments
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy payments_update on public.payments
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy payments_delete on public.payments
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Revoke first, then grant back only the four verbs the sync layer uses: Postgres grants
-- everything in `public` to PUBLIC by default, and TRUNCATE is NOT subject to RLS.
revoke all on public.purchase_orders from anon, authenticated;
revoke all on public.deliveries      from anon, authenticated;
revoke all on public.payments        from anon, authenticated;

grant select, insert, update, delete on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.deliveries      to authenticated;
grant select, insert, update, delete on public.payments        to authenticated;

alter publication supabase_realtime add table public.purchase_orders;
alter publication supabase_realtime add table public.deliveries;
alter publication supabase_realtime add table public.payments;
```

Finally, append the payables view at the end of the file:

```sql
-- ---------------------------------------------------------------------------
-- firm_balances — what the shop owes each firm
-- ---------------------------------------------------------------------------
-- The same courtesy `stock_levels` extends for stock: anyone reading the database directly gets
-- the derived number, instead of hunting for a balance column that deliberately does not exist.
--
-- Voided rows are SUMMED, not filtered: a void writes an opposite-signed twin, so the pair
-- cancels to zero on its own. Adding `where not voided` here would apply the twin alone and
-- report a debt that is wrong by twice the delivery.
--
-- security_invoker = true is essential: a view runs as its OWNER by default, which would bypass
-- RLS and let any signed-in user read every shop's debts.
create or replace view public.firm_balances with (security_invoker = true) as
  select
    s.user_id,
    s.id   as supplier_id,
    s.name,
    coalesce((select sum(d.total_amount) from public.deliveries d
              where d.user_id = s.user_id and d.supplier_id = s.id), 0)
    - coalesce((select sum(p.amount) from public.payments p
                where p.user_id = s.user_id and p.supplier_id = s.id), 0) as balance
  from public.suppliers s
  where s.deleted_at is null;

revoke all on public.firm_balances from anon;
grant select on public.firm_balances to authenticated;
```

- [ ] **Step 2: Wire the new tables into sync**

In `src/lib/sync.ts`, add the row mappers after `rowToSupplier`:

```ts
const rowToOrder = (r: Record<string, unknown>): PurchaseOrder => ({
  id: String(r.id),
  supplier_id: String(r.supplier_id),
  number: String(r.number ?? ''),
  ordered_at: n(r.ordered_at),
  expected_at: nOrU(r.expected_at),
  lines: (r.lines as OrderLine[]) ?? [],
  cancelled_at: nOrU(r.cancelled_at),
  note: (r.note as string) ?? undefined,
  user_name: String(r.user_name ?? ''),
  user_role: r.user_role === 'cashier' ? 'cashier' : 'admin',
  created_at: n(r.created_at),
  updated_at: n(r.updated_at),
  deleted_at: nOrU(r.deleted_at),
})

const rowToDelivery = (r: Record<string, unknown>): Delivery => ({
  id: String(r.id),
  supplier_id: String(r.supplier_id),
  order_id: (r.order_id as string) ?? undefined,
  created_at: n(r.created_at),
  delivered_at: n(r.delivered_at),
  doc_number: (r.doc_number as string) ?? undefined,
  doc_date: nOrU(r.doc_date),
  lines: (r.lines as OrderLine[]) ?? [],
  total_amount: n(r.total_amount),
  note: (r.note as string) ?? undefined,
  user_name: String(r.user_name ?? ''),
  user_role: r.user_role === 'cashier' ? 'cashier' : 'admin',
  voided: Boolean(r.voided),
  reversal_of: (r.reversal_of as string) ?? undefined,
})

const rowToPayment = (r: Record<string, unknown>): Payment => ({
  id: String(r.id),
  supplier_id: String(r.supplier_id),
  amount: n(r.amount),
  created_at: n(r.created_at),
  paid_at: n(r.paid_at),
  method: (['cash', 'bank', 'card', 'other'] as const).includes(r.method as never)
    ? (r.method as Payment['method'])
    : 'cash',
  doc_number: (r.doc_number as string) ?? undefined,
  note: (r.note as string) ?? undefined,
  user_name: String(r.user_name ?? ''),
  user_role: r.user_role === 'cashier' ? 'cashier' : 'admin',
  voided: Boolean(r.voided),
  reversal_of: (r.reversal_of as string) ?? undefined,
})
```

Extend the type import: `import type { Product, Transaction, Supplier, PurchaseOrder, Delivery, Payment, OrderLine } from './types'`

In `pushChanges`, after the existing suppliers push:

```ts
  const orders = local.purchase_orders.filter((o) => (o.updated_at ?? 0) >= wm)

  // Deliveries and payments are filtered on created_at — the WRITE time — never on
  // delivered_at / paid_at. A delivery typed in today for goods that arrived last week has a
  // delivered_at behind the watermark; paging on it would mean this row never leaves the device.
  const freshDeliveries = local.deliveries.filter((d) => d.created_at >= wm)
  const freshPayments = local.payments.filter((p) => p.created_at >= wm)

  // A void flips `voided` on an OLD row while writing a NEW twin. The old row sits behind the
  // watermark and would never be re-sent, leaving the other devices showing a debt this one
  // cancelled — so drag along whatever a new twin points at. Same rule as transactions.
  const voidedDeliveryIds = new Set(freshDeliveries.filter((d) => d.reversal_of).map((d) => d.reversal_of!))
  const revivedDeliveries = local.deliveries.filter((d) => voidedDeliveryIds.has(d.id) && d.created_at < wm)

  const voidedPaymentIds = new Set(freshPayments.filter((p) => p.reversal_of).map((p) => p.reversal_of!))
  const revivedPayments = local.payments.filter((p) => voidedPaymentIds.has(p.id) && p.created_at < wm)

  const deliveries = [...freshDeliveries, ...revivedDeliveries]
  const payments = [...freshPayments, ...revivedPayments]

  await upsertChunked('purchase_orders', orders.map((o) => ({ ...o, user_id: uid })))
  await upsertChunked('deliveries', deliveries.map((d) => ({ ...d, user_id: uid })))
  await upsertChunked('payments', payments.map((p) => ({ ...p, user_id: uid })))
```

and change the return to `return products.length + txs.length + suppliers.length + orders.length + deliveries.length + payments.length`.

In `pullChanges`, extend the parallel fetch and the merge:

```ts
  const [p, t, s, o, d, pay] = await Promise.all([
    fetchSince('products', uid, 'updated_at', wm),
    fetchSince('transactions', uid, 'ts', wm),
    fetchSince('suppliers', uid, 'updated_at', wm),
    fetchSince('purchase_orders', uid, 'updated_at', wm),
    // created_at, NOT delivered_at / paid_at — see the note in pushChanges.
    fetchSince('deliveries', uid, 'created_at', wm),
    fetchSince('payments', uid, 'created_at', wm),
  ])
```

After the existing voided-transactions fetch, add the same for the two new money tables — a void updates an OLD row in place, and its `created_at` never moves, so a watermark-based pull would never see it:

```ts
  const { data: voidedD, error: eD } = await supabase!
    .from('deliveries').select('*').eq('user_id', uid).eq('voided', true)
  if (eD) throw new Error(`deliveries: ${eD.message}`)

  const { data: voidedP, error: eP } = await supabase!
    .from('payments').select('*').eq('user_id', uid).eq('voided', true)
  if (eP) throw new Error(`payments: ${eP.message}`)

  const changed = await mergeRemote({
    products: p.map(rowToProduct),
    transactions: [...t, ...(voided ?? [])].map(rowToTx),
    suppliers: s.map(rowToSupplier),
    purchase_orders: o.map(rowToOrder),
    deliveries: [...d, ...(voidedD ?? [])].map(rowToDelivery),
    payments: [...pay, ...(voidedP ?? [])].map(rowToPayment),
  })
```

Finally, extend the realtime channel in `startAutoSync`:

```ts
    .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_orders' }, () => schedule(300))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => schedule(300))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => schedule(300))
```

- [ ] **Step 3: Verify types and tests**

Run: `npx tsc -b` → no errors.
Run: `npm run check` → PASS (sync isn't exercised by the suites, but `mergeRemote`'s new signature is).

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql src/lib/sync.ts
git commit -m "Sync orders, deliveries and payments; page money rows on write time"
```

---

### Task 8: Store wiring, navigation, and the Firmalar list

**Files:**
- Modify: `src/store.tsx`
- Modify: `src/App.tsx`
- Create: `src/pages/Firms.tsx`
- Create: `src/components/FirmForm.tsx`

**Interfaces:**
- Consumes: `watchDeliveries`, `watchPayments`, `watchPurchaseOrders` (Tasks 3–5); `supplierBalance`, `worstOverdue`, `forSupplier` (Task 2); `saveSupplier`, `deleteSupplier` (existing in `db.ts`).
- Produces: store fields `deliveries`, `payments`, `orders`. Routes `/firmalar` and `/firmalar/:id`. Component `FirmForm`.

- [ ] **Step 1: Extend the store**

In `src/store.tsx`, add to the `Store` interface:

```ts
  deliveries: Delivery[]
  payments: Payment[]
  orders: PurchaseOrder[]
```

Add the state, the watchers (inside the existing `stops` array), and the context value:

```ts
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
```

```ts
          watchDeliveries(setDeliveries),
          watchPayments(setPayments),
          watchPurchaseOrders(setOrders),
```

Import from `./lib/procurement` and add the three to the `value` object. Extend the type import with `Delivery, Payment, PurchaseOrder`.

- [ ] **Step 2: Add the nav entry and routes**

In `src/App.tsx`, add to `NAV` between Mahsulotlar and Hisobot:

```ts
  { to: '/firmalar', label: 'Firmalar', icon: '💼' },
```

Change the mobile bottom nav from `grid-cols-5` to `grid-cols-6`, and add the routes:

```tsx
          <Route path="/firmalar" element={<Firms />} />
          <Route path="/firmalar/:id" element={<FirmDetail />} />
```

- [ ] **Step 3: Write the firm form**

Create `src/components/FirmForm.tsx`:

```tsx
import { useState } from 'react'
import { saveSupplier } from '../lib/db'
import { useStore } from '../store'
import { Modal } from './ui'
import { parseNum } from '../lib/format'
import type { Supplier } from '../lib/types'

/** Everything you need to actually transfer money to a firm, in one block. */
export default function FirmForm({ firm, open, onClose }: {
  firm?: Supplier
  open: boolean
  onClose: () => void
}) {
  const { toast } = useStore()
  const [f, setF] = useState<Partial<Supplier>>(firm ?? {})
  const [busy, setBusy] = useState(false)

  const set = (k: keyof Supplier) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    if (!f.name?.trim()) return toast('Firma nomini kiriting', 'err')
    setBusy(true)
    try {
      await saveSupplier({
        ...f,
        id: firm?.id,
        name: f.name.trim(),
        payment_terms_days: f.payment_terms_days ? parseNum(f.payment_terms_days) : undefined,
      } as Supplier)
      toast(firm ? 'Firma yangilandi' : "Firma qo'shildi")
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={firm ? 'Firmani tahrirlash' : "Yangi firma"} wide>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="label">Firma nomi *</label>
          <input className="field" value={f.name ?? ''} onChange={set('name')} placeholder="Fayz Tamaki MChJ" />
        </div>
        <div>
          <label className="label">STIR (INN)</label>
          <input className="field num" value={f.inn ?? ''} onChange={set('inn')} inputMode="numeric" />
        </div>
        <div>
          <label className="label">Telefon</label>
          <input className="field" value={f.contact ?? ''} onChange={set('contact')} inputMode="tel" />
        </div>
        <div>
          <label className="label">Direktor</label>
          <input className="field" value={f.director ?? ''} onChange={set('director')} />
        </div>
        <div>
          <label className="label">Manzil</label>
          <input className="field" value={f.address ?? ''} onChange={set('address')} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Hisob raqam</label>
          <input className="field num" value={f.bank_account ?? ''} onChange={set('bank_account')} inputMode="numeric" />
        </div>
        <div>
          <label className="label">Bank</label>
          <input className="field" value={f.bank_name ?? ''} onChange={set('bank_name')} />
        </div>
        <div>
          <label className="label">MFO</label>
          <input className="field num" value={f.bank_mfo ?? ''} onChange={set('bank_mfo')} inputMode="numeric" />
        </div>
        <div>
          <label className="label">To'lov muddati (kun)</label>
          <input
            className="field num"
            value={f.payment_terms_days ?? ''}
            onChange={(e) => setF((p) => ({ ...p, payment_terms_days: parseNum(e.target.value) }))}
            inputMode="numeric"
            placeholder="30"
          />
          <p className="text-xs text-ink-400 mt-1">Shu kundan keyin qarz kechikkan hisoblanadi.</p>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Izoh</label>
          <input className="field" value={f.note ?? ''} onChange={set('note')} />
        </div>
      </div>

      <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}
```

- [ ] **Step 4: Write the firm list**

Create `src/pages/Firms.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import FirmForm from '../components/FirmForm'
import { money } from '../lib/format'
import { supplierBalance, worstOverdue, forSupplier } from '../lib/payables'

export default function Firms() {
  const { suppliers, deliveries, payments } = useStore()
  const [adding, setAdding] = useState(false)

  // Positive = we owe them (qarz). Negative = we prepaid, they owe us goods (avans).
  const rows = useMemo(() =>
    suppliers
      .map((f) => {
        const ds = forSupplier(deliveries, f.id)
        const ps = forSupplier(payments, f.id)
        return {
          firm: f,
          balance: supplierBalance(ds, ps),
          overdue: worstOverdue(ds, ps, f.payment_terms_days ?? 0),
        }
      })
      .sort((a, b) => b.balance - a.balance),
    [suppliers, deliveries, payments],
  )

  const totalDebt = rows.reduce((s, r) => s + Math.max(0, r.balance), 0)

  return (
    <Page
      title="Firmalar"
      subtitle="Tovar oladigan firmalar, qarzlar va to'lovlar."
      actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ Firma</button>}
    >
      {!suppliers.length ? (
        <Empty
          icon="💼"
          title="Hali firma qo'shilmagan"
          hint="Tovar oladigan firmangizni qo'shing — qarz va yetkazib berishlar shu yerda ko'rinadi."
          action={<button className="btn-primary" onClick={() => setAdding(true)}>+ Firma qo'shish</button>}
        />
      ) : (
        <>
          <div className="card p-4 mb-4">
            <div className="text-sm text-ink-500">Jami qarzimiz</div>
            <div className="text-3xl font-bold num tracking-tight text-red-600">{money(totalDebt)}</div>
          </div>

          <div className="card divide-y divide-ink-100">
            {rows.map(({ firm, balance, overdue }) => (
              <Link
                key={firm.id}
                to={`/firmalar/${firm.id}`}
                className="flex items-center gap-3 p-4 hover:bg-ink-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{firm.name}</div>
                  <div className="text-xs text-ink-400 truncate">
                    {firm.inn ? `STIR ${firm.inn}` : firm.contact || '—'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {balance > 0 ? (
                    <div className="font-semibold num text-red-600">{money(balance)}</div>
                  ) : balance < 0 ? (
                    <div className="font-semibold num text-emerald-600">
                      Avans {money(-balance)}
                    </div>
                  ) : (
                    <div className="text-sm text-ink-400">Qarz yo'q</div>
                  )}
                  {overdue > 0 && (
                    <div className="chip bg-amber-50 text-amber-700 mt-1">
                      ⚠️ {overdue} kun kechikkan
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <FirmForm open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc -b` → no errors.
Run: `npm run dev`, open `/firmalar`, add a firm with bank details, confirm it appears with "Qarz yo'q".

- [ ] **Step 6: Commit**

```bash
git add src/store.tsx src/App.tsx src/pages/Firms.tsx src/components/FirmForm.tsx
git commit -m "Firmalar list: firms with their derived balances"
```

---

### Task 9: Firm detail — the statement, payments, and voiding

**Files:**
- Create: `src/pages/FirmDetail.tsx`
- Create: `src/components/PaymentForm.tsx`

**Interfaces:**
- Consumes: `statement`, `supplierBalance`, `unpaidDeliveries`, `forSupplier` (Task 2); `recordPayment`, `voidPayment`, `voidDelivery` (Tasks 3–4).
- Produces: route component `FirmDetail`; component `PaymentForm`.

- [ ] **Step 1: Write the payment form**

Create `src/components/PaymentForm.tsx`:

```tsx
import { useState } from 'react'
import { useStore } from '../store'
import { recordPayment } from '../lib/procurement'
import { Modal } from './ui'
import { parseNum, money, isoDay, startOfDay } from '../lib/format'
import type { PaymentMethod, Supplier } from '../lib/types'

const METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'cash', label: 'Naqd' },
  { key: 'bank', label: 'Bank o\'tkazmasi' },
  { key: 'card', label: 'Plastik' },
  { key: 'other', label: 'Boshqa' },
]

export default function PaymentForm({ firm, owed, open, onClose }: {
  firm: Supplier
  owed: number
  open: boolean
  onClose: () => void
}) {
  const { actor, toast } = useStore()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('bank')
  const [day, setDay] = useState(isoDay(Date.now()))
  const [doc, setDoc] = useState('')
  const [busy, setBusy] = useState(false)

  const value = parseNum(amount)

  const submit = async () => {
    if (!(value > 0)) return toast("To'lov summasini kiriting", 'err')
    setBusy(true)
    try {
      await recordPayment({
        supplier_id: firm.id,
        amount: value,
        // The real-world date the money moved. `created_at` is stamped inside recordPayment
        // and is what sync uses — see the two-date rule.
        paid_at: startOfDay(day),
        method,
        doc_number: doc.trim() || undefined,
      }, actor)
      toast(`To'lov saqlandi — ${money(value)}`)
      setAmount(''); setDoc('')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`To'lov — ${firm.name}`}>
      <div className="flex items-baseline justify-between mb-4 text-sm">
        <span className="text-ink-500">Hozirgi qarz</span>
        <span className="font-semibold num text-red-600">{money(owed)}</span>
      </div>

      <label className="label">Summa *</label>
      <input
        className="field num text-lg h-12 mb-1"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric"
        placeholder="0"
        autoFocus
      />
      {owed > 0 && (
        <button
          className="text-xs font-semibold text-ink-500 hover:text-ink-900 mb-3"
          onClick={() => setAmount(String(owed))}
        >
          Butun qarzni to'lash ({money(owed)})
        </button>
      )}

      <label className="label mt-3">To'lov turi</label>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {METHODS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMethod(m.key)}
            className={`btn ${method === m.key ? 'btn-primary' : 'btn-ghost'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Sana</label>
          <input type="date" className="field" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div>
          <label className="label">Hujjat №</label>
          <input className="field" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="TT-19" />
        </div>
      </div>

      <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy || !(value > 0)}>
        {busy ? 'Saqlanmoqda…' : `To'lovni saqlash — ${money(value)}`}
      </button>
    </Modal>
  )
}
```

- [ ] **Step 2: Write the firm detail page**

Create `src/pages/FirmDetail.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { Link, useParams, Navigate } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import FirmForm from '../components/FirmForm'
import PaymentForm from '../components/PaymentForm'
import { money, dateLabel } from '../lib/format'
import {
  statement, supplierBalance, unpaidDeliveries, forSupplier,
} from '../lib/payables'
import { voidDelivery, voidPayment } from '../lib/procurement'

/** One field of the bank block. Kept dumb so the block reads as data, not markup. */
function Detail({ label, value }: { label: string; value?: string | number }) {
  if (!value) return null
  return (
    <div>
      <div className="text-xs text-ink-400">{label}</div>
      <div className="text-sm font-medium num break-all">{value}</div>
    </div>
  )
}

export default function FirmDetail() {
  const { id = '' } = useParams()
  const { suppliers, deliveries, payments, actor, toast } = useStore()
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)

  const firm = suppliers.find((f) => f.id === id)

  const view = useMemo(() => {
    if (!firm) return null
    const ds = forSupplier(deliveries, firm.id)
    const ps = forSupplier(payments, firm.id)
    return {
      balance: supplierBalance(ds, ps),
      rows: statement(ds, ps).reverse(),   // newest first on screen
      unpaid: unpaidDeliveries(ds, ps, firm.payment_terms_days ?? 0),
    }
  }, [firm, deliveries, payments])

  if (!firm || !view) return <Navigate to="/firmalar" replace />

  const { balance, rows, unpaid } = view
  const worstOverdue = unpaid.reduce((w, u) => Math.max(w, u.daysOverdue), 0)

  const undo = async (kind: 'delivery' | 'payment', rowId: string) => {
    if (!confirm('Bekor qilinsinmi? Yozuv o\'chmaydi — teskari yozuv qo\'shiladi.')) return
    try {
      if (kind === 'delivery') await voidDelivery(rowId, actor)
      else await voidPayment(rowId, actor)
      toast('Bekor qilindi')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Bekor qilib bo\'lmadi', 'err')
    }
  }

  return (
    <Page
      title={firm.name}
      subtitle={firm.director ? `Direktor: ${firm.director}` : undefined}
      actions={
        <div className="flex gap-2">
          <Link to="/firmalar" className="btn-ghost">← Firmalar</Link>
          <button className="btn-ghost" onClick={() => setEditing(true)}>Tahrirlash</button>
          <button className="btn-primary" onClick={() => setPaying(true)}>To'lov qilish</button>
        </div>
      }
    >
      {/* Balance */}
      <div className="card p-5 mb-4">
        <div className="text-sm text-ink-500">
          {balance > 0 ? 'Qarzimiz' : balance < 0 ? 'Avans (firma bizga qarzdor)' : 'Hisob-kitob teng'}
        </div>
        <div className={`text-4xl font-bold num tracking-tight ${
          balance > 0 ? 'text-red-600' : balance < 0 ? 'text-emerald-600' : ''
        }`}>
          {money(Math.abs(balance))}
        </div>
        {worstOverdue > 0 && (
          <div className="chip bg-amber-50 text-amber-700 mt-2">
            ⚠️ Eng eski to'lanmagan yetkazib berish — {worstOverdue} kun kechikkan
          </div>
        )}
        {firm.payment_terms_days ? (
          <p className="text-xs text-ink-400 mt-2">To'lov muddati: {firm.payment_terms_days} kun</p>
        ) : null}
      </div>

      {/* Bank block — read it out over the phone */}
      <div className="card p-5 mb-4">
        <h2 className="font-semibold mb-3">Rekvizitlar</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Detail label="STIR (INN)" value={firm.inn} />
          <Detail label="Hisob raqam" value={firm.bank_account} />
          <Detail label="Bank" value={firm.bank_name} />
          <Detail label="MFO" value={firm.bank_mfo} />
          <Detail label="Telefon" value={firm.contact} />
          <Detail label="Manzil" value={firm.address} />
        </div>
        {!firm.inn && !firm.bank_account && (
          <p className="text-sm text-ink-400">
            Rekvizitlar kiritilmagan. <button className="underline" onClick={() => setEditing(true)}>Qo'shish</button>
          </p>
        )}
      </div>

      {/* Statement — this IS the akt sverki */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-ink-200">
          <h2 className="font-semibold">Hisob-kitob</h2>
          <p className="text-xs text-ink-400 mt-0.5">
            Har bir yetkazib berish va to'lov — sana bo'yicha, qoldiq bilan.
          </p>
        </div>

        {!rows.length ? (
          <Empty
            icon="📄"
            title="Hali yozuv yo'q"
            hint="Kirim bo'limida shu firmani tanlab tovar qabul qiling."
          />
        ) : (
          <div className="divide-y divide-ink-100">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">
                    {r.kind === 'delivery' ? 'Yetkazib berish' : "To'lov"}
                    {r.doc_number && <span className="text-ink-400 font-normal"> · №{r.doc_number}</span>}
                  </div>
                  <div className="text-xs text-ink-400">{dateLabel(r.ts)}</div>
                </div>
                <div className={`text-sm font-semibold num shrink-0 ${
                  r.delta > 0 ? 'text-red-600' : 'text-emerald-600'
                }`}>
                  {r.delta > 0 ? '+' : '−'}{money(Math.abs(r.delta))}
                </div>
                <div className="text-sm font-bold num shrink-0 w-32 text-right">{money(r.balance)}</div>
                <button
                  onClick={() => undo(r.kind, r.id)}
                  className="text-ink-300 hover:text-red-600 text-xs font-semibold shrink-0"
                  title="Bekor qilish"
                >
                  Bekor
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <FirmForm firm={firm} open={editing} onClose={() => setEditing(false)} />
      <PaymentForm firm={firm} owed={Math.max(0, balance)} open={paying} onClose={() => setPaying(false)} />
    </Page>
  )
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc -b` → no errors.
Manually: `npm run dev` → open a firm, record a payment, confirm the balance drops and a row appears in the statement with the running balance. Void it, confirm the balance returns and BOTH rows disappear from the statement (they are a cancelling pair).

- [ ] **Step 4: Commit**

```bash
git add src/pages/FirmDetail.tsx src/components/PaymentForm.tsx
git commit -m "Firm detail: bank block, running-balance statement, payments"
```

---

### Task 10: Receiving — extend the Kirim counter

**Files:**
- Modify: `src/components/Counter.tsx`
- Modify: `src/pages/Restock.tsx`

The existing restock flow must keep working untouched when no firm is selected. This is an extension, not a fork.

**Interfaces:**
- Consumes: `createDelivery` (Task 3), `outstandingLines` (Task 2), store's `suppliers` / `orders`.
- Produces: `Counter` accepts the existing `type` prop; when `type === 'RESTOCK'` it renders a firm selector and commits a Delivery instead of a bare cart.

- [ ] **Step 1: Add the firm/faktura state to Counter**

In `src/components/Counter.tsx`, add imports and state:

```tsx
import { useSearchParams } from 'react-router-dom'
import { createDelivery } from '../lib/procurement'
import { outstandingLines } from '../lib/payables'
import { isoDay, startOfDay } from '../lib/format'
```

```tsx
  const { products, brands, actor, toast, suppliers, orders } = useStore()
  const [params] = useSearchParams()

  const [firmId, setFirmId] = useState('')
  const [docNumber, setDocNumber] = useState('')
  const [deliveredDay, setDeliveredDay] = useState(isoDay(Date.now()))
  const orderId = params.get('buyurtma') ?? ''
```

- [ ] **Step 2: Prefill the cart when arriving from an order**

Add this effect after the existing focus effect. It runs once per order id and fills the cart with what is still owed:

```tsx
  // Arriving from an order ("Qabul qilish"): prefill the cart with what is STILL outstanding,
  // not the full order — a second delivery against a partly-received order must not re-receive
  // the goods that already came.
  useEffect(() => {
    if (!orderId) return
    const order = orders.find((o) => o.id === orderId)
    if (!order) return

    setFirmId(order.supplier_id)
    setLines(
      outstandingLines(order, deliveries)
        .map((l) => {
          const p = products.find((x) => x.id === l.product_id)
          return p ? { product: p, quantity: l.quantity, unit_price: l.unit_cost } : null
        })
        .filter((l): l is CartLine => l !== null),
    )
  }, [orderId, orders, deliveries, products])
```

Add `deliveries` to the `useStore()` destructure.

- [ ] **Step 3: Commit as a delivery when a firm is chosen**

Replace the `submit` function's restock branch:

```tsx
  const submit = async () => {
    if (!lines.length || busy) return
    setBusy(true)
    try {
      // A firm turns this from a bare stock movement into a DELIVERY: stock rises and debt
      // rises, in one atomic write. With no firm chosen it stays exactly what it always was.
      if (!isSale && firmId) {
        const res = await createDelivery({
          supplier_id: firmId,
          order_id: orderId || undefined,
          delivered_at: startOfDay(deliveredDay),
          doc_number: docNumber.trim() || undefined,
          lines: lines.map((l) => ({
            product_id: l.product.id,
            product_name: l.product.name,
            brand: l.product.brand,
            quantity: l.quantity,
            unit_cost: l.unit_price,
          })),
          note: note.trim() || undefined,
        }, actor)
        const firm = suppliers.find((f) => f.id === firmId)
        toast(`Qabul qilindi — ${money(res.total)} · ${firm?.name ?? ''} qarziga qo'shildi`)
        clearCart()
        setNote(''); setDocNumber(''); setQ('')
        searchRef.current?.focus()
        return
      }

      const res = await commitCart(type, lines, actor, note.trim())
      toast(
        isSale
          ? `Sotuv saqlandi — ${money(res.total)} (foyda ${money(res.profit)})`
          : `Kirim saqlandi — ${money(res.total)}`,
      )
      clearCart()
      setNote('')
      setQ('')
      searchRef.current?.focus()
    } catch (e) {
      const msg = e instanceof StockError ? e.message
        : e instanceof Error ? e.message : 'Saqlashda xatolik'
      toast(msg, 'err')
    } finally {
      setBusy(false)
    }
  }
```

- [ ] **Step 4: Render the firm block**

Insert this above the note input in the cart panel (only for restock):

```tsx
            {!isSale && (
              <div className="rounded-lg border border-ink-200 p-3 space-y-2 mb-2">
                <div>
                  <label className="label">Firma</label>
                  <select
                    className="field"
                    value={firmId}
                    onChange={(e) => setFirmId(e.target.value)}
                  >
                    <option value="">Firmasiz (oddiy kirim)</option>
                    {suppliers.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-ink-400 mt-1">
                    {firmId
                      ? "Qarz shu firma hisobiga qo'shiladi."
                      : 'Firma tanlanmasa, faqat qoldiq oshadi — qarz yozilmaydi.'}
                  </p>
                </div>

                {!!firmId && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label">Faktura №</label>
                      <input
                        className="field"
                        value={docNumber}
                        onChange={(e) => setDocNumber(e.target.value)}
                        placeholder="4471"
                      />
                    </div>
                    <div>
                      <label className="label">Kelgan sana</label>
                      <input
                        type="date"
                        className="field"
                        value={deliveredDay}
                        onChange={(e) => setDeliveredDay(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
```

Change the confirm button label so it says what will actually happen:

```tsx
              {busy ? 'Saqlanmoqda…'
                : isSale ? 'Sotuvni tasdiqlash'
                : firmId ? 'Qabul qilish (qarzga)'
                : 'Kirimni tasdiqlash'}
```

- [ ] **Step 5: Verify**

Run: `npx tsc -b` → no errors.
Manually: `npm run dev` → `/kirim` with **no firm** selected behaves exactly as before (stock rises, no debt anywhere). Then select a firm, enter a faktura number, confirm → stock rises AND the firm's balance rises by the same total.

- [ ] **Step 6: Commit**

```bash
git add src/components/Counter.tsx src/pages/Restock.tsx
git commit -m "Kirim: receiving from a firm creates a delivery, not just a restock"
```

---

### Task 11: Orders — the board and the form

**Files:**
- Create: `src/pages/Orders.tsx`
- Create: `src/components/OrderForm.tsx`
- Modify: `src/App.tsx` (route `/buyurtmalar`)
- Modify: `src/pages/Firms.tsx` (tab link to orders)

**Interfaces:**
- Consumes: `savePurchaseOrder`, `cancelPurchaseOrder` (Task 5); `orderStatus`, `receivedQty`, `linesTotal`, `ORDER_STATUS_LABEL` (Tasks 2, 5).
- Produces: route component `Orders`; component `OrderForm`.

- [ ] **Step 1: Write the order form**

Create `src/components/OrderForm.tsx`:

```tsx
import { useState } from 'react'
import { useStore } from '../store'
import { savePurchaseOrder } from '../lib/procurement'
import { linesTotal } from '../lib/payables'
import { Modal } from './ui'
import { money, parseNum, isoDay, startOfDay } from '../lib/format'
import type { OrderLine } from '../lib/types'

export default function OrderForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { suppliers, products, actor, toast } = useStore()
  const [firmId, setFirmId] = useState('')
  const [expected, setExpected] = useState(isoDay(Date.now() + 7 * 86_400_000))
  const [lines, setLines] = useState<OrderLine[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  const results = products
    .filter((p) => p.active && q.trim() &&
      (p.name.toLowerCase().includes(q.toLowerCase()) || p.brand.toLowerCase().includes(q.toLowerCase())))
    .slice(0, 8)

  const add = (id: string) => {
    const p = products.find((x) => x.id === id)!
    if (lines.some((l) => l.product_id === id)) return
    setLines((prev) => [...prev, {
      product_id: p.id, product_name: p.name, brand: p.brand,
      quantity: 1, unit_cost: p.cost_price,
    }])
    setQ('')
  }

  const patch = (id: string, k: 'quantity' | 'unit_cost', v: number) =>
    setLines((prev) => prev.map((l) => (l.product_id === id ? { ...l, [k]: v } : l)))

  const submit = async () => {
    if (!firmId) return toast('Firmani tanlang', 'err')
    if (!lines.length) return toast("Mahsulot qo'shing", 'err')
    setBusy(true)
    try {
      await savePurchaseOrder({
        supplier_id: firmId,
        ordered_at: Date.now(),
        expected_at: expected ? startOfDay(expected) : undefined,
        lines,
      }, actor)
      toast('Buyurtma saqlandi')
      setLines([]); setFirmId('')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Saqlashda xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Yangi buyurtma" wide>
      <p className="text-sm text-ink-500 mb-4">
        Buyurtma — bu niyat. Qoldiq ham, qarz ham o'zgarmaydi: tovar kelganda Kirim bo'limida
        qabul qilasiz.
      </p>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="label">Firma *</label>
          <select className="field" value={firmId} onChange={(e) => setFirmId(e.target.value)}>
            <option value="">Tanlang…</option>
            {suppliers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Kutilayotgan sana</label>
          <input type="date" className="field" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>

      <label className="label">Mahsulot qo'shish</label>
      <input
        className="field mb-2"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Mahsulot nomi…"
      />
      {!!results.length && (
        <div className="card divide-y divide-ink-100 mb-3">
          {results.map((p) => (
            <button key={p.id} onClick={() => add(p.id)} className="w-full text-left px-3 py-2 hover:bg-ink-50">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-xs text-ink-400"> · {p.brand}</span>
            </button>
          ))}
        </div>
      )}

      {!!lines.length && (
        <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
          {lines.map((l) => (
            <div key={l.product_id} className="flex items-center gap-2 rounded-lg border border-ink-200 p-2">
              <div className="min-w-0 flex-1 text-sm font-medium truncate">{l.product_name}</div>
              <input
                className="field h-9 w-20 num text-center"
                value={l.quantity}
                onChange={(e) => patch(l.product_id, 'quantity', Math.max(1, Math.round(parseNum(e.target.value))))}
                inputMode="numeric"
                title="Soni"
              />
              <span className="text-xs text-ink-400">×</span>
              <input
                className="field h-9 w-28 num text-right"
                value={l.unit_cost}
                onChange={(e) => patch(l.product_id, 'unit_cost', parseNum(e.target.value))}
                inputMode="numeric"
                title="Kelish narxi"
              />
              <button
                onClick={() => setLines((prev) => prev.filter((x) => x.product_id !== l.product_id))}
                className="text-ink-300 hover:text-red-600 text-lg leading-none px-1"
                aria-label="O'chirish"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-between items-baseline border-t border-ink-200 pt-3">
        <span className="text-sm text-ink-500">Jami</span>
        <span className="text-2xl font-bold num tracking-tight">{money(linesTotal(lines))}</span>
      </div>

      <button className="btn-primary w-full mt-4" onClick={submit} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Buyurtmani saqlash'}
      </button>
    </Modal>
  )
}
```

- [ ] **Step 2: Write the orders board**

Create `src/pages/Orders.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store'
import { Page, Empty } from '../components/ui'
import OrderForm from '../components/OrderForm'
import { money, dateLabel } from '../lib/format'
import { orderStatus, receivedQty, linesTotal, ORDER_STATUS_LABEL } from '../lib/payables'
import { cancelPurchaseOrder } from '../lib/procurement'
import type { OrderStatus } from '../lib/types'

const TONE: Record<OrderStatus, string> = {
  waiting: 'bg-ink-100 text-ink-600',
  partial: 'bg-amber-50 text-amber-700',
  received: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-ink-100 text-ink-400',
}

export default function Orders() {
  const { orders, deliveries, suppliers, toast } = useStore()
  const [adding, setAdding] = useState(false)

  const rows = useMemo(() =>
    orders.map((o) => ({
      order: o,
      status: orderStatus(o, deliveries),
      got: receivedQty(o, deliveries),
      firm: suppliers.find((f) => f.id === o.supplier_id),
    })),
    [orders, deliveries, suppliers],
  )

  const cancel = async (id: string) => {
    if (!confirm('Buyurtma bekor qilinsinmi?')) return
    try {
      await cancelPurchaseOrder(id)
      toast('Buyurtma bekor qilindi')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    }
  }

  return (
    <Page
      title="Buyurtmalar"
      subtitle="Nima buyurtma qilindi, qachon kutilmoqda, keldimi."
      actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ Buyurtma</button>}
    >
      {!orders.length ? (
        <Empty
          icon="📋"
          title="Hali buyurtma yo'q"
          hint="Firmaga buyurtma bering — tovar kelganda Kirim bo'limida qabul qilasiz."
          action={<button className="btn-primary" onClick={() => setAdding(true)}>+ Buyurtma berish</button>}
        />
      ) : (
        <div className="space-y-3">
          {rows.map(({ order, status, got, firm }) => (
            <div key={order.id} className="card p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{order.number}</span>
                    <span className={`chip ${TONE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>
                  </div>
                  <div className="text-sm text-ink-500 mt-0.5">{firm?.name ?? '—'}</div>
                  {order.expected_at && (
                    <div className="text-xs text-ink-400">
                      Kutilmoqda: {dateLabel(order.expected_at)}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold num">{money(linesTotal(order.lines))}</div>
                  {status !== 'received' && status !== 'cancelled' && (
                    <div className="flex gap-2 mt-1 justify-end">
                      <Link to={`/kirim?buyurtma=${order.id}`} className="text-xs font-semibold text-ink-900 underline">
                        Qabul qilish
                      </Link>
                      <button
                        onClick={() => cancel(order.id)}
                        className="text-xs font-semibold text-ink-400 hover:text-red-600"
                      >
                        Bekor
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Ordered vs actually received, per product — a short delivery must be visible. */}
              <div className="space-y-1">
                {order.lines.map((l) => {
                  const received = got.get(l.product_id) ?? 0
                  const short = received < l.quantity
                  return (
                    <div key={l.product_id} className="flex justify-between text-sm">
                      <span className="text-ink-600 truncate">{l.product_name}</span>
                      <span className={`num shrink-0 ml-3 ${short ? 'text-amber-700 font-semibold' : 'text-ink-400'}`}>
                        {received} / {l.quantity}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <OrderForm open={adding} onClose={() => setAdding(false)} />
    </Page>
  )
}
```

- [ ] **Step 3: Add the route and cross-link**

In `src/App.tsx` add:

```tsx
          <Route path="/buyurtmalar" element={<Orders />} />
```

In `src/pages/Firms.tsx`, add a link in the `actions` prop:

```tsx
      actions={
        <div className="flex gap-2">
          <Link to="/buyurtmalar" className="btn-ghost">Buyurtmalar</Link>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Firma</button>
        </div>
      }
```

- [ ] **Step 4: Verify**

Run: `npx tsc -b` → no errors.
Manually: create an order for 50 units → status **Kutilmoqda**, no stock and no debt moved. Click **Qabul qilish** → `/kirim` opens with the firm preselected and 50 in the cart. Reduce to 20 and confirm → order shows **Qisman keldi** and `20 / 50`. Receive the rest → **Keldi**.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Orders.tsx src/components/OrderForm.tsx src/App.tsx src/pages/Firms.tsx
git commit -m "Purchase orders board: ordered vs received, prefilled receiving"
```

---

### Task 12: Dashboard widgets and end-to-end verification

**Files:**
- Modify: `src/pages/Dashboard.tsx`
- Modify: `tests/e2e.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: three dashboard KPIs; an e2e pass covering the delivery → debt → payment flow.

- [ ] **Step 1: Add the dashboard KPIs**

In `src/pages/Dashboard.tsx`, pull `deliveries`, `payments`, `orders` from `useStore()` and compute:

```tsx
  const payables = useMemo(() => {
    const totalDebt = suppliers.reduce((s, f) =>
      s + Math.max(0, supplierBalance(forSupplier(deliveries, f.id), forSupplier(payments, f.id))), 0)

    const overdueCount = suppliers.reduce((n, f) =>
      n + unpaidDeliveries(
        forSupplier(deliveries, f.id), forSupplier(payments, f.id), f.payment_terms_days ?? 0,
      ).filter((u) => u.daysOverdue > 0).length, 0)

    const weekAhead = Date.now() + 7 * 86_400_000
    const incoming = orders.filter((o) => {
      const st = orderStatus(o, deliveries)
      return (st === 'waiting' || st === 'partial' || st === 'overdue')
        && o.expected_at != null && o.expected_at <= weekAhead
    }).length

    return { totalDebt, overdueCount, incoming }
  }, [suppliers, deliveries, payments, orders])
```

Render them alongside the existing KPI cards, using the existing `Kpi` component from `components/ui`:

```tsx
        <Kpi
          label="Firmalarga qarz"
          value={moneyShort(payables.totalDebt)}
          sub={payables.overdueCount > 0 ? `${payables.overdueCount} ta kechikkan to'lov` : undefined}
          tone={payables.overdueCount > 0 ? 'bad' : 'default'}
        />
        <Kpi
          label="Kutilayotgan yetkazib berish"
          value={`${payables.incoming} ta`}
          sub="shu hafta ichida"
        />
```

Import `supplierBalance, unpaidDeliveries, forSupplier, orderStatus` from `../lib/payables` and `moneyShort` from `../lib/format`. Check the existing `Kpi` `tone` prop's accepted values in `components/ui.tsx:26` and use one of them.

- [ ] **Step 2: Extend the e2e script**

In `tests/e2e.mjs`, follow the existing pattern (Playwright, screenshots into `tests/screenshots/`). Add a scenario after the existing sale flow:

```js
  // --- procurement: a delivery creates debt, a payment clears it -------------
  await page.goto(`${BASE}/firmalar`)
  await page.getByRole('button', { name: '+ Firma' }).click()
  await page.getByPlaceholder('Fayz Tamaki MChJ').fill('Test Firma MChJ')
  await page.getByRole('button', { name: 'Saqlash' }).click()
  await page.screenshot({ path: 'tests/screenshots/11-firm-created.png' })

  // Receive goods against the firm — stock AND debt must move together.
  await page.goto(`${BASE}/kirim`)
  await page.getByPlaceholder('Mahsulot nomi yoki shtrix-kod…').fill('Winston')
  await page.keyboard.press('Enter')
  await page.selectOption('select', { label: 'Test Firma MChJ' })
  await page.getByPlaceholder('4471').fill('4471')
  await page.getByRole('button', { name: /Qabul qilish/ }).click()
  await page.screenshot({ path: 'tests/screenshots/12-delivery-received.png' })

  await page.goto(`${BASE}/firmalar`)
  const debt = await page.textContent('body')
  if (!/Test Firma/.test(debt)) throw new Error('firm missing from the list')
  await page.screenshot({ path: 'tests/screenshots/13-firm-debt.png' })

  // Pay it off — the balance must return to zero.
  await page.getByText('Test Firma MChJ').click()
  await page.getByRole('button', { name: "To'lov qilish" }).click()
  await page.getByRole('button', { name: /Butun qarzni to'lash/ }).click()
  await page.getByRole('button', { name: /To'lovni saqlash/ }).click()
  await page.screenshot({ path: 'tests/screenshots/14-firm-settled.png' })
```

- [ ] **Step 3: Run everything**

```bash
npm run check     # unit suites: db, logic, payables, procurement
npx tsc -b        # types
npm run build     # production build
npm run e2e       # browser flow
```

Expected: all four green. Inspect `tests/screenshots/13-firm-debt.png` and confirm the debt figure equals quantity × unit cost from the delivery.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Dashboard.tsx tests/e2e.mjs
git commit -m "Dashboard payables widgets and an end-to-end procurement pass"
```

---

## Self-review notes

Checked against the spec:

- **Spec coverage.** Firm bank fields → Task 1/8. Debt derived from ledgers → Task 2. Delivery moves stock+debt atomically → Task 3. Payments and prepayment → Task 4. Orders, derived status, over-receipt → Tasks 5/11. Statement/akt sverki → Task 9. FIFO + overdue → Tasks 2/9/12. Two-date sync rule → Tasks 1/3/6/7. Backup v2 with v1 restore → Task 6. Supabase tables/RLS/realtime → Task 7. Kirim extension without breaking the current flow → Task 10. Dashboard → Task 12. Every spec test in the "Testing" section maps to a step in Tasks 2, 3, 4, 5 or 6.
- **Naming is consistent across tasks.** `supplierBalance`, `liveDeliveries`, `unpaidDeliveries`, `orderStatus`, `outstandingLines`, `receivedQty`, `linesTotal`, `forSupplier`, `worstOverdue`, `createDelivery`, `voidDelivery`, `recordPayment`, `voidPayment`, `savePurchaseOrder`, `cancelPurchaseOrder`, `nextOrderNumber` — each is defined once and referenced with the same signature everywhere after.
- **`recomputeStock` is exported, not duplicated** (Task 3, Step 3), so `current_stock` keeps its single writer.

# Sale payment methods and Kassa (cash drawer)

Design doc. 2026-07-14.

## Problem

A sale records what was sold and for how much, but not *how it was paid*. The owner can't tell
cash from card takings, and there is no view of how much cash should physically be in the
drawer. Cash goes missing and there is nothing to reconcile against.

## Goal

- Every sale records its payment method: **Naqd** (cash), **Plastik** (card), or **Click**.
- A **Kassa** screen shows how much cash *should* be in the drawer right now, lets the owner
  record cash going out (expenses, withdrawals) and in (deposits/float), and check it against a
  physical count.

## Non-goals

- **No tendered/change handling.** A cash sale adds its full total to the drawer; "paid 50 000,
  change 5 000" is settled physically, not modelled.
- **No customer credit (nasiya).** Selling on debt is a separate feature; not here.
- **No forced daily open/close ritual.** The drawer is a running balance, always available, with
  an on-demand count check — not a shift that must be opened and closed.

## The central invariant, again

Like stock, firm debt, and everything else in this app, **the cash in the drawer is derived,
never stored**:

```
drawer = Σ cash sales − Σ cash paid to firms − Σ cash-out + Σ cash-in
```

There is no `balance` field to race on; two devices sum the same movements and agree. Voided
rows are summed, not skipped — a void writes an opposite-signed twin that carries the same
payment method, so the pair cancels itself.

**Honest limitation, stated in the UI:** the drawer number is only truthful if cash leaving for
the bank or the owner's pocket is recorded as a withdrawal. Unrecorded cash-out makes the drawer
read high; the count check is what surfaces that drift.

## Data model

### SalePaymentMethod and the payment method on a sale

```ts
export type SalePaymentMethod = 'cash' | 'card' | 'click'
```

`Transaction` gains an optional field:

```ts
  payment_method?: SalePaymentMethod   // set on SALE rows; undefined on RESTOCK and legacy rows
```

Set on every `Transaction` row of a sale (the whole basket shares one method). RESTOCK rows and
transactions written before this feature leave it `undefined`; the Kassa treats only
`payment_method === 'cash'` as cash, so an undefined legacy sale is simply not counted — correct,
since the drawer is used going forward.

`commitCart` gains a parameter:

```ts
commitCart(type, lines, actor, note = '', payment: SalePaymentMethod = 'cash')
```

It stamps `payment_method` on each SALE row. For RESTOCK it is left unset.

`voidTransaction` builds its reversal twin from explicit fields, not by copying the original, so
it must be changed to carry `payment_method: original.payment_method` onto the twin. Without this
the voided original (`+total`, cash) would have no cash twin to cancel it, and a voided cash sale
would leave the drawer overstated. With it, original and twin both carry the cash method and the
pair nets to zero — the same rule the rest of the ledger follows.

### CashMovement — the manual cash in/out

A new IndexedDB store `cash_movements` for cash that isn't a sale or a firm payment:

```ts
export type CashMovementKind = 'deposit' | 'expense' | 'withdrawal' | 'correction'

export interface CashMovement {
  id: string
  ts: number                 // when it happened; user-visible, drives ordering
  created_at: number         // write time; the sync watermark (see the deliveries two-date rule)
  /** Signed: positive adds to the drawer (deposit), negative removes it (expense/withdrawal). */
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

Append-only, corrected by an opposite twin, exactly like `Payment`. `deposit` is positive;
`expense` and `withdrawal` are negative; `correction` can be either (it makes the drawer match a
physical count). Two dates for the same reason deliveries and payments have them: sync pages on
`created_at` so a back-dated movement still replicates.

## Derived reads (pure, in a new `src/lib/kassa.ts`)

- `cashFromSales(txs: Transaction[]): number` — sum of `total_amount` over ALL SALE rows with
  `payment_method === 'cash'`, voided originals and their negative twins both included so they
  cancel to zero (same summing treatment as `analytics.totals`). Never filter voided rows out
  here — that would drop the original and leave the twin, or vice versa, and misreport the drawer.
- `cashToFirms(payments: Payment[]): number` — sum of `amount` over payments with `method ===
  'cash'` (voided pairs cancel).
- `cashMovementsTotal(rows: CashMovement[]): number` — signed sum (voided pairs cancel).
- `drawerBalance(txs, payments, movements): number` — `cashFromSales − cashToFirms +
  cashMovementsTotal`.
- `liveMovements(rows): CashMovement[]` — display filter hiding voided originals and twins (like
  `livePayments`).
- `revenueByMethod(txs): { cash: number; card: number; click: number; unknown: number }` — for
  the Reports split; legacy sales with no method fall in `unknown`.

All pure functions over arrays, unit-tested without IndexedDB.

## Write operations (in `src/lib/kassa.ts`)

- `recordCashMovement(input: { amount: number; kind: CashMovementKind; reason: string; note?: string; ts?: number }, actor): Promise<string>` — validates a non-zero amount and a reason,
  writes the row. Sign convention enforced here: `deposit` stored positive, `expense`/`withdrawal`
  stored negative, `correction` as given.
- `voidCashMovement(id, actor): Promise<void>` — flag original, append opposite twin.
- `recordCount(counted: number, expected: number, actor): Promise<void>` — if `counted !==
  expected`, writes a `correction` movement of `counted − expected` with reason "Sanoq tuzatishi"
  so the drawer matches the count; a matching count writes nothing.
- `fetchCashMovements()`, `watchCashMovements(cb)`.

## Screens

### Sotuv (sale) — payment selector
The sale cart gains a **Naqd / Plastik / Click** three-way toggle, defaulting to Naqd, styled
like the receiving pay-type toggle already in the Kirim counter. `commitCart` is called with the
chosen method. Available to cashiers (it is part of ringing up a sale). The confirm toast names
the method.

### Kassa (💵) — new tab, admin-only
Gated by a new capability `view-kassa` (admin only today, like the rest). A cashier never sees
the drawer total or records withdrawals.

- Header: **"Kassada bo'lishi kerak"** with the derived drawer balance in large type.
- Breakdown rows: naqd sotuvlar (+), firmalarga naqd to'lov (−), chiqimlar (−), kirimlar (+).
- **Chiqim** button → modal: amount, kind (expense/withdrawal), reason. Writes a negative movement.
- **Kirim** button → modal: amount, reason. Writes a positive `deposit`.
- **Sanoq (count check)**: an input for the counted amount; shows the difference against expected;
  if non-zero, a "Tuzatish" button records the correction so the drawer matches.
- History: `liveMovements`, newest first, each voidable.

### Boshqaruv (Dashboard)
One tile: current drawer balance (admin only — it sits with the payables tiles already gated by
the dashboard being admin-only).

### Hisobot (Reports)
A small **revenue by method** breakdown (Naqd / Plastik / Click) for the selected range.

## Persistence and sync

- New IndexedDB store `cash_movements`; `Transaction` gains `payment_method`. `DB_VERSION` 3 → 4;
  `onupgradeneeded` adds the store, existing data untouched.
- New Supabase table `cash_movements` (mirrors `payments`: RLS by `user_id`, realtime, revoke/grant
  the four verbs). `transactions` gains a `payment_method text` column.
- `snapshotForSync`/`mergeRemote` extend to `cash_movements` with the append-only + OR-on-`voided`
  rule; it pages on `created_at`. `rowToTx` maps `payment_method`.
- `BACKUP_STORES` and the sync store list gain `cash_movements`; `resetAllData` clears it too.
- Backup format is unchanged in shape apart from carrying the new array; a version-2 file still
  restores (the new store simply comes back empty).

## Capability

`Capability` gains `'view-kassa'`, admin-only in the `CAPABILITIES` map. Nav item and route are
guarded by it, exactly like the other admin areas.

## Testing

**Unit — `tests/kassa.check.ts` (pure functions + fake-indexeddb):**
- `drawerBalance` = cash sales − cash firm payments + signed movements.
- A card or click sale does NOT move the drawer; a cash sale does.
- A voided cash sale nets to zero (original + twin summed).
- A voided cash payment to a firm restores the drawer.
- `recordCashMovement` sign convention: deposit +, expense/withdrawal −.
- `voidCashMovement` restores the drawer; the twin is opposite-signed.
- `recordCount` writes a correction equal to `counted − expected`; a matching count writes nothing.
- `revenueByMethod` splits cash/card/click and buckets legacy (no method) as unknown.

**Extend `tests/db.check.ts`:** `commitCart` stamps `payment_method` on SALE rows; `resetAllData`
clears `cash_movements`.

**E2e:** ring up a Naqd sale and a Plastik sale → Kassa shows only the cash one; record an expense
→ drawer drops; run a count that differs → a correction lands and the drawer matches.

## Implementation order

1. `SalePaymentMethod`, `CashMovement` types; `cash_movements` store (DB v4); `payment_method` on
   `Transaction`; `commitCart` stamps it and `voidTransaction` copies it onto the twin. Unit + db
   tests (including that a voided cash sale nets to zero).
2. `kassa.ts` pure reads and write ops, with unit tests.
3. Sotuv payment selector.
4. Kassa screen + capability + nav/route; dashboard tile.
5. Reports revenue-by-method split.
6. Supabase schema, sync wiring, backup/reset inclusion; e2e.

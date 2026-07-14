# Firmalar — supplier, procurement and payables

Design doc. 2026-07-14.

## Problem

Tamaki Savdo tracks what it sells. It does not track what it *buys*, or from whom, or
what it still owes for it.

The shop buys cigarettes and other stock from firms on credit. Goods arrive with a
faktura; payment follows later, often in instalments, often weeks later. Today none of
that exists in the system: `Supplier` holds a name and a phone number, `products.supplier_id`
points at it, and nothing else. There is no record of what was ordered, whether it arrived,
what it cost, what has been paid, or what is still owed. That information currently lives in
a paper folder and in the owner's head.

## Goal

The system should be able to answer, at any moment and while offline:

- How much do we owe each firm, right now?
- What have we ordered, and when is it supposed to arrive?
- Did it arrive? All of it, or only part?
- What did we pay, when, and against which delivery?
- What are this firm's bank details, so we can transfer the money?
- Which debts are overdue?

## Non-goals

Decided explicitly, to keep the scope honest:

- **No document files.** No photos, no scans, no PDF generation. The system records
  document *numbers* (faktura no., date, amount) and links them to deliveries. The paper
  stays in the folder. This keeps the whole feature offline-capable with no new
  infrastructure — no Supabase Storage, no upload queue, no large blobs to sync.
- **No customer-side CRM.** This is about firms we buy *from*, not customers we sell to.
- **No accounting integration.** No 1C export, no tax reporting.

## The central invariant

The existing system rests on one rule: **stock is never stored, it is derived.**
`current_stock` is a cache of the append-only `transactions` ledger, recomputed by
`recomputeStock` after every write and every merge. That single decision is what makes
two devices safe to run offline at once — an append-only ledger with UUID keys is a
grow-only set, so two devices appending rows can never overwrite each other, and the
stock simply falls out as a sum once their rows meet.

**Money owed to a firm has exactly the same shape**, so it gets exactly the same treatment:

```
balance(firm) = Σ (deliveries from that firm) − Σ (payments to that firm)
```

Derived, never stored. Summed on read.

Consequences, all of which we want:

- **Prepayment is not a special case.** Pay before delivery and the balance goes negative,
  which reads as "the firm owes us goods". No advance-payment machinery, no separate
  credit concept. It falls out of the arithmetic.
- **Two devices cannot corrupt a balance.** There is no counter to race on. One device
  records a payment offline, another records a delivery offline, and when they meet the
  balance is simply correct.
- **A delivery moves stock and money in one atomic write**, so the two can never drift apart.

### Deliberate asymmetry: the balance is not cached

Products cache `current_stock` on the record. Firms will **not** cache their balance.

The product cache exists because the till reads stock on every keystroke and must not
re-scan history to do it. Firms are read on a page visit, and there are perhaps a dozen of
them; summing two small stores on read is genuinely cheap. Caching it would buy nothing and
would introduce a whole class of cache-coherence bugs (the exact bugs `recomputeStock` and
the `mergeRemote` "ignore the sender's cache" rule exist to prevent). Different pressure,
different answer.

## Data model

### Firm — extends the existing `Supplier`

Same `suppliers` store, same id, no migration of existing rows. New fields, all optional,
so rows written by the current version stay valid:

| Field | Meaning |
|---|---|
| `inn` | STIR / tax identification number |
| `bank_account` | Hisob raqam (settlement account) |
| `bank_name` | Bank name |
| `bank_mfo` | MFO (bank routing code) |
| `address` | Legal address |
| `director` | Director / contact person |
| `payment_terms_days` | Days of credit granted. Drives the overdue calculation. |

The existing `contact` field stays as-is and remains the phone number. No `phone` field is
added — that would be two fields meaning one thing, and would force a migration for nothing.

Mutable, last-write-wins on `updated_at`, soft-deleted via `deleted_at` — identical to how
products already replicate.

### PurchaseOrder (Buyurtma) — an intention, not money

An order records what we asked for. **It moves nothing** — no stock, no debt — until goods
physically arrive.

```
id, supplier_id, number, ordered_at, expected_at,
lines: [{ product_id, product_name, brand, quantity, unit_cost }],
cancelled_at?, note, user_name, user_role,
created_at, updated_at, deleted_at?
```

Lines are **embedded** on the order rather than kept in a separate store. An order is edited
as a whole unit and is not money, so a lost concurrent edit is annoying but never corrupting.
It replicates as a single mutable document, last-write-wins, like a product. (The append-only
discipline is reserved for the things that *are* money — see below.)

**Status is derived**, not stored, by comparing ordered quantities against what has actually
been received across the deliveries that link to this order:

- `cancelled` — `cancelled_at` is set. The only stored status, because it is a human
  decision rather than arithmetic.
- `received` — every line fully received.
- `partial` — some received, not all. A short delivery is therefore *visible*, not silent.
- `overdue` — nothing outstanding has arrived and `expected_at` has passed.
- `waiting` — otherwise.

**Over-receipt is allowed**, not an error: if the firm sends 55 blocks against an order of
50, all 55 are received (the stock is real and the debt is real), and the order reads
`received`. Refusing the extra five would mean the shelf and the system disagree, which is
worse than an order that over-fulfilled.

`number` is a human-facing sequence generated per order (`#001`, `#002`, …) from the count of
existing orders. It is a label for talking to the firm, never a key — `id` is the key. Two
devices creating an order offline can therefore both mint `#007`, which is cosmetic and
acceptable; making it collision-free would require a coordinating counter, which is exactly
the kind of shared mutable state this design avoids everywhere else.

### Delivery (Yetkazib berish) — the event that moves both stock and money

The heart of the feature. Accepting a delivery writes, **in one atomic IndexedDB transaction**:

1. one **RESTOCK row per line** in the existing `transactions` ledger — stock rises, through
   the single existing source of truth for stock, unchanged;
2. a **delivery header** carrying the firm, the document, and the total — debt rises.

```
id, supplier_id, order_id?,
created_at,                      // write time. immutable. sync watermark.
delivered_at,                    // the date the goods actually arrived. user-editable.
doc_number?, doc_date?,          // faktura / invoice number and date
lines: [{ product_id, product_name, brand, quantity, unit_cost }],
total_amount,                    // snapshotted at write time
user_name, user_role,
voided?, reversal_of?
```

`order_id` is optional: goods sometimes arrive without an order, because the agent simply
shows up with them. `total_amount` is snapshotted at write time for the same reason
`Transaction.cost_price` is — recomputing it later from current prices would silently rewrite
history.

The delivery's ledger rows use `ref_id = delivery.id`, so the stock movement and the debt
entry are joinable in both directions.

### Payment (To'lov)

```
id, supplier_id, amount,
created_at,                      // write time. immutable. sync watermark.
paid_at,                         // the date the money actually moved. user-editable.
method: 'cash' | 'bank' | 'card' | 'other',
doc_number?,                     // to'lov topshiriqnomasi number
note, user_name, user_role,
voided?, reversal_of?
```

Immutable.

### Why two dates on each

`created_at` is when the row was written and never changes. `delivered_at` / `paid_at` are
when the thing really happened, and the user can set them — because deliveries and payments
get entered a day or a week late, all the time.

**Sync must page on `created_at`, never on the user-editable date.** The existing sync pulls
transactions on `ts`, which is safe only because `ts` is always `Date.now()` at write time. A
user-editable date does not have that property: record a delivery today that arrived last
week, and its `delivered_at` lands *behind* the sync watermark — so it would never be pulled,
and the row would live on one till and nowhere else. The statement would disagree between
devices and the debt would be wrong on at least one of them.

The ordering in the statement, the FIFO settlement, and the overdue calculation all use the
real-world date. Only replication uses `created_at`.

### Corrections: void by opposite twin

Deliveries and payments are **append-only, exactly like sales**. Nothing is ever deleted or
edited. Voiding flags the original `voided: true` *and* appends an opposite-signed twin
carrying `reversal_of`.

Crucially, and mirroring `stockDelta` exactly: **voided rows are summed, not skipped.** The
original and its twin cancel to zero on their own. Skipping the original would apply the twin
alone and invent money out of nothing — the precise trap the existing comment in `db.ts`
warns about for stock. Voiding a delivery reverses its ledger rows too, so stock and debt
unwind together.

## Derived reads

**`supplierBalance(id)`** — sum of all delivery totals minus all payment amounts for that
firm, voided rows included (twins cancel). Positive = we owe them (qarz). Negative = we have
prepaid (avans).

**Unpaid deliveries / overdue** — payments settle the oldest deliveries first (FIFO),
computed on read, nothing stored. This is how firms actually reconcile in practice, and it is
what turns "overdue" into a real number: a delivery is overdue when it remains unsettled
under FIFO and `delivered_at + payment_terms_days` has passed.

## Screens

Navigation gains **one** item, **Firmalar (💼)**, taking it from five to six. Orders live
inside it as a tab rather than consuming another slot — they are meaningless without a firm.

`Boshqaruv · Sotuv · Kirim · Mahsulotlar · Firmalar · Hisobot`

### Firmalar — list

Every firm with its balance, ordered by who is owed most. Debt in red, prepayment in green,
with an overdue badge where a delivery has sat unsettled past that firm's terms.

### Firma — detail

Balance in large type. Every bank detail (STIR, hisob raqam, MFO, bank, direktor, telefon)
in a block that can be read out over the phone.

Below it, a **statement**: one chronological list of every delivery and every payment, with a
running balance down the right edge. This is the akt sverki, on screen — the document that
actually settles disputes.

```
12-iyun   Yetkazib berish   faktura №4471    +18 400 000    18 400 000
20-iyun   To'lov            bank o'tkazmasi   −6 000 000    12 400 000
02-iyul   Yetkazib berish   faktura №4602    +9 000 000     21 400 000
```

Actions: **To'lov qilish**, **Yetkazib berish qabul qilish**.

### Buyurtmalar — tab within Firmalar

Create: firm → products → quantities and cost → expected date. Outstanding orders show as a
board by derived status (Kutilmoqda / Qisman keldi / Keldi / Kechikkan), each listing ordered
vs. actually received per product.

### Kirim — extend the existing page, do not fork it

The existing restock counter gains a firm selector and a faktura field at the top.

- **No firm selected** → behaves *exactly* as today. Plain RESTOCK, no debt. The current
  flow does not change or break.
- **Firm selected** → the commit becomes a Delivery: stock rises and debt rises in one write.
- **Arrived from an order** → the cart is prefilled with the quantities still outstanding.

This extends a page that already exists rather than building a parallel receiving screen.

### Boshqaruv (Dashboard)

Three additions: total debt across all firms, count of overdue payments, deliveries expected
this week.

## Persistence and sync

Three new IndexedDB stores — `purchase_orders`, `deliveries`, `payments` — plus the new
columns on `suppliers`. `DB_VERSION` goes 1 → 2; `onupgradeneeded` creates the new stores and
leaves existing data untouched.

Three new Supabase tables mirroring them, with the same RLS-by-`user_id` and realtime
subscriptions the existing three tables use.

Merge rules follow the existing ones exactly, because the reasoning behind them has not
changed:

| Store | Rule | Why |
|---|---|---|
| `purchase_orders` | Last-write-wins on `updated_at`; tombstone on `deleted_at` | Mutable document, not money. Same as products. |
| `deliveries` | Append-only. Same id = same row. `voided` merges with **OR** | Money. Last-write-wins on a void would let a stale device un-cancel a cancelled delivery. Same as transactions. |
| `payments` | Append-only. `voided` merges with **OR** | Same. |

Deliveries and payments page on **`created_at`**, not on `delivered_at` / `paid_at` — see
"Why two dates on each" above. Orders page on `updated_at`, like products.

Push must drag along the row a new reversal points at, exactly as `pushChanges` already does
for voided transactions — a void flips a flag on an *old* row that sits behind the watermark
and would otherwise never be re-sent.

`exportBackup` / `restoreBackup` gain the three new stores; backup format version 1 → 2, with
version 1 files still restoring (their new stores simply come back empty).

## Testing

Extends the existing `tests/logic.check.ts` and `tests/db.check.ts` (fake-indexeddb) suites:

- Balance is delivery-sum minus payment-sum.
- A payment made before any delivery yields a negative balance (prepayment).
- Voiding a delivery returns the balance **and** the stock to where they were.
- Voided rows are summed, not skipped — a voided delivery plus its twin nets to zero, and
  skipping the original would double-count the twin.
- A delivery writes RESTOCK rows and the header atomically: if the ledger write fails,
  no debt is recorded.
- Order status derives correctly across none / partial / full / over-receipt.
- FIFO settlement picks the right oldest-unpaid delivery.
- `mergeRemote` on deliveries/payments: same id is idempotent; `voided` never flips back
  to false.
- **A backdated delivery still replicates**: a delivery written today with a `delivered_at`
  of last week is still picked up by a device whose watermark is later than that date. This
  is the regression test for the two-date rule.
- Restoring a version-1 backup still works.

## Implementation order

1. Types, IndexedDB v2 stores, firm fields. Firm CRUD with the full bank block.
2. Deliveries + payments + `supplierBalance`. Firma detail with the statement. This alone
   answers "how much do we owe and what is the history".
3. Purchase orders, derived status, prefilled receiving from an order.
4. Sync tables and merge rules; backup v2.
5. Dashboard widgets and overdue/FIFO surfacing.

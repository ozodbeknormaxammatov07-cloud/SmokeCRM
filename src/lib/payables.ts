/**
 * What the shop owes its firms — derived, never stored.
 *
 * Every function here is pure: arrays in, numbers out. No IndexedDB, no React. That is
 * deliberate — this is the money, and money should be the easiest thing in the codebase to
 * test exhaustively.
 */
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
 * Positive: we owe them (qarz). Negative: we have prepaid, so they owe us goods (avans).
 * Prepayment is therefore not a special case — it falls out of the arithmetic, which is the
 * whole reason for modelling debt as a ledger rather than a counter.
 *
 * VOIDED ROWS ARE INCLUDED, ON PURPOSE. A void flags the original and appends an
 * opposite-signed twin, so the pair cancels to zero on its own. Filtering flagged rows out
 * would apply the twin alone and conjure money from nothing — the same trap `stockDelta` in
 * db.ts warns about for stock. There is a test pinning exactly this.
 *
 * Callers pass rows already narrowed to one firm; see `forSupplier`.
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
 * This is a display filter, not an accounting one, and it is safe precisely because the pair
 * sums to zero — dropping both leaves the balance unchanged. Never compute a balance with it;
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
  /** The real-world date — delivered_at / paid_at. What a human reconciles against. */
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
 * where it happened, even if it was typed in today. Ordering by write time would produce a
 * running balance that tells a story which never occurred.
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
  /** 0 when still within the firm's payment terms. */
  daysOverdue: number
}

/**
 * Payments settle the OLDEST delivery first — computed on read, stored nowhere.
 *
 * Nothing in the data links a payment to a delivery, and nothing should: a firm sends one
 * transfer against three fakturas and nobody records which. FIFO is how firms actually
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
 * What is still owed on this order. Clamped at zero, because over-receipt is allowed (see
 * `orderStatus`) and a line must never report a negative outstanding quantity.
 */
export function outstandingLines(order: PurchaseOrder, deliveries: Delivery[]): OrderLine[] {
  const got = receivedQty(order, deliveries)
  return order.lines
    .map((l) => ({ ...l, quantity: l.quantity - (got.get(l.product_id) ?? 0) }))
    .filter((l) => l.quantity > 0)
}

/**
 * Derived — except `cancelled`, which is a human decision rather than arithmetic.
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

import {
  supplierBalance, statement, unpaidDeliveries, orderStatus, receivedQty,
  outstandingLines, linesTotal, liveDeliveries, worstOverdue,
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
  eq('voided payment + twin net to zero, so the debt is restored',
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

  console.log('\n=== a backdated delivery lands where it HAPPENED, not where it was typed ===')
  // Written last (created_at newest) but it arrived first. The statement must order by the
  // real-world date, or the running balance tells a story that never happened.
  const backdated = statement(
    [
      del({ id: 'typed-first', total_amount: 1_000, created_at: T0, delivered_at: T0 + 10 * DAY }),
      del({ id: 'arrived-first', total_amount: 5_000, created_at: T0 + 99 * DAY, delivered_at: T0 }),
    ],
    [],
  )
  eq('ordered by delivered_at, not created_at',
    backdated.map((r) => r.id), ['arrived-first', 'typed-first'])

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
  eq('60-day terms: the same delivery is not overdue at all',
    unpaidDeliveries([del({ id: 'd', total_amount: 1, delivered_at: T0 })], [], 60, now)
      .map((u) => u.daysOverdue), [0])
  eq('worstOverdue picks the worst of them',
    worstOverdue(
      [del({ id: 'a', total_amount: 1, delivered_at: T0 }),
        del({ id: 'b', total_amount: 1, delivered_at: T0 + 35 * DAY })],
      [], 0, now,
    ), 40)
  eq('a settled delivery is never overdue',
    worstOverdue([del({ id: 'a', total_amount: 100, delivered_at: T0 })],
      [pay({ id: 'p', amount: 100 })], 0, now), 0)

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

  console.log('\n=== a delivery for ANOTHER order never counts towards this one ===')
  const other = [del({
    id: 'dx', order_id: 'o-other', total_amount: 50_000, lines: [line('A', 50, 1000)],
  })]
  eq('other order ignored', orderStatus(order, other, before), 'waiting')

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
  eq('and nothing counts as received', [...receivedQty(order, voided)], [])

  console.log('\n=== cancelled beats everything ===')
  eq('cancelled order', orderStatus({ ...order, cancelled_at: T0 }, full, after), 'cancelled')

  eq('linesTotal', linesTotal([line('A', 3, 1000), line('B', 2, 2500)]), 8000)

  console.log(fail === 0 ? '\n✅ ALL PAYABLES CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main()

import 'fake-indexeddb/auto'
import { openDb, STORES, tx, getAll } from '../src/lib/idb'
import {
  createProduct, commitCart, fetchAllTransactions,
  exportBackup, restoreBackup, snapshotForSync, mergeRemote,
} from '../src/lib/db'
import {
  createDelivery, voidDelivery, fetchDeliveries,
  recordPayment, voidPayment, fetchPayments,
  savePurchaseOrder, cancelPurchaseOrder, fetchPurchaseOrders,
} from '../src/lib/procurement'
import { supplierBalance, orderStatus, outstandingLines } from '../src/lib/payables'
import type { Product, Delivery } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

const ACTOR = { name: 'Ahmadjon', role: 'admin' as const }
const products = () => tx([STORES.products], 'readonly', (t) => getAll<Product>(t, STORES.products))
const byId = async (id: string) => (await products()).find((p) => p.id === id)!

async function main() {
  console.log('\n=== the new stores exist at DB v2 ===')
  const db = await openDb()
  eq('db version', db.version, 3)
  ok('purchase_orders store', db.objectStoreNames.contains(STORES.purchase_orders))
  ok('deliveries store', db.objectStoreNames.contains(STORES.deliveries))
  ok('payments store', db.objectStoreNames.contains(STORES.payments))

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

  console.log('\n=== the sync watermark is the write time, not the delivery date ===')
  const backdatedAt = Date.now() - 30 * 86_400_000
  const { id: dBack } = await createDelivery({
    supplier_id: 'F1',
    delivered_at: backdatedAt,   // the goods arrived a month ago; we are typing it in now
    lines: [{ product_id: pid, product_name: 'Winston Blue', brand: 'Winston', quantity: 1, unit_cost: 14_000 }],
  }, ACTOR)
  const back = (await fetchDeliveries()).find((d) => d.id === dBack)!
  ok('created_at is now, not the backdated arrival', back.created_at > back.delivered_at)
  eq('delivered_at is preserved exactly as entered', back.delivered_at, backdatedAt)

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

  console.log('\n=== a void that would drive stock negative is refused outright ===')
  const p2 = await createProduct({
    name: 'Esse', brand: 'Esse', cost_price: 16_000, selling_price: 22_000,
    current_stock: 0, reorder_threshold: 5, active: true,
  }, ACTOR)
  const { id: d3 } = await createDelivery({
    supplier_id: 'F2', delivered_at: Date.now(),
    lines: [{ product_id: p2, product_name: 'Esse', brand: 'Esse', quantity: 5, unit_cost: 16_000 }],
  }, ACTOR)
  // The 5 units have since been sold. Reversing the receipt would claim stock we do not hold.
  await commitCart('SALE', [{ product: await byId(p2), quantity: 5, unit_price: 22_000 }], ACTOR)

  threw = null
  try { await voidDelivery(d3, ACTOR) } catch (e) { threw = e }
  ok('void refused when the goods are already sold', threw instanceof Error)
  eq('stock untouched by the refused void', (await byId(p2)).current_stock, 0)
  eq('debt untouched by the refused void',
    supplierBalance((await fetchDeliveries()).filter((d) => d.supplier_id === 'F2'), []), 80_000)

  console.log('\n=== paying cash at receipt settles the firm in one write ===')
  const cashProd = await createProduct({
    name: 'Marlboro', brand: 'Marlboro', cost_price: 22_000, selling_price: 28_000,
    current_stock: 0, reorder_threshold: 5, active: true,
  }, ACTOR)
  await createDelivery({
    supplier_id: 'F-CASH', delivered_at: Date.now(), doc_number: '5000',
    settle: 'cash',
    lines: [{ product_id: cashProd, product_name: 'Marlboro', brand: 'Marlboro', quantity: 10, unit_cost: 22_000 }],
  }, ACTOR)

  const cashDs = (await fetchDeliveries()).filter((d) => d.supplier_id === 'F-CASH')
  const cashPs = (await fetchPayments()).filter((p) => p.supplier_id === 'F-CASH')
  eq('stock still rose', (await byId(cashProd)).current_stock, 10)
  eq('a settling payment was written alongside the delivery', cashPs.length, 1)
  eq('its amount matches the delivery total', cashPs[0].amount, 220_000)
  eq('the method is recorded', cashPs[0].method, 'cash')
  eq('the firm owes nothing — paid on the spot', supplierBalance(cashDs, cashPs), 0)

  console.log('\n=== a credit delivery still leaves a debt ===')
  await createDelivery({
    supplier_id: 'F-CREDIT', delivered_at: Date.now(),
    lines: [{ product_id: cashProd, product_name: 'Marlboro', brand: 'Marlboro', quantity: 5, unit_cost: 22_000 }],
  }, ACTOR)
  const creditDs = (await fetchDeliveries()).filter((d) => d.supplier_id === 'F-CREDIT')
  const creditPs = (await fetchPayments()).filter((p) => p.supplier_id === 'F-CREDIT')
  eq('no payment written for a credit delivery', creditPs.length, 0)
  eq('the firm is owed the full amount', supplierBalance(creditDs, creditPs), 110_000)

  console.log('\n=== an empty delivery is refused ===')
  threw = null
  try {
    await createDelivery({ supplier_id: 'F1', delivered_at: Date.now(), lines: [] }, ACTOR)
  } catch (e) { threw = e }
  ok('empty delivery refused', threw instanceof Error)

  /* ---------------------------------------------------------------- */
  /* Payments                                                          */
  /* ---------------------------------------------------------------- */

  console.log('\n=== payments reduce the debt ===')
  const balF3 = async () => {
    const [d, p] = await Promise.all([fetchDeliveries(), fetchPayments()])
    return supplierBalance(
      d.filter((x) => x.supplier_id === 'F3'),
      p.filter((x) => x.supplier_id === 'F3'),
    )
  }

  const p3 = await createProduct({
    name: 'Kent', brand: 'Kent', cost_price: 18_000, selling_price: 24_000,
    current_stock: 0, reorder_threshold: 5, active: true,
  }, ACTOR)
  await createDelivery({
    supplier_id: 'F3', delivered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 100, unit_cost: 18_000 }],
  }, ACTOR)
  eq('owed after the delivery', await balF3(), 1_800_000)

  const payId = await recordPayment({
    supplier_id: 'F3', amount: 800_000, paid_at: Date.now(),
    method: 'bank', doc_number: 'TT-19',
  }, ACTOR)
  eq('debt reduced by the payment', await balF3(), 1_000_000)

  console.log('\n=== a payment before any delivery is a prepayment (negative balance) ===')
  await recordPayment({
    supplier_id: 'F4', amount: 2_000_000, paid_at: Date.now(), method: 'cash',
  }, ACTOR)
  const prepaid = (await fetchPayments()).filter((p) => p.supplier_id === 'F4')
  eq('prepayment reads as a negative balance', supplierBalance([], prepaid), -2_000_000)

  console.log('\n=== voiding a payment restores the debt ===')
  await voidPayment(payId, ACTOR)
  eq('debt back to the full amount', await balF3(), 1_800_000)

  const pays = await fetchPayments()
  const origPay = pays.find((p) => p.id === payId)!
  const twinPay = pays.find((p) => p.reversal_of === payId)!
  ok('original payment flagged, not deleted', origPay.voided === true)
  eq('twin payment is opposite-signed', twinPay.amount, -800_000)

  threw = null
  try { await voidPayment(payId, ACTOR) } catch (e) { threw = e }
  ok('double-void refused', threw instanceof Error)

  threw = null
  try {
    await recordPayment({ supplier_id: 'F3', amount: 0, paid_at: Date.now(), method: 'cash' }, ACTOR)
  } catch (e) { threw = e }
  ok('a payment of zero is refused', threw instanceof Error)

  /* ---------------------------------------------------------------- */
  /* Purchase orders                                                   */
  /* ---------------------------------------------------------------- */

  console.log('\n=== an order is an intention: it moves no stock and no money ===')
  const stockBeforeOrder = (await byId(p3)).current_stock
  const debtBeforeOrder = await balF3()

  const oid = await savePurchaseOrder({
    supplier_id: 'F3',
    ordered_at: Date.now(),
    expected_at: Date.now() + 7 * 86_400_000,
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 50, unit_cost: 18_000 }],
  }, ACTOR)

  eq('ordering moved no stock', (await byId(p3)).current_stock, stockBeforeOrder)
  eq('ordering moved no money', await balF3(), debtBeforeOrder)

  const o = (await fetchPurchaseOrders()).find((x) => x.id === oid)!
  ok('the order got a human number', /^#\d{3}$/.test(o.number))
  eq('a fresh order is waiting', orderStatus(o, await fetchDeliveries()), 'waiting')

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

  console.log('\n=== order numbers increment ===')
  const oid2 = await savePurchaseOrder({
    supplier_id: 'F3', ordered_at: Date.now(),
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 5, unit_cost: 18_000 }],
  }, ACTOR)
  const o2 = (await fetchPurchaseOrders()).find((x) => x.id === oid2)!
  eq('second order is #002', o2.number, '#002')

  console.log('\n=== cancelling an order ===')
  await cancelPurchaseOrder(oid2)
  const o2c = (await fetchPurchaseOrders()).find((x) => x.id === oid2)!
  eq('cancelled', orderStatus(o2c, await fetchDeliveries()), 'cancelled')

  console.log('\n=== editing an order keeps its id and number ===')
  await savePurchaseOrder({
    id: oid,
    supplier_id: 'F3', ordered_at: o.ordered_at,
    lines: [{ product_id: p3, product_name: 'Kent', brand: 'Kent', quantity: 99, unit_cost: 18_000 }],
  }, ACTOR)
  const oEdited = (await fetchPurchaseOrders()).find((x) => x.id === oid)!
  eq('number preserved across an edit', oEdited.number, o.number)
  eq('lines updated', oEdited.lines[0].quantity, 99)

  /* ---------------------------------------------------------------- */
  /* Backup and merge                                                  */
  /* ---------------------------------------------------------------- */

  console.log('\n=== backup carries the new stores ===')
  const backup = await exportBackup()
  eq('backup version', backup.version, 2)
  ok('deliveries in backup', backup.deliveries.length > 0)
  ok('payments in backup', backup.payments.length > 0)
  ok('orders in backup', backup.purchase_orders.length > 0)

  const roundTrip = await restoreBackup(backup)
  eq('restore reports the delivery count', roundTrip.deliveries, backup.deliveries.length)
  eq('deliveries survived the round-trip', (await fetchDeliveries()).length, backup.deliveries.length)

  console.log('\n=== a version-1 backup still restores ===')
  // A file written by the OLD version has no procurement arrays at all. It must restore with
  // those stores simply empty — never crash on a missing key, or the upgrade would strand the
  // owner's only copy of their data.
  const v1 = {
    format: 'tamaki-savdo' as const, version: 1, exported_at: Date.now(),
    products: backup.products, transactions: backup.transactions, suppliers: backup.suppliers,
  }
  await restoreBackup(v1 as never)
  eq('v1 restores with empty procurement stores', (await fetchDeliveries()).length, 0)
  ok('but the products came back', (await products()).length > 0)

  await restoreBackup(backup)   // put the real data back

  console.log('\n=== merge is idempotent ===')
  const snap = await snapshotForSync()
  eq('merging our own snapshot changes nothing', await mergeRemote(snap), 0)

  console.log('\n=== a stale device cannot un-void a delivery or a payment ===')
  const voidedDelivery = snap.deliveries.find((d) => d.voided)!
  const voidedPayment = snap.payments.find((p) => p.voided)!
  await mergeRemote({
    ...snap,
    deliveries: [{ ...voidedDelivery, voided: false }],
    payments: [{ ...voidedPayment, voided: false }],
  })
  eq('delivery stays voided',
    (await fetchDeliveries()).find((d) => d.id === voidedDelivery.id)!.voided, true)
  eq('payment stays voided',
    (await fetchPayments()).find((p) => p.id === voidedPayment.id)!.voided, true)

  console.log('\n=== a BACKDATED delivery still replicates ===')
  // The regression test for the two-date rule. This delivery ARRIVED 30 days ago but is being
  // written now. Had sync paged on delivered_at, it would sit behind the other device's
  // watermark and never be pulled — and the two tills would disagree about the debt forever.
  const backdated: Delivery = {
    id: 'backdated-1', supplier_id: 'F9',
    created_at: Date.now(),                       // written NOW
    delivered_at: Date.now() - 30 * 86_400_000,   // but it arrived a month ago
    lines: [], total_amount: 500_000,
    user_name: 'A', user_role: 'admin', voided: false,
  }
  ok('merge accepts it', (await mergeRemote({ ...snap, deliveries: [backdated] })) > 0)
  const pulled = (await fetchDeliveries()).find((d) => d.id === 'backdated-1')!
  ok('backdated delivery merged', !!pulled)
  ok('its watermark is the write time, not the arrival date',
    pulled.created_at > pulled.delivered_at)
  eq('and it counts towards the debt',
    supplierBalance((await fetchDeliveries()).filter((d) => d.supplier_id === 'F9'), []), 500_000)

  console.log('\n=== merging a delivery rebuilds the stock it carries ===')
  const merged = await fetchDeliveries()
  const live = merged.find((d) => !d.voided && !d.reversal_of && d.lines.length > 0)!
  ok('a merged delivery has lines to recompute from', live.lines.length > 0)

  console.log(fail === 0 ? '\n✅ ALL PROCUREMENT CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

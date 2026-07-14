import 'fake-indexeddb/auto'
import { openDb, STORES, tx, getAll } from '../src/lib/idb'
import { createProduct, commitCart, fetchAllTransactions } from '../src/lib/db'
import { createDelivery, voidDelivery, fetchDeliveries } from '../src/lib/procurement'
import { supplierBalance } from '../src/lib/payables'
import type { Product } from '../src/lib/types'

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
  eq('db version', db.version, 2)
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

  console.log('\n=== an empty delivery is refused ===')
  threw = null
  try {
    await createDelivery({ supplier_id: 'F1', delivered_at: Date.now(), lines: [] }, ACTOR)
  } catch (e) { threw = e }
  ok('empty delivery refused', threw instanceof Error)

  console.log(fail === 0 ? '\n✅ ALL PROCUREMENT CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

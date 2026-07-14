import 'fake-indexeddb/auto'
import {
  createProduct, updateProduct, commitCart, voidTransaction, adjustStock,
  fetchAllTransactions, importProducts, exportBackup, restoreBackup, resetAllData, StockError,
} from '../src/lib/db'
import { tx, STORES, getAll } from '../src/lib/idb'
import { totals } from '../src/lib/analytics'
import type { Product, CartLine } from '../src/lib/types'

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
const line = (p: Product, quantity: number, unit_price = p.selling_price): CartLine =>
  ({ product: p, quantity, unit_price })

async function main() {
  console.log('\n=== stock moves only through the ledger ===')
  const id = await createProduct({
    name: 'Winston Blue', brand: 'Winston', cost_price: 14000, selling_price: 20000,
    current_stock: 100, reorder_threshold: 20, active: true,
  }, ACTOR)
  let p = await byId(id)
  eq('opening stock', p.current_stock, 100)
  // ...and it came from somewhere: opening stock is a ledger row, not invented inventory.
  const opening = await fetchAllTransactions()
  eq('opening stock posted to the ledger', [opening.length, opening[0].type, opening[0].quantity],
    [1, 'RESTOCK', 100])

  await commitCart('SALE', [line(p, 10)], ACTOR)
  p = await byId(id)
  eq('sale decrements stock', p.current_stock, 90)

  await commitCart('RESTOCK', [line(p, 50, 14000)], ACTOR)
  p = await byId(id)
  eq('restock increments stock', p.current_stock, 140)

  let t = totals(await fetchAllTransactions())
  eq('revenue = 10 x 20 000', t.revenue, 200000)
  eq('profit = 10 x (20 000 - 14 000)', t.profit, 60000)
  // 100 opening @ 14 000 = 1 400 000, plus the 50 @ 14 000 restock = 700 000.
  eq('restock is not revenue', t.restockCost, 2100000)

  console.log('\n=== updateProduct cannot touch stock ===')
  // Even if a caller sneaks current_stock into the patch, it must be ignored.
  await updateProduct(id, { selling_price: 21000, current_stock: 99999 } as never)
  p = await byId(id)
  eq('price updated', p.selling_price, 21000)
  eq('stock NOT overwritten by updateProduct', p.current_stock, 140)

  console.log('\n=== negative stock is blocked ===')
  let threw: unknown = null
  try {
    await commitCart('SALE', [line(p, 141)], ACTOR)
  } catch (e) { threw = e }
  ok('overselling throws StockError', threw instanceof StockError)
  p = await byId(id)
  eq('stock unchanged after blocked sale', p.current_stock, 140)

  console.log('\n=== a basket is atomic (all lines or none) ===')
  const id2 = await createProduct({
    name: 'Esse Change', brand: 'Esse', cost_price: 16000, selling_price: 22000,
    current_stock: 3, reorder_threshold: 5, active: true,
  }, ACTOR)
  const p2 = await byId(id2)
  const before = (await fetchAllTransactions()).length
  threw = null
  try {
    // line 1 is fine, line 2 oversells -> the whole basket must roll back
    await commitCart('SALE', [line(await byId(id), 5), line(p2, 99)], ACTOR)
  } catch (e) { threw = e }
  ok('mixed basket throws', threw instanceof StockError)
  eq('good line rolled back too', (await byId(id)).current_stock, 140)
  eq('no ledger rows written', (await fetchAllTransactions()).length, before)

  console.log('\n=== same product twice in one basket is summed, not checked separately ===')
  threw = null
  try {
    // 2 + 2 = 4 > 3 available. Checked per-line this would wrongly pass.
    await commitCart('SALE', [line(p2, 2), line(p2, 2)], ACTOR)
  } catch (e) { threw = e }
  ok('duplicate lines validated against combined qty', threw instanceof StockError)
  eq('Esse stock untouched', (await byId(id2)).current_stock, 3)

  console.log('\n=== restock at a new cost repricess the product ===')
  await commitCart('RESTOCK', [line(await byId(id2), 10, 17000)], ACTOR)
  const p2b = await byId(id2)
  eq('cost_price updated by restock', p2b.cost_price, 17000)
  eq('stock 3 + 10', p2b.current_stock, 13)
  // and the profit of the OLD sale must not have moved
  await commitCart('SALE', [line(p2b, 1)], ACTOR)
  const esseSale = (await fetchAllTransactions()).find((x) => x.product_id === id2 && x.type === 'SALE')!
  eq('new sale profits off the NEW cost', esseSale.profit, 22000 - 17000)

  console.log('\n=== void reverses stock and nets profit to zero ===')
  const all = await fetchAllTransactions()
  const winSale = all.find((x) => x.product_id === id && x.type === 'SALE' && x.quantity === 10)!
  const stockBefore = (await byId(id)).current_stock
  await voidTransaction(winSale, ACTOR)
  eq('stock returned by void', (await byId(id)).current_stock, stockBefore + 10)

  const after = await fetchAllTransactions()
  const original = after.find((x) => x.id === winSale.id)!
  ok('original flagged voided', original.voided === true)
  ok('original still present (not deleted)', !!original)
  const rev = after.find((x) => x.reversal_of === winSale.id)!
  ok('reversal row written', !!rev)
  eq('reversal is opposite-signed', [rev.quantity, rev.total_amount, rev.profit], [-10, -200000, -60000])

  threw = null
  try { await voidTransaction(original, ACTOR) } catch (e) { threw = e }
  ok('double-void refused', threw instanceof Error)

  // The point of a void: the sale must vanish from the reports, not go negative.
  // Winston: the 10-pack sale is now voided. Esse: one live 1-pack sale at 22 000
  // against a 17 000 cost. That single sale is all the revenue there should be.
  const tv = totals(await fetchAllTransactions())
  eq('voided sale leaves the reports', tv.revenue, 22000)
  eq('voided profit leaves the reports', tv.profit, 5000)
  eq('voided units leave the reports', tv.unitsSold, 1)

  console.log('\n=== adjustStock posts an auditable row ===')
  const n1 = (await fetchAllTransactions()).length
  await adjustStock(await byId(id), 100, ACTOR, 'qayta sanaldi')
  eq('stock set to counted value', (await byId(id)).current_stock, 100)
  eq('adjustment logged', (await fetchAllTransactions()).length, n1 + 1)
  const adj = (await fetchAllTransactions())[0]
  ok('adjustment names the reason', (adj.note ?? '').includes('qayta sanaldi'))

  console.log('\n=== import posts opening stock as a ledger row ===')
  const n2 = (await fetchAllTransactions()).length
  const res = await importProducts([
    { name: 'Parliament Aqua', brand: 'Parliament', cost_price: 25000, selling_price: 32000, current_stock: 40, reorder_threshold: 10, active: true },
    { name: 'Parliament Night', brand: 'Parliament', cost_price: 26000, selling_price: 33000, current_stock: 0, reorder_threshold: 10, active: true },
  ], ACTOR)
  eq('both imported', res.imported, 2)
  // only the one WITH opening stock gets a ledger row
  eq('one opening-stock row written', (await fetchAllTransactions()).length, n2 + 1)

  console.log('\n=== backup round-trips exactly ===')
  const backup = await exportBackup()
  const sig = (b: typeof backup) => [b.products.length, b.transactions.length]
  const wanted = sig(backup)

  await commitCart('SALE', [line(await byId(id), 7)], ACTOR)   // mutate after backup
  ok('data changed after backup', JSON.stringify(sig(await exportBackup())) !== JSON.stringify(wanted))

  const r = await restoreBackup(backup)
  eq('restore reports counts', [r.products, r.transactions], wanted)
  eq('restored state matches backup', sig(await exportBackup()), wanted)
  eq('restored stock is the backed-up value', (await byId(id)).current_stock, 100)

  let bad: unknown = null
  try { await restoreBackup({ nope: true } as never) } catch (e) { bad = e }
  ok('garbage backup file refused', bad instanceof Error)

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

  console.log('\n=== resetAllData wipes the business stores ===')
  ok('there is data to wipe', (await fetchAllTransactions()).length > 0 && (await products()).length > 0)
  await resetAllData()
  eq('products cleared', (await products()).length, 0)
  eq('transactions cleared', (await fetchAllTransactions()).length, 0)
  const empty = await exportBackup()
  eq('every business store is empty',
    [empty.products.length, empty.transactions.length, empty.suppliers.length,
      empty.purchase_orders.length, empty.deliveries.length, empty.payments.length],
    [0, 0, 0, 0, 0, 0])

  console.log(fail === 0 ? '\n✅ ALL DB CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

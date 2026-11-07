import 'fake-indexeddb/auto'
import { createProduct, updateProduct, commitCart, voidTransaction, fetchAllTransactions } from '../src/lib/db'
import { tx, STORES, getAll } from '../src/lib/idb'
import { salesByPriceType } from '../src/lib/kassa'
import { priceFor } from '../src/lib/analytics'
import type { Product, CartLine } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

const ACTOR = { name: 'Ahmadjon', role: 'admin' as const }
const byId = async (id: string) =>
  (await tx([STORES.products], 'readonly', (t) => getAll<Product>(t, STORES.products))).find((p) => p.id === id)!

async function main() {
  console.log('\n=== price lists (naqd / karta) ===')
  const id = await createProduct({
    name: 'Pall Mall Red', brand: 'UzBat', cost_price: 15000, selling_price: 18000,
    card_price: 19000, current_stock: 100, reorder_threshold: 10, active: true,
  }, ACTOR)
  let p = await byId(id)
  eq('card price stored on the product', p.card_price, 19000)
  eq('priceFor cash', priceFor(p, 'cash'), 18000)
  eq('priceFor card', priceFor(p, 'card'), 19000)
  eq('no card price → card falls back to the normal price',
    priceFor({ ...p, card_price: undefined }, 'card'), 18000)

  // One basket, same product at both prices — two lines, one stock check.
  const lines: CartLine[] = [
    { product: p, quantity: 10, unit_price: 18000, price_type: 'cash' },
    { product: p, quantity: 2, unit_price: 19000, price_type: 'card' },
  ]
  await commitCart('SALE', lines, ACTOR)
  p = await byId(id)
  eq('both lines leave stock', p.current_stock, 88)

  let all = await fetchAllTransactions()
  const sales = all.filter((t) => t.type === 'SALE')
  eq('each sale row records its price list',
    sales.map((t) => [t.quantity, t.price_type]).sort(), [[10, 'cash'], [2, 'card']].sort())

  let split = salesByPriceType(all)
  eq('split: naqd revenue', split.cash.revenue, 180000)
  eq('split: karta revenue', split.card.revenue, 38000)
  eq('split: karta profit uses the card price', split.card.profit, 8000)
  eq('split: units', [split.cash.units, split.card.units], [10, 2])

  // Voiding the card line nets it out of the karta total, and the reversal keeps the label.
  const cardRow = sales.find((t) => t.price_type === 'card')!
  await voidTransaction(cardRow, ACTOR)
  all = await fetchAllTransactions()
  const reversal = all.find((t) => t.reversal_of === cardRow.id)!
  eq('reversal carries the same price list', reversal.price_type, 'card')
  split = salesByPriceType(all)
  eq('voided card sale leaves karta at zero', split.card.revenue, 0)
  eq('naqd untouched by the void', split.cash.revenue, 180000)

  // A restock never carries a price list.
  await commitCart('RESTOCK', [{ product: p, quantity: 5, unit_price: 15000 }], ACTOR)
  all = await fetchAllTransactions()
  eq('restock has no price list', all.filter((t) => t.type === 'RESTOCK').every((t) => t.price_type === undefined), true)

  // Clearing the card price on the product.
  await updateProduct(id, { card_price: undefined })
  eq('card price can be cleared', (await byId(id)).card_price, undefined)

  // Sales from before price lists existed count as naqd.
  eq('legacy sale (no price_type) counts as naqd',
    salesByPriceType([{ ...cardRow, id: 'old', price_type: undefined, voided: false }]).cash.revenue, 38000)

  if (fail) { console.log(`\n${fail} FAILED`); process.exit(1) }
  console.log('\n✅ ALL PRICE-LIST CHECKS PASSED')
}

main().catch((e) => { console.error(e); process.exit(1) })

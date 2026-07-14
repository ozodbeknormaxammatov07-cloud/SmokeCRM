import * as XLSX from 'xlsx'
import { parseNum, money, num, marginPct } from '../src/lib/format'
import { totals, byBrand, reorderList, stockLevel } from '../src/lib/analytics'
import { parseWorkbook, autoMap, buildPreview, markDuplicates } from '../src/lib/excel'
import type { Transaction, Product } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

// Thousands are grouped with U+00A0 so a price can't wrap mid-number.
const NB = ' '

console.log('\n=== formatting / parsing ===')
eq('money thousands (NBSP-grouped)', money(1250000), `1${NB}250${NB}000 so'm`)
eq('num negative', num(-45000), `-45${NB}000`)
eq("parseNum '12 000 so'm'", parseNum("12 000 so'm"), 12000)
eq("parseNum '25,000'", parseNum('25,000'), 25000)
eq("parseNum '1 250,50' decimal", parseNum('1 250,50'), 1250.5)
eq('parseNum junk', parseNum('—'), 0)
eq('margin 30%', marginPct(14000, 20000), 30)

console.log('\n=== ledger math ===')
const tx = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(), ts: Date.now(), type: 'SALE', product_id: 'p1',
  product_name: 'Winston Blue', brand: 'Winston', quantity: 1, unit_price: 0,
  cost_price: 0, total_amount: 0, profit: 0, user_name: 'A', user_role: 'admin',
  ref_id: 'r1', voided: false, ...o,
})

// 10 packs bought at 14 000, sold at 20 000 => revenue 200k, profit 60k, margin 30%
const sale = tx({ quantity: 10, unit_price: 20000, cost_price: 14000, total_amount: 200000, profit: 60000 })
const t1 = totals([sale])
eq('revenue', t1.revenue, 200000)
eq('profit', t1.profit, 60000)
eq('units', t1.unitsSold, 10)
eq('margin %', Math.round(t1.margin), 30)

// A voided sale plus its reversal must net to exactly zero.
const voided = { ...sale, voided: true }
const reversal = tx({ quantity: -10, unit_price: 20000, cost_price: 14000, total_amount: -200000, profit: -60000, reversal_of: sale.id })
const t2 = totals([voided, reversal])
eq('voided sale nets to zero revenue', t2.revenue, 0)
eq('voided sale nets to zero profit', t2.profit, 0)
eq('voided sale nets to zero units', t2.unitsSold, 0)
eq('a fully voided receipt is not a sale', t2.saleCount, 0)
// A second, live sale must be untouched by the void of the first.
const live = tx({ id: 'live', ref_id: 'r2', quantity: 5, unit_price: 20000, cost_price: 14000, total_amount: 100000, profit: 30000 })
const t3 = totals([live, voided, reversal])
eq('live sale survives the void', t3.revenue, 100000)
eq('live profit survives the void', t3.profit, 30000)
eq('live units survive the void', t3.unitsSold, 5)
eq('only the live sale is counted', t3.saleCount, 1)
// The breakdowns must agree with the totals — they are what the reports actually show.
eq('brand breakdown ignores voided + reversal',
  byBrand([live, voided, reversal]).map(b => [b.name, b.revenue, b.units]), [['Winston', 100000, 5]])
// A voided RESTOCK must not drive restock cost negative either.
const vRestock = tx({ type: 'RESTOCK', quantity: 50, unit_price: 14000, total_amount: 700000, voided: true })
const vRestockRev = tx({ type: 'RESTOCK', quantity: -50, unit_price: 14000, total_amount: -700000, reversal_of: vRestock.id })
eq('voided restock nets to zero cost', totals([vRestock, vRestockRev]).restockCost, 0)

// restock must never count as revenue
const t4 = totals([tx({ type: 'RESTOCK', quantity: 50, unit_price: 14000, total_amount: 700000, profit: 0 })])
eq('restock revenue = 0', t4.revenue, 0)
eq('restock cost tracked', t4.restockCost, 700000)

const bb = byBrand([sale, tx({ brand: 'Esse', quantity: 5, unit_price: 22000, cost_price: 16000, total_amount: 110000, profit: 30000 })])
eq('brand split', bb.map(b => [b.name, b.revenue]), [['Winston', 200000], ['Esse', 110000]])

console.log('\n=== stock levels ===')
const p = (o: Partial<Product>): Product => ({
  id: 'x', name: 'n', brand: 'b', cost_price: 1, selling_price: 2,
  current_stock: 0, reorder_threshold: 10, active: true, ...o,
})
eq('out of stock', stockLevel(p({ current_stock: 0 })), 'out')
eq('at threshold = low', stockLevel(p({ current_stock: 10 })), 'low')
eq('above threshold = ok', stockLevel(p({ current_stock: 11 })), 'ok')
eq('inactive excluded from reorder', reorderList([p({ current_stock: 0, active: false })]).length, 0)
eq('reorder sorted most-urgent-first',
  reorderList([p({ id: 'a', current_stock: 8 }), p({ id: 'b', current_stock: 0 })]).map(x => x.id),
  ['b', 'a'])

console.log('\n=== excel import (simulating the real 4-sheet shop file) ===')
const wb = XLSX.utils.book_new()
// Sheet shaped like a real hand-made shop file: a title row, then headers, then a "Jami" footer.
const winston = XLSX.utils.aoa_to_sheet([
  ['Winston sigaretalari', '', '', '', ''],
  ['Nomi', 'Sotib olish narxi', 'Sotish narxi', 'Qoldiq', 'Sotilgan'],
  ['Winston Blue', '14 000', '20 000', 120, 45],
  ['Winston Silver', 14500, 21000, 8, 30],
  ['Jami', '', '', 128, 75],
])
XLSX.utils.book_append_sheet(wb, winston, 'Winston')
const esse = XLSX.utils.aoa_to_sheet([
  ['Product', 'Purchase price', 'Selling price', 'Stock'],
  ['Esse Change', 16000, 22000, 4],
])
XLSX.utils.book_append_sheet(wb, esse, 'Esse')

const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
const sheets = parseWorkbook(buf)
eq('found both sheets', sheets.map(s => s.sheetName), ['Winston', 'Esse'])
eq('skipped the title row, found real headers', sheets[0].headers[0], 'Nomi')

const mapW = autoMap(sheets[0].headers)
eq('mapped Uzbek name col', mapW['Nomi'], 'name')
eq('mapped Uzbek cost col', mapW['Sotib olish narxi'], 'cost_price')
eq('mapped Uzbek sell col', mapW['Sotish narxi'], 'selling_price')
eq('mapped Uzbek stock col', mapW['Qoldiq'], 'current_stock')

const rowsW = buildPreview(sheets[0], mapW, '', 10)
eq('dropped the "Jami" footer row', rowsW.length, 2)
eq('parsed "14 000" string as 14000', rowsW[0].cost_price, 14000)
eq('sheet name became the brand', rowsW[0].brand, 'Winston')
eq('no import errors', rowsW.flatMap(r => r._errors), [])

const mapE = autoMap(sheets[1].headers)
eq('mapped English headers too', [mapE['Product'], mapE['Purchase price'], mapE['Selling price'], mapE['Stock']],
  ['name', 'cost_price', 'selling_price', 'current_stock'])
const rowsE = buildPreview(sheets[1], mapE, '', 10)
eq('Esse brand from sheet name', rowsE[0].brand, 'Esse')
eq('Esse low stock threshold default', rowsE[0].reorder_threshold, 10)

console.log('\n=== importing the same file twice must not double the catalogue ===')
// The shop already has Winston Blue; the file being imported carries it again, plus a
// genuinely new packet, plus the same new packet listed twice.
const existing: Product[] = [p({ id: 'w', name: 'Winston Blue', brand: 'Winston' })]
const firstPass = markDuplicates(rowsW, [])
eq('a clean import flags nothing', firstPass.filter(r => r._duplicate).length, 0)

const secondPass = markDuplicates(rowsW, [
  ...existing,
  p({ id: 's', name: 'Winston Silver', brand: 'Winston' }),
])
eq('re-importing the same file flags every row', secondPass.filter(r => r._duplicate).length, 2)
eq('so nothing new would be imported', secondPass.filter(r => !r._duplicate).length, 0)

// Case and stray spaces must not smuggle a duplicate past the check.
eq('name match ignores case and padding',
  markDuplicates(rowsW, [p({ id: 'w', name: '  winston BLUE ', brand: 'winston' })])[0]._duplicate, true)
// Same name under a different brand is a different product.
eq('same name, different brand is not a duplicate',
  markDuplicates(rowsW, [p({ id: 'w', name: 'Winston Blue', brand: 'Esse' })])[0]._duplicate, false)
// A barcode, when present, is the identity — a renamed packet is still the same packet.
const scanned = markDuplicates(
  rowsW.map((r, i) => (i === 0 ? { ...r, barcode: '4780' } : r)),
  [p({ id: 'w', name: 'totally different name', brand: 'Winston', barcode: '4780' })],
)
eq('barcode wins over the name', scanned[0]._duplicate, true)
// The file listing the same packet on two sheets: keep the first, drop the second.
const twice = markDuplicates([rowsW[0], { ...rowsW[0], _sheet: 'Sheet2' }], [])
eq('duplicate within one import: first kept, second dropped',
  twice.map(r => r._duplicate), [false, true])

console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
process.exit(fail === 0 ? 0 : 1)

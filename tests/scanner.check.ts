import { cleanCode, looksLikeBarcode, findByBarcode, barcodeOwner } from '../src/lib/scanner'
import type { Product } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

const p = (o: Partial<Product>): Product => ({
  id: Math.random().toString(), name: 'X', brand: 'B', cost_price: 1, selling_price: 2,
  current_stock: 5, reorder_threshold: 1, active: true, ...o,
})

const pack = p({ id: 'pack', name: 'Winston Blue', barcode: '4780102221300' })
const block = p({ id: 'block', name: 'Winston Blue blok', barcode: '47801022213001' })
const off = p({ id: 'off', name: 'Old', barcode: '1111111111', active: false })
const all = [pack, block, off]

console.log('\n=== scanner ===')
eq('cleanCode strips whitespace/CR', cleanCode(' 4780102221300\r\n'), '4780102221300')
eq('EAN-13 looks like barcode', looksLikeBarcode('4780102221300'), true)
eq('a name is not a barcode', looksLikeBarcode('Winston'), false)
eq('name with digits is not a barcode', looksLikeBarcode('Esse 100'), false)
eq('short number is not a barcode', looksLikeBarcode('20'), false)
eq('exact match wins, not the longer code', findByBarcode(all, '4780102221300')?.id, 'pack')
eq('longer code finds its own product', findByBarcode(all, '47801022213001')?.id, 'block')
eq('prefix does not match', findByBarcode(all, '478010222'), undefined)
eq('inactive product not sold by scan', findByBarcode(all, '1111111111'), undefined)
const dm = '010478010222130021AbC"d!2X5\u001d93Ab1c'
eq('DataMatrix marking code → EAN-13 inside it', cleanCode(dm), '4780102221300')
eq('DataMatrix is recognised as a scan', looksLikeBarcode(dm), true)
eq('DataMatrix with leading GS is recognised', looksLikeBarcode('\u001d' + dm), true)
eq('DataMatrix with leading GS → EAN-13', cleanCode('\u001d' + dm), '4780102221300')
eq('DataMatrix finds the same product as the line barcode', findByBarcode(all, dm)?.id, 'pack')
eq('another pack (different serial) → same product', findByBarcode(all, '010478010222130021ZZZZZZZ')?.id, 'pack')
eq('duplicate detected', barcodeOwner(all, '4780102221300', 'block')?.id, 'pack')
eq('own barcode is not a duplicate', barcodeOwner(all, '4780102221300', 'pack'), undefined)
eq('empty barcode never duplicate', barcodeOwner([p({ barcode: '' })], ''), undefined)

if (fail) { console.log(`\n${fail} FAILED`); process.exit(1) }

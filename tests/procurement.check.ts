import 'fake-indexeddb/auto'
import { openDb, STORES } from '../src/lib/idb'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

async function main() {
  console.log('\n=== the new stores exist at DB v2 ===')
  const db = await openDb()
  eq('db version', db.version, 2)
  ok('purchase_orders store', db.objectStoreNames.contains(STORES.purchase_orders))
  ok('deliveries store', db.objectStoreNames.contains(STORES.deliveries))
  ok('payments store', db.objectStoreNames.contains(STORES.payments))

  console.log(fail === 0 ? '\n✅ ALL PROCUREMENT CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

import 'fake-indexeddb/auto'
import {
  cashFromSales, cashToFirms, cashMovementsTotal, drawerBalance, revenueByMethod,
  recordCashMovement, voidCashMovement, recordCount, fetchCashMovements, liveMovements,
} from '../src/lib/kassa'
import type { Transaction, Payment } from '../src/lib/types'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

const ACTOR = { name: 'A', role: 'admin' as const }

const sale = (o: Partial<Transaction> & { total_amount: number }): Transaction => ({
  id: Math.random().toString(36), ts: 1, type: 'SALE', product_id: 'p', product_name: 'p',
  brand: 'b', quantity: 1, unit_price: o.total_amount, cost_price: 0, profit: 0,
  user_name: 'A', user_role: 'admin', ref_id: 'r', voided: false, ...o,
})
const pay = (amount: number, method: Payment['method'], extra: Partial<Payment> = {}): Payment => ({
  id: Math.random().toString(36), supplier_id: 'F', amount, created_at: 1, paid_at: 1, method,
  user_name: 'A', user_role: 'admin', voided: false, ...extra,
})

async function main() {
  console.log('\n=== only cash sales feed the drawer ===')
  const txs = [
    sale({ total_amount: 100000, payment_method: 'cash' }),
    sale({ total_amount: 50000, payment_method: 'card' }),
    sale({ total_amount: 30000, payment_method: 'click' }),
  ]
  eq('cash sales only', cashFromSales(txs), 100000)

  console.log('\n=== a voided cash sale contributes nothing ===')
  const voidedTxs = [
    sale({ id: 's1', total_amount: 100000, payment_method: 'cash', voided: true }),
    sale({ id: 's1r', total_amount: -100000, payment_method: 'cash', reversal_of: 's1' }),
    sale({ total_amount: 40000, payment_method: 'cash' }),
  ]
  eq('voided pair dropped, only the live sale counts', cashFromSales(voidedTxs), 40000)

  console.log('\n=== cash paid to firms leaves the drawer ===')
  const payments = [pay(60000, 'cash'), pay(500000, 'bank')]
  eq('only cash firm payments', cashToFirms(payments), 60000)
  eq('a voided cash payment is dropped',
    cashToFirms([pay(60000, 'cash', { voided: true }), pay(-60000, 'cash', { reversal_of: 'x' })]), 0)

  console.log('\n=== drawer = cash sales - cash to firms + movements ===')
  eq('empty drawer', drawerBalance([], [], []), 0)
  eq('full formula', drawerBalance(txs, payments, []), 100000 - 60000)

  console.log('\n=== manual movements: sign convention ===')
  await recordCashMovement({ amount: 200000, kind: 'deposit', reason: 'boshlang\'ich' }, ACTOR)
  await recordCashMovement({ amount: 30000, kind: 'expense', reason: 'choy-non' }, ACTOR)
  await recordCashMovement({ amount: 100000, kind: 'withdrawal', reason: 'bankka' }, ACTOR)
  const moves = await fetchCashMovements()
  eq('deposit is positive', moves.find((m) => m.kind === 'deposit')!.amount, 200000)
  eq('expense is negative', moves.find((m) => m.kind === 'expense')!.amount, -30000)
  eq('withdrawal is negative', moves.find((m) => m.kind === 'withdrawal')!.amount, -100000)
  eq('signed total', cashMovementsTotal(moves), 200000 - 30000 - 100000)

  console.log('\n=== voiding a movement restores the drawer ===')
  const depId = moves.find((m) => m.kind === 'deposit')!.id
  await voidCashMovement(depId, ACTOR)
  const afterVoid = await fetchCashMovements()
  eq('deposit no longer counts', cashMovementsTotal(afterVoid), -30000 - 100000)
  ok('void hides both rows of the pair', liveMovements(afterVoid).every((m) => m.id !== depId))

  console.log('\n=== a zero amount or empty reason is refused ===')
  let threw: unknown = null
  try { await recordCashMovement({ amount: 0, kind: 'expense', reason: 'x' }, ACTOR) } catch (e) { threw = e }
  ok('zero refused', threw instanceof Error)
  threw = null
  try { await recordCashMovement({ amount: 100, kind: 'expense', reason: '  ' }, ACTOR) } catch (e) { threw = e }
  ok('empty reason refused', threw instanceof Error)

  console.log('\n=== count check writes a correction only when it differs ===')
  const before = cashMovementsTotal(await fetchCashMovements())
  await recordCount(before, before, ACTOR)   // matches
  eq('a matching count writes nothing', cashMovementsTotal(await fetchCashMovements()), before)
  await recordCount(before + 5000, before, ACTOR)   // 5000 more than expected
  eq('a differing count writes the correction', cashMovementsTotal(await fetchCashMovements()), before + 5000)

  console.log('\n=== revenue splits by method ===')
  const split = revenueByMethod([
    sale({ total_amount: 100000, payment_method: 'cash' }),
    sale({ total_amount: 50000, payment_method: 'card' }),
    sale({ total_amount: 30000, payment_method: 'click' }),
    sale({ total_amount: 7000 }),   // legacy, no method
  ])
  eq('cash/card/click/unknown', [split.cash, split.card, split.click, split.unknown],
    [100000, 50000, 30000, 7000])

  console.log(fail === 0 ? '\n✅ ALL KASSA CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

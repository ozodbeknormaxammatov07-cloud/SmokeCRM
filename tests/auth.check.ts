import 'fake-indexeddb/auto'
import {
  hashPassword, verifyPassword, hasAnyAccount, listAccounts, countAdmins,
  createAccount, updateAccountPassword, removeAccount, login, can,
} from '../src/lib/auth'

let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const ok = (name: string, cond: boolean) => eq(name, !!cond, true)

async function main() {
  console.log('\n=== password hashing ===')
  const a = await hashPassword('parol123')
  const b = await hashPassword('parol123')
  ok('same password, different salts -> different hashes', a.hash !== b.hash)
  ok('correct password verifies', await verifyPassword('parol123', a.salt, a.hash))
  ok('wrong password rejected', !(await verifyPassword('boshqa', a.salt, a.hash)))

  console.log('\n=== first account bootstraps as admin ===')
  ok('no accounts yet', !(await hasAnyAccount()))
  const admin = await createAccount({ name: 'Ahmadjon', role: 'admin', password: 'admin1' })
  eq('admin created', admin.role, 'admin')
  ok('now there is an account', await hasAnyAccount())
  ok('password is not stored in plain text', !JSON.stringify(admin).includes('admin1'))

  console.log('\n=== login ===')
  ok('login with correct password', !!(await login('Ahmadjon', 'admin1')))
  ok('login is case-insensitive on name', !!(await login('ahmadjon', 'admin1')))
  ok('login with wrong password fails', !(await login('Ahmadjon', 'nope')))
  ok('login unknown user fails', !(await login('Nobody', 'admin1')))

  console.log('\n=== duplicate names refused ===')
  let threw: unknown = null
  try { await createAccount({ name: 'ahmadjon', role: 'cashier', password: 'x' }) } catch (e) { threw = e }
  ok('duplicate name (case-insensitive) refused', threw instanceof Error)

  console.log('\n=== the last admin cannot be removed ===')
  const cashier = await createAccount({ name: 'Dilnoza', role: 'cashier', password: 'kassa1' })
  eq('two accounts listed', (await listAccounts()).length, 2)
  eq('one admin', await countAdmins(), 1)
  threw = null
  try { await removeAccount(admin.id) } catch (e) { threw = e }
  ok('removing the only admin is refused', threw instanceof Error)

  await removeAccount(cashier.id)
  eq('cashier removed (soft) -> one account listed', (await listAccounts()).length, 1)
  ok('a removed account cannot log in', !(await login('Dilnoza', 'kassa1')))

  console.log('\n=== password reset ===')
  await updateAccountPassword(admin.id, 'yangi1')
  ok('old password no longer works', !(await login('Ahmadjon', 'admin1')))
  ok('new password works', !!(await login('Ahmadjon', 'yangi1')))

  console.log('\n=== the capability matrix ===')
  const caps = ['view-dashboard','receive-stock','view-firms','view-reports','manage-products','void','manage-staff'] as const
  ok('admin can do everything', caps.every((c) => can('admin', c)))
  ok('cashier can do none of the gated things', caps.every((c) => !can('cashier', c)))

  console.log(fail === 0 ? '\n✅ ALL AUTH CHECKS PASSED\n' : `\n❌ ${fail} CHECK(S) FAILED\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()

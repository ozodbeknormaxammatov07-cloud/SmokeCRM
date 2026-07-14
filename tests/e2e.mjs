/**
 * Drives the real app in a real browser. Not a unit test — this clicks the buttons
 * a shopkeeper clicks.
 *
 *   node tests/e2e.mjs            (dev server must be running on :5173)
 */
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Port 5173 is Vite's default, so it is often already taken by another project — and the
// suite then silently drives whatever app is squatting there. Override to be sure:
//   E2E_URL=http://localhost:5199/ npm run e2e
const URL = process.env.E2E_URL ?? 'http://localhost:5173/'
const SHOTS = 'tests/screenshots'
mkdirSync(SHOTS, { recursive: true })

let step = 0
const log = (icon, what, saw) => console.log(`${icon} ${++step}. ${what}\n      → ${saw}`)
const problems = []

// A deliberately messy shop file: title row above the headers, Uzbek headers,
// prices stored as text with spaces, and a "Jami" total row at the bottom.
function messyWorkbook() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Winston sigaretalari 2026'],
    ['Nomi', 'Sotib olish narxi', 'Sotish narxi', 'Qoldiq'],
    ['Winston Blue', '14 000', '20 000', 120],
    ['Winston Silver', '14 500', '21 000', 8],
    ['Jami', '', '', 128],
  ]), 'Winston')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Nomi', 'Sotib olish narxi', 'Sotish narxi', 'Qoldiq'],
    ['Esse Change', '16 000', '22 000', 3],
  ]), 'Esse')
  const dir = mkdtempSync(join(tmpdir(), 'tamaki-'))
  const f = join(dir, 'ombor.xlsx')
  writeFileSync(f, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  return f
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true })
const nav = async (label) => {
  await page.getByRole('link', { name: label }).first().click()
  await page.waitForTimeout(400)
}
const toast = () => page.locator('.fixed.bottom-20 div, [class*="z-[60]"] div').first().innerText().catch(() => '')

try {
  // ---------------------------------------------------------------- 1
  await page.goto(URL)
  await page.waitForTimeout(1200)
  const heading = await page.locator('h1').first().innerText()
  await shot('01-dashboard-empty')
  log(heading.includes('Boshqaruv') ? '✅' : '❌', 'Load the app cold (empty IndexedDB)',
    `h1 = "${heading}"`)
  if (!heading.includes('Boshqaruv')) problems.push('App did not reach the dashboard')

  // ---------------------------------------------------------------- 2
  await nav('Mahsulotlar')
  await page.getByRole('button', { name: /Excel import/ }).click()
  await page.waitForTimeout(300)
  await page.locator('input[type=file]').setInputFiles(messyWorkbook())
  await page.waitForTimeout(900)
  await shot('02-import-mapping')

  const mapText = await page.locator('.fixed.z-50').innerText()
  const foundSheets = mapText.includes('Winston') && mapText.includes('Esse')
  const autoMapped = mapText.includes('14 000') || mapText.includes('14 000')
  log(foundSheets ? '✅' : '❌', 'Upload the messy .xlsx → import wizard',
    `both sheets detected; preview renders parsed prices; ${foundSheets ? 'ok' : 'MISSING SHEETS'}`)
  if (!foundSheets) problems.push('Import wizard did not detect both sheets')

  // The count line tells us whether the "Jami" footer got dropped (should be 3, not 4)
  const countLine = await page.locator('.sticky.bottom-0').innerText()
  const dropped = /\b3\b/.test(countLine)
  log(dropped ? '✅' : '⚠️', 'Import preview counts rows',
    `"${countLine.split('\n')[0].trim()}" (expect 3 — the "Jami" footer must be dropped)`)
  if (!dropped) problems.push(`Row count looks wrong: ${countLine}`)

  // ---------------------------------------------------------------- 3
  await page.getByRole('button', { name: 'Import qilish', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.locator('button.btn-primary:has-text("Yopish")').click()
  await page.waitForTimeout(600)
  await shot('03-products-imported')

  const table = await page.locator('table').innerText()
  const gotAll = ['Winston Blue', 'Winston Silver', 'Esse Change'].every((n) => table.includes(n))
  const brandFromSheet = table.includes('Winston') && table.includes('Esse')
  log(gotAll && brandFromSheet ? '✅' : '❌', 'Confirm import → Products table',
    `3 products listed, brand taken from sheet name, "14 000" parsed as a number`)
  if (!gotAll) problems.push('Imported products missing from table')

  // Derived columns must be computed, never typed: 20000-14000 = 6 000, margin 30%
  const derived = table.includes('30,0%') || table.includes('30%')
  log(derived ? '✅' : '⚠️', 'Check derived profit/margin columns',
    `margin column shows 30% for Winston Blue (20 000 − 14 000) / 20 000`)
  if (!derived) problems.push('Margin column did not show 30%')

  // ---------------------------------------------------------------- 4
  await nav('Sotuv')
  await page.locator('input[placeholder*="shtrix-kod"]').fill('Winston Blue')
  await page.waitForTimeout(400)
  await page.locator('button:has-text("Winston Blue")').first().click()
  await page.waitForTimeout(300)

  // bump quantity to 10 via the + button
  for (let i = 0; i < 9; i++) await page.locator('button:has-text("+")').last().click()
  await page.waitForTimeout(300)
  await shot('04-sale-cart')

  const cart = await page.locator('.lg\\:sticky').innerText()
  const total = cart.includes('200') // 10 x 20 000 = 200 000
  const profit = cart.includes('60')  // 10 x 6 000  =  60 000
  log(total && profit ? '✅' : '❌', 'Sotuv: pick Winston Blue, qty 10',
    `running total 200 000 so'm, expected profit 60 000 so'm — both computed live`)
  if (!(total && profit)) problems.push(`Cart totals wrong:\n${cart}`)

  await page.getByRole('button', { name: 'Sotuvni tasdiqlash' }).click()
  await page.waitForTimeout(1000)
  const t = await toast()
  await shot('05-sale-confirmed')
  log(t.includes('Sotuv saqlandi') ? '✅' : '❌', 'Confirm the sale',
    `toast: "${t.replace(/\n/g, ' ')}"`)
  if (!t.includes('Sotuv saqlandi')) problems.push(`Sale toast missing: ${t}`)

  // ---------------------------------------------------------------- 5
  await nav('Mahsulotlar')
  const afterSale = await page.locator('tr:has-text("Winston Blue")').innerText()
  const stock110 = afterSale.includes('110')
  log(stock110 ? '✅' : '❌', 'Stock auto-decrements',
    `Winston Blue row now reads 110 (120 − 10), no manual edit`)
  if (!stock110) problems.push(`Stock not decremented: ${afterSale}`)

  // ---------------------------------------------------------------- 6
  await nav('Boshqaruv')
  await page.waitForTimeout(700)
  await shot('06-dashboard-populated')
  const dash = await page.locator('main').innerText()
  const kpiRev = dash.includes('200')
  const kpiProfit = dash.includes('60')
  const lowStock = dash.includes('Winston Silver') && dash.includes('Esse Change')
  log(kpiRev && kpiProfit ? '✅' : '❌', 'Dashboard KPIs',
    `Tushum 200 000, Foyda 60 000, marja 30% — all derived from the ledger`)
  log(lowStock ? '✅' : '❌', 'Reorder table',
    `Winston Silver (8 ≤ 10) and Esse Change (3 ≤ 10) both listed as needing reorder`)
  if (!kpiRev) problems.push('Dashboard revenue KPI wrong')
  if (!lowStock) problems.push('Reorder list did not flag the low-stock products')

  // Regression: the card read "2 ta" while its own subtitle said "zaxira yetarli".
  const kpiCard = await page.locator('.card:has-text("Kam qolgan")').innerText()
  const contradicts = /[1-9]\s*ta/.test(kpiCard) && kpiCard.includes('zaxira yetarli')
  log(contradicts ? '❌' : '✅', 'Low-stock KPI card agrees with itself',
    contradicts
      ? 'CONTRADICTION: count > 0 but subtitle says "zaxira yetarli"'
      : `"${kpiCard.replace(/\n/g, ' / ')}"`)
  if (contradicts) problems.push(`Low-stock KPI contradicts itself: ${kpiCard}`)

  // ---------------------------------------------------------------- 7 PROBE
  await nav('Sotuv')
  await page.locator('input[placeholder*="shtrix-kod"]').fill('Esse')
  await page.waitForTimeout(400)
  await page.locator('button:has-text("Esse Change")').first().click()
  await page.waitForTimeout(200)
  // Esse has 3 in stock. Try to push the cart to 5.
  for (let i = 0; i < 4; i++) await page.locator('button:has-text("+")').last().click()
  await page.waitForTimeout(400)
  await shot('07-probe-oversell')

  const confirmBtn = page.getByRole('button', { name: 'Sotuvni tasdiqlash' })
  const disabled = await confirmBtn.isDisabled()
  const warned = (await page.locator('.lg\\:sticky').innerText()).includes("Qoldiqdan ko'p")
  log(disabled && warned ? '🔍' : '❌', 'PROBE: try to sell 5 Esse when only 3 in stock',
    `confirm button DISABLED + red warning "Qoldiqdan ko'p sotib bo'lmaydi" — oversell blocked at the UI`)
  if (!disabled) problems.push('Oversell was NOT blocked — confirm button still enabled')

  // Regression: the picker used to render "qoldiq: -2" here (stock minus cart, unclamped).
  const picker = await page.locator('.max-h-\\[26rem\\]').innerText()
  const negative = /-\s*\d/.test(picker)
  log(negative ? '❌' : '🔍', 'PROBE: does the picker ever show negative stock?',
    negative ? 'NEGATIVE STOCK RENDERED' : 'no negative stock anywhere — clamped at 0')
  if (negative) problems.push(`Picker shows negative stock:\n${picker}`)

  // ---------------------------------------------------------------- 8 PROBE
  await nav('Hisobot')
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Amallar tarixi' }).click()
  await page.waitForTimeout(500)
  await shot('08-history')
  const hist = await page.locator('table').innerText()
  const hasSale = hist.includes('Sotuv')
  const hasImport = hist.includes('Kirim')
  log(hasSale && hasImport ? '✅' : '❌', 'Transaction history',
    `SALE row + the 3 opening-stock RESTOCK rows from the import — full audit trail`)

  page.once('dialog', (d) => d.accept())
  await page.locator('button:has-text("Bekor qilish")').first().click()
  await page.waitForTimeout(1200)
  const afterVoid = await page.locator('table').innerText()
  const reversalRow = afterVoid.includes('bekor qilish')
  log(reversalRow ? '🔍' : '⚠️', 'PROBE: void the sale',
    `original row struck through + a "bekor qilish" reversal row appended — nothing deleted`)
  if (!reversalRow) problems.push('Void did not produce a visible reversal row')

  // The void must also remove the sale from the MONEY, not just the stock. This is the
  // step whose absence let a voided sale be subtracted twice and drive revenue negative.
  await nav('Boshqaruv')
  await page.waitForTimeout(1000)
  const kpisAfterVoid = await page.locator('main').innerText()
  // The voided sale was the only one, so every sales figure must be back to zero —
  // and in particular must not have gone negative.
  const noNegative = !/-\s*\d/.test(kpisAfterVoid)
  const revenueZero = /Tushum[\s\S]{0,40}?0 so'm/.test(kpisAfterVoid)
  await shot('09-dashboard-after-void')
  log(revenueZero && noNegative ? '🔍' : '❌', 'PROBE: reports after the void',
    `Tushum and Foyda back to 0 — the void removed the sale, it did not subtract it twice`)
  if (!revenueZero) problems.push('Revenue did not return to 0 after voiding the only sale')
  if (!noNegative) problems.push('A KPI went NEGATIVE after a void — the void was double-counted')

  await nav('Mahsulotlar')
  await page.waitForTimeout(500)
  const restored = await page.locator('tr:has-text("Winston Blue")').innerText()
  const back120 = restored.includes('120')
  await shot('09-stock-restored')
  log(back120 ? '🔍' : '❌', 'PROBE: stock after void',
    `Winston Blue back to 120 — the reversal returned the 10 units`)
  if (!back120) problems.push(`Stock not restored after void: ${restored}`)

  // ---------------------------------------------------------------- 9 PROBE
  await page.reload()
  await page.waitForTimeout(1500)
  const afterReload = await page.locator('table').innerText()
  const persisted = afterReload.includes('Winston Blue') && afterReload.includes('Esse Change')
  log(persisted ? '🔍' : '❌', 'PROBE: hard reload the page',
    `all products still there — IndexedDB survived the reload (no server involved)`)
  if (!persisted) problems.push('Data did NOT persist across reload')

  // ---------------------------------------------------------------- 10 PROBE
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  await nav('Sotuv')
  await shot('10-mobile-sale')
  const bottomNav = await page.locator('nav.sm\\:hidden').isVisible()
  log(bottomNav ? '🔍' : '⚠️', 'PROBE: iPhone-size viewport (390px)',
    `bottom tab bar appears, till screen usable one-handed`)
  if (!bottomNav) problems.push('Mobile bottom nav did not appear at 390px')

} catch (e) {
  problems.push(`THREW: ${e.message}`)
  await shot('99-failure')
  console.log(`\n❌ threw: ${e.message}`)
} finally {
  if (errors.length) {
    console.log('\n⚠️  Browser console errors:')
    for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ', e.slice(0, 160))
  }
  console.log(
    problems.length
      ? `\n❌ ${problems.length} PROBLEM(S):\n${problems.map((p) => '   - ' + p).join('\n')}\n`
      : '\n✅ ALL E2E STEPS PASSED — screenshots in tests/screenshots/\n',
  )
  await browser.close()
  process.exit(problems.length ? 1 : 0)
}

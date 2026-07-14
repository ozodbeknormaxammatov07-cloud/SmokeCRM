import * as XLSX from 'xlsx'
import type { NewProduct, Product, Transaction } from './types'
import { parseNum, dateTimeLabel, isoDay } from './format'
import type { Breakdown } from './analytics'

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export type Field =
  | 'name'
  | 'brand'
  | 'cost_price'
  | 'selling_price'
  | 'current_stock'
  | 'reorder_threshold'
  | 'barcode'
  | 'ignore'

export const FIELD_LABELS: Record<Field, string> = {
  name: 'Mahsulot nomi',
  brand: 'Brend',
  cost_price: 'Kelish narxi',
  selling_price: 'Sotish narxi',
  current_stock: 'Qoldiq',
  reorder_threshold: 'Minimal zaxira',
  barcode: 'Shtrix-kod',
  ignore: '— tashlab ketish —',
}

/**
 * Header keywords, matched case-insensitively against the sheet's header row.
 * The Excel file is hand-made, so the same column shows up under many names —
 * this covers the Uzbek, Russian and English spellings a shop actually types.
 */
const HINTS: Record<Exclude<Field, 'ignore'>, string[]> = {
  name: ['nomi', 'nom', 'mahsulot', 'tovar', 'product', 'name', 'наименование', 'товар'],
  brand: ['brend', 'brand', 'kategoriya', 'category', 'turi', 'бренд', 'категория'],
  cost_price: [
    'kelish', 'kirim narx', 'tan narx', 'sotib olish', 'olish narx', 'xarid',
    'cost', 'purchase', 'buy', 'приход', 'закуп', 'себестоимость',
  ],
  selling_price: [
    'sotish narx', 'sotuv narx', 'sotish', 'sotuv', 'narxi', 'narx',
    'sell', 'selling', 'sale price', 'price', 'продажа', 'цена',
  ],
  current_stock: [
    'qoldiq', 'qolgan', 'ombor', 'zaxira', 'mavjud', 'soni', 'dona',
    'remain', 'stock', 'qty', 'quantity', 'остаток', 'количество',
  ],
  reorder_threshold: ['minimal', 'min', 'chegara', 'threshold', 'reorder', 'минимум'],
  barcode: ['shtrix', 'barkod', 'barcode', 'kod', 'штрих'],
}

export interface ParsedSheet {
  sheetName: string
  headers: string[]
  rows: Record<string, unknown>[]
}

export interface ImportPreviewRow extends NewProduct {
  _sheet: string
  _row: number
  _errors: string[]
  /** Already in the database, or listed twice in this same file. Skipped on import. */
  _duplicate: boolean
}

/**
 * Identity of a product for import purposes: a barcode if the shop scans one, otherwise
 * the name+brand pair, which is how a shopkeeper actually tells two packets apart.
 */
export function productKey(p: { name: string; brand: string; barcode?: string }): string {
  const bc = (p.barcode ?? '').trim()
  if (bc) return `bc:${bc}`
  return `nb:${p.name.trim().toLowerCase()}|${p.brand.trim().toLowerCase()}`
}

/**
 * Flags rows the shop already has. Importing the same file twice is the easy mistake to
 * make — without this it silently doubles the whole catalogue, and every duplicate brings
 * its own opening-stock row, so the shelf appears to hold twice the tobacco it does.
 */
export function markDuplicates(rows: ImportPreviewRow[], existing: Product[]): ImportPreviewRow[] {
  const seen = new Set(existing.map(productKey))
  return rows.map((r) => {
    const key = productKey(r)
    // Already in the DB, or an earlier row of this same import claimed the key.
    const duplicate = seen.has(key)
    seen.add(key)
    return { ...r, _duplicate: duplicate }
  })
}

export function parseWorkbook(data: ArrayBuffer): ParsedSheet[] {
  const wb = XLSX.read(data, { type: 'array' })
  const out: ParsedSheet[] = []

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue

    // Header row isn't always row 1 — shop files often have a title or blank rows
    // on top. Scan the first few rows for the one that looks most like headers.
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false })
    if (!grid.length) continue

    let headerIdx = 0
    let bestScore = -1
    for (let i = 0; i < Math.min(grid.length, 8); i++) {
      const row = grid[i] ?? []
      const filled = row.filter((c) => String(c ?? '').trim()).length
      const texty = row.filter((c) => typeof c === 'string' && c.trim().length > 1).length
      const score = filled + texty * 2
      if (filled >= 2 && score > bestScore) {
        bestScore = score
        headerIdx = i
      }
    }

    const rawHeaders = (grid[headerIdx] ?? []).map((h, i) =>
      String(h ?? '').trim() || `Ustun ${i + 1}`,
    )
    // De-duplicate so two "Narx" columns don't collapse into one key.
    const seen = new Map<string, number>()
    const headers = rawHeaders.map((h) => {
      const n = (seen.get(h) ?? 0) + 1
      seen.set(h, n)
      return n > 1 ? `${h} (${n})` : h
    })

    const rows: Record<string, unknown>[] = []
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const row = grid[i] ?? []
      if (!row.some((c) => String(c ?? '').trim())) continue
      const obj: Record<string, unknown> = {}
      headers.forEach((h, j) => { obj[h] = row[j] })
      rows.push(obj)
    }

    if (rows.length) out.push({ sheetName, headers, rows })
  }

  return out
}

/** Best-guess column -> field mapping, which the user can then correct in the UI. */
export function autoMap(headers: string[]): Record<string, Field> {
  const map: Record<string, Field> = {}
  const taken = new Set<Field>()

  const score = (header: string, field: Exclude<Field, 'ignore'>): number => {
    const h = header.toLowerCase().trim()
    let best = 0
    for (const hint of HINTS[field]) {
      if (h === hint) best = Math.max(best, 100)
      else if (h.startsWith(hint)) best = Math.max(best, 70)
      else if (h.includes(hint)) best = Math.max(best, 50 + hint.length)
    }
    return best
  }

  const fields = Object.keys(HINTS) as Exclude<Field, 'ignore'>[]
  const candidates: { header: string; field: Field; score: number }[] = []
  for (const h of headers) {
    for (const f of fields) {
      const s = score(h, f)
      if (s > 0) candidates.push({ header: h, field: f, score: s })
    }
  }
  // Highest-confidence pairs win first; each field is claimed at most once.
  candidates.sort((a, b) => b.score - a.score)
  for (const c of candidates) {
    if (map[c.header] || taken.has(c.field)) continue
    map[c.header] = c.field
    taken.add(c.field)
  }
  for (const h of headers) if (!map[h]) map[h] = 'ignore'
  return map
}

export function buildPreview(
  sheet: ParsedSheet,
  mapping: Record<string, Field>,
  defaultBrand: string,
  defaultThreshold: number,
): ImportPreviewRow[] {
  const colFor = (f: Field) => Object.keys(mapping).find((h) => mapping[h] === f)

  const cName = colFor('name')
  const cBrand = colFor('brand')
  const cCost = colFor('cost_price')
  const cSell = colFor('selling_price')
  const cStock = colFor('current_stock')
  const cThresh = colFor('reorder_threshold')
  const cBar = colFor('barcode')

  const out: ImportPreviewRow[] = []

  sheet.rows.forEach((r, i) => {
    const name = cName ? String(r[cName] ?? '').trim() : ''
    // Skip "Jami"/total footer rows that shop spreadsheets always carry.
    if (/^(jami|итого|total|umumiy)\b/i.test(name)) return

    const cost = cCost ? parseNum(r[cCost]) : 0
    const sell = cSell ? parseNum(r[cSell]) : 0
    const stock = cStock ? parseNum(r[cStock]) : 0

    const errors: string[] = []
    if (!name) errors.push('nomi yo‘q')
    if (sell <= 0) errors.push('sotish narxi yo‘q')
    if (cost > 0 && sell > 0 && sell < cost) errors.push('sotish narxi kelish narxidan past')

    out.push({
      _sheet: sheet.sheetName,
      _row: i + 2,
      _errors: errors,
      _duplicate: false, // filled in by markDuplicates, which needs the whole import at once
      name,
      // Sheet name is the brand when the sheet has no brand column — which is
      // exactly how the current per-brand-sheet Excel file is organised.
      brand: (cBrand ? String(r[cBrand] ?? '').trim() : '') || defaultBrand || sheet.sheetName,
      cost_price: cost,
      selling_price: sell,
      current_stock: Math.max(0, Math.round(stock)),
      reorder_threshold: cThresh ? Math.round(parseNum(r[cThresh])) || defaultThreshold : defaultThreshold,
      barcode: cBar ? String(r[cBar] ?? '').trim() || undefined : undefined,
      active: true,
    })
  })

  return out
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function download(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename, { compression: true })
}

function sheetFrom(rows: Record<string, unknown>[], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.json_to_sheet(rows)
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  return ws
}

export function exportProducts(products: Product[]) {
  const rows = products.map((p) => ({
    'Mahsulot': p.name,
    'Brend': p.brand,
    'Kelish narxi': p.cost_price,
    'Sotish narxi': p.selling_price,
    'Foyda (dona)': p.selling_price - p.cost_price,
    'Marja %': p.selling_price ? +(((p.selling_price - p.cost_price) / p.selling_price) * 100).toFixed(1) : 0,
    'Qoldiq': p.current_stock,
    'Minimal zaxira': p.reorder_threshold,
    'Qoldiq qiymati': p.cost_price * p.current_stock,
    'Shtrix-kod': p.barcode ?? '',
    'Faol': p.active ? 'ha' : 'yo‘q',
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheetFrom(rows, [28, 14, 14, 14, 13, 9, 9, 13, 15, 16, 7]), 'Mahsulotlar')
  download(wb, `mahsulotlar_${isoDay(Date.now())}.xlsx`)
}

export function exportTransactions(txs: Transaction[], filename = 'amallar') {
  const rows = txs.map((t) => ({
    'Sana': dateTimeLabel(t.ts),
    'Turi': t.type === 'SALE' ? 'Sotuv' : 'Kirim',
    'Mahsulot': t.product_name,
    'Brend': t.brand,
    'Soni': t.quantity,
    'Narx (dona)': t.unit_price,
    'Kelish narxi': t.cost_price,
    'Summa': t.total_amount,
    'Foyda': t.profit,
    'Xodim': t.user_name,
    'Izoh': t.note ?? '',
    'Holati': t.voided ? 'BEKOR QILINGAN' : t.reversal_of ? 'bekor qilish yozuvi' : 'faol',
    'ID': t.id,
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheetFrom(rows, [20, 9, 28, 13, 7, 13, 13, 14, 13, 12, 24, 18, 22]), 'Amallar')
  download(wb, `${filename}_${isoDay(Date.now())}.xlsx`)
}

export interface ReportExport {
  from: string
  to: string
  summary: Record<string, string | number>
  byBrand: Breakdown[]
  byProduct: Breakdown[]
  series: { label: string; revenue: number; profit: number; units: number }[]
  transactions: Transaction[]
}

/** One workbook, one sheet per view — the thing you actually hand to an accountant. */
export function exportReport(r: ReportExport) {
  const wb = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(
    wb,
    sheetFrom(
      Object.entries(r.summary).map(([k, v]) => ({ "Ko'rsatkich": k, 'Qiymat': v })),
      [28, 20],
    ),
    'Xulosa',
  )

  const brandRows = r.byBrand.map((b) => ({
    'Brend': b.name, 'Sotilgan (dona)': b.units, 'Tushum': b.revenue,
    'Foyda': b.profit, 'Marja %': +b.margin.toFixed(1),
  }))
  XLSX.utils.book_append_sheet(wb, sheetFrom(brandRows, [16, 16, 16, 16, 10]), 'Brendlar')

  const prodRows = r.byProduct.map((b) => ({
    'Mahsulot': b.name, 'Sotilgan (dona)': b.units, 'Tushum': b.revenue,
    'Foyda': b.profit, 'Marja %': +b.margin.toFixed(1),
  }))
  XLSX.utils.book_append_sheet(wb, sheetFrom(prodRows, [30, 16, 16, 16, 10]), 'Mahsulotlar')

  const seriesRows = r.series.map((s) => ({
    'Davr': s.label, 'Tushum': s.revenue, 'Foyda': s.profit, 'Sotilgan (dona)': s.units,
  }))
  XLSX.utils.book_append_sheet(wb, sheetFrom(seriesRows, [14, 16, 16, 16]), 'Dinamika')

  const txRows = r.transactions.map((t) => ({
    'Sana': dateTimeLabel(t.ts),
    'Turi': t.type === 'SALE' ? 'Sotuv' : 'Kirim',
    'Mahsulot': t.product_name, 'Brend': t.brand, 'Soni': t.quantity,
    'Narx (dona)': t.unit_price, 'Summa': t.total_amount, 'Foyda': t.profit,
    'Xodim': t.user_name, 'Holati': t.voided ? 'BEKOR' : 'faol',
  }))
  XLSX.utils.book_append_sheet(wb, sheetFrom(txRows, [20, 9, 28, 13, 7, 13, 14, 13, 12, 12]), 'Amallar')

  download(wb, `hisobot_${r.from}_${r.to}.xlsx`)
}

/** Blank workbook shaped the way the importer expects — the "how do I start" answer. */
export function downloadTemplate() {
  const wb = XLSX.utils.book_new()
  for (const brand of ['UzBat', 'Parliament', 'Winston', 'Esse']) {
    const rows = [{
      'Mahsulot nomi': '', 'Brend': brand, 'Kelish narxi': '',
      'Sotish narxi': '', 'Qoldiq': '', 'Minimal zaxira': 10, 'Shtrix-kod': '',
    }]
    XLSX.utils.book_append_sheet(wb, sheetFrom(rows, [30, 14, 14, 14, 10, 14, 16]), brand)
  }
  download(wb, 'mahsulotlar_shabloni.xlsx')
}

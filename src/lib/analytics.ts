import type { Product, Transaction } from './types'
import { isoDay, marginPct } from './format'

export interface Totals {
  revenue: number
  profit: number
  unitsSold: number
  restockCost: number
  saleCount: number
  margin: number
}

/**
 * A void writes TWO rows: it flags the original `voided` and appends an opposite-signed
 * reversal. Both are audit artefacts — the history table shows them, the reports must not
 * count either. Counting only one of the pair (the trap this used to fall into) subtracts
 * the sale twice and drives revenue negative.
 */
const counts = (t: Transaction): boolean => !t.voided && !t.reversal_of

export function totals(txs: Transaction[]): Totals {
  let revenue = 0
  let profit = 0
  let unitsSold = 0
  let restockCost = 0
  const sales = new Set<string>()

  for (const t of txs) {
    if (!counts(t)) continue
    if (t.type === 'SALE') {
      revenue += t.total_amount
      profit += t.profit
      unitsSold += t.quantity
      sales.add(t.ref_id)
    } else {
      restockCost += t.total_amount
    }
  }

  return {
    revenue,
    profit,
    unitsSold,
    restockCost,
    saleCount: sales.size,
    margin: revenue ? (profit / revenue) * 100 : 0,
  }
}

export interface Bucket {
  key: string
  label: string
  revenue: number
  profit: number
  units: number
}

export type Grain = 'day' | 'week' | 'month'

function bucketKey(ts: number, grain: Grain): { key: string; label: string } {
  const d = new Date(ts)
  if (grain === 'day') {
    const key = isoDay(d)
    return { key, label: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}` }
  }
  if (grain === 'week') {
    // ISO-ish week starting Monday.
    const monday = new Date(d)
    const dow = (d.getDay() + 6) % 7
    monday.setDate(d.getDate() - dow)
    monday.setHours(0, 0, 0, 0)
    const key = isoDay(monday)
    return { key, label: `${monday.getDate()}.${String(monday.getMonth() + 1).padStart(2, '0')}` }
  }
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return { key, label: key }
}

export function timeSeries(txs: Transaction[], grain: Grain): Bucket[] {
  const map = new Map<string, Bucket>()
  for (const t of txs) {
    if (!counts(t) || t.type !== 'SALE') continue
    const { key, label } = bucketKey(t.ts, grain)
    const b = map.get(key) ?? { key, label, revenue: 0, profit: 0, units: 0 }
    b.revenue += t.total_amount
    b.profit += t.profit
    b.units += t.quantity
    map.set(key, b)
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export interface Breakdown {
  key: string
  name: string
  units: number
  revenue: number
  profit: number
  margin: number
}

function breakdownBy(
  txs: Transaction[],
  keyOf: (t: Transaction) => string,
  nameOf: (t: Transaction) => string,
): Breakdown[] {
  const map = new Map<string, Breakdown>()
  for (const t of txs) {
    if (!counts(t) || t.type !== 'SALE') continue
    const key = keyOf(t)
    const b = map.get(key) ?? { key, name: nameOf(t), units: 0, revenue: 0, profit: 0, margin: 0 }
    b.units += t.quantity
    b.revenue += t.total_amount
    b.profit += t.profit
    map.set(key, b)
  }
  const rows = [...map.values()]
  for (const r of rows) r.margin = r.revenue ? (r.profit / r.revenue) * 100 : 0
  return rows.sort((a, b) => b.revenue - a.revenue)
}

export function byBrand(txs: Transaction[]): Breakdown[] {
  return breakdownBy(txs, (t) => t.brand || '—', (t) => t.brand || '—')
}

export function byProduct(txs: Transaction[]): Breakdown[] {
  return breakdownBy(txs, (t) => t.product_id, (t) => t.product_name)
}

export function bestSellers(txs: Transaction[], n = 6): Breakdown[] {
  return [...byProduct(txs)].sort((a, b) => b.units - a.units).slice(0, n)
}

export type StockLevel = 'out' | 'low' | 'ok'

export function stockLevel(p: Product): StockLevel {
  if (p.current_stock <= 0) return 'out'
  if (p.current_stock <= p.reorder_threshold) return 'low'
  return 'ok'
}

/** Products at or below their reorder threshold, most urgent first. */
export function reorderList(products: Product[]): Product[] {
  return products
    .filter((p) => p.active && stockLevel(p) !== 'ok')
    .sort((a, b) => {
      const ga = a.current_stock - a.reorder_threshold
      const gb = b.current_stock - b.reorder_threshold
      return ga - gb
    })
}

/** What the shelf is worth right now, at cost and at retail. */
export function inventoryValue(products: Product[]): { atCost: number; atRetail: number; potentialProfit: number } {
  let atCost = 0
  let atRetail = 0
  for (const p of products) {
    if (!p.active) continue
    atCost += p.cost_price * p.current_stock
    atRetail += p.selling_price * p.current_stock
  }
  return { atCost, atRetail, potentialProfit: atRetail - atCost }
}

export function productMargin(p: Product): number {
  return marginPct(p.cost_price, p.selling_price)
}

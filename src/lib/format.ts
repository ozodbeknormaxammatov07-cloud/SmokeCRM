/** Non-breaking: a price must never wrap across lines mid-number. */
const GROUP_SEP = '\u00A0'

/** 1250000 -> "1 250 000" (grouped with non-breaking spaces) */
export function num(n: number, decimals = 0): string {
  if (!isFinite(n)) return '0'
  const fixed = n.toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const sign = int.startsWith('-') ? '-' : ''
  const digits = sign ? int.slice(1) : int
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEP)
  return sign + grouped + (frac ? ',' + frac : '')
}

/** 1250000 -> "1 250 000 so'm" */
export function money(n: number): string {
  return `${num(Math.round(n))} so'm`
}

/** Compact form for KPI cards: 12 400 000 -> "12,4 mln so'm" */
export function moneyShort(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${num(n / 1_000_000_000, 1)} mlrd so'm`
  if (abs >= 1_000_000) return `${num(n / 1_000_000, 1)} mln so'm`
  if (abs >= 10_000) return `${num(n / 1_000, 0)} ming so'm`
  return money(n)
}

export function pct(n: number): string {
  if (!isFinite(n)) return '—'
  return `${num(n, 1)}%`
}

const MONTHS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
]

export function dateLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function dateTimeLabel(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${dateLabel(ts)}, ${hh}:${mm}`
}

/** Local-timezone YYYY-MM-DD, for <input type="date"> and day grouping. */
export function isoDay(ts: number | Date): string {
  const d = typeof ts === 'number' ? new Date(ts) : ts
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function startOfDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

export function endOfDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

/** Parses "12 000", "12,000", "12 000 so'm", 12000 -> 12000. Returns 0 for junk. */
export function parseNum(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0
  if (v == null) return 0
  const cleaned = String(v)
    .replace(/[^\d.,-]/g, '')
    .replace(/\s/g, '')
  if (!cleaned) return 0
  // Treat "," as a decimal separator only when it's clearly not a thousands group.
  const normalized =
    cleaned.includes(',') && !cleaned.includes('.') && /,\d{1,2}$/.test(cleaned)
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '')
  const n = parseFloat(normalized)
  return isFinite(n) ? n : 0
}

export function marginPct(cost: number, selling: number): number {
  if (!selling) return 0
  return ((selling - cost) / selling) * 100
}

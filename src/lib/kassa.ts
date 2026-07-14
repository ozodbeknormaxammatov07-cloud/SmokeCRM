/**
 * The cash drawer. Derived, never stored:
 *
 *   drawer = Σ cash sales − Σ cash paid to firms + Σ signed manual movements
 *
 * Honest limitation surfaced in the UI: the number is only truthful if cash leaving for the bank
 * or the owner's pocket is recorded as a withdrawal. Unrecorded cash-out reads high; the count
 * check is what catches the drift.
 */
import { STORES, tx, get, put, getAll, newId, notify, subscribe } from './idb'
import { livePayments } from './payables'
import type { Transaction, Payment, CashMovement, CashMovementKind, User } from './types'

interface Actor { name: string; role: User['role'] }

/** Live rows only: neither a voided original nor its reversal twin — same rule as analytics. */
const liveTx = (t: Transaction): boolean => !t.voided && !t.reversal_of
export const liveMovements = (rows: CashMovement[]): CashMovement[] =>
  rows.filter((m) => !m.voided && !m.reversal_of)

/* ------------------------------------------------------------------ */
/* Derived reads                                                       */
/* ------------------------------------------------------------------ */

export function cashFromSales(txs: Transaction[]): number {
  return txs
    .filter((t) => t.type === 'SALE' && liveTx(t) && t.payment_method === 'cash')
    .reduce((s, t) => s + t.total_amount, 0)
}

export function cashToFirms(payments: Payment[]): number {
  return livePayments(payments)
    .filter((p) => p.method === 'cash')
    .reduce((s, p) => s + p.amount, 0)
}

export const cashMovementsTotal = (rows: CashMovement[]): number =>
  liveMovements(rows).reduce((s, m) => s + m.amount, 0)

export function drawerBalance(
  txs: Transaction[], payments: Payment[], movements: CashMovement[],
): number {
  return cashFromSales(txs) - cashToFirms(payments) + cashMovementsTotal(movements)
}

export function revenueByMethod(
  txs: Transaction[],
): { cash: number; card: number; click: number; unknown: number } {
  const out = { cash: 0, card: 0, click: 0, unknown: 0 }
  for (const t of txs) {
    if (t.type !== 'SALE' || !liveTx(t)) continue
    const k = t.payment_method ?? 'unknown'
    out[k in out ? (k as keyof typeof out) : 'unknown'] += t.total_amount
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Manual movements                                                    */
/* ------------------------------------------------------------------ */

export interface NewCashMovement {
  amount: number
  kind: CashMovementKind
  reason: string
  note?: string
  ts?: number
}

/** deposit stored +, expense/withdrawal stored −, correction keeps its own sign. */
function signed(amount: number, kind: CashMovementKind): number {
  const a = Math.abs(amount)
  if (kind === 'expense' || kind === 'withdrawal') return -a
  if (kind === 'deposit') return a
  return amount
}

export async function recordCashMovement(input: NewCashMovement, actor: Actor): Promise<string> {
  if (!input.amount || input.amount === 0) throw new Error("Summa 0 dan farqli bo'lishi kerak")
  if (!input.reason.trim()) throw new Error('Sababni yozing')

  const id = newId()
  const now = Date.now()
  await tx([STORES.cash_movements], 'readwrite', (t) =>
    put(t, STORES.cash_movements, {
      id,
      ts: input.ts ?? now,
      created_at: now,
      amount: signed(input.amount, input.kind),
      kind: input.kind,
      reason: input.reason.trim(),
      note: input.note?.trim() || undefined,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
    } satisfies CashMovement),
  )
  notify()
  return id
}

export async function voidCashMovement(id: string, actor: Actor): Promise<void> {
  await tx([STORES.cash_movements], 'readwrite', async (t) => {
    const original = await get<CashMovement>(t, STORES.cash_movements, id)
    if (!original) throw new Error('Yozuv topilmadi')
    if (original.voided) throw new Error('Bu yozuv allaqachon bekor qilingan')

    const now = Date.now()
    await put(t, STORES.cash_movements, { ...original, voided: true })
    await put(t, STORES.cash_movements, {
      ...original,
      id: newId(),
      created_at: now,
      amount: -original.amount,
      note: `BEKOR QILINDI: ${original.note || '—'}`,
      user_name: actor.name,
      user_role: actor.role,
      voided: false,
      reversal_of: original.id,
    } satisfies CashMovement)
  })
  notify()
}

/**
 * Records a physical count. If it differs from the expected drawer, writes a `correction`
 * movement of `counted − expected` so the drawer matches reality; a matching count writes nothing.
 */
export async function recordCount(counted: number, expected: number, actor: Actor): Promise<void> {
  const diff = counted - expected
  if (diff === 0) return
  await recordCashMovement(
    { amount: diff, kind: 'correction', reason: 'Sanoq tuzatishi' },
    actor,
  )
}

export const fetchCashMovements = (): Promise<CashMovement[]> =>
  tx([STORES.cash_movements], 'readonly', (t) => getAll<CashMovement>(t, STORES.cash_movements))

export function watchCashMovements(cb: (rows: CashMovement[]) => void): () => void {
  let alive = true
  const run = () => { void fetchCashMovements().then((r) => { if (alive) cb(r) }) }
  run()
  const off = subscribe(run)
  return () => { alive = false; off() }
}

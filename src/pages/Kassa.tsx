import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Page, Modal } from '../components/ui'
import { money, dateTimeLabel, parseNum } from '../lib/format'
import {
  drawerBalance, cashFromSales, cashToFirms, cashMovementsTotal, liveMovements,
  recordCashMovement, voidCashMovement, recordCount,
} from '../lib/kassa'
import type { CashMovementKind } from '../lib/types'

const KIND_LABEL: Record<CashMovementKind, string> = {
  deposit: 'Kirim', expense: 'Xarajat', withdrawal: 'Yechib olindi', correction: 'Tuzatish',
}

export default function Kassa() {
  const { recent, payments, movements, actor, toast } = useStore()
  const [modal, setModal] = useState<'in' | 'out' | null>(null)
  const [counting, setCounting] = useState(false)

  // `recent` holds the latest 300 transactions — enough for a live drawer at shop scale.
  const expected = useMemo(
    () => drawerBalance(recent, payments, movements),
    [recent, payments, movements],
  )
  const sales = cashFromSales(recent)
  const firms = cashToFirms(payments)
  const manual = cashMovementsTotal(movements)
  const rows = liveMovements(movements).sort((a, b) => b.ts - a.ts)

  const undo = async (id: string) => {
    if (!confirm('Bu yozuv bekor qilinsinmi?')) return
    try { await voidCashMovement(id, actor); toast('Bekor qilindi') }
    catch (e) { toast(e instanceof Error ? e.message : 'Xatolik', 'err') }
  }

  return (
    <Page
      title="Kassa"
      subtitle="Kassada hozir qancha naqd pul bo'lishi kerak."
      actions={
        <>
          <button className="btn-ghost" onClick={() => setCounting(true)}>Sanash</button>
          <button className="btn-ghost" onClick={() => setModal('out')}>− Chiqim</button>
          <button className="btn-primary" onClick={() => setModal('in')}>+ Kirim</button>
        </>
      }
    >
      <div className="card p-5 mb-4">
        <div className="text-xs font-semibold text-ink-500">Kassada bo'lishi kerak</div>
        <div className={`mt-1 text-4xl font-bold num tracking-tight ${expected < 0 ? 'text-red-600' : ''}`}>
          {money(expected)}
        </div>
        <p className="text-xs text-ink-400 mt-2">
          Bu son to'g'ri bo'lishi uchun bankka yoki cho'ntakka chiqqan pulni "Chiqim" sifatida
          yozib boring.
        </p>
      </div>

      <div className="card divide-y divide-ink-100 mb-4">
        <Row label="Naqd sotuvlar" value={sales} sign="+" />
        <Row label="Firmalarga naqd to'lov" value={-firms} sign="−" />
        <Row label="Qo'lda kiritilgan (kirim − chiqim)" value={manual} sign={manual < 0 ? '−' : '+'} />
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-ink-200"><h2 className="font-semibold">Kassa harakatlari</h2></div>
        {!rows.length ? (
          <p className="p-8 text-center text-sm text-ink-400">Hali qo'lda kiritilgan harakat yo'q</p>
        ) : (
          <div className="divide-y divide-ink-100">
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{KIND_LABEL[m.kind]} · {m.reason}</div>
                  <div className="text-xs text-ink-400">{dateTimeLabel(m.ts)} · {m.user_name}</div>
                </div>
                <div className={`text-sm font-semibold num shrink-0 ${m.amount < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {m.amount > 0 ? '+' : '−'}{money(Math.abs(m.amount))}
                </div>
                <button onClick={() => undo(m.id)} className="text-ink-300 hover:text-red-600 text-xs font-semibold shrink-0">
                  Bekor
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <MoveForm
          direction={modal}
          onClose={() => setModal(null)}
          onDone={(msg) => { toast(msg); setModal(null) }}
          onErr={(msg) => toast(msg, 'err')}
        />
      )}
      {counting && (
        <CountForm
          expected={expected}
          onClose={() => setCounting(false)}
          onDone={(msg) => { toast(msg); setCounting(false) }}
          onErr={(msg) => toast(msg, 'err')}
        />
      )}
    </Page>
  )
}

function Row({ label, value, sign }: { label: string; value: number; sign: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-ink-600">{label}</span>
      <span className="num font-medium">{sign} {money(Math.abs(value))}</span>
    </div>
  )
}

function MoveForm({ direction, onClose, onDone, onErr }: {
  direction: 'in' | 'out'; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const { actor } = useStore()
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<CashMovementKind>(direction === 'in' ? 'deposit' : 'expense')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const value = parseNum(amount)

  const save = async () => {
    if (!(value > 0)) return onErr('Summani kiriting')
    if (!reason.trim()) return onErr('Sababni yozing')
    setBusy(true)
    try {
      await recordCashMovement({ amount: value, kind, reason }, actor)
      onDone(direction === 'in' ? 'Kirim saqlandi' : 'Chiqim saqlandi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={direction === 'in' ? 'Kassaga kirim' : 'Kassadan chiqim'}>
      <label className="label">Summa</label>
      <input className="field num text-lg h-12 mb-3" value={amount} onChange={(e) => setAmount(e.target.value)}
        inputMode="numeric" placeholder="0" autoFocus />

      {direction === 'out' && (
        <>
          <label className="label">Turi</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {([['expense', 'Xarajat'], ['withdrawal', 'Yechib olindi']] as const).map(([k, l]) => (
              <button key={k} className={`btn ${kind === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="label">Sabab</label>
      <input className="field" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={direction === 'in' ? "boshlang'ich qoldiq / mayda pul" : 'choy-non / bankka'} />

      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}

function CountForm({ expected, onClose, onDone, onErr }: {
  expected: number; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const { actor } = useStore()
  const [counted, setCounted] = useState('')
  const [busy, setBusy] = useState(false)
  const value = parseNum(counted)
  const diff = value - expected

  const save = async () => {
    setBusy(true)
    try {
      await recordCount(value, expected, actor)
      onDone(diff === 0 ? "Kassa to'g'ri" : 'Tuzatish saqlandi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Kassani sanash">
      <div className="flex items-baseline justify-between text-sm mb-3">
        <span className="text-ink-500">Bo'lishi kerak</span>
        <span className="num font-semibold">{money(expected)}</span>
      </div>
      <label className="label">Sanab chiqqan summa</label>
      <input className="field num text-lg h-12" value={counted} onChange={(e) => setCounted(e.target.value)}
        inputMode="numeric" placeholder="0" autoFocus />
      {counted.trim() && (
        <p className={`text-sm font-semibold mt-2 ${diff === 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          {diff === 0 ? 'Mos keladi' : `Farq: ${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}
        </p>
      )}
      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy || !counted.trim()}>
        {busy ? 'Saqlanmoqda…' : diff === 0 ? 'Tasdiqlash' : 'Farqni tuzatish'}
      </button>
    </Modal>
  )
}

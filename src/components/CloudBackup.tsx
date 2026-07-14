import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { cloudConfigured, signIn, signUp, signOut } from '../lib/supabase'
import { onSyncState, pushChanges, pullFromCloud, cloudCounts, type SyncState } from '../lib/sync'
import { num, dateTimeLabel } from '../lib/format'

const PHASE_LABEL: Record<SyncState['phase'], { text: string; cls: string }> = {
  off:          { text: 'Bulut sozlanmagan',   cls: 'bg-ink-100 text-ink-500' },
  'signed-out': { text: 'Kirilmagan',          cls: 'bg-amber-50 text-amber-700' },
  idle:         { text: 'Saqlangan',           cls: 'bg-emerald-50 text-emerald-700' },
  syncing:      { text: 'Saqlanmoqda…',        cls: 'bg-blue-50 text-blue-700' },
  offline:      { text: 'Internet yo‘q',       cls: 'bg-amber-50 text-amber-700' },
  error:        { text: 'Xatolik',             cls: 'bg-red-50 text-red-700' },
}

export default function CloudBackup() {
  const { toast } = useStore()
  const [s, setS] = useState<SyncState>({
    phase: 'off', lastSyncedAt: null, error: null, email: null, needsRestore: false,
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [counts, setCounts] = useState<{ products: number; transactions: number } | null>(null)

  useEffect(() => onSyncState(setS), [])

  useEffect(() => {
    if (s.phase === 'idle') void cloudCounts().then(setCounts).catch(() => {})
  }, [s.phase, s.lastSyncedAt])

  if (!cloudConfigured) return null

  const signedIn = s.phase !== 'signed-out' && s.phase !== 'off'
  const badge = PHASE_LABEL[s.phase]

  const doAuth = async (mode: 'in' | 'up') => {
    if (!email.trim() || !password) return toast('Email va parolni kiriting', 'err')
    setBusy(true)
    try {
      if (mode === 'up') {
        const { needsConfirmation } = await signUp(email.trim(), password)
        toast(needsConfirmation
          ? 'Emailingizga tasdiqlash xati yuborildi — havolani bosing'
          : "Hisob yaratildi — ma'lumotlar bulutga saqlanadi")
      } else {
        await signIn(email.trim(), password)
        toast('Kirdingiz — bulutga saqlash yoqildi')
      }
      setPassword('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const doPush = async () => {
    setBusy(true)
    try {
      const { pushed } = await pushChanges()
      toast(pushed ? `Bulutga saqlandi — ${num(pushed)} ta yozuv` : "Hammasi allaqachon saqlangan")
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const doPull = async () => {
    if (!confirm(
      `DIQQAT: shu brauzerdagi hamma ma'lumot o'chiriladi va bulutdagi nusxa bilan ` +
      `almashtiriladi.\n\nBu faqat yangi qurilmada yoki ma'lumot yo'qolganda kerak.\n\nDavom etilsinmi?`,
    )) return
    setBusy(true)
    try {
      const r = await pullFromCloud()
      toast(`Bulutdan tiklandi — ${num(r.products)} mahsulot, ${num(r.transactions)} yozuv`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const doSignOut = async () => {
    await signOut()
    toast("Chiqdingiz — ma'lumotlar shu brauzerda qoladi, lekin bulutga saqlanmaydi")
  }

  return (
    <section className="card p-4 mt-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            ☁️ Bulutga zaxira
            <span className={`chip ${badge.cls}`}>{badge.text}</span>
          </h2>
          <p className="text-xs text-ink-400 mt-1 max-w-lg">
            Sotuv shu brauzerda saqlanadi va internetsiz ham ishlaydi. Bulut — nusxa:
            noutbuk buzilsa yoki brauzer tozalansa, hammasini qaytarib olasiz.
          </p>
        </div>
      </div>

      {s.error && (
        <p className="text-xs text-red-600 font-semibold mb-3">{s.error}</p>
      )}

      {!signedIn ? (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className="text-sm text-ink-500 mb-3">
            Bulutga saqlash uchun bitta hisob yarating. Shu hisob bilan boshqa qurilmada
            ma'lumotni tiklaysiz — parolni yo'qotmang.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            <div>
              <label className="label">Email</label>
              <input
                className="field" type="email" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="dokon@example.com"
              />
            </div>
            <div>
              <label className="label">Parol</label>
              <input
                className="field" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="kamida 6 ta belgi"
                onKeyDown={(e) => { if (e.key === 'Enter') void doAuth('in') }}
              />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button className="btn-primary" onClick={() => void doAuth('in')} disabled={busy}>
              {busy ? '…' : 'Kirish'}
            </button>
            <button className="btn-ghost" onClick={() => void doAuth('up')} disabled={busy}>
              Yangi hisob yaratish
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-ink-200 p-3">
          {s.needsRestore && (
            <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
              <p className="text-sm font-semibold text-amber-900">
                Bu qurilma bo'sh, lekin bulutda ma'lumot bor.
              </p>
              <p className="text-xs text-amber-800 mt-1">
                Yangi qurilmada yoki brauzer tozalangandan keyin shunday bo'ladi.
                Ishni boshlashdan oldin bulutdagi nusxani tiklang — aks holda ikki xil
                ro'yxat paydo bo'ladi.
              </p>
              <button className="btn-primary mt-3" onClick={doPull} disabled={busy}>
                ⬇ Bulutdan tiklash
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">{s.email}</div>
              <div className="text-xs text-ink-400">
                {s.lastSyncedAt
                  ? `oxirgi saqlash: ${dateTimeLabel(s.lastSyncedAt)}`
                  : 'hali saqlanmagan'}
                {counts && ` · bulutda ${num(counts.products)} mahsulot, ${num(counts.transactions)} yozuv`}
              </div>
            </div>
            <button className="text-xs font-semibold text-ink-400 hover:text-red-600" onClick={doSignOut}>
              Chiqish
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <button className="btn-ghost" onClick={doPush} disabled={busy || s.phase === 'syncing'}>
              ⬆ Hozir saqlash
            </button>
            <button className="btn-ghost text-red-600 hover:bg-red-50" onClick={doPull} disabled={busy}>
              ⬇ Bulutdan tiklash
            </button>
          </div>
          <p className="text-xs text-ink-400 mt-2">
            Har bir sotuv avtomatik saqlanadi — tugmani faqat tekshirish uchun bosing.
            "Tiklash" esa shu brauzerdagi ma'lumotni bulutdagisi bilan almashtiradi.
          </p>
        </div>
      )}
    </section>
  )
}

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { cloudConfigured, signIn, signUp, signOut } from '../lib/supabase'
import { onSyncState, syncNow, type SyncState } from '../lib/sync'
import { dateTimeLabel } from '../lib/format'

const PHASE: Record<SyncState['phase'], { text: string; cls: string }> = {
  off:          { text: 'Sinxronlash sozlanmagan', cls: 'bg-ink-100 text-ink-500' },
  'signed-out': { text: 'Kirilmagan',              cls: 'bg-amber-50 text-amber-700' },
  idle:         { text: 'Sinxronlangan',           cls: 'bg-emerald-50 text-emerald-700' },
  syncing:      { text: 'Sinxronlanmoqda…',        cls: 'bg-blue-50 text-blue-700' },
  offline:      { text: 'Internet yo‘q',           cls: 'bg-amber-50 text-amber-700' },
  error:        { text: 'Xatolik',                 cls: 'bg-red-50 text-red-700' },
}

export default function CloudBackup() {
  const { toast } = useStore()
  const [s, setS] = useState<SyncState>({
    phase: 'off', lastSyncedAt: null, error: null, email: null, oversold: [],
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => onSyncState(setS), [])

  if (!cloudConfigured) return null

  const signedIn = s.phase !== 'signed-out' && s.phase !== 'off'

  const doAuth = async (mode: 'in' | 'up') => {
    if (!email.trim() || !password) return toast('Email va parolni kiriting', 'err')
    setBusy(true)
    try {
      if (mode === 'up') {
        const { needsConfirmation } = await signUp(email.trim(), password)
        toast(needsConfirmation
          ? 'Emailingizga tasdiqlash xati yuborildi — havolani bosing'
          : "Do'kon hisobi yaratildi — endi hamma qurilma bir xil ma'lumotni ko'radi")
      } else {
        await signIn(email.trim(), password)
        toast('Kirdingiz — sinxronlash yoqildi')
      }
      setPassword('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const doSync = async () => {
    setBusy(true)
    try {
      const { pushed, pulled } = await syncNow()
      toast(
        pushed || pulled
          ? `Sinxronlandi — ${pushed} ta yuborildi, ${pulled} ta qabul qilindi`
          : 'Hammasi allaqachon bir xil',
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4 mt-4">
      <div className="mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          ☁️ Sinxronlash
          <span className={`chip ${PHASE[s.phase].cls}`}>{PHASE[s.phase].text}</span>
        </h2>
        <p className="text-xs text-ink-400 mt-1 max-w-xl">
          Hamma qurilma bitta do'kon hisobiga kiradi va bir xil ma'lumotni ko'radi.
          Sotuv avval shu qurilmada saqlanadi — internet yo'q bo'lsa ham ishlaydi —
          keyin avtomatik yuboriladi.
        </p>
      </div>

      {s.error && <p className="text-xs text-red-600 font-semibold mb-3">{s.error}</p>}

      {/* Two tills, both offline, both sold the last packet. The ledger is right; the shelf
          isn't. Nothing can prevent this without demanding internet for every sale, so say it
          out loud instead of quietly clamping to zero. */}
      {!!s.oversold.length && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 p-3">
          <p className="text-sm font-semibold text-red-800">
            Qoldiq manfiy: {s.oversold.join(', ')}
          </p>
          <p className="text-xs text-red-700 mt-1">
            Ikki qurilma internetsiz bir vaqtda bir xil tovarni sotgan. Sotuvlar yozuvda
            to'g'ri turibdi, lekin javondagi soni to'g'ri kelmayapti — qayta sanab,
            "Qoldiqni tuzatish" orqali to'g'rilang.
          </p>
        </div>
      )}

      {!signedIn ? (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className="text-sm text-ink-500 mb-3">
            Do'kon uchun bitta hisob yarating va hamma xodim shu hisobga kirsin.
            Kim sotgani har bir yozuvda alohida saqlanadi ("Xodim" nomi bo'yicha).
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
              Yangi do'kon hisobi
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-ink-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">{s.email}</div>
              <div className="text-xs text-ink-400">
                {s.lastSyncedAt ? `oxirgi sinxronlash: ${dateTimeLabel(s.lastSyncedAt)}` : 'hali sinxronlanmagan'}
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={doSync} disabled={busy || s.phase === 'syncing'}>
                ⟳ Hozir sinxronlash
              </button>
              <button
                className="text-xs font-semibold text-ink-400 hover:text-red-600"
                onClick={async () => {
                  await signOut()
                  toast("Chiqdingiz — ma'lumot shu qurilmada qoladi, lekin sinxronlanmaydi")
                }}
              >
                Chiqish
              </button>
            </div>
          </div>
          <p className="text-xs text-ink-400 mt-2">
            Avtomatik ishlaydi — tugmani faqat tekshirish uchun bosing.
          </p>
        </div>
      )}
    </section>
  )
}

import { useState } from 'react'
import { useStore } from '../store'
import { signIn, signUp } from '../lib/supabase'

/**
 * The shop account. ONE login for the whole shop: every device that signs in here sees the same
 * live data. It is the gate to the app — staff names and PINs live behind it, added on the
 * Xodimlar page once the shop is in. A shop signs up once, then every till just signs in.
 */
export default function ShopLogin() {
  const { toast } = useStore()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    if (!email.trim() || !password) {
      setErr('Email va parolni kiriting')
      return
    }
    setBusy(true)
    setErr('')
    try {
      if (mode === 'up') {
        const { needsConfirmation } = await signUp(email.trim(), password)
        if (needsConfirmation) {
          toast('Emailingizga tasdiqlash xati yuborildi — havolani bosing, keyin kiring')
          setMode('in')
        }
        // With confirmation off, signUp already opened a session; the app advances on its own.
      } else {
        await signIn(email.trim(), password)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="card p-6 w-full max-w-sm">
        <div className="text-center mb-5">
          <div className="font-bold text-lg tracking-tight">Tamaki Savdo</div>
          <div className="text-sm text-ink-500 mt-0.5">
            {mode === 'up' ? "Do'kon hisobini yaratish" : "Do'kon hisobiga kirish"}
          </div>
        </div>

        <label className="label">Email</label>
        <input
          className="field mb-3"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="username"
          placeholder="dokon@example.com"
        />

        <label className="label">Parol</label>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
          placeholder={mode === 'up' ? 'kamida 6 ta belgi' : ''}
        />

        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}

        <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy}>
          {busy ? '…' : mode === 'up' ? "Yaratish va kirish" : 'Kirish'}
        </button>

        <button
          className="w-full text-xs font-semibold text-ink-500 hover:text-ink-900 mt-4"
          onClick={() => { setErr(''); setMode(mode === 'in' ? 'up' : 'in') }}
        >
          {mode === 'in' ? "Yangi do'kon? Hisob yarating" : 'Hisobingiz bormi? Kiring'}
        </button>

        <p className="text-xs text-ink-400 mt-4 text-center">
          Bu do'kon uchun bitta hisob. Hamma qurilma shu hisobga kiradi va bir xil
          ma'lumotni ko'radi. Xodimlarni keyin qo'shasiz.
        </p>
      </div>
    </div>
  )
}

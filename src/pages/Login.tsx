import { useState } from 'react'
import { useStore } from '../store'

/**
 * Two faces of the same screen: when the shop has no accounts yet it creates the first
 * administrator; otherwise it signs someone in. No password recovery — a single-owner shop that
 * loses the admin password clears the browser data and starts over (see the design's non-goals).
 */
export default function Login() {
  const { needsSetup, login, createFirstAdmin } = useStore()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    if (!name.trim() || !password) {
      setErr('Ism va parolni kiriting')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const okAuth = needsSetup
        ? await createFirstAdmin(name.trim(), password)
        : await login(name.trim(), password)
      if (!okAuth) setErr("Noto'g'ri ism yoki parol")
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
            {needsSetup ? 'Birinchi administrator hisobini yarating' : 'Tizimga kirish'}
          </div>
        </div>

        <label className="label">Ism</label>
        <input
          className="field mb-3"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          autoComplete="username"
        />

        <label className="label">Parol</label>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
        />

        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}

        <button className="btn-primary w-full mt-5" onClick={submit} disabled={busy}>
          {busy ? '…' : needsSetup ? 'Yaratish va kirish' : 'Kirish'}
        </button>

        {needsSetup && (
          <p className="text-xs text-ink-400 mt-4 text-center">
            Bu hisob administrator bo'ladi — keyin xodimlar qo'shishingiz mumkin.
          </p>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useStore } from '../store'

/**
 * The shop account, shown on the Reports page. There is no sync status to report anymore — the
 * data is always live off the one cloud database — so this is just: which shop is signed in, and
 * a way to sign the whole shop out of this device.
 */
export default function AccountPanel() {
  const { shopEmail, signOutShop, toast } = useStore()
  const [busy, setBusy] = useState(false)

  const out = async () => {
    if (!confirm("Do'kon hisobidan chiqasizmi? Ma'lumotni ko'rish uchun qaytadan kirish kerak.")) return
    setBusy(true)
    try {
      await signOutShop()
      toast("Chiqdingiz")
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4 mt-4">
      <h2 className="font-semibold flex items-center gap-2">
        ☁️ Do'kon hisobi
        <span className="chip bg-emerald-50 text-emerald-700">Ulangan</span>
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
        <div className="text-sm">
          <div className="font-semibold">{shopEmail}</div>
          <div className="text-xs text-ink-400">
            Hamma qurilma shu hisobga kiradi va bir xil ma'lumotni jonli ko'radi.
          </div>
        </div>
        <button
          className="text-xs font-semibold text-ink-400 hover:text-red-600"
          onClick={out}
          disabled={busy}
        >
          Chiqish
        </button>
      </div>
    </section>
  )
}

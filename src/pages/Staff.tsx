import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Page, Empty, Modal } from '../components/ui'
import { watchAccounts, createAccount, updateAccountPassword, removeAccount } from '../lib/auth'
import { dateLabel } from '../lib/format'
import type { Account, Role } from '../lib/types'

export default function Staff() {
  const { account, toast } = useStore()
  const [rows, setRows] = useState<Account[]>([])
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<Account | null>(null)

  useEffect(() => watchAccounts(setRows), [])

  const adminCount = rows.filter((a) => a.role === 'admin').length

  const remove = async (a: Account) => {
    if (!confirm(`"${a.name}" hisobi o'chirilsinmi?`)) return
    try {
      await removeAccount(a.id)
      toast("Hisob o'chirildi")
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    }
  }

  return (
    <Page
      title="Xodimlar"
      subtitle="Kim tizimga kira oladi va qanday huquq bilan."
      actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ Xodim</button>}
    >
      {!rows.length ? (
        <Empty icon="👥" title="Xodim yo'q" hint="Yangi xodim qo'shing." />
      ) : (
        <div className="card divide-y divide-ink-100 overflow-hidden">
          {rows.map((a) => (
            <div key={a.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">
                  {a.name}
                  {a.id === account?.id && (
                    <span className="ml-2 chip bg-ink-100 text-ink-500">siz</span>
                  )}
                </div>
                <div className="text-xs text-ink-400">
                  {a.role === 'admin' ? 'Administrator' : 'Kassir'} · {dateLabel(a.created_at)}
                </div>
              </div>
              <button
                className="text-xs font-semibold text-ink-500 hover:text-ink-900"
                onClick={() => setResetting(a)}
              >
                Parolni almashtirish
              </button>
              {/* The last admin has no remove button — losing it locks everyone out. */}
              {!(a.role === 'admin' && adminCount <= 1) && (
                <button
                  className="text-xs font-semibold text-ink-400 hover:text-red-600"
                  onClick={() => remove(a)}
                >
                  O'chirish
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AddStaff
          onClose={() => setAdding(false)}
          onDone={(m) => { toast(m); setAdding(false) }}
          onErr={(m) => toast(m, 'err')}
        />
      )}
      {resetting && (
        <ResetPassword
          account={resetting}
          onClose={() => setResetting(null)}
          onDone={(m) => { toast(m); setResetting(null) }}
          onErr={(m) => toast(m, 'err')}
        />
      )}
    </Page>
  )
}

function AddStaff({ onClose, onDone, onErr }: {
  onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('cashier')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim() || !password) return onErr('Ism va parolni kiriting')
    setBusy(true)
    try {
      await createAccount({ name: name.trim(), role, password })
      onDone("Xodim qo'shildi")
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Yangi xodim">
      <label className="label">Ism</label>
      <input
        className="field mb-3" value={name} onChange={(e) => setName(e.target.value)}
        autoFocus autoComplete="off"
      />

      <label className="label">Lavozim</label>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {(['admin', 'cashier'] as Role[]).map((r) => (
          <button
            key={r}
            className={`btn ${role === r ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setRole(r)}
          >
            {r === 'admin' ? 'Administrator' : 'Kassir'}
          </button>
        ))}
      </div>

      <label className="label">Parol</label>
      <input
        className="field" type="password" value={password}
        onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
      />

      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Saqlash'}
      </button>
    </Modal>
  )
}

function ResetPassword({ account, onClose, onDone, onErr }: {
  account: Account; onClose: () => void; onDone: (m: string) => void; onErr: (m: string) => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!password) return onErr('Yangi parolni kiriting')
    setBusy(true)
    try {
      await updateAccountPassword(account.id, password)
      onDone('Parol almashtirildi')
    } catch (e) {
      onErr(e instanceof Error ? e.message : 'Xatolik')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Parol — ${account.name}`}>
      <label className="label">Yangi parol</label>
      <input
        className="field" type="password" value={password}
        onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password"
      />
      <button className="btn-primary w-full mt-5" onClick={save} disabled={busy}>
        {busy ? 'Saqlanmoqda…' : 'Almashtirish'}
      </button>
    </Modal>
  )
}

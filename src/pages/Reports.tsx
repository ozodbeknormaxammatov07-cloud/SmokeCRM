import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  watchTransactions, voidTransaction, fetchAllTransactions, exportBackup, restoreBackup,
  resetAllData, type Backup,
} from '../lib/db'
import { totals, timeSeries, byBrand, byProduct, type Grain } from '../lib/analytics'
import { exportReport, exportTransactions } from '../lib/excel'
import {
  money, moneyShort, num, pct, isoDay, daysAgo, startOfDay, endOfDay, dateTimeLabel,
} from '../lib/format'
import { Page, Kpi, MarginChip } from '../components/ui'
import { TrendChart, BrandChart } from '../components/charts'
import CloudBackup from '../components/CloudBackup'
import type { Transaction } from '../lib/types'

const PRESETS = [
  { label: 'Bugun', from: () => isoDay(Date.now()), grain: 'day' as Grain },
  { label: '7 kun', from: () => daysAgo(6), grain: 'day' as Grain },
  { label: '30 kun', from: () => daysAgo(29), grain: 'day' as Grain },
  { label: '90 kun', from: () => daysAgo(89), grain: 'week' as Grain },
  { label: '1 yil', from: () => daysAgo(364), grain: 'month' as Grain },
]

type Tab = 'brand' | 'product' | 'history'

export default function Reports() {
  const { brands, actor, toast } = useStore()

  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(isoDay(Date.now()))
  const [grain, setGrain] = useState<Grain>('day')
  const [brand, setBrand] = useState('')
  const [tab, setTab] = useState<Tab>('brand')
  const [raw, setRaw] = useState<Transaction[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return watchTransactions(startOfDay(from), endOfDay(to), setRaw)
  }, [from, to])

  // Brand is filtered client-side: a brand + date-range Firestore query would need a
  // composite index for every brand, and the range is already small.
  const txs = useMemo(
    () => (brand ? raw.filter((t) => t.brand === brand) : raw),
    [raw, brand],
  )

  const t = useMemo(() => totals(txs), [txs])
  const series = useMemo(() => timeSeries(txs, grain), [txs, grain])
  const brandRows = useMemo(() => byBrand(txs), [txs])
  const productRows = useMemo(() => byProduct(txs), [txs])

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setFrom(p.from())
    setTo(isoDay(Date.now()))
    setGrain(p.grain)
  }

  const doExport = () => {
    exportReport({
      from, to,
      summary: {
        'Davr': `${from} — ${to}`,
        'Brend': brand || 'hammasi',
        'Tushum (so\'m)': t.revenue,
        'Foyda (so\'m)': t.profit,
        'Marja %': +t.margin.toFixed(1),
        'Sotilgan (dona)': t.unitsSold,
        'Sotuvlar soni': t.saleCount,
        'Kirim summasi (so\'m)': t.restockCost,
      },
      byBrand: brandRows,
      byProduct: productRows,
      series,
      transactions: txs,
    })
    toast('Hisobot yuklab olindi')
  }

  /**
   * Data lives only in this browser, so the backup is the safety net. Writes both a
   * .json (machine-readable — restores exactly) and a .xlsx (human-readable).
   */
  const backup = async () => {
    setBusy(true)
    try {
      const b = await exportBackup()

      const blob = new Blob([JSON.stringify(b)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `zaxira_${isoDay(Date.now())}.json`
      a.click()
      URL.revokeObjectURL(a.href)

      exportTransactions(await fetchAllTransactions(), 'zaxira_nusxa')
      toast(`Zaxira nusxa saqlandi — ${num(b.transactions.length)} ta yozuv`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const restore = async (file: File) => {
    let parsed: Backup
    try {
      parsed = JSON.parse(await file.text()) as Backup
    } catch {
      toast("Faylni o'qib bo'lmadi — .json zaxira faylini tanlang", 'err')
      return
    }
    if (
      !confirm(
        `DIQQAT: hozirgi hamma ma'lumot o'chiriladi va zaxira nusxadagi ` +
        `${num(parsed.products?.length ?? 0)} ta mahsulot, ` +
        `${num(parsed.transactions?.length ?? 0)} ta yozuv bilan almashtiriladi.\n\nDavom etilsinmi?`,
      )
    ) return

    setBusy(true)
    try {
      const r = await restoreBackup(parsed)
      toast(`Tiklandi — ${num(r.products)} mahsulot, ${num(r.transactions)} yozuv`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  const doVoid = async (tx: Transaction) => {
    if (!confirm(`"${tx.product_name}" — ${num(tx.quantity)} dona. Bu amal bekor qilinsinmi?\n\nYozuv o'chirilmaydi: teskari yozuv qo'shiladi va qoldiq tiklanadi.`)) return
    try {
      await voidTransaction(tx, actor)
      toast('Amal bekor qilindi')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    }
  }

  return (
    <Page
      title="Hisobotlar"
      subtitle="Sotuv, foyda va brendlar kesimida tahlil"
      actions={
        <>
          <label className="btn-ghost cursor-pointer">
            ♻️ Tiklash
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = '' // let the same file be picked twice
                if (f) void restore(f)
              }}
            />
          </label>
          <button className="btn-ghost" onClick={backup} disabled={busy}>💾 Zaxira nusxa</button>
          <button className="btn-primary" onClick={doExport} disabled={!txs.length}>⬇ Excel'ga eksport</button>
        </>
      }
    >
      {/* Filters — one row above the charts */}
      <div className="card p-3 mb-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className={`chip h-8 px-3 ${from === p.from() ? 'bg-ink-950 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="label">Dan</label>
            <input type="date" className="field w-40" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">Gacha</label>
            <input type="date" className="field w-40" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="label">Brend</label>
            <select className="field w-40" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">Hammasi</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Guruhlash</label>
            <select className="field w-32" value={grain} onChange={(e) => setGrain(e.target.value as Grain)}>
              <option value="day">Kunlik</option>
              <option value="week">Haftalik</option>
              <option value="month">Oylik</option>
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Kpi label="Tushum" value={moneyShort(t.revenue)} sub={`${num(t.saleCount)} ta sotuv`} />
        <Kpi label="Foyda" value={moneyShort(t.profit)} sub={`marja ${pct(t.margin)}`} tone={t.profit >= 0 ? 'good' : 'bad'} />
        <Kpi label="Sotilgan" value={`${num(t.unitsSold)} dona`} />
        <Kpi label="Kirim summasi" value={moneyShort(t.restockCost)} sub="tovarga sarflandi" />
      </div>

      <section className="card p-4 mt-4">
        <h2 className="font-semibold mb-1">Tushum va foyda dinamikasi</h2>
        <p className="text-xs text-ink-400 mb-3">Ikkalasi ham so'mda — bitta o'lchov o'qida</p>
        <TrendChart data={series} />
      </section>

      <section className="card p-4 mt-4">
        <h2 className="font-semibold mb-3">Brendlar bo'yicha tushum</h2>
        <BrandChart data={brandRows.map((b) => ({ name: b.name, revenue: b.revenue }))} />
      </section>

      <div className="mt-4">
        <div className="flex gap-1 p-1 bg-ink-100 rounded-lg w-fit mb-3">
          {([
            ['brand', 'Brendlar'],
            ['product', 'Mahsulotlar'],
            ['history', 'Amallar tarixi'],
          ] as [Tab, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${
                tab === k ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab !== 'history' ? (
          <BreakdownTable rows={tab === 'brand' ? brandRows : productRows} head={tab === 'brand' ? 'Brend' : 'Mahsulot'} />
        ) : (
          <HistoryTable txs={txs} onVoid={doVoid} />
        )}
      </div>

      <CloudBackup />
      <DangerZone />
    </Page>
  )
}

/**
 * Wipes all business data on this device, behind a typed confirmation. The typed word is what
 * stops a mis-tap from erasing the shop — a single "are you sure?" is too easy to click through.
 */
function DangerZone() {
  const { toast } = useStore()
  const [confirming, setConfirming] = useState(false)
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = async () => {
    setBusy(true)
    try {
      await resetAllData()
      toast("Barcha ma'lumot tozalandi")
      setConfirming(false)
      setWord('')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Xatolik', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-4 mt-4 border-red-200">
      <h2 className="font-semibold text-red-700">Ma'lumotni tozalash</h2>
      <p className="text-sm text-ink-500 mt-1">
        Bu qurilmadagi barcha mahsulot, sotuv, firma, buyurtma va to'lovlarni o'chiradi. Xodim
        hisoblari saqlanadi. Orqaga qaytarib bo'lmaydi — avval zaxira (Excel) oling.
      </p>
      <p className="text-xs text-ink-400 mt-1">
        Eslatma: agar qurilma bulutga (Sinxronlash) ulangan bo'lsa, keyingi sinxronlashda bulutdagi
        ma'lumot qaytadan yuklanadi.
      </p>

      {!confirming ? (
        <button
          className="btn bg-red-600 text-white hover:bg-red-700 mt-3"
          onClick={() => setConfirming(true)}
        >
          Barcha ma'lumotni tozalash
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="label">Tasdiqlash uchun "TOZALASH" deb yozing</label>
          <input
            className="field"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder="TOZALASH"
            autoFocus
          />
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => { setConfirming(false); setWord('') }}>
              Bekor
            </button>
            <button
              className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
              onClick={reset}
              disabled={busy || word.trim().toUpperCase() !== 'TOZALASH'}
            >
              {busy ? 'Tozalanmoqda…' : "Ha, hammasini o'chir"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function BreakdownTable({ rows, head }: { rows: ReturnType<typeof byBrand>; head: string }) {
  if (!rows.length) {
    return <div className="card p-8 text-center text-sm text-ink-400">Bu davrda sotuv bo'lmagan</div>
  }
  const maxRev = Math.max(...rows.map((r) => r.revenue), 1)
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink-50 border-b border-ink-200">
            <tr>
              <th className="th">{head}</th>
              <th className="th text-right">Sotilgan</th>
              <th className="th text-right">Tushum</th>
              <th className="th text-right">Foyda</th>
              <th className="th text-right">Marja</th>
              <th className="th w-32">Ulush</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={r.key} className="hover:bg-ink-50">
                <td className="td font-medium max-w-[16rem] truncate">{r.name}</td>
                <td className="td text-right num">{num(r.units)}</td>
                <td className="td text-right num font-medium">{money(r.revenue)}</td>
                <td className={`td text-right num font-medium ${r.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {money(r.profit)}
                </td>
                <td className="td text-right"><MarginChip value={r.margin} /></td>
                <td className="td">
                  <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(r.revenue / maxRev) * 100}%`, background: '#2a78d6' }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistoryTable({ txs, onVoid }: { txs: Transaction[]; onVoid: (t: Transaction) => void }) {
  if (!txs.length) {
    return <div className="card p-8 text-center text-sm text-ink-400">Bu davrda amal bo'lmagan</div>
  }
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink-50 border-b border-ink-200">
            <tr>
              <th className="th">Sana</th>
              <th className="th">Turi</th>
              <th className="th">Mahsulot</th>
              <th className="th text-right">Soni</th>
              <th className="th text-right">Summa</th>
              <th className="th text-right">Foyda</th>
              <th className="th">Xodim</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {txs.map((t) => {
              const reversal = !!t.reversal_of
              return (
                <tr
                  key={t.id}
                  className={`hover:bg-ink-50 ${t.voided ? 'opacity-50 line-through' : ''} ${reversal ? 'bg-amber-50/50' : ''}`}
                >
                  <td className="td text-ink-500">{dateTimeLabel(t.ts)}</td>
                  <td className="td">
                    <span className={`chip ${t.type === 'SALE' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}>
                      {t.type === 'SALE' ? 'Sotuv' : 'Kirim'}
                    </span>
                  </td>
                  <td className="td font-medium max-w-[14rem] truncate" title={t.note || t.product_name}>
                    {t.product_name}
                    {reversal && <span className="ml-2 chip bg-amber-100 text-amber-700">bekor qilish</span>}
                  </td>
                  <td className="td text-right num">{num(t.quantity)}</td>
                  <td className="td text-right num font-medium">{money(t.total_amount)}</td>
                  <td className={`td text-right num ${t.profit > 0 ? 'text-emerald-600' : t.profit < 0 ? 'text-red-600' : 'text-ink-400'}`}>
                    {t.type === 'SALE' ? money(t.profit) : '—'}
                  </td>
                  <td className="td text-ink-500">{t.user_name}</td>
                  <td className="td text-right">
                    {!t.voided && !reversal && (
                      <button
                        onClick={() => onVoid(t)}
                        className="text-xs font-semibold text-ink-400 hover:text-red-600"
                      >
                        Bekor qilish
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2.5 text-xs text-ink-400 bg-ink-50 border-t border-ink-200">
        Yozuvlar o'chirilmaydi. "Bekor qilish" teskari yozuv qo'shadi va qoldiqni tiklaydi — tarix to'liq saqlanadi.
      </p>
    </div>
  )
}

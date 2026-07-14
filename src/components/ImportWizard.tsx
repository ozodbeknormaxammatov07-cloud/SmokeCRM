import { useState } from 'react'
import { useStore } from '../store'
import {
  parseWorkbook, autoMap, buildPreview, downloadTemplate, markDuplicates,
  FIELD_LABELS, type Field, type ParsedSheet, type ImportPreviewRow,
} from '../lib/excel'
import { importProducts } from '../lib/db'
import { money, num } from '../lib/format'
import { Modal } from './ui'

type Step = 'pick' | 'map' | 'done'

export default function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actor, toast, products } = useStore()
  const [step, setStep] = useState<Step>('pick')
  const [sheets, setSheets] = useState<ParsedSheet[]>([])
  const [mappings, setMappings] = useState<Record<string, Record<string, Field>>>({})
  const [skipped, setSkipped] = useState<Record<string, boolean>>({})
  const [threshold, setThreshold] = useState(10)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(0)

  const reset = () => {
    setStep('pick'); setSheets([]); setMappings({}); setSkipped({}); setResult(0)
  }

  const close = () => { reset(); onClose() }

  const onFile = async (file: File) => {
    try {
      const parsed = parseWorkbook(await file.arrayBuffer())
      if (!parsed.length) {
        toast("Faylda ma'lumot topilmadi", 'err')
        return
      }
      setSheets(parsed)
      // Each sheet gets its own guessed mapping — column names differ per sheet.
      setMappings(Object.fromEntries(parsed.map((s) => [s.sheetName, autoMap(s.headers)])))
      setStep('map')
    } catch {
      toast("Faylni o'qib bo'lmadi. .xlsx yoki .csv yuklang.", 'err')
    }
  }

  // Duplicates are resolved across the whole import at once, not per sheet — the same
  // packet can appear on two sheets, and it must only be imported the first time.
  const flat = markDuplicates(
    sheets
      .filter((s) => !skipped[s.sheetName])
      .flatMap((s) => buildPreview(s, mappings[s.sheetName] ?? {}, s.sheetName, threshold)),
    products,
  )

  const previews: Record<string, ImportPreviewRow[]> = {}
  for (const r of flat) (previews[r._sheet] ??= []).push(r)

  const valid = flat.filter((r) => !r._errors.length && !r._duplicate)
  const invalid = flat.filter((r) => r._errors.length)
  const dupes = flat.filter((r) => !r._errors.length && r._duplicate)

  const run = async () => {
    if (!valid.length || busy) return
    setBusy(true)
    try {
      const { imported } = await importProducts(
        valid.map(({ _sheet: _s, _row: _r, _errors: _e, _duplicate: _d, ...p }) => p),
        actor,
      )
      setResult(imported)
      setStep('done')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import xatoligi', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title="Excel'dan import" wide>
      {step === 'pick' && (
        <div>
          {products.length > 0 && (
            <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              Bazada allaqachon {num(products.length)} ta mahsulot bor. Import ularni
              <b> almashtirmaydi</b> — faqat yangi mahsulotlar qo'shiladi. Bazada bor
              mahsulotlar (shtrix-kod yoki nomi+brendi bo'yicha) avtomatik tashlab ketiladi,
              shuning uchun bir faylni ikki marta yuklasangiz ham takrorlanmaydi.
            </div>
          )}

          <label className="block border-2 border-dashed border-ink-200 rounded-xl p-10 text-center cursor-pointer hover:border-ink-400 hover:bg-ink-50 transition-colors">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
            />
            <div className="text-4xl mb-2">📄</div>
            <div className="font-semibold">Excel faylni tanlang</div>
            <p className="text-sm text-ink-500 mt-1">
              .xlsx, .xls yoki .csv — har bir varaq (UzBat, Parliament, …) alohida o'qiladi
            </p>
          </label>

          <div className="mt-4 text-sm text-ink-500">
            Fayl yo'qmi?{' '}
            <button onClick={downloadTemplate} className="font-semibold text-ink-900 underline">
              Bo'sh shablonni yuklab oling
            </button>
          </div>
        </div>
      )}

      {step === 'map' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end gap-4 pb-4 border-b border-ink-200">
            <div>
              <label className="label">Standart minimal zaxira</label>
              <input
                className="field w-40 num"
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <p className="text-xs text-ink-400 flex-1 min-w-[16rem]">
              Faylda "minimal zaxira" ustuni bo'lmasa, shu qiymat ishlatiladi.
              Varaq nomi brend sifatida olinadi.
            </p>
          </div>

          {sheets.map((s) => {
            const off = skipped[s.sheetName]
            const rows = previews[s.sheetName] ?? []
            const bad = rows.filter((r) => r._errors.length).length
            return (
              <section key={s.sheetName} className={`rounded-xl border ${off ? 'border-ink-200 opacity-50' : 'border-ink-200'}`}>
                <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200">
                  <div>
                    <h3 className="font-semibold">{s.sheetName}</h3>
                    <p className="text-xs text-ink-400">
                      {num(s.rows.length)} qator
                      {!off && bad > 0 && <span className="text-red-600 font-semibold"> · {num(bad)} tasi xato</span>}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-ink-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={(e) => setSkipped((p) => ({ ...p, [s.sheetName]: !e.target.checked }))}
                    />
                    Import qilish
                  </label>
                </header>

                {!off && (
                  <div className="p-4 space-y-4">
                    <div>
                      <div className="label">Ustunlarni moslashtiring</div>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {s.headers.map((h) => (
                          <div key={h} className="flex items-center gap-2">
                            <span className="text-xs text-ink-500 truncate flex-1" title={h}>{h}</span>
                            <select
                              className="field h-8 w-40 text-xs"
                              value={mappings[s.sheetName]?.[h] ?? 'ignore'}
                              onChange={(e) =>
                                setMappings((prev) => ({
                                  ...prev,
                                  [s.sheetName]: { ...prev[s.sheetName], [h]: e.target.value as Field },
                                }))
                              }
                            >
                              {(Object.keys(FIELD_LABELS) as Field[]).map((f) => (
                                <option key={f} value={f}>{FIELD_LABELS[f]}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="overflow-x-auto border border-ink-200 rounded-lg">
                      <table className="w-full">
                        <thead className="bg-ink-50">
                          <tr>
                            <th className="th">Mahsulot</th>
                            <th className="th">Brend</th>
                            <th className="th text-right">Kelish</th>
                            <th className="th text-right">Sotish</th>
                            <th className="th text-right">Qoldiq</th>
                            <th className="th">Holat</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {rows.slice(0, 5).map((r, i) => (
                            <tr
                              key={i}
                              className={r._errors.length ? 'bg-red-50' : r._duplicate ? 'bg-ink-50 opacity-60' : ''}
                            >
                              <td className="td font-medium max-w-[14rem] truncate">{r.name || '—'}</td>
                              <td className="td text-ink-500">{r.brand}</td>
                              <td className="td text-right num">{money(r.cost_price)}</td>
                              <td className="td text-right num">{money(r.selling_price)}</td>
                              <td className="td text-right num">{num(r.current_stock)}</td>
                              <td className="td text-xs">
                                {r._errors.length
                                  ? <span className="text-red-600 font-semibold">{r._errors.join(', ')}</span>
                                  : r._duplicate
                                    ? <span className="text-ink-500 font-semibold">bazada bor</span>
                                    : <span className="text-emerald-600 font-semibold">ok</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {rows.length > 5 && (
                        <div className="px-3 py-2 text-xs text-ink-400 bg-ink-50 border-t border-ink-200">
                          … va yana {num(rows.length - 5)} qator
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )
          })}

          <div className="sticky bottom-0 bg-white pt-3 border-t border-ink-200 flex flex-wrap items-center gap-3">
            <div className="text-sm flex-1">
              <b className="num">{num(valid.length)}</b> ta yangi mahsulot import qilinadi
              {dupes.length > 0 && (
                <span className="text-ink-500 font-semibold"> · {num(dupes.length)} tasi bazada bor</span>
              )}
              {invalid.length > 0 && (
                <span className="text-red-600 font-semibold"> · {num(invalid.length)} tasi xato</span>
              )}
            </div>
            <button className="btn-ghost" onClick={reset}>Orqaga</button>
            <button className="btn-primary" onClick={run} disabled={!valid.length || busy}>
              {busy ? 'Import qilinmoqda…' : 'Import qilish'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="text-center py-8">
          <div className="text-4xl mb-3">✅</div>
          <h3 className="font-semibold text-lg">{num(result)} ta mahsulot qo'shildi</h3>
          <p className="text-sm text-ink-500 mt-1 max-w-sm mx-auto">
            Boshlang'ich qoldiqlar "Kirim" amali sifatida yozildi, shuning uchun ular
            hisobotlarda ham ko'rinadi.
          </p>
          <button className="btn-primary mt-5" onClick={close}>Yopish</button>
        </div>
      )}
    </Modal>
  )
}

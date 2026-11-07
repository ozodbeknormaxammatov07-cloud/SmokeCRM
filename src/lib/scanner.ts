import { useEffect, useRef } from 'react'
import type { Product } from './types'

/**
 * USB / Bluetooth 2D scanners in "keyboard mode" type the code very fast and finish with Enter.
 * Nothing to install: the app just has to recognise that burst and look the code up.
 */

/**
 * The PRODUCT identity inside whatever was scanned.
 *
 * Packs carry two codes: the line barcode (EAN-13, same on every pack of a product) and the
 * "Asl belgisi" DataMatrix marking code, which is unique PER PACK: `01` + 14-digit GTIN + `21` +
 * serial + crypto tail. Linking the full marking code would make every pack look like a new
 * product, so we take the GTIN out of it — and drop GTIN-14's leading 0 so it equals the
 * EAN-13 printed on the same pack. Either code then finds the same product.
 */
export function cleanCode(raw: string): string {
  const s = raw.replace(/[\s\u0000-\u001f]/g, '')
  const m = /^(?:\]d2)?01(\d{14})/.exec(s)
  if (m && s.length > 16) return m[1].startsWith('0') ? m[1].slice(1) : m[1]
  return s
}

/** A typed name ("Winston") is not a barcode; a run of 6+ digits/letters without spaces is. */
export function looksLikeBarcode(raw: string): boolean {
  // Scanners often prefix a DataMatrix with an invisible FNC1/GS character — strip control
  // characters before testing, or the scan is mistaken for a typed name.
  const s = raw.replace(/[\s\u0000-\u001f]/g, '')
  if (/^(?:\]d2)?01\d{14}./.test(s)) return true // DataMatrix marking code
  return /^[0-9A-Za-z\-]{6,}$/.test(s) && /\d{4,}/.test(s)
}

/** Exact barcode match only. A substring match could put the wrong cigarettes in the basket. */
export function findByBarcode(products: Product[], raw: string): Product | undefined {
  const code = cleanCode(raw)
  if (!code) return undefined
  return products.find((p) => p.active && cleanCode(p.barcode ?? '') === code)
}

/** Another product that already owns this barcode (for the duplicate check when saving). */
export function barcodeOwner(products: Product[], raw: string, exceptId?: string): Product | undefined {
  const code = cleanCode(raw)
  if (!code) return undefined
  return products.find((p) => p.id !== exceptId && !p.deleted_at && cleanCode(p.barcode ?? '') === code)
}

let audio: AudioContext | null = null
/** Short beep so the cashier hears a scan landed (high) or failed (low) without looking. */
export function beep(ok: boolean) {
  try {
    audio ??= new AudioContext()
    const o = audio.createOscillator()
    const g = audio.createGain()
    o.frequency.value = ok ? 1800 : 300
    g.gain.value = 0.08
    o.connect(g).connect(audio.destination)
    o.start()
    o.stop(audio.currentTime + (ok ? 0.08 : 0.25))
  } catch { /* no audio available — silent is fine */ }
}

const isEditable =(el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable)

/**
 * Catches a scan when no text box has focus (the cashier just clicked a button or the page),
 * so the scan is never lost. Human typing is too slow to trigger it: a scanner sends each
 * character within a few milliseconds of the last.
 */
export function useGlobalScanner(
  onScan: (code: string) => void,
  enabled = true,
  /** Called with the code as it is being typed, so the screen can show the scan arriving. */
  onTyping?: (partial: string) => void,
) {
  const cb = useRef(onScan)
  cb.current = onScan
  const typing = useRef(onTyping)
  typing.current = onTyping

  useEffect(() => {
    if (!enabled) return
    let buf = ''
    let last = 0
    // Max pause between characters of one scan. Generous on purpose: many 2D scanners type at
    // 50–150ms per character, and a strict limit silently dropped their scans. Nothing is lost
    // to it either way — this only runs when no text box has focus, where typing goes nowhere.
    const MAX_GAP = 400

    const onKey = (e: KeyboardEvent) => {
      if (isEditable(document.activeElement)) { buf = ''; return }
      if (e.ctrlKey || e.metaKey) return
      const now = performance.now()
      if (now - last > MAX_GAP) buf = ''
      last = now

      // Scanners end a code with Enter (sometimes keypad Enter, sometimes Tab).
      if (e.key === 'Enter' || e.key === 'Tab' || e.code === 'NumpadEnter') {
        const code = cleanCode(buf)
        buf = ''
        if (code.length >= 6) {
          e.preventDefault()
          cb.current(code)
        }
        return
      }
      const ch = keyChar(e)
      if (ch) {
        buf += ch
        typing.current?.(buf)
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

/**
 * The character a key press stands for. Safari can report a scanner's keys with
 * `key: "Unidentified"`, which silently dropped every character; the physical `code`
 * (Digit4, Numpad4, KeyA) still says which key it was.
 */
function keyChar(e: KeyboardEvent): string {
  if (e.key && e.key.length === 1) return e.key
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code) ?? /^Key([A-Z])$/.exec(e.code)
  if (!m) return ''
  return e.shiftKey ? m[1] : m[1].toLowerCase()
}

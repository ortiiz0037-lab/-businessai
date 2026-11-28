'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DuplicateGuard, HidDetector, CAMERA_FORMATS, type ScanSource } from '@/lib/inventory/scanner'
import { normalizeScan } from '@/lib/inventory/codes'

export type ScanCopy = { placeholder: string; submit: string; camera: string; stop: string; cameraDenied: string; cameraUnavailable: string; hint: string }

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector } }

/**
 * Where a code comes in, three ways:
 *   - a USB / Bluetooth scanner in keyboard (HID) mode: it types into the focused field and presses
 *     Enter; when the focus is elsewhere on the page, its fast burst is still recognised;
 *   - the camera (iPhone, iPad, computers): the browser's BarcodeDetector where it exists, otherwise
 *     the ZXing decoder; without camera permission the field keeps working;
 *   - typing the code by hand and pressing Enter.
 * The same code read again within 1.5 s is ignored (accidental double scans), unless allowRepeat.
 */
export function ScanInput({ onCode, copy, busy, allowRepeat = false, autoFocus = true }: { onCode: (code: string, source: ScanSource) => void; copy: ScanCopy; busy?: boolean; allowRepeat?: boolean; autoFocus?: boolean }) {
  const [value, setValue] = useState('')
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off')
  const [camMsg, setCamMsg] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const guard = useRef(new DuplicateGuard(1500))
  const stopRef = useRef<(() => void) | null>(null)
  const emit = useCallback((raw: string, source: ScanSource) => {
    const code = normalizeScan(raw)
    if (!code) return
    if (!allowRepeat && source !== 'manual' && !guard.current.accept(code, Date.now())) return
    if (allowRepeat && source === 'camera' && !guard.current.accept(code, Date.now())) return   // a camera keeps seeing the label
    onCode(code, source)
  }, [onCode, allowRepeat])

  // a scanner burst while the focus is not in a text field
  useEffect(() => {
    const hid = new HidDetector({ minLength: 4, maxGapMs: 50 })
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const code = hid.key(e.key, e.timeStamp || performance.now())
      if (code) { e.preventDefault(); emit(code, 'hid') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [emit])

  const stopCamera = useCallback(() => { stopRef.current?.(); stopRef.current = null; setCamera('off') }, [])
  useEffect(() => () => { stopRef.current?.() }, [])

  function submitTyped() { const v = value; setValue(''); emit(v, 'manual'); input.current?.focus() }

  async function startCamera() {
    setCamMsg(null)
    if (!navigator.mediaDevices?.getUserMedia) { setCamMsg(copy.cameraUnavailable); return }
    setCamera('starting')
    try {
      if (window.BarcodeDetector) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        const v = video.current!
        v.srcObject = stream; await v.play()
        const det = new window.BarcodeDetector({ formats: [...CAMERA_FORMATS] })
        let alive = true
        const loop = async () => {
          if (!alive) return
          try { const found = await det.detect(v); if (found[0]?.rawValue) emit(found[0].rawValue, 'camera') } catch { /* frame not ready */ }
          setTimeout(loop, 250)
        }
        loop()
        stopRef.current = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); v.srcObject = null }
      } else {
        // Safari (iPhone / iPad) and others without BarcodeDetector: ZXing, loaded only when needed
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        const reader = new BrowserMultiFormatReader()
        const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video.current!, (result) => {
          if (result) emit(result.getText(), 'camera')
        })
        stopRef.current = () => controls.stop()
      }
      setCamera('on')
    } catch (e) {
      setCamera('off')
      setCamMsg((e as Error)?.name === 'NotAllowedError' ? copy.cameraDenied : copy.cameraUnavailable)
    }
  }

  return (
    <div className="space-y-3" data-testid="scan-input">
      {/* not a <form>: this field may live inside the page's own form (lines of a document) */}
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="scan-code">{copy.placeholder}</label>
        <input id="scan-code" ref={input} value={value} onChange={(e) => setValue(e.target.value)} autoFocus={autoFocus} autoComplete="off" autoCapitalize="off" spellCheck={false}
          inputMode="text" enterKeyHint="go" placeholder={copy.placeholder} className="field min-w-0 flex-1 font-mono" disabled={busy} data-testid="scan-field"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitTyped() } }} />
        <button type="button" className="btn-primary shrink-0" disabled={busy} onClick={submitTyped}>{copy.submit}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {camera === 'off'
          ? <button type="button" className="btn-secondary btn-sm" onClick={startCamera} data-testid="scan-camera">{copy.camera}</button>
          : <button type="button" className="btn-secondary btn-sm" onClick={stopCamera}>{copy.stop}</button>}
        <span className="text-xs text-muted">{copy.hint}</span>
      </div>
      {camMsg && <p role="alert" className="text-xs text-amber-200">{camMsg}</p>}
      <video ref={video} muted playsInline className={camera === 'off' ? 'hidden' : 'aspect-video w-full max-w-md rounded-xl border border-line bg-black object-cover'} />
    </div>
  )
}

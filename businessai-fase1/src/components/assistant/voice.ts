'use client'
/**
 * Push-to-talk and spoken answers with the browser's Web Speech API.
 * - The microphone is used ONLY while the user holds the button or between
 *   a tap to start and a tap to stop; there is no wake word and no
 *   continuous listening (continuous = false, hard stop after MAX_MS).
 * - Recognition is done by the browser (Chrome / Edge / Safari may send the
 *   audio to their own speech service); BusinessAI never receives audio,
 *   only the final text, which the user can edit before sending.
 * - Spoken answers use speechSynthesis, off by default.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

type Alt = { transcript: string }
type ResultEvent = { resultIndex: number; results: ArrayLike<ArrayLike<Alt> & { isFinal: boolean }> }
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  onresult: ((e: ResultEvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionCtor = new () => Recognition

export const MAX_LISTEN_MS = 30_000
export const VOICE_LANGS = [{ code: 'es-PR', label: 'Español' }, { code: 'en-US', label: 'English' }] as const

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const noop = () => () => {}

export function usePushToTalk(lang: string, onText: (text: string, final: boolean) => void) {
  const supported = useSyncExternalStore(noop, () => ctor() !== null, () => false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef(onText)
  useEffect(() => { textRef.current = onText }, [onText])

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    rec.current?.stop()
  }, [])

  const start = useCallback(() => {
    const C = ctor()
    if (!C || rec.current) return
    const r = new C()
    r.lang = lang; r.continuous = false; r.interimResults = true; r.maxAlternatives = 1
    let finalText = ''
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) finalText += res[0].transcript
        else interim += res[0].transcript
      }
      textRef.current((finalText + interim).trim(), false)
    }
    r.onerror = (e) => { setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : 'failed') }
    r.onend = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null; rec.current = null; setListening(false)
      if (finalText.trim()) textRef.current(finalText.trim(), true)
    }
    setError(null)
    try { r.start(); rec.current = r; setListening(true) } catch { setError('failed'); return }
    timer.current = setTimeout(() => r.stop(), MAX_LISTEN_MS)
  }, [lang])

  // the microphone is released when the component goes away
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); rec.current?.abort() }, [])
  return { supported, listening, error, start, stop }
}

export function speak(text: string, lang: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text.replace(/\/[a-z0-9\-/?=&]+/gi, '').slice(0, 1500))
  u.lang = lang
  window.speechSynthesis.speak(u)
}
export function stopSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
}

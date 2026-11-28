'use client'
/**
 * Push-to-talk and spoken answers for the assistant, on the provider-neutral
 * voice engines (src/lib/voice/engines.ts): the mobile shell's native speech
 * when present, otherwise the browser's Web Speech API.
 * - The microphone is used ONLY while the user holds the button or between
 *   a tap to start and a tap to stop; there is no wake word and no
 *   continuous listening (hard stop after MAX_LISTEN_MS).
 * - BusinessAI never receives audio, only the final text, which the user can
 *   edit before sending. Spoken answers are off by default.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { pickStt, pickTts, speakable, type SpeechToText } from '@/lib/voice/engines'

export const MAX_LISTEN_MS = 30_000
export const VOICE_LANGS = [{ code: 'es-PR', label: 'Español' }, { code: 'en-US', label: 'English' }] as const

const noop = () => () => {}

export function usePushToTalk(lang: string, onText: (text: string, final: boolean) => void) {
  const supported = useSyncExternalStore(noop, () => pickStt() !== null, () => false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const engine = useRef<SpeechToText | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef(onText)
  useEffect(() => { textRef.current = onText }, [onText])

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    engine.current?.stop()
  }, [])

  const start = useCallback(() => {
    if (engine.current) return
    const e = pickStt()
    if (!e) { setError('failed'); return }
    setError(null)
    const ok = e.start({ lang, maxMs: MAX_LISTEN_MS }, {
      onText: (t, final) => textRef.current(t, final),
      onError: (code) => setError(code === 'denied' ? 'denied' : 'failed'),
      onEnd: () => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null; engine.current = null; setListening(false)
      },
    })
    if (!ok) return
    engine.current = e; setListening(true)
    timer.current = setTimeout(() => e.stop(), MAX_LISTEN_MS)
  }, [lang])

  // the microphone is released when the component goes away
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); engine.current?.abort() }, [])
  return { supported, listening, error, start, stop }
}

export function speak(text: string, lang: string) { pickTts()?.speak(speakable(text), lang) }
export function stopSpeaking() { pickTts()?.stop() }

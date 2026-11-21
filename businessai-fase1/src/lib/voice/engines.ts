/**
 * Voice engines (CLIENT side), provider-neutral. The assistant only ever
 * receives TEXT: speech is turned into text on the device (or by the browser's
 * own speech service) and the user can edit it before sending. Push-to-talk
 * only: no wake word, no continuous listening, a hard stop after maxMs.
 *
 * Engines, picked in this order:
 *   1. 'native'  — the BusinessAI mobile shell (iOS / iPadOS / Android, see
 *                  docs/MOBILE.md) injects window.BusinessAINative.speech, backed
 *                  by SFSpeechRecognizer / Android SpeechRecognizer (on-device
 *                  when the OS supports it). Same events, same limits.
 *   2. 'browser' — the Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 *   3. none      — voice is unavailable; typing still works.
 * A future server engine (streaming speech-to-text through BusinessAI) would be
 * another SpeechToText behind an explicit consent; it is NOT implemented.
 */

export type SttError = 'denied' | 'failed' | 'unsupported'
export type SttHandlers = { onText: (text: string, final: boolean) => void; onError: (e: SttError) => void; onEnd: () => void }
export interface SpeechToText {
  id: 'native' | 'browser'
  /** starts listening; resolves false when it could not start */
  start(opts: { lang: string; maxMs: number }, h: SttHandlers): boolean
  stop(): void
  abort(): void
}
export interface TextToSpeech { id: 'native' | 'browser'; speak(text: string, lang: string): void; stop(): void }

/** What a mobile shell injects. Text only crosses the bridge; never audio. */
export type NativeBridge = {
  version: number
  speech?: { start(opts: { lang: string; maxMs: number }, cb: (e: { type: 'partial' | 'final' | 'error' | 'end'; text?: string; code?: string }) => void): void; stop(): void; abort(): void }
  tts?: { speak(text: string, lang: string): void; stop(): void }
}

type Alt = { transcript: string }
type ResultEvent = { resultIndex: number; results: ArrayLike<ArrayLike<Alt> & { isFinal: boolean }> }
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  onresult: ((e: ResultEvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionCtor = new () => Recognition
type W = { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor; BusinessAINative?: NativeBridge; speechSynthesis?: SpeechSynthesis }

const win = (): W | null => (typeof window === 'undefined' ? null : (window as unknown as W))
/** Only a bridge that declares a supported version is trusted (a stray global is ignored). */
export const nativeBridge = (w: W | null = win()): NativeBridge | null => (w?.BusinessAINative && w.BusinessAINative.version === 1 ? w.BusinessAINative : null)

export function nativeStt(bridge: NativeBridge): SpeechToText | null {
  const s = bridge.speech
  if (!s) return null
  return {
    id: 'native',
    start(opts, h) {
      let final = ''
      try {
        s.start(opts, (e) => {
          if (e.type === 'partial') h.onText(String(e.text ?? '').trim(), false)
          else if (e.type === 'final') { final = String(e.text ?? '').trim(); h.onText(final, true) }
          else if (e.type === 'error') h.onError(e.code === 'denied' ? 'denied' : 'failed')
          else h.onEnd()
        })
        return true
      } catch { h.onError('failed'); return false }
    },
    stop: () => s.stop(),
    abort: () => s.abort(),
  }
}

export function browserStt(C: RecognitionCtor): SpeechToText {
  let r: Recognition | null = null
  return {
    id: 'browser',
    start(opts, h) {
      if (r) return false
      const rec = new C()
      rec.lang = opts.lang; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1
      let finalText = ''
      rec.onresult = (e) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]
          if (res.isFinal) finalText += res[0].transcript
          else interim += res[0].transcript
        }
        h.onText((finalText + interim).trim(), false)
      }
      rec.onerror = (e) => h.onError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : 'failed')
      rec.onend = () => { r = null; if (finalText.trim()) h.onText(finalText.trim(), true); h.onEnd() }
      try { rec.start(); r = rec; return true } catch { h.onError('failed'); return false }
    },
    stop: () => r?.stop(),
    abort: () => { r?.abort(); r = null },
  }
}

/** The best speech-to-text engine of this device, or null (typing only). */
export function pickStt(w: W | null = win()): SpeechToText | null {
  const bridge = nativeBridge(w)
  const native = bridge ? nativeStt(bridge) : null
  if (native) return native
  const C = w?.SpeechRecognition ?? w?.webkitSpeechRecognition
  return C ? browserStt(C) : null
}

export function pickTts(w: W | null = win()): TextToSpeech | null {
  const bridge = nativeBridge(w)
  if (bridge?.tts) return { id: 'native', speak: (t, l) => bridge.tts!.speak(t, l), stop: () => bridge.tts!.stop() }
  const synth = w?.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return null
  return {
    id: 'browser',
    speak(text, lang) { synth.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = lang; synth.speak(u) },
    stop: () => synth.cancel(),
  }
}

/** What is read aloud: no internal links, bounded length. */
export const speakable = (text: string) => text.replace(/\/[a-z0-9\-/?=&]+/gi, '').slice(0, 1500)

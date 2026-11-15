/**
 * Voice engines (S4): the native bridge of the mobile shell first (only a
 * declared version is trusted), then the browser's Web Speech API, else none.
 * Text only crosses the bridge; links are not read aloud.
 */
import { describe, expect, it, vi } from 'vitest'
import { browserStt, nativeBridge, pickStt, pickTts, speakable, type NativeBridge } from '@/lib/voice/engines'

class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''; continuous = true; interimResults = false; maxAlternatives = 0
  onresult: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null; onend: (() => void) | null = null
  constructor() { FakeRecognition.last = this }
  start() {}
  stop() { this.onend?.() }
  abort() {}
  say(text: string, isFinal: boolean) { const r = Object.assign([{ transcript: text }], { isFinal }); this.onresult?.({ resultIndex: 0, results: [r] }) }
}

function bridge(): NativeBridge & { cb?: (e: { type: 'partial' | 'final' | 'error' | 'end'; text?: string; code?: string }) => void } {
  const b: NativeBridge & { cb?: (e: { type: 'partial' | 'final' | 'error' | 'end'; text?: string; code?: string }) => void } = { version: 1 }
  b.speech = { start: (_o, cb) => { b.cb = cb }, stop: vi.fn(), abort: vi.fn() }
  b.tts = { speak: vi.fn(), stop: vi.fn() }
  return b
}

describe('engine selection', () => {
  it('native bridge first, then the browser, else none', () => {
    expect(pickStt({ BusinessAINative: bridge(), webkitSpeechRecognition: FakeRecognition as never })?.id).toBe('native')
    expect(pickStt({ webkitSpeechRecognition: FakeRecognition as never })?.id).toBe('browser')
    expect(pickStt({})).toBeNull()
    expect(pickStt(null)).toBeNull()
  })
  it('a bridge without a supported version is ignored', () => {
    expect(nativeBridge({ BusinessAINative: { ...bridge(), version: 2 } })).toBeNull()
    expect(pickStt({ BusinessAINative: { version: 2 } as NativeBridge, SpeechRecognition: FakeRecognition as never })?.id).toBe('browser')
  })
  it('spoken answers prefer the native voice', () => {
    const b = bridge()
    pickTts({ BusinessAINative: b })!.speak('Hola', 'es-PR')
    expect(b.tts!.speak).toHaveBeenCalledWith('Hola', 'es-PR')
    expect(pickTts({})).toBeNull()
  })
})

describe('push-to-talk contract', () => {
  it('browser: interim and final text, then the end; single-shot, not continuous', () => {
    const got: [string, boolean][] = []
    const onEnd = vi.fn()
    const e = browserStt(FakeRecognition as never)
    expect(e.start({ lang: 'es-PR', maxMs: 30000 }, { onText: (t, f) => got.push([t, f]), onError: vi.fn(), onEnd })).toBe(true)
    const r = FakeRecognition.last!
    expect(r.continuous).toBe(false); expect(r.lang).toBe('es-PR')
    expect(e.start({ lang: 'es-PR', maxMs: 30000 }, { onText: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toBe(false)   // already listening
    r.say('facturas', false); r.say('facturas vencidas', true)
    e.stop()
    expect(got).toEqual([['facturas', false], ['facturas vencidas', false], ['facturas vencidas', true]])
    expect(onEnd).toHaveBeenCalledOnce()
  })
  it('browser: a denied microphone is reported as denied', () => {
    const onError = vi.fn()
    browserStt(FakeRecognition as never).start({ lang: 'en-US', maxMs: 1000 }, { onText: vi.fn(), onError, onEnd: vi.fn() })
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' })
    expect(onError).toHaveBeenCalledWith('denied')
  })
  it('native: the same events through the bridge (text only)', () => {
    const b = bridge()
    const got: [string, boolean][] = []
    const onError = vi.fn(), onEnd = vi.fn()
    pickStt({ BusinessAINative: b })!.start({ lang: 'en-US', maxMs: 30000 }, { onText: (t, f) => got.push([t, f]), onError, onEnd })
    b.cb!({ type: 'partial', text: ' overdue ' }); b.cb!({ type: 'final', text: 'overdue invoices' }); b.cb!({ type: 'error', code: 'denied' }); b.cb!({ type: 'end' })
    expect(got).toEqual([['overdue', false], ['overdue invoices', true]])
    expect(onError).toHaveBeenCalledWith('denied'); expect(onEnd).toHaveBeenCalledOnce()
  })
  it('links are not read aloud and the text is bounded', () => {
    expect(speakable('Vea /receivables/clients/abc para detalles')).toBe('Vea  para detalles')
    expect(speakable('x'.repeat(5000))).toHaveLength(1500)
  })
})

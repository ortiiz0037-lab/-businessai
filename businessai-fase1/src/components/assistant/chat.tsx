'use client'
/**
 * The assistant conversation (used by the floating widget and by /assistant).
 * The turn streams from /api/assistant/stream: tool progress and a
 * PROVISIONAL text appear while the model writes; when the turn ends the
 * server's verified answer replaces it (figures rendered from the data, with
 * sources). Answers are rendered as TEXT (no HTML): paragraphs, bullet
 * lists, **bold**, and links only to internal BusinessAI paths. Proposed
 * actions show Confirm / Cancel; nothing runs until the user confirms.
 */
import Link from 'next/link'
import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { assistantDecide, assistantRetry } from '@/app/actions/assistant'
import { COPY, TOOL_LABELS } from '@/lib/assistant/copy'
import type { AssistantStatus, ChatAction, ChatMessage, StreamEvent } from '@/lib/assistant/service'
import type { TraceEntry } from '@/lib/assistant/engine'
import type { Locale } from '@/lib/i18n/app'
import { Icon } from '@/components/ui/icon'
import { speak, stopSpeaking, usePushToTalk, VOICE_LANGS } from '@/components/assistant/voice'

const INTERNAL = /(\/(?:dashboard|clients|documents|receivables|payments|payables|bank|finance|accounting|workforce|studio|billing|settings|assistant)(?:\/[\w\-/]*)?(?:\?[\w=&\-.%]*)?)/g
const isInternal = (s: string) => /^\/(?:dashboard|clients|documents|receivables|payments|payables|bank|finance|accounting|workforce|studio|billing|settings|assistant)(?:\/[\w\-/]*)?(?:\?[\w=&\-.%]*)?$/.test(s)
const VOICE_CONSENT = 'ba-voice-consent-v1'
const readConsent = () => { try { return localStorage.getItem(VOICE_CONSENT) === 'yes' } catch { return false } }
const saveConsent = () => { try { localStorage.setItem(VOICE_CONSENT, 'yes') } catch { /* private mode: asked again next time */ } }

function Inline({ text }: { text: string }) {
  // **bold** and internal links; everything else is plain text
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i} className="font-semibold text-fg">{part.slice(2, -2)}</strong>
        return (
          <Fragment key={i}>
            {part.split(INTERNAL).map((seg, j) => (isInternal(seg)
              ? <Link key={j} href={seg} className="break-all font-medium text-blue-300 underline underline-offset-2 hover:text-blue-200">{seg}</Link>
              : <Fragment key={j}>{seg}</Fragment>))}
          </Fragment>
        )
      })}
    </>
  )
}

export function MessageText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          return <ul key={i} className="list-disc space-y-1 pl-5">{lines.map((l, j) => <li key={j}><Inline text={l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')} /></li>)}</ul>
        }
        return <p key={i} className="whitespace-pre-wrap break-words"><Inline text={b.replace(/^#+\s*/gm, '')} /></p>
      })}
    </div>
  )
}

function Sources({ tools, locale }: { tools: TraceEntry[]; locale: Locale }) {
  const t = COPY[locale]
  if (!tools?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400" data-testid="assistant-trace">
      <span>{t.sources}:</span>
      {tools.map((x, k) => {
        const label = `${TOOL_LABELS[x.name]?.[locale] ?? x.name}${x.as_of ? ` · ${t.asOf} ${x.as_of}` : x.from ? ` · ${x.from} → ${x.to}` : ''}${x.ok ? '' : ` · ${x.error === 'not_allowed' || x.error === 'forbidden' ? t.toolDenied : t.toolFailed}`}${x.flagged ? ` · ${t.flagged}` : ''}${x.ok && x.complete === false ? ` · ${t.incompleteData}` : ''}`
        const cls = `rounded-full border px-2 py-0.5 ${x.ok ? 'border-line' : 'border-amber-400/40 text-amber-300'}`
        return x.link && isInternal(x.link) ? <Link key={k} href={x.link} className={`${cls} hover:text-fg`}>{label}</Link> : <span key={k} className={cls}>{label}</span>
      })}
    </div>
  )
}

function ActionCard({ a, locale, onDecide, onRetry, busy }: { a: ChatAction; locale: Locale; onDecide: (id: string, d: 'confirm' | 'cancel') => void; onRetry: (id: string) => void; busy: boolean }) {
  const t = COPY[locale]
  const open = a.status === 'proposed'   // an expired proposal is refused by the database (shown as expired)
  const stuck = a.status === 'confirmed' || a.status === 'executing'
  const tone = a.status === 'executed' ? 'border-emerald-400/30 bg-emerald-400/[0.06]' : a.status === 'failed' ? 'border-red-400/30 bg-red-400/[0.06]' : 'border-electric/40 bg-electric/[0.07]'
  return (
    <div className={`rounded-xl border p-3 ${tone}`} data-testid="assistant-action" data-status={a.status}>
      <p className="eyebrow text-[10px]">{t.actionTitle} · {t.levels[a.level] ?? a.level}</p>
      <p className="mt-1 text-sm font-semibold text-fg">{a.summary}</p>
      <p className="mt-1 text-xs text-slate-400">{open ? t.actionNote : (t.statuses[a.status] ?? a.status)}{a.error ? ` (${a.error})` : ''}</p>
      {a.status === 'executed' && a.result?.link && isInternal(a.result.link) && <Link href={a.result.link} className="btn btn-secondary btn-sm mt-2">{t.openDraft}</Link>}
      {a.status === 'executed' && !!a.result?.missing?.length && <p className="mt-2 text-xs text-amber-300">{t.missing}: {a.result.missing.join(', ')}</p>}
      {open && (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide(a.id, 'confirm')}>{t.confirm}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDecide(a.id, 'cancel')}>{t.cancel}</button>
        </div>
      )}
      {stuck && <button type="button" className="btn btn-secondary btn-sm mt-3" disabled={busy} onClick={() => onRetry(a.id)}>{t.retry}</button>}
    </div>
  )
}

function blockedText(status: AssistantStatus | null, locale: Locale): string | null {
  const t = COPY[locale]
  if (!status) return t.forbidden
  if (!status.configured) {
    switch (status.reason) {
      case 'disabled': return t.disabled
      case 'missing_key': return t.notConfigured
      case 'missing_server_key': return t.notConfiguredServerKey
      case 'server_key_not_registered': return t.serverKeyNotRegistered
      default: return t.invalidConfig
    }
  }
  if (!status.allowed) return status.limitReason === 'forbidden' ? t.forbidden : t.limit[status.limitReason ?? ''] ?? t.forbidden
  return null
}

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

export function AssistantChat({ locale, status, initial, compact = false, onConversation }: {
  locale: Locale
  status: AssistantStatus | null
  initial?: { conversationId: string | null; messages: ChatMessage[]; actions: ChatAction[] }
  compact?: boolean
  onConversation?: (id: string) => void
}) {
  const t = COPY[locale]
  const pathname = usePathname()
  const [conversationId, setConversationId] = useState<string | null>(initial?.conversationId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>(initial?.messages ?? [])
  const [actions, setActions] = useState<ChatAction[]>(initial?.actions ?? [])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [live, setLive] = useState<{ text: string; tools: TraceEntry[]; model: string | null }>({ text: '', tools: [], model: null })
  const [deciding, startDecide] = useTransition()
  const [voiceLang, setVoiceLang] = useState<string>(locale === 'en' ? 'en-US' : 'es-PR')
  const [speakOn, setSpeakOn] = useState(false)
  const [state, setState] = useState(status)
  const [askConsent, setAskConsent] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const decisionKeys = useRef(new Map<string, string>())
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const blocked = blockedText(state, locale)

  const hasLive = live.text.length > 0
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, actions.length, pending, hasLive])
  useEffect(() => () => { stopSpeaking(); abort.current?.abort() }, [])

  const fail = useCallback((e: Extract<StreamEvent, { type: 'error' }>) => {
    if (e.error === 'not_configured') setState((s) => (s ? { ...s, configured: false, reason: e.reason ?? 'missing_key' } : s))
    if (e.error === 'limit') setState((s) => (s ? { ...s, allowed: false, limitReason: e.reason ?? 'limit_user' } : s))
    setError(e.error === 'limit' ? t.limit[e.reason ?? ''] ?? t.forbidden : e.error === 'not_configured' ? (blockedText({ configured: false, reason: e.reason ?? 'missing_key', allowed: false, limitReason: null, used: 0, limit: 0, budgetPct: null }, locale) ?? t.notConfigured)
      : e.error === 'not_found' ? t.notFound : e.error === 'invalid' ? t.invalid : e.error === 'server_auth' ? t.serverAuth : t.forbidden)
  }, [t, locale])

  const send = useCallback(async (value: string) => {
    const body = value.trim()
    if (!body || pending || blocked) return
    setError(null)
    const optimistic: ChatMessage = { id: -Date.now(), role: 'user', content: body, tools: [], status: 'ok', created_at: new Date().toISOString(), turn: null }
    setMessages((m) => [...m, optimistic])
    setText('')
    setPending(true)
    setLive({ text: '', tools: [], model: null })
    const ctl = new AbortController()
    abort.current = ctl
    let finished = false
    try {
      const res = await fetch('/api/assistant/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, text: body, screen: pathname }), signal: ctl.signal })
      if (!res.ok || !res.body) throw new Error('http')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        buf += dec.decode(chunk, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = block.split('\n').find((l) => l.startsWith('data: '))
          if (!data) continue
          const e = JSON.parse(data.slice(6)) as StreamEvent
          if (e.type === 'start') { if (e.conversationId !== conversationId) { setConversationId(e.conversationId); onConversation?.(e.conversationId) } setLive((l) => ({ ...l, model: e.model })) }
          else if (e.type === 'model') setLive((l) => ({ ...l, model: e.model }))
          else if (e.type === 'tool') setLive((l) => ({ ...l, tools: [...l.tools, e.entry] }))
          else if (e.type === 'delta') setLive((l) => ({ ...l, text: (l.text + e.text).slice(-8000) }))
          else if (e.type === 'reset') setLive((l) => ({ ...l, text: '' }))
          else if (e.type === 'final') {
            finished = true
            setMessages(e.messages); setActions(e.actions)
            const last = e.messages[e.messages.length - 1]
            if (speakOn && last?.role === 'assistant') speak(last.content, voiceLang)
            setState((s) => (s ? { ...s, used: s.used + 1 } : s))
          } else if (e.type === 'error') {
            finished = true
            setMessages((m) => m.filter((x) => x.id !== optimistic.id)); setText(body); fail(e)
          }
        }
      }
      if (!finished) throw new Error('incomplete')
    } catch {
      // cancelled by the user or the connection dropped: the server still records the turn; reload it
      if (conversationId) {
        try { const { assistantLoad } = await import('@/app/actions/assistant'); const c = await assistantLoad(conversationId); if (c) { setMessages(c.messages); setActions(c.actions) } } catch { /* offline */ }
      }
      if (!ctl.signal.aborted) setError(t.providerError)
    } finally {
      setPending(false); setLive({ text: '', tools: [], model: null }); abort.current = null
    }
  }, [pending, blocked, conversationId, pathname, onConversation, speakOn, voiceLang, fail, t])

  const decide = (id: string, decision: 'confirm' | 'cancel') => startDecide(async () => {
    // one key per decision on this card: a repeated click or a retried request is answered the same (idempotent)
    const k = `${id}:${decision}`
    if (!decisionKeys.current.has(k)) decisionKeys.current.set(k, newKey())
    const r = await assistantDecide({ actionId: id, decision, requestKey: decisionKeys.current.get(k)! })
    if (r.actions) setActions(r.actions)
  })
  const retry = (id: string) => startDecide(async () => { const r = await assistantRetry({ actionId: id }); if (r.actions) setActions(r.actions) })

  const voice = usePushToTalk(voiceLang, (said, final) => { setText(said); if (final) input.current?.focus() })
  const downAt = useRef(0)
  const startVoice = () => { if (!readConsent()) { setAskConsent(true); return false } voice.start(); return true }

  // proposed actions are shown after the answer of the turn that proposed them
  const actionsAfter = (m: ChatMessage, i: number) => {
    if (m.role !== 'assistant') return []
    const prev = messages[i - 1]?.created_at ?? ''
    return actions.filter((a) => a.created_at >= prev && a.created_at <= m.created_at)
  }
  const placed = new Set(messages.flatMap((m, i) => actionsAfter(m, i).map((a) => a.id)))
  const badge = (m: ChatMessage) => m.turn?.verification === 'verified' ? t.verified : m.turn?.verification === 'regenerated' ? t.regenerated : m.turn?.verification === 'fallback' ? t.fallbackNote : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="assistant-chat">
      <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto ${compact ? 'px-4 py-4' : 'px-4 py-5 sm:px-6'}`} aria-live="polite">
        {!messages.length && (
          <div className="mx-auto max-w-md py-6 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-electric/15 text-blue-300"><Icon name="sparkle" className="h-6 w-6" /></span>
            <p className="mt-3 text-lg font-semibold text-fg">{t.emptyTitle}</p>
            <p className="mt-1 text-sm text-slate-400">{t.emptyHint}</p>
            {!blocked && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {t.suggestions.map((s) => <button key={s} type="button" className="rounded-full border border-line px-3 py-1.5 text-xs text-slate-300 hover:border-electric/50 hover:text-fg" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-electric/20 px-3.5 py-2.5 text-sm text-fg ring-1 ring-electric/30" data-testid="assistant-user-msg">
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            ) : (
              <div className="space-y-2" data-testid="assistant-answer" data-status={m.status} data-verification={m.turn?.verification ?? ''}>
                <div className={`rounded-2xl rounded-bl-md border px-3.5 py-3 text-slate-200 ${m.status === 'ok' ? 'border-line bg-white/[0.03]' : 'border-amber-400/30 bg-amber-400/[0.05]'}`}>
                  <MessageText text={m.content} />
                </div>
                <Sources tools={m.tools} locale={locale} />
                {(badge(m) || m.turn?.model) && (
                  <p className="flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                    {badge(m) && <span className="flex items-center gap-1"><Icon name="check" className="h-3 w-3" />{badge(m)}</span>}
                    {m.turn?.model && <span>{t.modelLabel}: {m.turn.model}</span>}
                  </p>
                )}
                {actionsAfter(m, i).map((a) => <ActionCard key={a.id} a={a} locale={locale} onDecide={decide} onRetry={retry} busy={deciding} />)}
              </div>
            )}
          </div>
        ))}
        {actions.filter((a) => !placed.has(a.id)).map((a) => <ActionCard key={a.id} a={a} locale={locale} onDecide={decide} onRetry={retry} busy={deciding} />)}
        {pending && (
          <div className="space-y-2" data-testid="assistant-live">
            {!!live.tools.length && <Sources tools={live.tools} locale={locale} />}
            {live.text
              ? <div className="rounded-2xl rounded-bl-md border border-dashed border-line px-3.5 py-3 text-slate-400" data-testid="assistant-provisional"><p className="mb-1 text-[11px] text-slate-500">{t.provisional}</p><MessageText text={live.text.replace(/\[\[[^\]]*\]\]?/g, '…')} /></div>
              : <p className="flex items-center gap-2 text-sm text-slate-400" role="status"><span className="h-2 w-2 animate-pulse rounded-full bg-electric" />{t.sending}{live.model ? ` · ${live.model}` : ''}</p>}
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="border-t border-line bg-app-2/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        {blocked && <p className="alert alert-warning mb-2 text-xs" role="status" data-testid="assistant-blocked">{blocked}</p>}
        {error && !blocked && <p className="alert alert-danger mb-2 text-xs" role="alert">{error}</p>}
        {voice.error && <p className="mb-2 text-xs text-amber-300" role="status">{t.voiceError}</p>}
        {askConsent && (
          <div className="mb-2 rounded-xl border border-line bg-app p-3 text-xs text-slate-300" role="dialog" aria-label={t.voiceConsentTitle} data-testid="voice-consent">
            <p className="font-semibold text-fg">{t.voiceConsentTitle}</p>
            <p className="mt-1">{t.voiceConsentText}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { saveConsent(); setAskConsent(false); voice.start() }}>{t.voiceAccept}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAskConsent(false)}>{t.voiceDecline}</button>
            </div>
          </div>
        )}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(text) }}>
          {voice.supported && (
            <button type="button" aria-label={voice.listening ? t.listening : t.voice} title={voice.listening ? t.listening : t.voice} aria-pressed={voice.listening}
              disabled={!!blocked || pending}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border transition ${voice.listening ? 'border-red-400/60 bg-red-500/20 text-red-200' : 'border-line text-slate-300 hover:text-fg'}`}
              onPointerDown={(e) => { e.preventDefault(); if (voice.listening) voice.stop(); else if (startVoice()) downAt.current = Date.now() }}
              onPointerUp={() => { if (voice.listening && downAt.current && Date.now() - downAt.current > 450) voice.stop(); downAt.current = 0 }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (voice.listening) voice.stop(); else startVoice() } }}>
              <Icon name="mic" className="h-5 w-5" />
            </button>
          )}
          <label className="sr-only" htmlFor={compact ? 'assistant-input-w' : 'assistant-input'}>{t.placeholder}</label>
          <textarea id={compact ? 'assistant-input-w' : 'assistant-input'} ref={input} rows={1} maxLength={4000} value={text} disabled={!!blocked}
            onChange={(e) => setText(e.target.value)} placeholder={voice.listening ? t.listening : t.placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
            className="field max-h-40 min-h-11 flex-1 resize-none py-2.5 text-sm" />
          {pending
            ? <button type="button" className="btn btn-secondary h-11 shrink-0 px-3" onClick={() => abort.current?.abort()} data-testid="assistant-stop">{t.stop}</button>
            : <button type="submit" className="btn btn-primary h-11 w-11 shrink-0 p-0" disabled={!text.trim() || !!blocked} aria-label={t.send}><Icon name="send" className="h-5 w-5" /></button>}
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>{state && state.configured && state.limit > 0 ? t.usage(state.used, state.limit) : ''}</span>
          <span className="flex items-center gap-2">
            {voice.supported && (
              <label className="flex items-center gap-1">
                <span className="sr-only">{t.language}</span>
                <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)} className="rounded-md border border-line bg-transparent px-1.5 py-0.5 text-[11px] text-slate-300" aria-label={t.language}>
                  {VOICE_LANGS.map((l) => <option key={l.code} value={l.code} className="bg-app-2">{l.label}</option>)}
                </select>
              </label>
            )}
            <button type="button" onClick={() => { if (speakOn) stopSpeaking(); setSpeakOn(!speakOn) }} aria-pressed={speakOn} title={t.speak} aria-label={t.speak}
              className={`grid h-7 w-7 place-items-center rounded-md border ${speakOn ? 'border-electric/60 text-blue-300' : 'border-line text-slate-400'}`}>
              <Icon name={speakOn ? 'volume' : 'volumeOff'} className="h-4 w-4" />
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

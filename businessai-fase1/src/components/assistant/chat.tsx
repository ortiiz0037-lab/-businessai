'use client'
/**
 * The assistant conversation (used by the floating widget and by /assistant).
 * Answers are rendered as TEXT (no HTML): short paragraphs, bullet lists,
 * **bold**, and links only to internal BusinessAI paths. Proposed actions
 * show Confirm / Cancel; nothing runs until the user confirms.
 */
import Link from 'next/link'
import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePathname } from 'next/navigation'
import { assistantDecide, assistantSend } from '@/app/actions/assistant'
import { COPY, TOOL_LABELS } from '@/lib/assistant/copy'
import type { AssistantStatus, ChatAction, ChatMessage } from '@/lib/assistant/service'
import type { Locale } from '@/lib/i18n/app'
import { Icon } from '@/components/ui/icon'
import { speak, stopSpeaking, usePushToTalk, VOICE_LANGS } from '@/components/assistant/voice'

const INTERNAL = /(\/(?:dashboard|clients|documents|receivables|payments|payables|bank|finance|accounting|workforce|studio|billing|settings|assistant)(?:\/[\w\-/]*)?(?:\?[\w=&\-.%]*)?)/g
const isInternal = (s: string) => /^\/(?:dashboard|clients|documents|receivables|payments|payables|bank|finance|accounting|workforce|studio|billing|settings|assistant)(?:\/[\w\-/]*)?(?:\?[\w=&\-.%]*)?$/.test(s)

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

function ActionCard({ a, locale, onDecide, busy }: { a: ChatAction; locale: Locale; onDecide: (id: string, d: 'confirm' | 'cancel') => void; busy: boolean }) {
  const t = COPY[locale]
  const open = a.status === 'proposed'   // an expired proposal is refused by the database (shown as expired)
  const tone = a.status === 'executed' ? 'border-emerald-400/30 bg-emerald-400/[0.06]' : a.status === 'failed' ? 'border-red-400/30 bg-red-400/[0.06]' : 'border-electric/40 bg-electric/[0.07]'
  return (
    <div className={`rounded-xl border p-3 ${tone}`} data-testid="assistant-action" data-status={a.status}>
      <p className="eyebrow text-[10px]">{t.actionTitle} · {t.levels[a.level] ?? a.level}</p>
      <p className="mt-1 text-sm font-semibold text-fg">{a.summary}</p>
      <p className="mt-1 text-xs text-slate-400">{open ? t.actionNote : (t.statuses[a.status] ?? a.status)}{a.error ? ` (${a.error})` : ''}</p>
      {a.status === 'executed' && a.result?.link && isInternal(a.result.link) && (
        <Link href={a.result.link} className="btn btn-secondary btn-sm mt-2">{t.openDraft}</Link>
      )}
      {a.status === 'executed' && !!a.result?.missing?.length && <p className="mt-2 text-xs text-amber-300">{t.missing}: {a.result.missing.join(', ')}</p>}
      {open && (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide(a.id, 'confirm')}>{t.confirm}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDecide(a.id, 'cancel')}>{t.cancel}</button>
        </div>
      )}
    </div>
  )
}

function blockedText(status: AssistantStatus | null, locale: Locale): string | null {
  const t = COPY[locale]
  if (!status) return t.forbidden
  if (!status.configured) return status.reason === 'disabled' ? t.disabled : status.reason === 'missing_key' ? t.notConfigured : t.invalidConfig
  if (!status.allowed) return status.limitReason === 'forbidden' ? t.forbidden : t.limit[status.limitReason ?? ''] ?? t.forbidden
  return null
}

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
  const [pending, startSend] = useTransition()
  const [deciding, startDecide] = useTransition()
  const [voiceLang, setVoiceLang] = useState<string>(locale === 'en' ? 'en-US' : 'es-PR')
  const [speakOn, setSpeakOn] = useState(false)
  const [state, setState] = useState(status)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const blocked = blockedText(state, locale)

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, actions.length, pending])
  useEffect(() => () => stopSpeaking(), [])

  const send = useCallback((value: string) => {
    const body = value.trim()
    if (!body || pending || blocked) return
    setError(null)
    const optimistic: ChatMessage = { id: -Date.now(), role: 'user', content: body, tools: [], status: 'ok', created_at: new Date().toISOString() }
    setMessages((m) => [...m, optimistic])
    setText('')
    startSend(async () => {
      const r = await assistantSend({ conversationId, text: body, screen: pathname })
      if (r.ok) {
        setMessages(r.messages); setActions(r.actions)
        if (r.conversationId !== conversationId) { setConversationId(r.conversationId); onConversation?.(r.conversationId) }
        const last = r.messages[r.messages.length - 1]
        if (speakOn && last?.role === 'assistant') speak(last.content, voiceLang)
        if (state) setState({ ...state, used: state.used + 1 })
      } else {
        setMessages((m) => m.filter((x) => x.id !== optimistic.id))
        setText(body)
        if (r.error === 'not_configured') setState((s) => (s ? { ...s, configured: false, reason: r.reason ?? 'missing_key' } : s))
        if (r.error === 'limit' && state) setState({ ...state, allowed: false, limitReason: r.reason ?? 'limit_user' })
        setError(r.error === 'limit' ? t.limit[r.reason ?? ''] ?? t.forbidden : r.error === 'not_configured' ? t.notConfigured : r.error === 'not_found' ? t.notFound : r.error === 'invalid' ? t.invalid : t.forbidden)
      }
    })
  }, [pending, blocked, conversationId, pathname, onConversation, speakOn, voiceLang, state, t])

  const decide = (id: string, decision: 'confirm' | 'cancel') => startDecide(async () => {
    const r = await assistantDecide({ actionId: id, decision })
    if (r.actions) setActions(r.actions)
  })

  const voice = usePushToTalk(voiceLang, (said, final) => { setText(said); if (final) input.current?.focus() })
  const downAt = useRef(0)

  // proposed actions are shown after the answer that proposed them
  const actionsAfter = (m: ChatMessage, i: number) => {
    if (m.role !== 'assistant') return []
    const next = messages[i + 1]
    return actions.filter((a) => a.created_at >= messages[i - 1]?.created_at && a.created_at <= m.created_at && (!next || a.created_at < next.created_at))
  }
  const placed = new Set(messages.flatMap((m, i) => actionsAfter(m, i).map((a) => a.id)))

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
              <div className="space-y-2" data-testid="assistant-answer" data-status={m.status}>
                <div className={`rounded-2xl rounded-bl-md border px-3.5 py-3 text-slate-200 ${m.status === 'ok' ? 'border-line bg-white/[0.03]' : 'border-amber-400/30 bg-amber-400/[0.05]'}`}>
                  <MessageText text={m.content} />
                </div>
                {!!m.tools?.length && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400" data-testid="assistant-trace">
                    <span>{t.toolsUsed}:</span>
                    {m.tools.map((x, k) => (
                      <span key={k} className={`rounded-full border px-2 py-0.5 ${x.ok ? 'border-line' : 'border-amber-400/40 text-amber-300'}`}>
                        {TOOL_LABELS[x.name]?.[locale] ?? x.name}{x.ok ? '' : ` · ${x.error === 'not_allowed' || x.error === 'forbidden' ? t.toolDenied : t.toolFailed}`}{x.flagged ? ` · ${t.flagged}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {actionsAfter(m, i).map((a) => <ActionCard key={a.id} a={a} locale={locale} onDecide={decide} busy={deciding} />)}
              </div>
            )}
          </div>
        ))}
        {actions.filter((a) => !placed.has(a.id)).map((a) => <ActionCard key={a.id} a={a} locale={locale} onDecide={decide} busy={deciding} />)}
        {pending && <p className="flex items-center gap-2 text-sm text-slate-400" role="status"><span className="h-2 w-2 animate-pulse rounded-full bg-electric" />{t.sending}</p>}
        <div ref={end} />
      </div>

      <div className="border-t border-line bg-app-2/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        {blocked && <p className="alert alert-warning mb-2 text-xs" role="status" data-testid="assistant-blocked">{blocked}</p>}
        {error && !blocked && <p className="alert alert-danger mb-2 text-xs" role="alert">{error}</p>}
        {voice.error && <p className="mb-2 text-xs text-amber-300" role="status">{t.voiceError}</p>}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(text) }}>
          {voice.supported && (
            <button type="button" aria-label={voice.listening ? t.listening : t.voice} title={voice.listening ? t.listening : t.voice} aria-pressed={voice.listening}
              disabled={!!blocked || pending}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border transition ${voice.listening ? 'border-red-400/60 bg-red-500/20 text-red-200' : 'border-line text-slate-300 hover:text-fg'}`}
              onPointerDown={(e) => { e.preventDefault(); if (voice.listening) voice.stop(); else { downAt.current = Date.now(); voice.start() } }}
              onPointerUp={() => { if (voice.listening && downAt.current && Date.now() - downAt.current > 450) voice.stop(); downAt.current = 0 }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (voice.listening) voice.stop(); else voice.start() } }}>
              <Icon name="mic" className="h-5 w-5" />
            </button>
          )}
          <label className="sr-only" htmlFor={compact ? 'assistant-input-w' : 'assistant-input'}>{t.placeholder}</label>
          <textarea id={compact ? 'assistant-input-w' : 'assistant-input'} ref={input} rows={1} maxLength={4000} value={text} disabled={!!blocked}
            onChange={(e) => setText(e.target.value)} placeholder={voice.listening ? t.listening : t.placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
            className="field max-h-40 min-h-11 flex-1 resize-none py-2.5 text-sm" />
          <button type="submit" className="btn btn-primary h-11 w-11 shrink-0 p-0" disabled={!text.trim() || pending || !!blocked} aria-label={t.send}>
            <Icon name="send" className="h-5 w-5" />
          </button>
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

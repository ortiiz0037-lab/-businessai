'use client'
/**
 * Floating assistant, available on every screen of the app. Closed by
 * default; opening it loads the status (configured? within limits?) and the
 * last conversation of this tab. iPhone: full-screen sheet above the tab bar;
 * iPad / desktop: a panel in the corner. Hidden on /assistant (the center).
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { assistantLoad, assistantState } from '@/app/actions/assistant'
import { COPY } from '@/lib/assistant/copy'
import type { AssistantStatus, ChatAction, ChatMessage } from '@/lib/assistant/service'
import type { Locale } from '@/lib/i18n/app'
import { Icon } from '@/components/ui/icon'
import { AssistantChat } from '@/components/assistant/chat'

const KEY = 'ba-assistant-conversation'
const read = () => { try { return sessionStorage.getItem(KEY) } catch { return null } }
const write = (v: string | null) => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY) } catch { /* private mode */ } }

export function AssistantWidget({ locale }: { locale: Locale }) {
  const t = COPY[locale]
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AssistantStatus | null | undefined>(undefined)
  const [initial, setInitial] = useState<{ conversationId: string | null; messages: ChatMessage[]; actions: ChatAction[] } | null>(null)
  const [key, setKey] = useState(0)

  useEffect(() => {
    if (!open) return
    let live = true
    ;(async () => {
      const [s, conv] = await Promise.all([assistantState(), (async () => { const id = read(); return id ? assistantLoad(id) : null })()])
      if (!live) return
      setStatus(s)
      setInitial(conv && !conv.conversation.archived_at ? { conversationId: conv.conversation.id, messages: conv.messages, actions: conv.actions } : { conversationId: null, messages: [], actions: [] })
    })()
    return () => { live = false }
  }, [open, key])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (pathname?.startsWith('/assistant')) return null
  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-label={t.open} title={t.name} data-testid="assistant-fab"
          className="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-electric to-blue-700 text-white shadow-lg shadow-electric/30 ring-1 ring-white/20 transition hover:scale-105 md:bottom-6 md:right-6">
          <Icon name="sparkle" className="h-6 w-6" />
        </button>
      )}
      {open && (
        <div role="dialog" aria-modal="false" aria-label={t.name} data-testid="assistant-panel"
          className="fixed inset-0 z-[55] flex flex-col bg-app-2 pt-[env(safe-area-inset-top)] md:inset-auto md:bottom-6 md:right-6 md:h-[min(42rem,calc(100vh-6rem))] md:w-[26rem] md:rounded-2xl md:border md:border-line md:pt-0 md:shadow-2xl md:shadow-black/50">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-electric/15 text-blue-300"><Icon name="sparkle" className="h-4 w-4" /></span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg">{t.name}</p>
                {status && !status.configured && <p className="text-[11px] text-amber-300">{t.notConfiguredShort}</p>}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-fg" aria-label={t.newChat} title={t.newChat}
                onClick={() => { write(null); setInitial(null); setKey((k) => k + 1) }}><Icon name="plus" className="h-4 w-4" /></button>
              <Link href={initial?.conversationId ? `/assistant?c=${initial.conversationId}` : '/assistant'} onClick={() => setOpen(false)} aria-label={t.expand} title={t.expand}
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-fg"><Icon name="expand" className="h-4 w-4" /></Link>
              <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-fg" aria-label={t.close} onClick={() => setOpen(false)}>
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {status === undefined || !initial
              ? <p className="p-6 text-sm text-slate-400" role="status">…</p>
              : <AssistantChat key={`${key}-${initial.conversationId ?? 'new'}`} locale={locale} status={status} initial={initial} compact onConversation={(id) => write(id)} />}
          </div>
        </div>
      )}
    </>
  )
}

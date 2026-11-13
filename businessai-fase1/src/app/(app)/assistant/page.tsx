import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { createClient } from '@/lib/supabase/server'
import { assistantStatus, listConversations, loadConversation } from '@/lib/assistant/service'
import { COPY } from '@/lib/assistant/copy'
import { AssistantChat } from '@/components/assistant/chat'
import { ConversationList } from '@/components/assistant/conversation-list'
import { Icon } from '@/components/ui/icon'

export const dynamic = 'force-dynamic'

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ c?: string; view?: string }> }) {
  const locale = await getLocale()
  const tr = translator(locale)
  const t = COPY[locale]
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/assistant')
  const sp = await searchParams
  const archived = sp.view === 'archived'
  const [status, conversations, current] = await Promise.all([
    assistantStatus(),
    listConversations(archived),
    sp.c ? loadConversation(sp.c) : Promise.resolve(null),
  ])
  if (!status) redirect('/onboarding')
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{tr('Asistente', 'Assistant')}</p>
          <h1 className="page-title">{t.center}</h1>
          <p className="muted mt-1 max-w-2xl text-sm">{t.privacy}</p>
        </div>
        <Link href="/assistant" className="btn btn-primary btn-sm"><Icon name="plus" className="h-4 w-4" />{t.newChat}</Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="card p-3" aria-label={t.conversations}>
          <div className="mb-2 flex gap-1 text-xs">
            <Link href="/assistant" className={`rounded-lg px-2.5 py-1.5 ${!archived ? 'bg-white/10 text-fg' : 'text-slate-400 hover:text-fg'}`}>{t.conversations}</Link>
            <Link href="/assistant?view=archived" className={`rounded-lg px-2.5 py-1.5 ${archived ? 'bg-white/10 text-fg' : 'text-slate-400 hover:text-fg'}`}>{t.archived}</Link>
          </div>
          <ConversationList locale={locale} items={conversations} currentId={current?.conversation.id ?? null} archived={archived} />
        </aside>
        <section className="card flex h-[calc(100dvh-16rem)] min-h-[28rem] flex-col overflow-hidden p-0 md:h-[calc(100dvh-14rem)]">
          {current && (
            <div className="border-b border-line px-4 py-3 sm:px-6">
              <p className="truncate font-semibold text-fg" data-testid="assistant-title">{current.conversation.title}</p>
              {current.conversation.archived_at && <p className="text-xs text-amber-300">{t.archived}</p>}
            </div>
          )}
          {sp.c && !current
            ? <p className="p-6 text-sm text-slate-400">{t.notFound}</p>
            : <AssistantChat key={current?.conversation.id ?? 'new'} locale={locale} status={current?.conversation.archived_at ? { ...status, allowed: false, limitReason: 'archived' } : status}
                initial={{ conversationId: current?.conversation.id ?? null, messages: current?.messages ?? [], actions: current?.actions ?? [] }} />}
        </section>
      </div>
    </div>
  )
}

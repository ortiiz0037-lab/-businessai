'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { assistantArchive, assistantRename } from '@/app/actions/assistant'
import { COPY } from '@/lib/assistant/copy'
import type { Conversation } from '@/lib/assistant/service'
import type { Locale } from '@/lib/i18n/app'
import { Icon } from '@/components/ui/icon'

export function ConversationList({ locale, items, currentId, archived }: { locale: Locale; items: Conversation[]; currentId: string | null; archived: boolean }) {
  const t = COPY[locale]
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [pending, start] = useTransition()
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { day: 'numeric', month: 'short' })
  if (!items.length) return <p className="px-2 py-4 text-sm text-slate-400">{t.noConversations}</p>
  return (
    <ul className="max-h-[22rem] space-y-1 overflow-y-auto lg:max-h-[calc(100dvh-20rem)]" data-testid="assistant-conversations">
      {items.map((c) => (
        <li key={c.id} className={`group rounded-lg ${c.id === currentId ? 'bg-electric/15 ring-1 ring-electric/30' : 'hover:bg-white/5'}`}>
          {editing === c.id ? (
            <form className="flex gap-1 p-1.5" onSubmit={(e) => { e.preventDefault(); start(async () => { await assistantRename({ id: c.id, title }); setEditing(null); router.refresh() }) }}>
              <label className="sr-only" htmlFor={`rename-${c.id}`}>{t.rename}</label>
              <input id={`rename-${c.id}`} className="field h-8 flex-1 py-1 text-sm" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <button className="btn btn-primary btn-sm" disabled={pending || !title.trim()}>{t.save}</button>
            </form>
          ) : (
            <div className="flex items-center gap-1 pr-1">
              <Link href={`/assistant?c=${c.id}${archived ? '&view=archived' : ''}`} className="min-w-0 flex-1 px-2.5 py-2">
                <span className="block truncate text-sm text-fg">{c.title}</span>
                <span className="text-[11px] text-slate-500">{date.format(new Date(c.updated_at))}</span>
              </Link>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:text-fg" aria-label={`${t.rename}: ${c.title}`} title={t.rename}
                onClick={() => { setEditing(c.id); setTitle(c.title) }}><Icon name="edit" className="h-4 w-4" /></button>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:text-fg" disabled={pending}
                aria-label={`${archived ? t.restore : t.archive}: ${c.title}`} title={archived ? t.restore : t.archive}
                onClick={() => start(async () => { await assistantArchive({ id: c.id, archived: !archived }); router.push(archived ? '/assistant?view=archived' : '/assistant'); router.refresh() })}>
                <Icon name="archive" className="h-4 w-4" />
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

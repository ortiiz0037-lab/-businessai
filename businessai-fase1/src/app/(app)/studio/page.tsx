import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { studioPage } from '@/lib/studio/page'
import { KINDS, kindLabel, statusLabel, statusTone, studioMessage } from '@/lib/studio/model'

export const dynamic = 'force-dynamic'
const PAGE = 30

type SP = { q?: string; kind?: string; status?: string; folder?: string; page?: string; error?: string }

/** Document Studio: every document of the company, searchable and filtered (paginated). */
export default async function StudioPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1))
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? '') ? sp.kind! : null
  const status = ['draft', 'final', 'archived'].includes(sp.status ?? '') ? sp.status! : null
  const term = (sp.q ?? '').replace(/[%_,()*\\]/g, ' ').trim().slice(0, 60)
  const folder = (sp.folder ?? '').trim().slice(0, 60) || null
  let q = supabase.from('studio_documents').select('id, kind, title, folder, status, number, updated_at, origin', { count: 'exact' }).eq('company_id', companyId)
  if (kind) q = q.eq('kind', kind)
  if (status) q = q.eq('status', status); else q = q.neq('status', 'archived')
  if (folder) q = q.eq('folder', folder)
  if (term) q = q.or(`title.ilike.%${term}%,number.ilike.%${term}%`)
  const [{ data, count }, { data: folders }] = await Promise.all([
    q.order('updated_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1),
    supabase.from('studio_documents').select('folder').eq('company_id', companyId).not('folder', 'is', null).limit(500),
  ])
  const docs = (data ?? []) as { id: string; kind: string; title: string; folder: string | null; status: string; number: string | null; updated_at: string; origin: string }[]
  const folderList = [...new Set(((folders ?? []) as { folder: string }[]).map((x) => x.folder))].sort()
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const link = (o: Partial<SP>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ q: term || null, kind, status, folder, ...o })) if (v) p.set(k, String(v)); return `/studio?${p}` }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Document Studio" title={tr('Documentos', 'Documents')}
        description={tr('Cartas, cotizaciones, facturas, contratos, informes y más con la identidad de tu empresa. Los importes se leen de BusinessAI; nunca se escriben a mano.',
          'Letters, quotes, invoices, contracts, reports and more with your company identity. Amounts are read from BusinessAI, never typed by hand.')}
        actions={access.edit ? <Link href="/studio/new" className="btn-primary">{tr('Nuevo documento', 'New document')}</Link> : undefined} />
      <StudioNav tr={tr} current="/studio" />
      <Flash error={studioMessage(sp.error, locale)} />
      <form action="/studio" className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <label className="text-sm lg:col-span-2"><span className="field-label">{tr('Buscar por título o número', 'Search by title or number')}</span><input name="q" defaultValue={term} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span><select name="kind" defaultValue={kind ?? ''} className="field"><option value="">{tr('Todos', 'All')}</option>{KINDS.map((k) => <option key={k} value={k}>{kindLabel(k, locale)}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{tr('Estado', 'Status')}</span><select name="status" defaultValue={status ?? ''} className="field"><option value="">{tr('Activos', 'Active')}</option>{['draft', 'final', 'archived'].map((s) => <option key={s} value={s}>{statusLabel(s, locale)}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{tr('Carpeta', 'Folder')}</span><select name="folder" defaultValue={folder ?? ''} className="field"><option value="">{tr('Todas', 'All')}</option>{folderList.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <button type="submit" className="btn-secondary lg:col-start-5">{tr('Filtrar', 'Filter')}</button>
      </form>
      {docs.length === 0 ? (
        <div className="card"><EmptyState icon="file" title={tr('Sin documentos', 'No documents')} description={tr('Empieza desde una plantilla o pide un borrador al asistente.', 'Start from a template or ask the assistant for a draft.')}
          action={access.edit ? <Link href="/studio/new" className="btn-primary">{tr('Nuevo documento', 'New document')}</Link> : undefined} /></div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {docs.map((d) => (
            <li key={d.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/studio/${d.id}`} className="block truncate font-display text-base font-semibold text-fg hover:text-accent">{d.title}</Link>
                  <p className="text-xs text-muted">{[kindLabel(d.kind, locale), d.number, d.folder].filter(Boolean).join(' · ')}</p>
                </div>
                <span className={statusTone(d.status)}>{statusLabel(d.status, locale)}</span>
              </div>
              <p className="mt-2 text-xs text-muted">{tr('Actualizado', 'Updated')} {f.dateTime(d.updated_at)}{d.origin === 'assistant' ? ` · ${tr('borrador del asistente', 'assistant draft')}` : ''}</p>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label={tr('Páginas', 'Pages')} className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={link({ page: String(page - 1) })} className="btn-secondary btn-sm">{tr('Anterior', 'Previous')}</Link> : <span />}
          <span className="text-muted">{page} / {pages}</span>
          {page < pages ? <Link href={link({ page: String(page + 1) })} className="btn-secondary btn-sm">{tr('Siguiente', 'Next')}</Link> : <span />}
        </nav>
      )}
    </div>
  )
}

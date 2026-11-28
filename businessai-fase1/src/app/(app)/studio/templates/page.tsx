import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { studioPage } from '@/lib/studio/page'
import { systemTemplates } from '@/lib/studio/templates'
import { kindLabel, studioMessage } from '@/lib/studio/model'
import { archiveTemplate, customizeTemplate } from '@/app/actions/studio'

export const dynamic = 'force-dynamic'

/** System templates (read-only, for every company) and the company's own customised copies. */
export default async function StudioTemplates({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  const { data } = await supabase.from('studio_templates').select('id, kind, name, description, base_key, version, updated_at').eq('company_id', companyId).eq('status', 'active').order('name')
  const own = (data ?? []) as { id: string; kind: string; name: string; description: string | null; base_key: string | null; version: number; updated_at: string }[]
  const done: Record<string, string> = { template_archived: tr('Plantilla archivada.', 'Template archived.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Document Studio" title={tr('Plantillas', 'Templates')}
        description={tr('Las plantillas del sistema son comunes y no se modifican; personaliza una copia para tu empresa (las demás empresas no la ven).',
          'System templates are shared and never change; customise a copy for your company (other companies do not see it).')} />
      <StudioNav tr={tr} current="/studio/templates" />
      <Flash done={sp.done ? done[sp.done] : null} error={studioMessage(sp.error, locale)} />
      <section aria-labelledby="own" className="space-y-3">
        <h2 id="own" className="font-display text-lg font-semibold text-fg">{tr('Plantillas de la empresa', 'Company templates')}</h2>
        {own.length === 0 ? <p className="card p-4 text-sm text-muted">{tr('Aún no hay plantillas propias.', 'No company templates yet.')}</p> : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{own.map((t) => (
            <li key={t.id} className="card space-y-2 p-4">
              <p className="font-semibold text-fg">{t.name}</p>
              <p className="text-xs text-muted">{kindLabel(t.kind, locale)} · v{t.version} · {f.dateTime(t.updated_at)}</p>
              <div className="flex flex-wrap gap-2">
                {access.edit && <Link href={`/studio/new?template=tpl:${t.id}`} className="btn-primary btn-sm">{tr('Usar', 'Use')}</Link>}
                {access.templates && <Link href={`/studio/templates/${t.id}`} className="btn-secondary btn-sm">{tr('Editar', 'Edit')}</Link>}
                {access.templates && <form action={archiveTemplate}><input type="hidden" name="id" value={t.id} /><button type="submit" className="btn-secondary btn-sm">{tr('Archivar', 'Archive')}</button></form>}
              </div>
            </li>))}</ul>
        )}
      </section>
      <section aria-labelledby="sys" className="space-y-3">
        <h2 id="sys" className="font-display text-lg font-semibold text-fg">{tr('Plantillas del sistema', 'System templates')}</h2>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{systemTemplates(locale).map((t) => (
          <li key={t.key} className="card space-y-2 p-4">
            <p className="font-semibold text-fg">{t.name}</p>
            <p className="text-xs text-muted">{kindLabel(t.kind, locale)} · {t.description}</p>
            <div className="flex flex-wrap gap-2">
              {access.edit && <Link href={`/studio/new?template=sys:${t.key}`} className="btn-primary btn-sm">{tr('Usar', 'Use')}</Link>}
              {access.templates && <form action={customizeTemplate}><input type="hidden" name="template" value={`sys:${t.key}`} /><SubmitButton className="w-auto">{tr('Personalizar', 'Customise')}</SubmitButton></form>}
            </div>
          </li>))}</ul>
      </section>
    </div>
  )
}

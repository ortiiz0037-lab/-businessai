import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'
import type { Locale } from '@/lib/i18n/app'
import { crmMessage } from '@/lib/crm/core'

/** Section tabs of the CRM (scrolls horizontally on phones). */
export function CrmNav({ tr, current, configure }: { tr: Tr; current: string; configure: boolean }) {
  const items = [
    ['/crm', tr('Resumen', 'Overview')],
    ['/crm/pipeline', tr('Pipeline', 'Pipeline')],
    ['/crm/opportunities', tr('Oportunidades', 'Opportunities')],
    ['/crm/activities', tr('Actividades', 'Activities')],
    ['/clients', tr('Clientes', 'Clients')],
    ...(configure ? [['/crm/settings', tr('Configuración', 'Settings')]] : []),
  ]
  return (
    <nav aria-label="CRM" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href
                ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>{label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoCrmAccess({ tr, reason }: { tr: Tr; reason: 'role' | 'unavailable' }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center" data-testid="crm-denied">
      <h1 className="font-display text-2xl font-semibold text-fg">CRM</h1>
      <p className="mt-2 text-sm text-muted">
        {reason === 'unavailable' ? tr('El CRM todavía no está activado en esta base de datos.', 'The CRM is not enabled in this database yet.')
          : tr('Tu rol no tiene acceso al CRM de esta empresa.', 'Your role has no access to this company\'s CRM.')}
      </p>
    </div>
  )
}

const DONE: Record<string, [string, string]> = {
  created: ['Oportunidad creada.', 'Opportunity created.'], saved: ['Cambios guardados.', 'Changes saved.'], moved: ['Etapa actualizada.', 'Stage updated.'],
  archived: ['Oportunidad archivada.', 'Opportunity archived.'], restored: ['Oportunidad restaurada.', 'Opportunity restored.'],
  linked: ['Documento asociado.', 'Document linked.'], unlinked: ['Documento desvinculado.', 'Document unlinked.'],
  activity_created: ['Actividad registrada.', 'Activity recorded.'], activity_saved: ['Actividad actualizada.', 'Activity updated.'],
  activity_completed: ['Actividad completada.', 'Activity completed.'], activity_pending: ['Actividad reabierta.', 'Activity reopened.'], activity_cancelled: ['Actividad cancelada.', 'Activity cancelled.'],
  contact_saved: ['Contacto guardado.', 'Contact saved.'], contact_archived: ['Contacto archivado.', 'Contact archived.'], contact_restored: ['Contacto restaurado.', 'Contact restored.'],
  tags_saved: ['Etiquetas actualizadas.', 'Tags updated.'], tag_saved: ['Etiqueta guardada.', 'Tag saved.'], stage_saved: ['Etapa guardada.', 'Stage saved.'],
  settings_saved: ['Configuración guardada.', 'Settings saved.'], branch_saved: ['Sucursal guardada.', 'Branch saved.'], branch_archived: ['Sucursal archivada.', 'Branch archived.'],
  branch_restored: ['Sucursal restaurada.', 'Branch restored.'], member_assigned: ['Miembro asignado a la sucursal.', 'Member assigned to the branch.'],
  member_unassigned: ['Miembro retirado de la sucursal.', 'Member removed from the branch.'], client_shared: ['Cliente compartido con la sucursal.', 'Client shared with the branch.'],
  client_unshared: ['Cliente ya no compartido con la sucursal.', 'Client no longer shared with the branch.'],
}

/** ?done= / ?error= banners shared by the CRM pages. */
export function CrmFlash({ locale, done, error }: { locale: Locale; done?: string; error?: string }) {
  return (
    <>
      {done && DONE[done] && <div role="status" className="alert-success p-4">{DONE[done][locale === 'en' ? 1 : 0]}</div>}
      {error && <div role="alert" className="alert-danger p-4">{crmMessage(error, locale)}</div>}
    </>
  )
}

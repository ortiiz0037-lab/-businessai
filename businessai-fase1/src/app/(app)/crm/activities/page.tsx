import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { CrmFlash, CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { ActivityForm, ActivityList, type ActivityRow } from '@/components/crm-activities'
import { crmPage, loadMembers } from '@/lib/crm/page'
import { ACTIVITY_KINDS, crmLabel } from '@/lib/crm/core'
import { localDay } from '@/lib/workforce/hours'

export const dynamic = 'force-dynamic'
const VIEWS = ['pending', 'overdue', 'today', 'week', 'completed', 'all'] as const

/** Agenda of follow-ups: by day, with filters; pending ones are completed or cancelled here. */
export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ view?: string; mine?: string; kind?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, user, companyId, can, available } = await crmPage('/crm/activities')
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoCrmAccess tr={tr} reason="role" />
  const view = ((VIEWS as readonly string[]).includes(params.view ?? '') ? params.view : 'pending') as (typeof VIEWS)[number]
  const mine = params.mine === '1'
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(params.kind ?? '') ? params.kind! : null
  const now = new Date()
  const today = localDay(now, 'America/Puerto_Rico')
  const dayStart = new Date(`${today}T00:00:00-04:00`)
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)
  let q = supabase.from('crm_activities').select('id, kind, subject, body, direction, due_at, status, outcome, assigned_to, created_by, created_at, completed_at, version, origin, client_id, opportunity_id')
    .eq('company_id', companyId)
  if (view === 'pending') q = q.eq('status', 'pending')
  if (view === 'overdue') q = q.eq('status', 'pending').lt('due_at', now.toISOString())
  if (view === 'today') q = q.eq('status', 'pending').gte('due_at', dayStart.toISOString()).lt('due_at', dayEnd.toISOString())
  if (view === 'week') q = q.eq('status', 'pending').gte('due_at', dayStart.toISOString()).lt('due_at', new Date(dayStart.getTime() + 7 * 86_400_000).toISOString())
  if (view === 'completed') q = q.eq('status', 'completed')
  if (mine) q = q.eq('assigned_to', user.id)
  if (kind) q = q.eq('kind', kind)
  q = view === 'completed' || view === 'all' ? q.order('created_at', { ascending: false }) : q.order('due_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false })
  const [{ data }, members, { data: clientRows }] = await Promise.all([q.limit(200), loadMembers(supabase, companyId, { id: user.id, email: user.email }),
    supabase.from('clients').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name').limit(500)])
  const rows = (data ?? []) as ActivityRow[]
  const clients = (clientRows ?? []) as { id: string; name: string }[]
  const ids = [...new Set(rows.map((r) => r.client_id).filter(Boolean))] as string[]
  const { data: cl } = ids.length ? await supabase.from('clients').select('id, name').in('id', ids) : { data: [] }
  const names = new Map(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
  // group by local day (due date for pending work, creation for history)
  const key = (r: ActivityRow) => localDay(new Date(view === 'completed' || view === 'all' || !r.due_at ? r.created_at : r.due_at), 'America/Puerto_Rico')
  const groups = new Map<string, ActivityRow[]>()
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r])
  const link = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams()
    const cur: Record<string, string | null> = { view, mine: mine ? '1' : null, kind, ...patch }
    for (const [k, v] of Object.entries(cur)) if (v) sp.set(k, v)
    return `/crm/activities?${sp}`
  }
  const back = link({})
  const viewLabel: Record<string, string> = { pending: tr('Pendientes', 'Pending'), overdue: tr('Atrasadas', 'Overdue'), today: tr('Hoy', 'Today'), week: tr('7 días', '7 days'), completed: tr('Completadas', 'Completed'), all: tr('Todas', 'All') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="CRM" title={tr('Actividades y seguimiento', 'Activities and follow-up')}
        description={tr('Llamadas, emails registrados, reuniones, tareas, notas y recordatorios. Nada se envía desde aquí.', 'Calls, logged emails, meetings, tasks, notes and reminders. Nothing is sent from here.')} />
      <CrmNav tr={tr} current="/crm/activities" configure={can.configure} />
      <CrmFlash locale={locale} done={params.done} error={params.error} />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr('Vista', 'View')}>
        {VIEWS.map((v) => <Link key={v} href={link({ view: v })} aria-current={v === view ? 'page' : undefined} className={v === view ? 'badge-accent' : 'badge-neutral'}>{viewLabel[v]}</Link>)}
        <Link href={link({ mine: mine ? null : '1' })} className={mine ? 'badge-accent' : 'badge-neutral'}>{tr('Solo mías', 'Only mine')}</Link>
        <form method="get" className="flex gap-2"><input type="hidden" name="view" value={view} />{mine && <input type="hidden" name="mine" value="1" />}
          <select name="kind" defaultValue={kind ?? ''} aria-label={tr('Tipo', 'Type')} className="field w-auto py-1 text-sm"><option value="">{tr('Todos los tipos', 'All types')}</option>
            {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{crmLabel(k, locale)}</option>)}</select>
          <button type="submit" className="btn-secondary btn-sm">{tr('Filtrar', 'Filter')}</button></form>
      </nav>

      <section className="card p-5" aria-label={tr('Agenda', 'Agenda')} data-testid="agenda">
        {rows.length === 0 ? <p className="text-sm text-muted">{tr('No hay actividades en esta vista.', 'No activities in this view.')}</p> :
          [...groups.entries()].map(([day, list]) => (
            <div key={day} className="mb-4">
              <h2 className={`text-xs font-bold uppercase tracking-wide ${day < today && view !== 'completed' && view !== 'all' ? 'text-rose-300' : day === today ? 'text-blue-300' : 'text-muted'}`}>
                {f.date(day)}{day === today ? ` · ${tr('hoy', 'today')}` : ''}</h2>
              <ActivityList rows={list} members={members} locale={locale} tr={tr} f={f} canManage={can.manage} back={back} names={names} />
            </div>
          ))}
      </section>

      {can.manage && (
        <section className="card p-5" aria-labelledby="new-act-title">
          <h2 id="new-act-title" className="font-display text-lg font-semibold text-fg">{tr('Registrar actividad', 'Log activity')}</h2>
          {clients.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Primero registra un cliente.', 'Register a client first.')}</p>
            : <ActivityForm tr={tr} locale={locale} members={members} selfId={user.id} clients={clients} back={back} />}
        </section>
      )}
    </div>
  )
}

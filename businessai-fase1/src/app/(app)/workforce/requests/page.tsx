import { PageHeader, EmptyState } from '@/components/ui/page'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { leaveLabel, punchLabel, wfMessage } from '@/lib/workforce/context'
import { cancelLeave, decideCorrection, decideLeave } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'

/** Approvals: punch corrections and leave requests waiting for a decision. */
export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, user, companyId, access, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const [{ data: corr }, { data: leave }, { data: upcoming }, { data: emps }] = await Promise.all([
    supabase.from('punch_corrections').select('id, employee_id, action, kind, at, reason, requested_by, requested_at').eq('company_id', companyId).eq('status', 'pending').order('requested_at').limit(100),
    supabase.from('leave_requests').select('id, employee_id, leave_type, starts_on, ends_on, partial_minutes, reason, requested_at').eq('company_id', companyId).eq('status', 'pending').order('starts_on').limit(100),
    supabase.from('leave_requests').select('id, employee_id, leave_type, starts_on, ends_on').eq('company_id', companyId).eq('status', 'approved').gte('ends_on', new Date().toISOString().slice(0, 10)).order('starts_on').limit(50),
    supabase.from('employees').select('id, first_name, last_name, user_id').eq('company_id', companyId),
  ])
  const emp = new Map(((emps ?? []) as { id: string; first_name: string; last_name: string; user_id: string | null }[]).map((e) => [e.id, e]))
  const name = (id: string) => { const e = emp.get(id); return e ? `${e.first_name} ${e.last_name}` : '—' }
  const own = (id: string) => emp.get(id)?.user_id === user.id
  const done: Record<string, string> = { approved: tr('Aprobado.', 'Approved.'), rejected: tr('Rechazado.', 'Rejected.'), cancelled: tr('Ausencia cancelada.', 'Leave cancelled.') }
  const decide = (action: typeof decideCorrection, id: string, mine: boolean) => mine ? (
    <p className="text-xs text-warning">{tr('Es tuya: la decide otra persona.', 'It is yours: someone else decides it.')}</p>
  ) : (
    <div className="flex flex-wrap gap-2">
      {(['approve', 'reject'] as const).map((d) => (
        <form key={d} action={action} className="flex gap-2">
          <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value={d} /><input type="hidden" name="back" value="/workforce/requests" />
          {d === 'reject' && <input name="note" maxLength={300} placeholder={tr('Nota (opcional)', 'Note (optional)')} aria-label={tr('Nota', 'Note')} className="field w-36 py-1.5 text-sm" />}
          <button type="submit" className={d === 'approve' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}>{d === 'approve' ? tr('Aprobar', 'Approve') : tr('Rechazar', 'Reject')}</button>
        </form>
      ))}
    </div>
  )
  const corrections = (corr ?? []) as { id: string; employee_id: string; action: string; kind: string | null; at: string | null; reason: string; requested_by: string; requested_at: string }[]
  const leaves = (leave ?? []) as { id: string; employee_id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null; reason: string | null }[]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Solicitudes', 'Requests')}
        description={tr('Correcciones de ponches y ausencias por aprobar. Queda registrado quién decide.', 'Punch corrections and leave to approve. Who decides is recorded.')} />
      <WorkforceNav tr={tr} current="/workforce/requests" manages={access.manages} />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="c-title">
          <h2 id="c-title" className="font-display text-lg font-semibold text-fg">{tr('Correcciones de ponches', 'Punch corrections')} <span className="badge-neutral">{corrections.length}</span></h2>
          {corrections.length === 0 ? <EmptyState icon="clock" title={tr('Nada pendiente.', 'Nothing pending.')} /> : (
            <ul className="mt-2 divide-y divide-line">
              {corrections.map((c) => (
                <li key={c.id} className="space-y-2 py-3 text-sm">
                  <p className="font-semibold text-fg">{name(c.employee_id)}</p>
                  <p className="text-slate-300">{c.action === 'void' ? tr('Anular un ponche', 'Void a punch') : `${c.action === 'add' ? tr('Añadir', 'Add') : tr('Cambiar a', 'Change to')} ${c.kind ? punchLabel(c.kind, locale) : ''}`}{c.at ? ` · ${f.dateTime(c.at)}` : ''}</p>
                  <p className="text-xs text-muted">“{c.reason}” · {f.dateTime(c.requested_at)}{c.requested_by === user.id ? ` · ${tr('pedida por ti', 'requested by you')}` : ''}</p>
                  {decide(decideCorrection, c.id, own(c.employee_id))}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-5" aria-labelledby="l-title">
          <h2 id="l-title" className="font-display text-lg font-semibold text-fg">{tr('Vacaciones y permisos', 'Vacation and leave')} <span className="badge-neutral">{leaves.length}</span></h2>
          {leaves.length === 0 ? <EmptyState icon="clipboard" title={tr('Nada pendiente.', 'Nothing pending.')} /> : (
            <ul className="mt-2 divide-y divide-line">
              {leaves.map((l) => (
                <li key={l.id} className="space-y-2 py-3 text-sm">
                  <p className="font-semibold text-fg">{name(l.employee_id)}</p>
                  <p className="text-slate-300">{leaveLabel(l.leave_type, locale)} · {f.date(l.starts_on)}{l.ends_on !== l.starts_on ? ` – ${f.date(l.ends_on)}` : ''}{l.partial_minutes ? ` · ${Math.round(l.partial_minutes / 6) / 10} h` : ''}</p>
                  {l.reason && <p className="text-xs text-muted">“{l.reason}”</p>}
                  {decide(decideLeave, l.id, own(l.employee_id))}
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-5 font-semibold text-fg">{tr('Ausencias aprobadas próximas', 'Upcoming approved leave')}</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {((upcoming ?? []) as { id: string; employee_id: string; leave_type: string; starts_on: string; ends_on: string }[]).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                <span>{name(l.employee_id)} · {leaveLabel(l.leave_type, locale)} · {f.date(l.starts_on)}{l.ends_on !== l.starts_on ? ` – ${f.date(l.ends_on)}` : ''}</span>
                <form action={cancelLeave}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="back" value="/workforce/requests" />
                  <button type="submit" className="btn-secondary btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

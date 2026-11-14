import { PageHeader, EmptyState } from '@/components/ui/page'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import Link from 'next/link'
import { ALERT_ACTIONS, leaveLabel, localTime, punchLabel, wfLabel, wfMessage } from '@/lib/workforce/context'
import { addDays, daysBetween, localDay } from '@/lib/workforce/hours'
import { decideShiftChange, resolveMealAlert } from '@/app/actions/workforce-hr'
import { cancelLeave, decideCorrection, decideLeave } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'

/** Approvals: punch corrections and leave requests waiting for a decision. */
export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; month?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, user, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const today = localDay(new Date(), rules.timezone)
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : today.slice(0, 7)
  const monthStart = `${month}-01`
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 7)}-01`, -1)
  const [{ data: shiftReq }, { data: calData }, { data: alertData }] = await Promise.all([
    supabase.from('shift_change_requests').select('id, employee_id, kind, old_starts_at, old_ends_at, new_starts_at, new_ends_at, reason, requested_by, requested_at').eq('company_id', companyId).eq('status', 'pending').order('requested_at').limit(100),
    supabase.from('leave_requests').select('id, employee_id, leave_type, starts_on, ends_on, status').eq('company_id', companyId).in('status', ['approved', 'pending']).lte('starts_on', monthEnd).gte('ends_on', monthStart).limit(500),
    supabase.from('meal_alerts').select('id, employee_id, kind, due_at, detected_at, acknowledged_at, acknowledged_by, action_taken, note').eq('company_id', companyId).order('detected_at', { ascending: false }).limit(40),
  ])
  const [{ data: corr }, { data: leave }, { data: upcoming }, { data: emps }] = await Promise.all([
    supabase.from('punch_corrections').select('id, employee_id, action, kind, at, reason, requested_by, requested_at').eq('company_id', companyId).eq('status', 'pending').order('requested_at').limit(100),
    supabase.from('leave_requests').select('id, employee_id, leave_type, starts_on, ends_on, partial_minutes, reason, requested_at').eq('company_id', companyId).eq('status', 'pending').order('starts_on').limit(100),
    supabase.from('leave_requests').select('id, employee_id, leave_type, starts_on, ends_on').eq('company_id', companyId).eq('status', 'approved').gte('ends_on', new Date().toISOString().slice(0, 10)).order('starts_on').limit(50),
    supabase.from('employees').select('id, first_name, last_name, user_id').eq('company_id', companyId),
  ])
  const emp = new Map(((emps ?? []) as { id: string; first_name: string; last_name: string; user_id: string | null }[]).map((e) => [e.id, e]))
  const name = (id: string) => { const e = emp.get(id); return e ? `${e.first_name} ${e.last_name}` : '—' }
  const own = (id: string) => emp.get(id)?.user_id === user.id
  const done: Record<string, string> = { approved: tr('Aprobado.', 'Approved.'), rejected: tr('Rechazado.', 'Rejected.'), cancelled: tr('Ausencia cancelada.', 'Leave cancelled.'),
    alert_resolved: tr('Alerta atendida; la acción quedó registrada.', 'Alert handled; the action was recorded.') }
  const shiftChanges = (shiftReq ?? []) as { id: string; employee_id: string; kind: string; old_starts_at: string; old_ends_at: string; new_starts_at: string | null; new_ends_at: string | null; reason: string; requested_by: string; requested_at: string }[]
  const calendar = (calData ?? []) as { id: string; employee_id: string; leave_type: string; starts_on: string; ends_on: string; status: string }[]
  const alerts = (alertData ?? []) as { id: string; employee_id: string; kind: string; due_at: string; detected_at: string; acknowledged_at: string | null; action_taken: string | null; note: string | null }[]
  const span = (a: string, b: string) => `${f.date(localDay(a, rules.timezone))} ${localTime(a, rules.timezone, locale)}–${localTime(b, rules.timezone, locale)}`
  const monthDays = daysBetween(monthStart, monthEnd)
  const prevMonth = addDays(monthStart, -1).slice(0, 7)
  const nextMonth = addDays(monthEnd, 1).slice(0, 7)
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

      <section className="card p-5" aria-labelledby="sc-title" data-testid="shift-change-requests">
        <h2 id="sc-title" className="font-display text-lg font-semibold text-fg">{tr('Cambios de turno', 'Shift changes')} <span className="badge-neutral">{shiftChanges.length}</span></h2>
        {shiftChanges.length === 0 ? <EmptyState icon="clipboard" title={tr('Nada pendiente.', 'Nothing pending.')} /> : (
          <ul className="mt-2 divide-y divide-line">
            {shiftChanges.map((c) => (
              <li key={c.id} className="space-y-2 py-3 text-sm">
                <p className="font-semibold text-fg">{name(c.employee_id)}</p>
                <p className="text-slate-300">{c.kind === 'drop' ? tr('Quitar el turno', 'Drop the shift') : tr('Cambiar el turno', 'Change the shift')} {span(c.old_starts_at, c.old_ends_at)}
                  {c.kind === 'change' && c.new_starts_at && c.new_ends_at ? ` → ${span(c.new_starts_at, c.new_ends_at)}` : ''}</p>
                <p className="text-xs text-muted">“{c.reason}” · {f.dateTime(c.requested_at)}</p>
                {decide(decideShiftChange, c.id, own(c.employee_id))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5" aria-labelledby="cal-title" data-testid="leave-calendar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cal-title" className="font-display text-lg font-semibold text-fg">{tr('Calendario de ausencias', 'Leave calendar')}</h2>
          <nav className="flex items-center gap-2 text-sm">
            <Link className="btn-secondary btn-sm" href={`/workforce/requests?month=${prevMonth}`}>←</Link>
            <span className="font-semibold text-fg">{f.monthLong(month)}</span>
            <Link className="btn-secondary btn-sm" href={`/workforce/requests?month=${nextMonth}`}>→</Link>
          </nav>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {monthDays.map((d) => {
            const on = calendar.filter((l) => l.starts_on <= d && d <= l.ends_on)
            return (
              <div key={d} className={`min-h-16 rounded-lg border p-2 text-xs ${d === today ? 'border-electric/60' : 'border-line'}`}>
                <p className="font-semibold text-slate-300">{f.date(d)}</p>
                {on.map((l) => <p key={l.id} className={l.status === 'approved' ? 'text-accent' : 'text-warning'}>{name(l.employee_id)} · {leaveLabel(l.leave_type, locale)}{l.status === 'pending' ? ` (${tr('pendiente', 'pending')})` : ''}</p>)}
              </div>
            )
          })}
        </div>
      </section>

      <section className="card p-5" aria-labelledby="al-title" data-testid="meal-alerts-history">
        <h2 id="al-title" className="font-display text-lg font-semibold text-fg">{tr('Historial de alertas de comida y descanso', 'Meal and break alert history')}</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {alerts.length === 0 && <li className="py-2 text-muted">{tr('Sin alertas.', 'No alerts.')}</li>}
          {alerts.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-2 lg:flex-row lg:items-center lg:justify-between">
              <span><span className={a.kind === 'missed' ? 'badge-danger' : 'badge-warning'}>{a.kind === 'missed' ? tr('Incumplido', 'Missed') : tr('Se aproxima', 'Approaching')}</span>{' '}
                <strong className="text-fg">{name(a.employee_id)}</strong> · {tr('comida antes de las', 'meal due by')} {localTime(a.due_at, rules.timezone, locale)} · {f.date(localDay(a.due_at, rules.timezone))}
                {a.acknowledged_at && <span className="text-xs text-muted"> · {tr('atendida', 'handled')}{a.action_taken ? `: ${wfLabel(a.action_taken, locale)}` : ''}{a.note ? ` — “${a.note}”` : ''}</span>}</span>
              {!a.acknowledged_at && !own(a.employee_id) && (
                <form action={resolveMealAlert} className="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value="/workforce/requests" />
                  <select name="action" required aria-label={tr('Acción tomada', 'Action taken')} className="field w-48 py-1.5 text-sm">{ALERT_ACTIONS.map((x) => <option key={x} value={x}>{wfLabel(x, locale)}</option>)}</select>
                  <input name="note" maxLength={300} placeholder={tr('Nota', 'Note')} aria-label={tr('Nota', 'Note')} className="field w-36 py-1.5 text-sm" />
                  <button type="submit" className="btn-secondary btn-sm">{tr('Registrar', 'Record')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

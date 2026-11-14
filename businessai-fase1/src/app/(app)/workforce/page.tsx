import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AutoRefresh } from '@/components/auto-refresh'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { attendance, hhmm, localDay, type Punch } from '@/lib/workforce/hours'
import { ALERT_ACTIONS, localTime, nextPunches, punchLabel, stateLabel, wfLabel, wfMessage } from '@/lib/workforce/context'
import { addDays } from '@/lib/workforce/hours'
import { resolveMealAlert } from '@/app/actions/workforce-hr'
import { punchAction } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'

type Emp = { id: string; first_name: string; last_name: string; department_id: string | null; position: string | null }

/** Live panel: who is working, on break or out; late and absent today; pending approvals. */
export default async function WorkforceLivePage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, supabase, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />

  const now = new Date()
  const today = localDay(now, rules.timezone)
  const dayStart = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString()
  const [{ data: empData }, { data: nowData }, { data: punchData }, { data: shiftData }, { data: leaveData }, { count: pendingCorr }, { count: pendingLeave }] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name, department_id, position').eq('company_id', companyId).eq('status', 'active').order('first_name').limit(200),
    supabase.rpc('workforce_now', { target: companyId }),
    supabase.from('time_punches').select('employee_id, kind, at').eq('company_id', companyId).is('voided_at', null).gte('at', dayStart).order('at').limit(5000),
    supabase.from('work_shifts').select('employee_id, starts_at, ends_at, break_minutes').eq('company_id', companyId).gte('ends_at', dayStart).lte('starts_at', new Date(Date.parse(`${today}T23:59:59Z`) + 86_400_000).toISOString()),
    supabase.from('leave_requests').select('employee_id, leave_type, starts_on, ends_on, partial_minutes').eq('company_id', companyId).eq('status', 'approved').lte('starts_on', today).gte('ends_on', today),
    supabase.from('punch_corrections').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending'),
    supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending'),
  ])
  const employees = (empData ?? []) as Emp[]
  // Meal periods (0022): evaluated while this panel is open; kept as history.
  await supabase.rpc('refresh_meal_alerts', { target: companyId })
  const { data: alertData } = await supabase.from('meal_alerts').select('id, employee_id, kind, due_at, detected_at')
    .eq('company_id', companyId).is('acknowledged_at', null).order('detected_at', { ascending: false }).limit(50)
  const mealAlerts = (alertData ?? []) as { id: string; employee_id: string; kind: string; due_at: string; detected_at: string }[]
  // forgotten clock-outs and shifts without a clock-in in the last 7 days (0033)
  const { data: missingData } = await supabase.rpc('wf_missing_punches', { target: companyId, from_day: addDays(today, -7), to_day: today })
  const missing = (missingData ?? []) as { employee_id: string; kind: string; day: string; ref_at: string; shift_id: string | null }[]
  const { data: allEmp } = missing.length ? await supabase.from('employees').select('id, first_name, last_name').in('id', missing.map((m) => m.employee_id)) : { data: [] }
  const anyName = (eid: string) => { const x = ((allEmp ?? []) as Emp[]).find((e) => e.id === eid) ?? employees.find((e) => e.id === eid); return x ? `${x.first_name} ${x.last_name}` : '—' }
  const empName = (eid: string) => { const x = employees.find((e) => e.id === eid); return x ? `${x.first_name} ${x.last_name}` : '—' }
  const stateOf = new Map(((nowData ?? []) as { employee_id: string; state: string; since: string | null }[]).map((r) => [r.employee_id, r]))
  const punches = (punchData ?? []) as (Punch & { employee_id: string })[]
  const shifts = (shiftData ?? []) as { employee_id: string; starts_at: string; ends_at: string; break_minutes: number }[]
  const leaves = (leaveData ?? []) as { employee_id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null }[]

  const rows = employees.map((e) => {
    const a = attendance({
      punches: punches.filter((p) => p.employee_id === e.id), shifts: shifts.filter((s) => s.employee_id === e.id),
      leaves: leaves.filter((l) => l.employee_id === e.id), rules, from: today, to: today, now,
    }).days[0]
    const st = stateOf.get(e.id)
    return { e, day: a, state: st?.state ?? 'out', since: st?.since ?? null }
  })
  const count = (fn: (r: (typeof rows)[number]) => boolean) => rows.filter(fn).length
  const stats = [
    [tr('Trabajando', 'Working'), count((r) => r.state === 'in' || r.state === 'break_end'), 'text-success'],
    [tr('En descanso', 'On break'), count((r) => r.state === 'break_start'), 'text-warning'],
    [tr('Tarde hoy', 'Late today'), count((r) => r.day.lateMinutes > 0), 'text-warning'],
    [tr('Ausentes hoy', 'Absent today'), count((r) => r.day.absent), 'text-danger'],
  ] as const
  const done: Record<string, string> = { punch_in: tr('Entrada registrada.', 'Clocked in.'), punch_out: tr('Salida registrada.', 'Clocked out.'),
    punch_break_start: tr('Descanso iniciado.', 'Break started.'), punch_break_end: tr('Descanso terminado.', 'Break ended.'),
    alert_resolved: tr('Alerta atendida; la acción quedó registrada.', 'Alert handled; the action was recorded.') }

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={30} />
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Panel en vivo', 'Live panel')}
        description={tr('Quién está trabajando ahora. Se actualiza cada 30 segundos.', 'Who is working right now. Refreshes every 30 seconds.')}
        actions={access.manages ? <Link href="/workforce/employees" className="btn-primary">{tr('Nuevo empleado', 'New employee')}</Link> : undefined} />
      <WorkforceNav tr={tr} current="/workforce" manages={access.manages} />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([label, n, tone]) => (
          <div key={label} className="card p-4"><p className="text-xs uppercase tracking-wider text-muted">{label}</p><p className={`mt-1 font-display text-3xl font-semibold tabular-nums ${tone}`}>{n}</p></div>
        ))}
      </div>
      {((pendingCorr ?? 0) + (pendingLeave ?? 0)) > 0 && (
        <Link href="/workforce/requests" className="alert-info block p-4">
          {tr(`${pendingCorr ?? 0} correcciones y ${pendingLeave ?? 0} ausencias esperan aprobación →`, `${pendingCorr ?? 0} corrections and ${pendingLeave ?? 0} leave requests await approval →`)}
        </Link>
      )}

      {missing.length > 0 && (
        <section className="card p-5" aria-labelledby="miss-title" data-testid="missing-punches">
          <h2 id="miss-title" className="font-display text-lg font-semibold text-fg">{tr('Ponches faltantes (últimos 7 días)', 'Missing punches (last 7 days)')} <span className="badge-warning">{missing.length}</span></h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {missing.map((m) => (
              <li key={`${m.kind}-${m.employee_id}-${m.shift_id ?? m.ref_at}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><strong className="text-fg">{anyName(m.employee_id)}</strong> · {m.kind === 'no_clock_out'
                  ? tr(`sin salida desde el ${m.day} ${localTime(m.ref_at, rules.timezone, locale)}`, `no clock-out since ${m.day} ${localTime(m.ref_at, rules.timezone, locale)}`)
                  : tr(`turno del ${m.day} a las ${localTime(m.ref_at, rules.timezone, locale)} sin entrada`, `shift on ${m.day} at ${localTime(m.ref_at, rules.timezone, locale)} without clock-in`)}</span>
                <Link href={`/workforce/employees/${m.employee_id}`} className="btn-secondary btn-sm">{tr('Revisar y corregir', 'Review and correct')}</Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{tr('Los ponches pasados solo se añaden con una corrección aprobada (queda en el historial).', 'Past punches are only added through an approved correction (kept in the history).')}</p>
        </section>
      )}

      {mealAlerts.length > 0 && (
        <section className="card p-5" aria-labelledby="meal-title">
          <h2 id="meal-title" className="font-display text-lg font-semibold text-fg">{tr('Alertas de periodo de comida', 'Meal period alerts')} <span className="badge-warning">{mealAlerts.length}</span></h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {mealAlerts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  <span className={a.kind === 'missed' ? 'badge-danger' : 'badge-warning'}>{a.kind === 'missed' ? tr('Incumplido', 'Missed') : tr('Se aproxima', 'Approaching')}</span>{' '}
                  <strong className="text-fg">{empName(a.employee_id)}</strong> · {tr('comida antes de las', 'meal due by')} {localTime(a.due_at, rules.timezone, locale)}
                </span>
                <form action={resolveMealAlert} className="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value="/workforce" />
                  <select name="action" required aria-label={tr('Acción tomada', 'Action taken')} className="field w-48 py-1.5 text-sm">{ALERT_ACTIONS.map((x) => <option key={x} value={x}>{wfLabel(x, locale)}</option>)}</select>
                  <input name="note" maxLength={300} placeholder={tr('Nota (obligatoria si es "Otro")', 'Note (required for "Other")')} aria-label={tr('Nota', 'Note')} className="field w-44 py-1.5 text-sm" />
                  <button type="submit" className="btn-secondary btn-sm">{tr('Registrar acción', 'Record action')}</button>
                </form>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{tr('Las alertas se evalúan con cada ponche y mientras este panel está abierto (no se envían correos ni notificaciones automáticas: no hay un programador configurado). La acción tomada queda en el historial con quién la registró.',
            'Alerts are evaluated with every punch and while this panel is open (no emails or automatic notifications are sent: no scheduler is configured). The action taken stays in the history with who recorded it.')}</p>
        </section>
      )}

      <section className="card overflow-hidden" aria-labelledby="now-title">
        <h2 id="now-title" className="border-b border-line px-5 py-4 font-display text-lg font-semibold text-fg">{tr('Hoy', 'Today')} · {today}</h2>
        {rows.length === 0 ? (
          <EmptyState icon="users" title={tr('No hay empleados activos a tu cargo.', 'No active employees under you.')} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map(({ e, day, state, since }) => (
              <li key={e.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <Link href={`/workforce/employees/${e.id}`} className="font-semibold text-fg hover:text-blue-400">{e.first_name} {e.last_name}</Link>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className={state === 'break_start' ? 'badge-warning' : state === 'out' ? 'badge-neutral' : 'badge-success'}>{stateLabel(state, locale)}</span>
                    {since && state !== 'out' && <span>{tr('desde', 'since')} {localTime(since, rules.timezone, locale)}</span>}
                    <span>{tr('Hoy', 'Today')} {hhmm(day.workedMinutes)}</span>
                    {day.lateMinutes > 0 && <span className="badge-warning">{tr(`Tarde ${day.lateMinutes} min`, `Late ${day.lateMinutes} min`)}</span>}
                    {day.absent && <span className="badge-danger">{tr('Ausente', 'Absent')}</span>}
                    {day.leave && <span className="badge-accent">{tr('Con permiso', 'On leave')}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {nextPunches(state).map((k) => (
                    <form key={k} action={punchAction}>
                      <input type="hidden" name="employee_id" value={e.id} />
                      <input type="hidden" name="kind" value={k} />
                      <input type="hidden" name="back" value="/workforce" />
                      <SubmitButton variant="primary" pendingLabel="…" className="btn-sm w-auto">{punchLabel(k, locale)}</SubmitButton>
                    </form>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted">{tr('Los ponches que haces aquí quedan registrados como hechos por ti (modo quiosco).', 'Punches made here are recorded as made by you (kiosk mode).')}</p>
    </div>
  )
}

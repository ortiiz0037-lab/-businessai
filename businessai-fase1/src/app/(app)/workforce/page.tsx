import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AutoRefresh } from '@/components/auto-refresh'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { attendance, hhmm, localDay, type Punch } from '@/lib/workforce/hours'
import { localTime, nextPunches, punchLabel, stateLabel, wfMessage } from '@/lib/workforce/context'
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
    punch_break_start: tr('Descanso iniciado.', 'Break started.'), punch_break_end: tr('Descanso terminado.', 'Break ended.') }

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

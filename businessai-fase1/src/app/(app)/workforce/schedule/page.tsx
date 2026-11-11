import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { addDays, daysBetween, hhmm, localDay, weekStart } from '@/lib/workforce/hours'
import { localTime, wfMessage } from '@/lib/workforce/context'
import { createShift, deleteShift } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'

/** Week schedule: shifts per employee and day; add (with repeat) and remove. */
export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const today = localDay(new Date(), rules.timezone)
  const ws = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(params.week ?? '') ? params.week! : today, rules.weekStartsOn)
  const days = daysBetween(ws, addDays(ws, 6))
  const from = new Date(Date.parse(`${addDays(ws, -1)}T00:00:00Z`)).toISOString()
  const to = new Date(Date.parse(`${addDays(ws, 8)}T00:00:00Z`)).toISOString()
  const [{ data: empData }, { data: shiftData }] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).eq('status', 'active').order('first_name').limit(200),
    supabase.from('work_shifts').select('id, employee_id, starts_at, ends_at, break_minutes').eq('company_id', companyId).gte('starts_at', from).lt('starts_at', to).order('starts_at'),
  ])
  const employees = (empData ?? []) as { id: string; first_name: string; last_name: string }[]
  const shifts = (shiftData ?? []) as { id: string; employee_id: string; starts_at: string; ends_at: string; break_minutes: number }[]
  const cell = (emp: string, day: string) => shifts.filter((s) => s.employee_id === emp && localDay(s.starts_at, rules.timezone) === day)
  const back = `/workforce/schedule?week=${ws}`
  const weekly = (emp: string) => shifts.filter((s) => s.employee_id === emp && days.includes(localDay(s.starts_at, rules.timezone)))
    .reduce((n, s) => n + Math.max(0, (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000 - s.break_minutes), 0)
  const dayName = (d: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Horarios y turnos', 'Schedules and shifts')}
        description={tr('Los turnos definen las tardanzas y ausencias de los informes.', 'Shifts define lateness and absences in the reports.')} />
      <WorkforceNav tr={tr} current="/workforce/schedule" manages={access.manages} />
      {params.done && <div role="status" className="alert-success p-4">{params.done === 'shift_deleted' ? tr('Turno eliminado.', 'Shift removed.') : tr('Turno guardado.', 'Shift saved.')}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}

      <div className="flex items-center justify-between gap-3">
        <Link className="btn-secondary btn-sm" href={`/workforce/schedule?week=${addDays(ws, -7)}`}>{tr('← Semana anterior', '← Previous week')}</Link>
        <span className="text-sm font-semibold text-fg">{f.date(ws)} – {f.date(addDays(ws, 6))}</span>
        <Link className="btn-secondary btn-sm" href={`/workforce/schedule?week=${addDays(ws, 7)}`}>{tr('Semana siguiente →', 'Next week →')}</Link>
      </div>

      <section className="card overflow-x-auto" aria-label={tr('Semana', 'Week')}>
        {employees.length === 0 ? <EmptyState icon="users" title={tr('No hay empleados activos a tu cargo.', 'No active employees under you.')} /> : (
          <table className="table-premium min-w-[900px] text-sm">
            <thead><tr><th>{tr('Empleado', 'Employee')}</th>{days.map((d) => <th key={d} className={d === today ? 'text-accent' : ''}>{dayName(d)}</th>)}<th className="text-right">{tr('Total', 'Total')}</th></tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap font-semibold text-fg">{e.first_name} {e.last_name}</td>
                  {days.map((d) => (
                    <td key={d} className="align-top">
                      {cell(e.id, d).map((s) => (
                        <div key={s.id} className="mb-1 flex items-center justify-between gap-1 rounded-lg border border-electric/30 bg-brand/10 px-2 py-1 text-xs">
                          <span>{localTime(s.starts_at, rules.timezone, locale)}–{localTime(s.ends_at, rules.timezone, locale)}</span>
                          <form action={deleteShift}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="back" value={back} />
                            <button type="submit" aria-label={tr('Eliminar turno', 'Remove shift')} className="text-muted hover:text-danger">×</button></form>
                        </div>
                      ))}
                    </td>
                  ))}
                  <td className="text-right tabular-nums">{hhmm(weekly(e.id))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {employees.length > 0 && (
        <section className="card p-5" aria-labelledby="add-title">
          <h2 id="add-title" className="font-display text-lg font-semibold text-fg">{tr('Añadir turno', 'Add shift')}</h2>
          <form action={createShift} className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <input type="hidden" name="back" value={back} />
            <label className="field-label sm:col-span-3 lg:col-span-2">{tr('Empleado', 'Employee')}
              <select name="employee_id" required className="field mt-1">{employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}</select>
            </label>
            <label className="field-label">{tr('Día', 'Day')}<input name="day" type="date" required defaultValue={ws} className="field mt-1" /></label>
            <label className="field-label">{tr('Desde', 'From')}<input name="start" type="time" required defaultValue="08:00" className="field mt-1" /></label>
            <label className="field-label">{tr('Hasta', 'To')}<input name="end" type="time" required defaultValue="17:00" className="field mt-1" /></label>
            <label className="field-label">{tr('Descanso (min)', 'Break (min)')}<input name="break_minutes" type="number" min={0} max={480} defaultValue={60} className="field mt-1" /></label>
            <label className="field-label">{tr('Repetir días', 'Repeat days')}<input name="repeat_days" type="number" min={1} max={14} defaultValue={5} className="field mt-1" /></label>
            <div className="sm:col-span-3 lg:col-span-7"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="sm:w-auto">{tr('Guardar turno', 'Save shift')}</SubmitButton></div>
          </form>
          <p className="mt-2 text-xs text-muted">{tr('Si la hora de fin es menor que la de inicio, el turno termina al día siguiente. Un turno no puede cruzarse con otro del mismo empleado.',
            'If the end time is earlier than the start, the shift ends the next day. A shift cannot overlap another of the same employee.')}</p>
        </section>
      )}
    </div>
  )
}

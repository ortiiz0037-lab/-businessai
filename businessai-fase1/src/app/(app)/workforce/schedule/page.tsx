import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { addDays, daysBetween, hhmm, localDay, weekStart } from '@/lib/workforce/hours'
import { WEEKDAY_NUMBERS, leaveLabel, localTime, weekdayLabel, wfLabel, wfMessage } from '@/lib/workforce/context'
import { createShiftPattern, endShiftPattern, generatePatternShifts } from '@/app/actions/workforce-hr'
import { createShift, deleteShift } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'

/** Week schedule: shifts per employee and day; add (with repeat) and remove. */
export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; done?: string; error?: string; created?: string; conflicts?: string; leave?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const today = localDay(new Date(), rules.timezone)
  const ws = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(params.week ?? '') ? params.week! : today, rules.weekStartsOn)
  const days = daysBetween(ws, addDays(ws, 6))
  const from = new Date(Date.parse(`${addDays(ws, -1)}T00:00:00Z`)).toISOString()
  const to = new Date(Date.parse(`${addDays(ws, 8)}T00:00:00Z`)).toISOString()
  const [{ data: empData }, { data: shiftData }, { data: patternData }, { data: conflictData }] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).eq('status', 'active').order('first_name').limit(200),
    supabase.from('work_shifts').select('id, employee_id, starts_at, ends_at, break_minutes, pattern_id').eq('company_id', companyId).gte('starts_at', from).lt('starts_at', to).order('starts_at'),
    supabase.from('shift_patterns').select('id, employee_id, name, weekdays, start_time, end_time, break_minutes, starts_on, ends_on, status').eq('company_id', companyId).order('status').order('created_at', { ascending: false }).limit(100),
    supabase.rpc('wf_schedule_conflicts', { target: companyId, from_day: ws, to_day: addDays(ws, 27) }),
  ])
  const patterns = (patternData ?? []) as { id: string; employee_id: string; name: string | null; weekdays: number[]; start_time: string; end_time: string; break_minutes: number; starts_on: string; ends_on: string | null; status: string }[]
  const conflicts = (conflictData ?? []) as { kind: string; employee_id: string; shift_id: string | null; starts_at: string; detail: string }[]
  const employees = (empData ?? []) as { id: string; first_name: string; last_name: string }[]
  const shifts = (shiftData ?? []) as { id: string; employee_id: string; starts_at: string; ends_at: string; break_minutes: number; pattern_id: string | null }[]
  const empName = (eid: string) => { const x = employees.find((e) => e.id === eid); return x ? `${x.first_name} ${x.last_name}` : '—' }
  const overnight = (sh: { starts_at: string; ends_at: string }) => localDay(sh.ends_at, rules.timezone) !== localDay(sh.starts_at, rules.timezone)
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
      {params.done && <div role="status" className="alert-success p-4">{({ shift_deleted: tr('Turno eliminado.', 'Shift removed.'), pattern_created: tr('Patrón creado. Genera sus turnos abajo.', 'Pattern created. Generate its shifts below.'),
        pattern_ended: tr('Patrón terminado (los turnos ya creados se conservan).', 'Pattern ended (shifts already created are kept).'),
        generated: tr(`Turnos generados: ${params.created ?? 0}. Omitidos por choque: ${params.conflicts ?? 0}; por ausencia aprobada: ${params.leave ?? 0}.`,
          `Shifts generated: ${params.created ?? 0}. Skipped (overlap): ${params.conflicts ?? 0}; (approved leave): ${params.leave ?? 0}.`) } as Record<string, string>)[params.done] ?? tr('Turno guardado.', 'Shift saved.')}</div>}
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
                          <span>{localTime(s.starts_at, rules.timezone, locale)}–{localTime(s.ends_at, rules.timezone, locale)}{overnight(s) ? ' (+1)' : ''}{s.pattern_id ? ' ↻' : ''}</span>
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


      {conflicts.length > 0 && (
        <section className="card border-warning/40 p-5" aria-labelledby="conf-title" data-testid="schedule-conflicts">
          <h2 id="conf-title" className="font-display text-lg font-semibold text-fg">{tr('Conflictos en las próximas 4 semanas', 'Conflicts in the next 4 weeks')} <span className="badge-warning">{conflicts.length}</span></h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {conflicts.slice(0, 50).map((c, i) => (
              <li key={`${c.kind}-${c.shift_id ?? i}`} className="py-2">
                <strong className="text-fg">{empName(c.employee_id)}</strong> · {c.kind === 'leave' ? tr(`turno el ${f.date(localDay(c.starts_at, rules.timezone))} durante una ausencia aprobada (${leaveLabel(c.detail, locale)})`, `shift on ${f.date(localDay(c.starts_at, rules.timezone))} during approved leave (${leaveLabel(c.detail, locale)})`)
                  : c.kind === 'employee_not_active' ? tr(`turno futuro de un empleado ${wfLabel(c.detail, locale).toLowerCase()}`, `future shift of a ${wfLabel(c.detail, locale).toLowerCase()} employee`)
                  : tr(`semana del ${f.date(c.starts_at.slice(0, 10))}: ${hhmm(Number(c.detail))} programadas, sobre el límite semanal de horas extra`, `week of ${f.date(c.starts_at.slice(0, 10))}: ${hhmm(Number(c.detail))} scheduled, over the weekly overtime threshold`)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {employees.length > 0 && (
        <section className="card p-5" aria-labelledby="pat-title" data-testid="shift-patterns">
          <h2 id="pat-title" className="font-display text-lg font-semibold text-fg">{tr('Turnos recurrentes', 'Recurring shifts')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('Un patrón genera turnos concretos (hasta 93 días por vez). No duplica turnos, y omite los días con otro turno o con una ausencia aprobada.',
            'A pattern generates concrete shifts (up to 93 days at a time). It never duplicates shifts and skips days with another shift or approved leave.')}</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {patterns.length === 0 && <li className="py-2 text-muted">{tr('Sin patrones.', 'No patterns.')}</li>}
            {patterns.map((p) => (
              <li key={p.id} className={`flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between ${p.status === 'ended' ? 'opacity-60' : ''}`}>
                <span><strong className="text-fg">{empName(p.employee_id)}</strong>{p.name ? ` · ${p.name}` : ''} · {[...p.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => weekdayLabel(d, locale)).join(', ')} · {p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}{p.end_time <= p.start_time ? ' (+1)' : ''}
                  <span className="text-xs text-muted"> · {tr('desde', 'from')} {f.date(p.starts_on)}{p.ends_on ? ` ${tr('hasta', 'to')} ${f.date(p.ends_on)}` : ''}{p.status === 'ended' ? ` · ${tr('terminado', 'ended')}` : ''}</span></span>
                {p.status === 'active' && (
                  <span className="flex flex-wrap gap-2">
                    <form action={generatePatternShifts} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                      <input name="from" type="date" required defaultValue={ws > p.starts_on ? ws : p.starts_on} aria-label={tr('Desde', 'From')} className="field w-36 py-1.5 text-sm" />
                      <input name="to" type="date" required defaultValue={addDays(ws, 27)} aria-label={tr('Hasta', 'To')} className="field w-36 py-1.5 text-sm" />
                      <button type="submit" className="btn-primary btn-sm">{tr('Generar turnos', 'Generate shifts')}</button>
                    </form>
                    <form action={endShiftPattern}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Terminar', 'End')}</button></form>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <form action={createShiftPattern} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-6">
            <input type="hidden" name="back" value={back} />
            <label className="field-label sm:col-span-2">{tr('Empleado', 'Employee')}
              <select name="employee_id" required className="field mt-1">{employees.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}</select>
            </label>
            <label className="field-label">{tr('Nombre (opcional)', 'Name (optional)')}<input name="name" maxLength={80} className="field mt-1" /></label>
            <label className="field-label">{tr('Desde', 'From')}<input name="start" type="time" required defaultValue="08:00" className="field mt-1" /></label>
            <label className="field-label">{tr('Hasta', 'To')}<input name="end" type="time" required defaultValue="17:00" className="field mt-1" /></label>
            <label className="field-label">{tr('Descanso (min)', 'Break (min)')}<input name="break_minutes" type="number" min={0} max={480} defaultValue={60} className="field mt-1" /></label>
            <fieldset className="sm:col-span-3 lg:col-span-6"><legend className="field-label">{tr('Días', 'Days')}</legend>
              <div className="mt-1 flex flex-wrap gap-3">{WEEKDAY_NUMBERS.map((d) => (
                <label key={d} className="flex items-center gap-1 text-sm text-slate-300"><input type="checkbox" name="weekdays" value={d} defaultChecked={d >= 1 && d <= 5} /> {weekdayLabel(d, locale)}</label>
              ))}</div>
            </fieldset>
            <label className="field-label">{tr('Vigente desde', 'Valid from')}<input name="starts_on" type="date" required defaultValue={ws} className="field mt-1" /></label>
            <label className="field-label">{tr('Hasta (opcional)', 'Until (optional)')}<input name="ends_on" type="date" className="field mt-1" /></label>
            <div className="flex items-end sm:col-span-1 lg:col-span-4"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="w-auto">{tr('Crear patrón', 'Create pattern')}</SubmitButton></div>
          </form>
          <p className="mt-2 text-xs text-muted">{tr('Si la hora de fin es menor que la de inicio, el turno termina al día siguiente y cuenta según la regla de turnos nocturnos de la empresa.',
            'If the end time is earlier than the start, the shift ends the next day and counts under the company overnight rule.')}</p>
        </section>
      )}
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

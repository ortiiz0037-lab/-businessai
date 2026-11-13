/**
 * Attendance report for a period: one row per employee (and the daily
 * detail), built with the user's session — RLS limits it to the employees
 * the user manages or supervises. Used by /workforce/reports and the CSV
 * export (/api/workforce/report).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '@/lib/supabase/paged'
import { employeeRuleInputs, ruleSets, rulesFor } from '@/lib/workforce/context'
import { addDays, attendance, hhmm, localDay, toCsv, weekStart, type DayRow, type Punch, type Rules, type Totals } from '@/lib/workforce/hours'

export type ReportRow = { id: string; name: string; number: string | null; department: string | null; totals: Totals; days: DayRow[]
  /** punches entered or changed by an approved correction in the period (0020 evidence) */
  correctedPunches: number; voidedPunches: number }

export async function buildReport(supabase: SupabaseClient, input: { companyId: string; from: string; to: string; rules: Rules; department?: string | null; employee?: string | null }) {
  const sets = await ruleSets(supabase, input.companyId)
  const withGroups = sets.length > 0
  let q = supabase.from('employees').select(withGroups ? 'id, first_name, last_name, employee_number, department_id, rule_set_id' : 'id, first_name, last_name, employee_number, department_id')
    .eq('company_id', input.companyId).neq('status', 'terminated')
  if (input.department) q = q.eq('department_id', input.department)
  if (input.employee) q = q.eq('id', input.employee)
  const [{ data: emps }, { data: depts }] = await Promise.all([
    q.order('first_name').limit(500),
    supabase.from('departments').select('id, name').eq('company_id', input.companyId),
  ])
  const employees = (emps ?? []) as unknown as { id: string; first_name: string; last_name: string; employee_number: string | null; department_id: string | null; rule_set_id?: string | null }[]
  const deptName = new Map(((depts ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]))
  const ids = employees.map((e) => e.id)
  if (!ids.length) return [] as ReportRow[]
  // From the start of the week of `from` (weekly overtime needs the whole week).
  const from = new Date(Date.parse(`${addDays(weekStart(input.from, input.rules.weekStartsOn), -1)}T00:00:00Z`)).toISOString()
  const to = new Date(Date.parse(`${addDays(input.to, 2)}T00:00:00Z`)).toISOString()
  const [punchesAll, shifts, leaves, inputs] = await Promise.all([
    fetchAllPages<Punch & { employee_id: string; source: string; voided_at: string | null }>((a, b) => supabase.from('time_punches').select('id, employee_id, kind, at, source, voided_at').in('employee_id', ids)
      .gte('at', from).lt('at', to).order('at').order('id').range(a, b)),
    fetchAllPages<{ employee_id: string; starts_at: string; ends_at: string; break_minutes: number }>((a, b) => supabase.from('work_shifts')
      .select('id, employee_id, starts_at, ends_at, break_minutes').in('employee_id', ids).gte('starts_at', from).lt('starts_at', to).order('id').range(a, b)),
    fetchAllPages<{ employee_id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null }>((a, b) => supabase.from('leave_requests')
      .select('id, employee_id, leave_type, starts_on, ends_on, partial_minutes').in('employee_id', ids).eq('status', 'approved')
      .lte('starts_on', input.to).gte('ends_on', weekStart(input.from, input.rules.weekStartsOn)).order('id').range(a, b)),
    employeeRuleInputs(supabase, input.companyId, ids),
  ])
  const punches = { rows: punchesAll.rows.filter((p) => !p.voided_at) }
  return employees.map((e): ReportRow => {
    const r = attendance({
      punches: punches.rows.filter((p) => p.employee_id === e.id), shifts: shifts.rows.filter((s) => s.employee_id === e.id),
      leaves: leaves.rows.filter((l) => l.employee_id === e.id),
      rules: rulesFor(input.rules, sets.find((x) => x.id === e.rule_set_id), inputs.overrides.get(e.id), inputs.classification.get(e.id)), from: input.from, to: input.to,
    })
    const mine = punchesAll.rows.filter((p) => { const d = localDay(p.at, input.rules.timezone); return p.employee_id === e.id && d >= input.from && d <= input.to })
    return { id: e.id, name: `${e.first_name} ${e.last_name}`, number: e.employee_number, department: e.department_id ? deptName.get(e.department_id) ?? null : null, totals: r.totals, days: r.days,
      correctedPunches: mine.filter((p) => p.source === 'correction' && !p.voided_at).length, voidedPunches: mine.filter((p) => p.voided_at).length }
  })
}

/** CSV: summary per employee, or the daily detail. Spanish or English headers. */
export function reportCsv(rows: ReportRow[], detail: boolean, locale: 'es' | 'en'): string {
  const en = locale === 'en'
  if (!detail) {
    return toCsv([
      en ? ['Employee', 'Number', 'Department', 'Worked', 'Regular', 'Overtime', 'Breaks', 'Scheduled', 'Late days', 'Late minutes', 'Absences', 'Leave days', 'Open sessions', 'Days to review (>16 h)', 'Missed meal periods', 'Corrected punches', 'Voided punches']
         : ['Empleado', 'Número', 'Departamento', 'Trabajado', 'Regular', 'Extra', 'Descansos', 'Programado', 'Días tarde', 'Minutos tarde', 'Ausencias', 'Días de permiso', 'Sesiones abiertas', 'Días a revisar (>16 h)', 'Comidas incumplidas', 'Ponches corregidos', 'Ponches anulados'],
      ...rows.map((r) => [r.name, r.number, r.department, hhmm(r.totals.workedMinutes), hhmm(r.totals.regularMinutes), hhmm(r.totals.overtimeMinutes),
        hhmm(r.totals.breakMinutes), hhmm(r.totals.scheduledMinutes), r.totals.lateDays, r.totals.lateMinutes, r.totals.absences, r.totals.leaveDays, r.totals.openSessions, r.totals.reviewDays, r.totals.mealMissedDays,
        r.correctedPunches, r.voidedPunches]),
      [en ? 'Attendance summary under the configured rules. Not an official payroll and not legal advice.' : 'Resumen de asistencia según las reglas configuradas. No es una nómina oficial ni asesoría legal.'],
    ])
  }
  return toCsv([
    en ? ['Employee', 'Number', 'Department', 'Day', 'First in', 'Last out', 'Worked', 'Regular', 'Overtime', 'Breaks', 'Scheduled', 'Late minutes', 'Absent', 'Leave', 'Open']
       : ['Empleado', 'Número', 'Departamento', 'Día', 'Primera entrada', 'Última salida', 'Trabajado', 'Regular', 'Extra', 'Descansos', 'Programado', 'Minutos tarde', 'Ausente', 'Permiso', 'Abierto'],
    ...rows.flatMap((r) => r.days.map((d) => [r.name, r.number, r.department, d.day, d.firstIn, d.lastOut, hhmm(d.workedMinutes), hhmm(d.regularMinutes),
      hhmm(d.overtimeMinutes), hhmm(d.breakMinutes), hhmm(d.scheduledMinutes), d.lateMinutes, d.absent ? (en ? 'yes' : 'sí') : '', d.leave, d.openSession ? (en ? 'yes' : 'sí') : ''])),
  ])
}

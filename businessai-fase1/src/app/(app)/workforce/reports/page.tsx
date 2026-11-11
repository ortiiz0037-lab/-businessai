import { PageHeader, EmptyState } from '@/components/ui/page'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { hhmm, localDay, periodFor } from '@/lib/workforce/hours'
import { buildReport } from '@/lib/workforce/report'

export const dynamic = 'force-dynamic'
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Attendance report by period, department and employee, with CSV export. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; dept?: string; emp?: string; period?: string }> }) {
  const params = await searchParams
  const { tr, f, supabase, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const today = localDay(new Date(), rules.timezone)
  const preset = periodFor((['week', 'last_week', 'two_weeks', 'month'] as const).find((k) => k === params.period) ?? 'last_week', today, rules.weekStartsOn)
  const from = DAY.test(params.from ?? '') ? params.from! : preset.from
  let to = DAY.test(params.to ?? '') ? params.to! : preset.to
  if (to < from) to = from
  if (Date.parse(to) - Date.parse(from) > 370 * 86_400_000) to = new Date(Date.parse(from) + 370 * 86_400_000).toISOString().slice(0, 10)
  const [{ data: deptData }, { data: empData }] = await Promise.all([
    supabase.from('departments').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).neq('status', 'terminated').order('first_name').limit(500),
  ])
  const depts = (deptData ?? []) as { id: string; name: string }[]
  const emps = (empData ?? []) as { id: string; first_name: string; last_name: string }[]
  const dept = depts.some((d) => d.id === params.dept) ? params.dept! : ''
  const emp = emps.some((e) => e.id === params.emp) ? params.emp! : ''
  const rows = await buildReport(supabase, { companyId, from, to, rules, department: dept || null, employee: emp || null })
  const sum = rows.reduce((t, r) => ({ w: t.w + r.totals.workedMinutes, o: t.o + r.totals.overtimeMinutes, a: t.a + r.totals.absences, l: t.l + r.totals.lateDays }), { w: 0, o: 0, a: 0, l: 0 })
  const qs = new URLSearchParams({ from, to, ...(dept ? { dept } : {}), ...(emp ? { emp } : {}) })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Informes de asistencia', 'Attendance reports')}
        description={tr('Horas regulares, extra, tardanzas y ausencias según las reglas configuradas.', 'Regular hours, overtime, lateness and absences under the configured rules.')} />
      <WorkforceNav tr={tr} current="/workforce/reports" manages={access.manages} />
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="field-label">{tr('Desde', 'From')}<input name="from" type="date" defaultValue={from} className="field mt-1" /></label>
        <label className="field-label">{tr('Hasta', 'To')}<input name="to" type="date" defaultValue={to} className="field mt-1" /></label>
        <label className="field-label">{tr('Departamento', 'Department')}
          <select name="dept" defaultValue={dept} className="field mt-1"><option value="">{tr('Todos', 'All')}</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
        <label className="field-label">{tr('Empleado', 'Employee')}
          <select name="emp" defaultValue={emp} className="field mt-1"><option value="">{tr('Todos', 'All')}</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}</select>
        </label>
        <div className="flex items-end"><button type="submit" className="btn-primary w-full">{tr('Ver informe', 'Show report')}</button></div>
      </form>

      <div className="flex flex-wrap gap-2">
        <a className="btn-secondary btn-sm" href={`/api/workforce/report?${qs}`}>{tr('Exportar resumen (CSV)', 'Export summary (CSV)')}</a>
        <a className="btn-secondary btn-sm" href={`/api/workforce/report?${qs}&detail=1`}>{tr('Exportar detalle diario (CSV)', 'Export daily detail (CSV)')}</a>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[[tr('Horas trabajadas', 'Hours worked'), hhmm(sum.w)], [tr('Horas extra', 'Overtime'), hhmm(sum.o)], [tr('Tardanzas', 'Late days'), String(sum.l)], [tr('Ausencias', 'Absences'), String(sum.a)]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs uppercase tracking-wider text-muted">{l}</p><p className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">{v}</p></div>
        ))}
      </div>

      <section className="card overflow-x-auto" aria-label={tr('Resumen por empleado', 'Summary by employee')}>
        {rows.length === 0 ? <EmptyState icon="users" title={tr('Sin datos para ese periodo.', 'No data for that period.')} /> : (
          <table className="table-premium min-w-[820px] text-sm">
            <thead><tr>
              <th>{tr('Empleado', 'Employee')}</th><th>{tr('Departamento', 'Department')}</th><th className="text-right">{tr('Trabajado', 'Worked')}</th>
              <th className="text-right">{tr('Regular', 'Regular')}</th><th className="text-right">{tr('Extra', 'OT')}</th><th className="text-right">{tr('Programado', 'Scheduled')}</th>
              <th className="text-right">{tr('Tarde', 'Late')}</th><th className="text-right">{tr('Ausencias', 'Absences')}</th><th className="text-right">{tr('Permisos', 'Leave')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/workforce/employees/${r.id}`} className="font-semibold text-fg hover:text-blue-400">{r.name}</a>{r.totals.openSessions > 0 && <span className="badge-warning ml-2">{tr('sin salida', 'missing out')}</span>}</td>
                  <td className="text-muted">{r.department ?? '—'}</td>
                  <td className="text-right tabular-nums">{hhmm(r.totals.workedMinutes)}</td>
                  <td className="text-right tabular-nums">{hhmm(r.totals.regularMinutes)}</td>
                  <td className="text-right tabular-nums">{hhmm(r.totals.overtimeMinutes)}</td>
                  <td className="text-right tabular-nums">{hhmm(r.totals.scheduledMinutes)}</td>
                  <td className="text-right tabular-nums">{r.totals.lateDays}</td>
                  <td className="text-right tabular-nums">{r.totals.absences}</td>
                  <td className="text-right tabular-nums">{r.totals.leaveDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-xs text-muted">
        {tr(`Periodo ${f.date(from)} – ${f.date(to)} en la zona ${rules.timezone}. Horas extra: más de ${rules.dailyOvertimeAfter ? hhmm(rules.dailyOvertimeAfter) : '—'} al día y de ${rules.weeklyOvertimeAfter ? hhmm(rules.weeklyOvertimeAfter) : '—'} a la semana. Para semanas exactas, empieza el periodo el primer día de la semana.`,
          `Period ${f.date(from)} – ${f.date(to)} in ${rules.timezone}. Overtime: over ${rules.dailyOvertimeAfter ? hhmm(rules.dailyOvertimeAfter) : '—'} a day and ${rules.weeklyOvertimeAfter ? hhmm(rules.weeklyOvertimeAfter) : '—'} a week. For exact weeks, start the period on the first day of a week.`)}
      </p>
    </div>
  )
}

import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { addDays, attendance, hhmm, localDay, periodFor, weekStart, type Punch } from '@/lib/workforce/hours'
import { DOC_CATEGORIES, EMPLOYMENT_TYPES, employeeRuleInputs, leaveLabel, localTime, punchLabel, ruleSets, rulesFor, wfLabel, wfMessage } from '@/lib/workforce/context'
import { roleLabel } from '@/lib/team'
import { ruleKeyLabel, ruleValueLabel } from '@/lib/workforce/hr'
import { HrDocumentUploader } from '@/components/workforce/hr-document-uploader'
import { RuleProposals, type Proposal } from '@/components/workforce/rule-proposals'
import { archiveEmployee, proposeEmployeeRules, saveEmployeeContact, setEmployeeStatus, updateEmployeeDocument } from '@/app/actions/workforce-hr'
import { clearEmployeePin, createEmployeeAccess, decideCorrection, requestCorrection, revokeEmployeeAccess, setEmployeePin, updateEmployee } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Emp = {
  id: string; company_id: string; user_id: string | null; employee_number: string | null; first_name: string; last_name: string; email: string | null
  phone: string | null; department_id: string | null; position: string | null; hire_date: string | null; termination_date: string | null
  status: string; pay_type: string; notes: string | null; access_expires_at: string | null
  employment_type?: string; classification?: string; supervisor_user_id?: string | null; status_reason?: string | null; archived_at?: string | null
}
type Doc = { id: string; category: string; title: string; file_name: string; size_bytes: number; visible_to_employee: boolean; created_at: string; archived_at: string | null }
type Contact = { address: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; emergency_contact_relation: string | null }
type P = Punch & { id: string; source: string; recorded_by: string | null; voided_at: string | null; void_reason: string | null }

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string; period?: string; proposal?: string }> }) {
  const { id } = await params
  const query = await searchParams
  const { locale, tr, f, supabase, user, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  if (!UUID.test(id)) redirect('/workforce/employees')
  const { data } = await supabase.from('employees')
    .select('id, company_id, user_id, employee_number, first_name, last_name, email, phone, department_id, position, hire_date, termination_date, status, pay_type, notes, access_expires_at')
    .eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!data) redirect('/workforce/employees?error=employee_not_found')
  // 0033 fields (separate read so the page still works on a database without 0033)
  const { data: hr } = await supabase.from('employees').select('employment_type, classification, supervisor_user_id, status_reason, archived_at').eq('id', id).maybeSingle()
  const emp = { ...(data as Emp), ...((hr ?? {}) as Partial<Emp>) }
  const self = emp.user_id === user.id

  const today = localDay(new Date(), rules.timezone)
  const periodKind = (['week', 'last_week', 'two_weeks', 'month'] as const).find((k) => k === query.period) ?? 'week'
  const period = periodFor(periodKind, today, rules.weekStartsOn)
  const since = new Date(Date.parse(`${addDays(weekStart(period.from, rules.weekStartsOn), -1)}T00:00:00Z`)).toISOString()
  const until = new Date(Date.parse(`${addDays(period.to, 2)}T00:00:00Z`)).toISOString()
  const [{ data: punchData }, { data: shiftData }, { data: leaveData }, { data: corrData }, { data: deptData }, { data: pay }, { data: events }] = await Promise.all([
    supabase.from('time_punches').select('id, kind, at, source, recorded_by, voided_at, void_reason').eq('employee_id', id).gte('at', since).lt('at', until).order('at'),
    supabase.from('work_shifts').select('starts_at, ends_at, break_minutes').eq('employee_id', id).gte('starts_at', since).lt('starts_at', until),
    supabase.from('leave_requests').select('id, leave_type, starts_on, ends_on, partial_minutes, status').eq('employee_id', id).order('starts_on', { ascending: false }).limit(20),
    supabase.from('punch_corrections').select('id, action, kind, at, reason, status, requested_by, requested_at').eq('employee_id', id).order('requested_at', { ascending: false }).limit(20),
    supabase.from('departments').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name'),
    access.manages ? supabase.rpc('employee_pay', { emp: id }) : Promise.resolve({ data: null }),
    supabase.from('workforce_events').select('id, entity, action, details, created_at').eq('employee_id', id).order('created_at', { ascending: false }).limit(25),
  ])
  const sets = access.manages ? await ruleSets(supabase, companyId) : []
  const [{ data: memberData }, { data: contactData }, { data: docData }, ruleInputs, { data: propData }] = await Promise.all([
    access.manages ? supabase.rpc('company_members', { target: companyId }) : Promise.resolve({ data: [] }),
    access.manages ? supabase.from('employee_contacts').select('address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation').eq('employee_id', id).maybeSingle() : Promise.resolve({ data: null }),
    access.manages ? supabase.from('employee_documents').select('id, category, title, file_name, size_bytes, visible_to_employee, created_at, archived_at').eq('employee_id', id).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    employeeRuleInputs(supabase, companyId, [id]),
    access.manages ? supabase.from('labor_rule_changes').select('id, scope, scope_id, changes, note, proposed_at, proposed_by, base_version').eq('scope', 'employee').eq('scope_id', id).eq('status', 'pending') : Promise.resolve({ data: [] }),
  ])
  const team = ((memberData ?? []) as { user_id: string; email: string | null; role: string; status: string }[]).filter((m) => m.status === 'active' && m.user_id !== emp.user_id)
  const memberEmail = (uid: string | null) => (uid ? team.find((m) => m.user_id === uid)?.email ?? uid.slice(0, 8) : '—')
  const contact = (contactData ?? null) as Contact | null
  const docs = (docData ?? []) as Doc[]
  const overrides = ruleInputs.overrides.get(id) ?? null
  const pendingRules = (propData ?? []) as Proposal[]
  const { data: groupRow } = sets.length ? await supabase.from('employees').select('rule_set_id').eq('id', id).maybeSingle() : { data: null }
  const { data: pinData } = await supabase.rpc('employee_pin_status', { emp: id })
  const pin = Array.isArray(pinData) ? (pinData[0] as { pin_set: boolean; set_at: string | null; locked_until: string | null } | undefined) : undefined
  const all = (punchData ?? []) as P[]
  const valid = all.filter((p) => !p.voided_at)
  const leaves = (leaveData ?? []) as { id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null; status: string }[]
  const groupId = (groupRow as { rule_set_id: string | null } | null)?.rule_set_id ?? null
  const effective = rulesFor(rules, sets.find((g) => g.id === groupId), overrides, emp.classification)
  const report = attendance({ punches: valid, shifts: (shiftData ?? []) as never[], leaves: leaves.filter((l) => l.status === 'approved'), rules: effective, from: period.from, to: period.to })
  const corrections = (corrData ?? []) as { id: string; action: string; kind: string | null; at: string | null; reason: string; status: string; requested_by: string; requested_at: string }[]
  const depts = (deptData ?? []) as { id: string; name: string }[]
  const rate = Array.isArray(pay) ? (pay[0] as { hourly_rate: number | null } | undefined)?.hourly_rate ?? null : null
  const link = (await cookies()).get('ba_employee_link')?.value ?? null
  const back = `/workforce/employees/${id}`
  const done: Record<string, string> = {
    created: tr('Empleado creado.', 'Employee created.'), updated: tr('Cambios guardados.', 'Changes saved.'),
    link: tr('Enlace de acceso creado.', 'Access link created.'), unlinked: tr('Acceso del empleado retirado.', 'Employee access removed.'),
    correction_requested: tr('Corrección registrada; queda pendiente de aprobación.', 'Correction recorded; it awaits approval.'),
    approved: tr('Aprobado.', 'Approved.'), rejected: tr('Rechazado.', 'Rejected.'),
    pin_set: tr('PIN guardado.', 'PIN saved.'), pin_cleared: tr('PIN eliminado.', 'PIN removed.'),
    status_active: tr('Empleado activo.', 'Employee active.'), status_suspended: tr('Empleado suspendido: no puede ponchar.', 'Employee suspended: cannot punch.'),
    status_inactive: tr('Empleado inactivo.', 'Employee inactive.'), status_terminated: tr('Baja registrada.', 'Termination recorded.'),
    archived: tr('Empleado archivado. Su historial se conserva.', 'Employee archived. Their history is kept.'), unarchived: tr('Empleado restaurado.', 'Employee restored.'),
    contact_saved: tr('Contacto guardado.', 'Contact saved.'), document_updated: tr('Documento actualizado.', 'Document updated.'), document_archived: tr('Documento archivado.', 'Document archived.'),
    proposed: tr('Excepción propuesta: aplícala abajo para que surta efecto.', 'Exception proposed: apply it below for it to take effect.'), rules_applied: tr('Excepción aplicada.', 'Exception applied.'),
    rules_discarded: tr('Propuesta descartada.', 'Proposal discarded.'),
  }
  const st = (s: string) => ({ pending: tr('Pendiente', 'Pending'), approved: tr('Aprobada', 'Approved'), rejected: tr('Rechazada', 'Rejected'), cancelled: tr('Cancelada', 'Cancelled') } as Record<string, string>)[s] ?? s
  const field = (name: keyof Emp, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field-label">{label}<input name={name} defaultValue={(emp[name] as string | null) ?? ''} disabled={!access.manages} className="field mt-1" {...props} /></label>
  )

  return (
    <div className="space-y-6">
      <Link href="/workforce/employees" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Empleados', '← Employees')}</Link>
      <section className="card-hero p-6 sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{tr('Expediente', 'Employee record')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{emp.first_name} {emp.last_name}</h1>
        <p className="mt-1 text-sm text-white/60">{[emp.position, depts.find((d) => d.id === emp.department_id)?.name, emp.employee_number ? `#${emp.employee_number}` : null].filter(Boolean).join(' · ')}</p>
        <p className="mt-3 flex flex-wrap gap-2" data-testid="employee-badges">
          <span className={emp.status === 'active' ? 'badge-success' : emp.status === 'suspended' ? 'badge-warning' : 'badge-neutral'}>{wfLabel(emp.status, locale)}</span>
          {emp.employment_type && <span className="badge-neutral">{wfLabel(emp.employment_type, locale)}</span>}
          {emp.classification && <span className="badge-neutral">{wfLabel(emp.classification, locale)}</span>}
          {emp.archived_at && <span className="badge-accent">{tr('Archivado', 'Archived')}</span>}
          {emp.supervisor_user_id && access.manages && <span className="badge-neutral">{tr('Supervisor', 'Supervisor')}: {memberEmail(emp.supervisor_user_id)}</span>}
        </p>
        {emp.status_reason && <p className="mt-2 text-xs text-white/60">{tr('Motivo', 'Reason')}: {emp.status_reason}</p>}
      </section>
      <WorkforceNav tr={tr} current="/workforce/employees" manages={access.manages} />
      {query.done && done[query.done] && <div role="status" className="alert-success p-4">{done[query.done]}</div>}
      {query.error && <div role="alert" className="alert-danger p-4">{wfMessage(query.error, locale)}</div>}
      {self && <div className="alert-info p-4">{tr('Este es tu propio expediente: tus correcciones y ausencias las decide otra persona.', 'This is your own record: someone else decides your corrections and leave.')}</div>}

      <section className="card p-5" aria-labelledby="att-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="att-title" className="font-display text-lg font-semibold text-fg">{tr('Asistencia', 'Attendance')} · {f.date(period.from)} – {f.date(period.to)}</h2>
          <nav className="flex flex-wrap gap-2 text-sm">
            {(['week', 'last_week', 'two_weeks', 'month'] as const).map((k) => (
              <Link key={k} href={`${back}?period=${k}`} className={k === periodKind ? 'badge-accent' : 'badge-neutral'}>
                {({ week: tr('Esta semana', 'This week'), last_week: tr('Semana pasada', 'Last week'), two_weeks: tr('2 semanas', '2 weeks'), month: tr('Mes', 'Month') })[k]}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[[tr('Trabajado', 'Worked'), hhmm(report.totals.workedMinutes)], [tr('Regular', 'Regular'), hhmm(report.totals.regularMinutes)],
            [tr('Extra', 'Overtime'), hhmm(report.totals.overtimeMinutes)], [tr('Tardanzas', 'Late days'), String(report.totals.lateDays)],
            [tr('Ausencias', 'Absences'), String(report.totals.absences)]].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-line p-3"><p className="text-xs text-muted">{l}</p><p className="font-display text-xl font-semibold tabular-nums text-fg">{v}</p></div>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="table-premium min-w-[640px] text-sm">
            <thead><tr><th>{tr('Día', 'Day')}</th><th>{tr('Entrada', 'In')}</th><th>{tr('Salida', 'Out')}</th><th className="text-right">{tr('Trabajado', 'Worked')}</th><th className="text-right">{tr('Extra', 'OT')}</th><th>{tr('Notas', 'Notes')}</th></tr></thead>
            <tbody>
              {report.days.filter((d) => d.workedMinutes > 0 || d.absent || d.leave || d.scheduledMinutes > 0).map((d) => (
                <tr key={d.day}>
                  <td className="whitespace-nowrap">{f.date(d.day)}</td>
                  <td>{d.firstIn ? localTime(d.firstIn, rules.timezone, locale) : '—'}</td>
                  <td>{d.lastOut ? localTime(d.lastOut, rules.timezone, locale) : d.openSession ? tr('abierto', 'open') : '—'}</td>
                  <td className="text-right tabular-nums">{hhmm(d.workedMinutes)}</td>
                  <td className="text-right tabular-nums">{hhmm(d.overtimeMinutes)}</td>
                  <td className="space-x-1">{d.lateMinutes > 0 && <span className="badge-warning">{tr(`Tarde ${d.lateMinutes}m`, `Late ${d.lateMinutes}m`)}</span>}{d.absent && <span className="badge-danger">{tr('Ausente', 'Absent')}</span>}{d.leave && <span className="badge-accent">{leaveLabel(d.leave, locale)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="punch-title">
          <h2 id="punch-title" className="font-display text-lg font-semibold text-fg">{tr('Ponches del periodo', 'Punches in the period')}</h2>
          <ul className="mt-2 max-h-96 divide-y divide-line overflow-y-auto text-sm">
            {all.length === 0 && <li className="py-2 text-muted">{tr('Sin ponches.', 'No punches.')}</li>}
            {all.map((p) => (
              <li key={p.id} className={`flex items-center justify-between gap-2 py-2 ${p.voided_at ? 'opacity-50' : ''}`}>
                <span className={p.voided_at ? 'line-through' : ''}>{f.date(localDay(p.at, rules.timezone))} {localTime(p.at, rules.timezone, locale)} · {punchLabel(p.kind, locale)}
                  <span className="text-xs text-muted"> · {p.source === 'self' ? tr('propio', 'self') : p.source === 'supervisor' ? tr('supervisor', 'supervisor') : tr('corrección', 'correction')}</span></span>
                {!p.voided_at && !self && (
                  <form action={requestCorrection} className="flex gap-1">
                    <input type="hidden" name="employee_id" value={id} /><input type="hidden" name="action" value="void" />
                    <input type="hidden" name="punch_id" value={p.id} /><input type="hidden" name="back" value={back} />
                    <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} aria-label={tr('Motivo para anular', 'Reason to void')} className="field w-28 py-1 text-xs" />
                    <button type="submit" className="btn-secondary btn-sm">{tr('Anular', 'Void')}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {!self && (
            <form action={requestCorrection} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-2">
              <input type="hidden" name="employee_id" value={id} /><input type="hidden" name="action" value="add" /><input type="hidden" name="back" value={back} />
              <label className="field-label">{tr('Añadir ponche', 'Add punch')}
                <select name="kind" className="field mt-1">{(['in', 'break_start', 'break_end', 'out'] as const).map((k) => <option key={k} value={k}>{punchLabel(k, locale)}</option>)}</select>
              </label>
              <label className="field-label">{tr('Fecha', 'Date')}<input name="day" type="date" required max={today} defaultValue={today} className="field mt-1" /></label>
              <label className="field-label">{tr('Hora', 'Time')}<input name="time" type="time" required className="field mt-1" /></label>
              <label className="field-label">{tr('Motivo *', 'Reason *')}<input name="reason" required minLength={3} maxLength={300} className="field mt-1" /></label>
              <div className="sm:col-span-2"><SubmitButton pendingLabel="…">{tr('Registrar corrección', 'Record correction')}</SubmitButton></div>
            </form>
          )}
        </section>

        <section className="card p-5" aria-labelledby="corr-title">
          <h2 id="corr-title" className="font-display text-lg font-semibold text-fg">{tr('Correcciones', 'Corrections')}</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {corrections.length === 0 && <li className="py-2 text-muted">{tr('Sin correcciones.', 'No corrections.')}</li>}
            {corrections.map((c) => (
              <li key={c.id} className="space-y-2 py-2">
                <p><span className="font-semibold text-fg">{c.action === 'void' ? tr('Anular ponche', 'Void punch') : `${c.action === 'add' ? tr('Añadir', 'Add') : tr('Cambiar', 'Change')} ${c.kind ? punchLabel(c.kind, locale) : ''}`}</span>
                  {c.at ? ` · ${f.dateTime(c.at)}` : ''} · <span className="text-muted">{st(c.status)}</span></p>
                <p className="text-xs text-muted">{c.reason}{c.requested_by === user.id ? ` · ${tr('pedida por ti', 'requested by you')}` : ''}</p>
                {c.status === 'pending' && !self && (
                  <div className="flex gap-2">
                    {(['approve', 'reject'] as const).map((d) => (
                      <form key={d} action={decideCorrection}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value={d} /><input type="hidden" name="back" value={back} />
                        <button type="submit" className={d === 'approve' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}>{d === 'approve' ? tr('Aprobar', 'Approve') : tr('Rechazar', 'Reject')}</button></form>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <h3 className="mt-5 font-semibold text-fg">{tr('Ausencias', 'Leave')}</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {leaves.length === 0 && <li className="py-2 text-muted">{tr('Sin solicitudes.', 'No requests.')}</li>}
            {leaves.map((l) => <li key={l.id} className="py-2">{leaveLabel(l.leave_type, locale)} · {f.date(l.starts_on)}{l.ends_on !== l.starts_on ? ` – ${f.date(l.ends_on)}` : ''} · <span className="text-muted">{st(l.status)}</span></li>)}
          </ul>
        </section>
      </div>

      {access.manages && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="card p-5" aria-labelledby="edit-title">
            <h2 id="edit-title" className="font-display text-lg font-semibold text-fg">{tr('Datos del empleado', 'Employee details')}</h2>
            <form action={updateEmployee} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={id} />
              {field('first_name', tr('Nombre *', 'First name *'), { required: true, maxLength: 80 })}
              {field('last_name', tr('Apellidos *', 'Last name *'), { required: true, maxLength: 80 })}
              {field('email', tr('Correo', 'Email'), { type: 'email', maxLength: 254 })}
              {field('phone', tr('Teléfono', 'Phone'), { maxLength: 40 })}
              {field('employee_number', tr('Número', 'Number'), { maxLength: 30 })}
              {field('position', tr('Puesto', 'Position'), { maxLength: 80 })}
              <label className="field-label">{tr('Departamento', 'Department')}
                <select name="department_id" defaultValue={emp.department_id ?? ''} className="field mt-1"><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              </label>
              <label className="field-label">{tr('Tipo de empleo', 'Employment type')}
                <select name="employment_type" defaultValue={emp.employment_type ?? 'full_time'} className="field mt-1">
                  {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{wfLabel(t, locale)}</option>)}
                </select>
              </label>
              <label className="field-label">{tr('Clasificación', 'Classification')}
                <select name="classification" defaultValue={emp.classification ?? 'non_exempt'} className="field mt-1">
                  <option value="non_exempt">{wfLabel('non_exempt', locale)}</option><option value="exempt">{wfLabel('exempt', locale)}</option>
                </select>
              </label>
              <label className="field-label sm:col-span-2">{tr('Supervisor directo', 'Direct supervisor')}
                <select name="supervisor_user_id" defaultValue={emp.supervisor_user_id ?? ''} className="field mt-1">
                  <option value="">{tr('Sin supervisor directo (usa el del departamento)', 'No direct supervisor (department supervisor)')}</option>
                  {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.email} · {roleLabel(m.role, locale)}</option>)}
                </select>
              </label>
              {field('hire_date', tr('Ingreso', 'Hire date'), { type: 'date' })}
              {field('termination_date', tr('Fecha de baja', 'Termination date'), { type: 'date' })}
              {sets.length > 0 && (
                <label className="field-label">{tr('Grupo de reglas', 'Rule group')}
                  <select name="rule_set_id" defaultValue={(groupRow as { rule_set_id: string | null } | null)?.rule_set_id ?? ''} className="field mt-1">
                    <option value="">{tr('Valores de la empresa', 'Company defaults')}</option>
                    {sets.filter((g) => !g.archived_at).map((g) => <option key={g.id} value={g.id}>{g.name}{g.exempt ? ` · ${tr('exento', 'exempt')}` : ''}</option>)}
                  </select>
                </label>
              )}
              <label className="field-label">{tr('Pago', 'Pay')}
                <select name="pay_type" defaultValue={emp.pay_type} className="field mt-1"><option value="hourly">{tr('Por hora', 'Hourly')}</option><option value="salary">{tr('Salario', 'Salary')}</option></select>
              </label>
              <label className="field-label">{tr('Tarifa por hora ($)', 'Hourly rate ($)')}<input name="hourly_rate" inputMode="decimal" defaultValue={rate ?? ''} className="field mt-1" /></label>
              <label className="field-label sm:col-span-2">{tr('Notas', 'Notes')}<textarea name="notes" maxLength={2000} rows={3} defaultValue={emp.notes ?? ''} className="field mt-1" /></label>
              <div className="sm:col-span-2"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')}>{tr('Guardar cambios', 'Save changes')}</SubmitButton></div>
            </form>
          </section>

          <section className="card space-y-4 p-5" aria-labelledby="access-title">
            <h2 id="access-title" className="font-display text-lg font-semibold text-fg">{tr('Acceso al reloj ponchador', 'Time clock access')}</h2>
            {emp.user_id ? (
              <>
                <p className="text-sm text-muted">{tr('El empleado tiene una cuenta vinculada y poncha en /clock.', 'The employee has a linked account and punches at /clock.')}</p>
                <form action={revokeEmployeeAccess}><input type="hidden" name="id" value={id} />
                  <button type="submit" className="btn-danger btn-sm">{tr('Retirar acceso', 'Remove access')}</button></form>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{tr('Crea un enlace de un solo uso (7 días). Solo funciona con una cuenta del correo del empleado.', 'Create a one-time link (7 days). It only works with an account of the employee\'s email.')}</p>
                {link && query.done === 'link' && <input readOnly value={link} aria-label={tr('Enlace de acceso', 'Access link')} className="field w-full font-mono text-xs" />}
                <form action={createEmployeeAccess}><input type="hidden" name="id" value={id} />
                  <button type="submit" className="btn-primary btn-sm" disabled={!emp.email}>{tr('Crear enlace de acceso', 'Create access link')}</button></form>
                {!emp.email && <p className="text-xs text-warning">{tr('Añade el correo del empleado primero.', 'Add the employee email first.')}</p>}
              </>
            )}
            <h3 className="pt-2 font-semibold text-fg">{tr('PIN para tabletas', 'Tablet PIN')}</h3>
            <p className="text-sm text-muted">
              {!emp.employee_number ? tr('Asigna un número de empleado para usar el modo PIN.', 'Assign an employee number to use PIN mode.')
                : pin?.pin_set ? tr(`PIN configurado${pin.locked_until ? ' · bloqueado por intentos fallidos' : ''}. Número para la tableta: ${emp.employee_number}.`, `PIN set${pin.locked_until ? ' · locked after failed attempts' : ''}. Tablet number: ${emp.employee_number}.`)
                : tr('Sin PIN. El empleado puede crearlo en su reloj, o puedes asignarlo aquí.', 'No PIN. The employee can create it on their clock, or you can set it here.')}
            </p>
            <form action={setEmployeePin} className="grid grid-cols-2 gap-2" autoComplete="off">
              <input type="hidden" name="employee_id" value={id} /><input type="hidden" name="back" value={back} />
              <input name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="new-password" placeholder={tr('PIN nuevo', 'New PIN')} aria-label={tr('PIN nuevo', 'New PIN')} className="field" />
              <input name="pin_confirm" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="new-password" placeholder={tr('Repetir PIN', 'Repeat PIN')} aria-label={tr('Repetir PIN', 'Repeat PIN')} className="field" />
              <button type="submit" className="btn-secondary btn-sm col-span-2">{pin?.pin_set ? tr('Cambiar PIN (desbloquea)', 'Change PIN (unlocks)') : tr('Asignar PIN', 'Set PIN')}</button>
            </form>
            {pin?.pin_set && (
              <form action={clearEmployeePin}><input type="hidden" name="employee_id" value={id} /><input type="hidden" name="back" value={back} />
                <button type="submit" className="btn-secondary btn-sm">{tr('Eliminar PIN', 'Remove PIN')}</button></form>
            )}
            <h3 className="pt-2 font-semibold text-fg">{tr('Historial de cambios', 'Change history')}</h3>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-slate-400" data-testid="employee-history">
              {((events ?? []) as { id: number; entity: string; action: string; details: Record<string, unknown>; created_at: string }[]).map((e) => {
                const changes = (e.details.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null
                return (
                  <li key={e.id}>{f.dateTime(e.created_at)} · {e.entity} · {e.action}
                    {changes ? ` — ${Object.entries(changes).map(([k, c]) => `${k}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}`
                      : Array.isArray(e.details.fields) ? ` (${(e.details.fields as string[]).join(', ')})` : ''}</li>
                )
              })}
            </ul>
          </section>
        </div>
      )}

      {access.manages && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="card space-y-3 p-5" aria-labelledby="status-title" data-testid="employment-status">
            <h2 id="status-title" className="font-display text-lg font-semibold text-fg">{tr('Estado laboral', 'Employment status')}</h2>
            <p className="text-sm text-muted">{tr('Suspender o dar de baja exige un motivo. Nada se borra: los ponches, solicitudes e historial se conservan.',
              'Suspending or terminating requires a reason. Nothing is deleted: punches, requests and history are kept.')}</p>
            {emp.archived_at ? (
              <form action={archiveEmployee}><input type="hidden" name="id" value={id} /><input type="hidden" name="archive" value="no" />
                <button type="submit" className="btn-secondary btn-sm">{tr('Restaurar del archivo', 'Restore from archive')}</button></form>
            ) : (
              <>
                <form action={setEmployeeStatus} className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <input type="hidden" name="id" value={id} />
                  <select name="status" defaultValue={emp.status} aria-label={tr('Nuevo estado', 'New status')} className="field">
                    {(['active', 'suspended', 'inactive', 'terminated'] as const).map((st2) => <option key={st2} value={st2}>{wfLabel(st2, locale)}</option>)}
                  </select>
                  <input name="reason" maxLength={300} placeholder={tr('Motivo (obligatorio al suspender o dar de baja)', 'Reason (required to suspend or terminate)')} aria-label={tr('Motivo', 'Reason')} className="field" />
                  <button type="submit" className="btn-primary btn-sm">{tr('Cambiar estado', 'Change status')}</button>
                </form>
                {(emp.status === 'inactive' || emp.status === 'terminated') && (
                  <form action={archiveEmployee}><input type="hidden" name="id" value={id} /><input type="hidden" name="archive" value="yes" />
                    <button type="submit" className="btn-secondary btn-sm">{tr('Archivar (ocultar de las listas)', 'Archive (hide from lists)')}</button></form>
                )}
              </>
            )}
            <h3 className="pt-2 font-semibold text-fg">{tr('Contacto privado', 'Private contact')}</h3>
            <p className="text-xs text-muted">{tr('Solo lo ven los administradores y el propio empleado (no los supervisores).', 'Only admins and the employee see it (not supervisors).')}</p>
            <form action={saveEmployeeContact} className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="employee_id" value={id} /><input type="hidden" name="back" value={back} />
              <label className="field-label sm:col-span-2">{tr('Dirección', 'Address')}<input name="address" maxLength={300} defaultValue={contact?.address ?? ''} className="field mt-1" /></label>
              <label className="field-label">{tr('Contacto de emergencia', 'Emergency contact')}<input name="emergency_contact_name" maxLength={120} defaultValue={contact?.emergency_contact_name ?? ''} className="field mt-1" /></label>
              <label className="field-label">{tr('Teléfono de emergencia', 'Emergency phone')}<input name="emergency_contact_phone" maxLength={40} defaultValue={contact?.emergency_contact_phone ?? ''} className="field mt-1" /></label>
              <label className="field-label">{tr('Relación', 'Relationship')}<input name="emergency_contact_relation" maxLength={60} defaultValue={contact?.emergency_contact_relation ?? ''} className="field mt-1" /></label>
              <div className="flex items-end"><SubmitButton pendingLabel="…" className="w-auto">{tr('Guardar contacto', 'Save contact')}</SubmitButton></div>
            </form>
          </section>

          <section className="card space-y-3 p-5" aria-labelledby="docs-title" data-testid="employee-documents">
            <h2 id="docs-title" className="font-display text-lg font-semibold text-fg">{tr('Documentos laborales privados', 'Private labor documents')}</h2>
            <p className="text-xs text-muted">{tr('Archivo privado de la empresa (PDF o imagen, 10 MB). Los supervisores no lo ven. Compártelo con el empleado solo si corresponde. No subas información médica.',
              'Private company file (PDF or image, 10 MB). Supervisors do not see it. Share it with the employee only when appropriate. Do not upload medical information.')}</p>
            <HrDocumentUploader companyId={companyId} employeeId={id} copy={{
              title: tr('Título', 'Title'), category: tr('Tipo', 'Type'), shared: tr('Visible para el empleado', 'Visible to the employee'), choose: tr('Subir documento', 'Upload document'),
              uploading: tr('Subiendo…', 'Uploading…'), done: tr('Documento guardado.', 'Document saved.'), fallback: tr('No se pudo guardar el documento.', 'The document could not be saved.'),
              categories: DOC_CATEGORIES.map((c) => ({ value: c, label: wfLabel(c, locale) })),
              errors: { document_type: wfMessage('document_type', locale)!, forbidden: wfMessage('forbidden', locale)!, document_file_missing: wfMessage('document_file_missing', locale)! },
            }} />
            <ul className="divide-y divide-line text-sm">
              {docs.length === 0 && <li className="py-2 text-muted">{tr('Sin documentos.', 'No documents.')}</li>}
              {docs.map((d) => (
                <li key={d.id} className={`flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between ${d.archived_at ? 'opacity-50' : ''}`}>
                  <span><a href={`/api/workforce/documents/${d.id}`} className="font-semibold text-fg hover:text-blue-400">{d.title}</a>
                    <span className="text-xs text-muted"> · {wfLabel(d.category, locale)} · {f.date(d.created_at.slice(0, 10))}{d.visible_to_employee ? ` · ${tr('compartido', 'shared')}` : ''}{d.archived_at ? ` · ${tr('archivado', 'archived')}` : ''}</span></span>
                  {!d.archived_at && (
                    <span className="flex gap-2">
                      <form action={updateEmployeeDocument}><input type="hidden" name="id" value={d.id} /><input type="hidden" name="employee_id" value={id} />
                        <input type="hidden" name="shared" value={d.visible_to_employee ? 'no' : 'yes'} />
                        <button type="submit" className="btn-secondary btn-sm">{d.visible_to_employee ? tr('Dejar de compartir', 'Stop sharing') : tr('Compartir', 'Share')}</button></form>
                      <form action={updateEmployeeDocument}><input type="hidden" name="id" value={d.id} /><input type="hidden" name="employee_id" value={id} /><input type="hidden" name="archive" value="yes" />
                        <button type="submit" className="btn-secondary btn-sm">{tr('Archivar', 'Archive')}</button></form>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {access.manages && (
        <>
          <RuleProposals tr={tr} locale={locale} proposals={pendingRules} current={() => (overrides ?? {}) as Record<string, unknown>} title={() => tr('Excepciones de este empleado', 'This employee\'s exceptions')}
            back={back} highlight={query.proposal ?? null} who={(uid) => memberEmail(uid)} date={(d) => f.dateTime(d)} />
          <section className="card p-5" aria-labelledby="exc-title" data-testid="rule-exceptions">
            <h2 id="exc-title" className="font-display text-lg font-semibold text-fg">{tr('Reglas de este empleado', 'This employee\'s rules')}</h2>
            <p className="mt-1 text-sm text-muted">
              {tr('Vigentes', 'In effect')}: {effective.exempt ? tr('exento de horas extra', 'overtime exempt')
                : `${tr('extra después de', 'overtime after')} ${ruleValueLabel('daily_overtime_after_minutes', effective.dailyOvertimeAfter, locale)} / ${ruleValueLabel('weekly_overtime_after_minutes', effective.weeklyOvertimeAfter, locale)}`}
              {' · '}{tr('comida antes de', 'meal before')} {ruleValueLabel('meal_break_after_minutes', effective.mealAfterMinutes ?? null, locale)}
              {overrides && Object.keys(overrides).length > 0 && <> · <span className="badge-accent">{tr('con excepciones', 'with exceptions')}: {Object.keys(overrides).map((k) => ruleKeyLabel(k, locale)).join(', ')}</span></>}
            </p>
            <form action={proposeEmployeeRules} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="employee_id" value={id} />
              {([['daily_hours', 'daily_overtime_after_minutes', tr('Extra/día (h)', 'OT/day (h)')], ['weekly_hours', 'weekly_overtime_after_minutes', tr('Extra/semana (h)', 'OT/week (h)')],
                ['meal_after_hours', 'meal_break_after_minutes', tr('Comida antes de (h)', 'Meal before (h)')]] as const).map(([field, key, label]) => {
                const has = overrides ? key in overrides : false
                const val = has ? (overrides as Record<string, number | null>)[key] : undefined
                return (
                  <fieldset key={field} className="space-y-1">
                    <legend className="field-label">{label}</legend>
                    <select name={`${field}_mode`} defaultValue={!has ? 'inherit' : val === null ? 'none' : 'value'} className="field" aria-label={label}>
                      <option value="inherit">{tr('Heredar', 'Inherit')}</option><option value="none">{tr('No aplica', 'Does not apply')}</option><option value="value">{tr('Valor propio', 'Own value')}</option>
                    </select>
                    <input name={field} inputMode="decimal" defaultValue={typeof val === 'number' ? val / 60 : ''} aria-label={`${label} — ${tr('valor', 'value')}`} className="field" />
                  </fieldset>
                )
              })}
              <label className="field-label">{tr('Exento de extras', 'Overtime exempt')}
                <select name="exempt" defaultValue={overrides && 'exempt' in overrides ? (overrides.exempt ? 'yes' : 'no') : 'inherit'} className="field mt-1">
                  <option value="inherit">{tr('Heredar', 'Inherit')}</option><option value="yes">{tr('Sí', 'Yes')}</option><option value="no">{tr('No', 'No')}</option>
                </select></label>
              <label className="field-label sm:col-span-2 lg:col-span-3">{tr('Motivo de la excepción (obligatorio)', 'Reason for the exception (required)')}<input name="reason" required minLength={3} maxLength={300} className="field mt-1" /></label>
              <div className="flex items-end"><SubmitButton pendingLabel="…" className="w-auto">{tr('Proponer excepción', 'Propose exception')}</SubmitButton></div>
            </form>
            <p className="mt-2 text-xs text-muted">{tr('La excepción no surte efecto hasta que se aplica. Referencia configurable; no es asesoría legal.', 'The exception takes effect only once applied. Configurable reference; not legal advice.')}</p>
          </section>
        </>
      )}
    </div>
  )
}

import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { addDays, attendance, hhmm, localDay, periodFor, weekStart, type Punch } from '@/lib/workforce/hours'
import { leaveLabel, localTime, punchLabel, ruleSets, wfMessage } from '@/lib/workforce/context'
import { clearEmployeePin, createEmployeeAccess, decideCorrection, requestCorrection, revokeEmployeeAccess, setEmployeePin, updateEmployee } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Emp = {
  id: string; company_id: string; user_id: string | null; employee_number: string | null; first_name: string; last_name: string; email: string | null
  phone: string | null; department_id: string | null; position: string | null; hire_date: string | null; termination_date: string | null
  status: string; pay_type: string; notes: string | null; access_expires_at: string | null
}
type P = Punch & { id: string; source: string; recorded_by: string | null; voided_at: string | null; void_reason: string | null }

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string; period?: string }> }) {
  const { id } = await params
  const query = await searchParams
  const { locale, tr, f, supabase, user, companyId, access, rules, allowed } = await workforcePage()
  if (!allowed) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  if (!UUID.test(id)) redirect('/workforce/employees')
  const { data } = await supabase.from('employees')
    .select('id, company_id, user_id, employee_number, first_name, last_name, email, phone, department_id, position, hire_date, termination_date, status, pay_type, notes, access_expires_at')
    .eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!data) redirect('/workforce/employees?error=employee_not_found')
  const emp = data as Emp
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
  const { data: groupRow } = sets.length ? await supabase.from('employees').select('rule_set_id').eq('id', id).maybeSingle() : { data: null }
  const { data: pinData } = await supabase.rpc('employee_pin_status', { emp: id })
  const pin = Array.isArray(pinData) ? (pinData[0] as { pin_set: boolean; set_at: string | null; locked_until: string | null } | undefined) : undefined
  const all = (punchData ?? []) as P[]
  const valid = all.filter((p) => !p.voided_at)
  const leaves = (leaveData ?? []) as { id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null; status: string }[]
  const report = attendance({ punches: valid, shifts: (shiftData ?? []) as never[], leaves: leaves.filter((l) => l.status === 'approved'), rules, from: period.from, to: period.to })
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
              <label className="field-label">{tr('Estado', 'Status')}
                <select name="status" defaultValue={emp.status} className="field mt-1">
                  <option value="active">{tr('Activo', 'Active')}</option><option value="inactive">{tr('Inactivo', 'Inactive')}</option><option value="terminated">{tr('Baja', 'Terminated')}</option>
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
            <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-slate-400">
              {((events ?? []) as { id: number; entity: string; action: string; details: Record<string, unknown>; created_at: string }[]).map((e) => (
                <li key={e.id}>{f.dateTime(e.created_at)} · {e.entity} · {e.action}{Array.isArray(e.details.fields) ? ` (${(e.details.fields as string[]).join(', ')})` : ''}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
}

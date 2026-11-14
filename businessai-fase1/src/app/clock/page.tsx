import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatters } from '@/lib/i18n/app'
import { Brand } from '@/components/ui/brand'
import { SubmitButton } from '@/components/submit-button'
import { HtmlLang } from '@/components/html-lang'
import { attendance, hhmm, localDay, weekStart, addDays } from '@/lib/workforce/hours'
import { LEAVE_TYPES, employeeRuleInputs, leaveLabel, localTime, nextPunches, punchLabel, ruleSets, rulesFor, stateLabel, wfLabel, wfMessage, workforceRules } from '@/lib/workforce/context'
import { cancelCorrection, cancelLeave, punchAction, requestCorrection, requestLeave, setEmployeePin } from '@/app/actions/workforce'
import { cancelShiftChange, requestShiftChange, saveEmployeeContact } from '@/app/actions/workforce-hr'
import { signOut } from '@/app/actions/auth'

export const dynamic = 'force-dynamic'

type Emp = { id: string; company_id: string; first_name: string; last_name: string; status: string; position: string | null }
type P = { id: string; kind: 'in' | 'out' | 'break_start' | 'break_end'; at: string; source: string; voided_at: string | null }

/** The employee's own time clock: punch, today, this week, requests. */
export default async function ClockPage({ searchParams }: { searchParams: Promise<{ e?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/clock')

  const { data: mine, error: empError } = await supabase.from('employees')
    .select('id, company_id, first_name, last_name, status, position').eq('user_id', user.id).neq('status', 'terminated')
  const employees = (mine ?? []) as Emp[]
  const emp = employees.find((x) => x.id === params.e) ?? employees[0]

  if (empError || !emp) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
        <HtmlLang locale={locale} />
        <div className="card p-8 text-center">
          <Brand />
          <h1 className="mt-6 font-display text-2xl font-semibold text-fg">{tr('No tienes un reloj ponchador asignado', 'You have no time clock assigned')}</h1>
          <p className="mt-2 text-sm text-muted">{tr('Pide a tu empresa el enlace de acceso para empleados y ábrelo con esta cuenta.', 'Ask your company for the employee access link and open it with this account.')}</p>
          <Link href="/dashboard" className="btn-secondary mt-6">{tr('Ir al panel de la empresa', 'Go to the company dashboard')}</Link>
        </div>
      </main>
    )
  }

  const companyRules = await workforceRules(supabase, emp.company_id)
  // the employee's own rules: exceptions > classification > group > company (the employee may read its own group and exceptions)
  const [sets, inputs, { data: grp }] = await Promise.all([ruleSets(supabase, emp.company_id), employeeRuleInputs(supabase, emp.company_id, [emp.id]),
    supabase.from('employees').select('rule_set_id').eq('id', emp.id).maybeSingle()])
  const rules = rulesFor(companyRules, sets.find((g) => g.id === (grp as { rule_set_id: string | null } | null)?.rule_set_id), inputs.overrides.get(emp.id), inputs.classification.get(emp.id))
  const now = new Date()
  const today = localDay(now, rules.timezone)
  const ws = weekStart(today, rules.weekStartsOn)
  const since = new Date(Date.parse(`${addDays(ws, -1)}T00:00:00Z`)).toISOString()
  const [{ data: punchData }, { data: shiftData }, { data: leaveData }, { data: corrData }, { data: company }] = await Promise.all([
    supabase.from('time_punches').select('id, kind, at, source, voided_at').eq('employee_id', emp.id).gte('at', since).order('at'),
    supabase.from('work_shifts').select('id, starts_at, ends_at, break_minutes').eq('employee_id', emp.id).gte('ends_at', since).order('starts_at').limit(60),
    supabase.from('leave_requests').select('id, leave_type, starts_on, ends_on, partial_minutes, status, reason').eq('employee_id', emp.id).order('starts_on', { ascending: false }).limit(20),
    supabase.from('punch_corrections').select('id, action, kind, at, reason, status, requested_at, decision_note').eq('employee_id', emp.id).order('requested_at', { ascending: false }).limit(10),
    supabase.from('companies').select('name').eq('id', emp.company_id).maybeSingle(),
  ])
  const punches = ((punchData ?? []) as P[]).filter((p) => !p.voided_at)
  const state = punches.at(-1)?.kind ?? 'out'
  const next = emp.status === 'active' ? nextPunches(state) : []
  const shifts = (shiftData ?? []) as { id: string; starts_at: string; ends_at: string; break_minutes: number }[]
  // 0033: own alerts, shift change requests, shared documents, own private contact
  const [{ data: myAlerts }, { data: myChanges }, { data: myDocs }, { data: myContact }] = await Promise.all([
    supabase.from('meal_alerts').select('id, kind, due_at, acknowledged_at, action_taken').eq('employee_id', emp.id).order('detected_at', { ascending: false }).limit(10),
    supabase.from('shift_change_requests').select('id, shift_id, kind, old_starts_at, new_starts_at, new_ends_at, status, decision_note').eq('employee_id', emp.id).order('requested_at', { ascending: false }).limit(10),
    supabase.from('employee_documents').select('id, title, category, created_at').eq('employee_id', emp.id).order('created_at', { ascending: false }),
    supabase.from('employee_contacts').select('address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation').eq('employee_id', emp.id).maybeSingle(),
  ])
  const alerts = (myAlerts ?? []) as { id: string; kind: string; due_at: string; acknowledged_at: string | null; action_taken: string | null }[]
  const changes = (myChanges ?? []) as { id: string; shift_id: string | null; kind: string; old_starts_at: string; new_starts_at: string | null; new_ends_at: string | null; status: string; decision_note: string | null }[]
  const docs = (myDocs ?? []) as { id: string; title: string; category: string; created_at: string }[]
  const contact = (myContact ?? null) as { address: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; emergency_contact_relation: string | null } | null
  // payroll (0034): the employee's own pay stubs of approved / paid runs (RLS)
  const { data: myPay } = await supabase.from('payroll_lines').select('id, run_id, net_cents, gross_cents').eq('employee_id', emp.id).order('created_at', { ascending: false }).limit(12)
  const payRuns = (myPay ?? []).length
    ? ((await supabase.from('payroll_runs').select('id, period_start, period_end, status').in('id', ((myPay ?? []) as { run_id: string }[]).map((x) => x.run_id))).data ?? []) as { id: string; period_start: string; period_end: string; status: string }[]
    : []
  const stubs = ((myPay ?? []) as { id: string; run_id: string; net_cents: string; gross_cents: string }[]).map((l) => ({ ...l, run: payRuns.find((r) => r.id === l.run_id) })).filter((l) => l.run)
  const pendingShift = new Set(changes.filter((c) => c.status === 'pending' && c.shift_id).map((c) => c.shift_id as string))
  const leaves = (leaveData ?? []) as { id: string; leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null; status: string; reason: string | null }[]
  const week = attendance({ punches, shifts, leaves: leaves.filter((l) => l.status === 'approved'), rules, from: ws, to: addDays(ws, 6), now })
  const todayRow = week.days.find((d) => d.day === today)
  const todayPunches = punches.filter((p) => localDay(p.at, rules.timezone) === today)
  const upcoming = shifts.filter((s) => Date.parse(s.ends_at) >= now.getTime()).slice(0, 5)
  const corrections = (corrData ?? []) as { id: string; action: string; kind: string | null; at: string | null; reason: string; status: string; decision_note: string | null }[]
  const back = `/clock${employees.length > 1 ? `?e=${emp.id}` : ''}`
  const statusText = (s: string) => ({ pending: tr('Pendiente', 'Pending'), approved: tr('Aprobada', 'Approved'), rejected: tr('Rechazada', 'Rejected'), cancelled: tr('Cancelada', 'Cancelled') } as Record<string, string>)[s] ?? s
  const done: Record<string, string> = {
    punch_in: tr('Entrada registrada.', 'Clocked in.'), punch_out: tr('Salida registrada.', 'Clocked out.'),
    punch_break_start: tr('Descanso iniciado.', 'Break started.'), punch_break_end: tr('Descanso terminado.', 'Break ended.'),
    correction_requested: tr('Corrección enviada a tu supervisor.', 'Correction sent to your supervisor.'),
    leave_requested: tr('Solicitud enviada a tu supervisor.', 'Request sent to your supervisor.'),
    cancelled: tr('Solicitud cancelada.', 'Request cancelled.'), pin_set: tr('Tu PIN quedó guardado.', 'Your PIN was saved.'),
    shift_change_requested: tr('Solicitud de cambio de turno enviada a tu supervisor.', 'Shift change request sent to your supervisor.'), contact_saved: tr('Contacto de emergencia guardado.', 'Emergency contact saved.'), linked: tr('Tu cuenta quedó vinculada. Ya puedes ponchar.', 'Your account is linked. You can punch now.'),
  }
  const big: Record<string, string> = { in: 'btn-accent', out: 'btn-danger', break_start: 'btn-secondary', break_end: 'btn-primary' }

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:py-10">
      <HtmlLang locale={locale} />
      <header className="flex items-center justify-between gap-3">
        <Brand />
        <form action={signOut}><button className="btn-secondary btn-sm" type="submit">{tr('Salir', 'Sign out')}</button></form>
      </header>

      <section className="card-hero p-6 sm:p-8" aria-labelledby="clock-title">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{company?.name ?? ''}</p>
        <h1 id="clock-title" className="mt-2 font-display text-2xl font-semibold sm:text-3xl">{emp.first_name} {emp.last_name}</h1>
        <p className="mt-1 text-sm text-white/60">{stateLabel(state, locale)}{punches.at(-1) && state !== 'out' ? ` · ${tr('desde', 'since')} ${localTime(punches.at(-1)!.at, rules.timezone, locale)}` : ''}</p>
        {employees.length > 1 && (
          <nav className="mt-3 flex flex-wrap gap-2" aria-label={tr('Empresa', 'Company')}>
            {employees.map((x) => <Link key={x.id} href={`/clock?e=${x.id}`} className={x.id === emp.id ? 'badge-accent' : 'badge-neutral'}>{x.first_name} · {x.company_id.slice(0, 4)}</Link>)}
          </nav>
        )}
        {params.done && done[params.done] && <p role="status" className="alert-success mt-4 p-3 text-sm">{done[params.done]}</p>}
        {params.error && <p role="alert" className="alert-danger mt-4 p-3 text-sm">{wfMessage(params.error, locale)}</p>}
        <div className={`mt-6 grid gap-3 ${next.length > 1 ? 'sm:grid-cols-2' : ''}`}>
          {next.map((k) => (
            <form key={k} action={punchAction}>
              <input type="hidden" name="employee_id" value={emp.id} />
              <input type="hidden" name="kind" value={k} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton pendingLabel={tr('Registrando…', 'Recording…')} className={`w-full py-6 text-lg ${big[k]}`}>{punchLabel(k, locale)}</SubmitButton>
            </form>
          ))}
          {next.length === 0 && <p className="alert-warning p-3 text-sm">{tr('Tu ficha no está activa: no puedes ponchar.', 'Your record is not active: you cannot punch.')}</p>}
        </div>
        <p className="mt-3 text-xs text-white/50">{tr('La hora la registra el sistema al pulsar; no se puede cambiar desde el teléfono.', 'The system records the time when you tap; it cannot be changed from the phone.')}</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          [tr('Hoy', 'Today'), hhmm(todayRow?.workedMinutes ?? 0)],
          [tr('Semana', 'Week'), hhmm(week.totals.workedMinutes)],
          [tr('Horas extra', 'Overtime'), hhmm(week.totals.overtimeMinutes)],
          [tr('Descansos hoy', 'Breaks today'), hhmm(todayRow?.breakMinutes ?? 0)],
        ].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs uppercase tracking-wider text-muted">{l}</p><p className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">{v}</p></div>
        ))}
      </section>

      <section className="card p-5" aria-labelledby="today-title">
        <h2 id="today-title" className="font-display text-lg font-semibold text-fg">{tr('Ponches de hoy', 'Today\'s punches')}</h2>
        {todayPunches.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Todavía no hay ponches hoy.', 'No punches today yet.')}</p> : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {todayPunches.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span className="text-slate-300">{punchLabel(p.kind, locale)}{p.source !== 'self' ? ` · ${p.source === 'supervisor' ? tr('por supervisor', 'by supervisor') : tr('corrección', 'correction')}` : ''}</span>
                <span className="font-semibold tabular-nums text-fg">{localTime(p.at, rules.timezone, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card p-5">
        <summary className="cursor-pointer font-display text-lg font-semibold text-fg">{tr('Mi PIN para la tableta de la empresa', 'My PIN for the company tablet')}</summary>
        <p className="mt-2 text-xs text-muted">{tr('Con tu número de empleado y este PIN puedes ponchar en la tableta compartida. No lo compartas. Exactamente 6 dígitos; no se aceptan PIN fáciles como 123456.',
          'With your employee number and this PIN you can punch on the shared tablet. Do not share it. Exactly 6 digits; easy PINs like 123456 are refused.')}</p>
        <form action={setEmployeePin} className="mt-3 grid grid-cols-2 gap-2" autoComplete="off">
          <input type="hidden" name="employee_id" value={emp.id} /><input type="hidden" name="back" value={back} />
          <input name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="new-password" placeholder="PIN" aria-label="PIN" className="field" />
          <input name="pin_confirm" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="new-password" placeholder={tr('Repetir', 'Repeat')} aria-label={tr('Repetir PIN', 'Repeat PIN')} className="field" />
          <div className="col-span-2"><SubmitButton pendingLabel="…">{tr('Guardar PIN', 'Save PIN')}</SubmitButton></div>
        </form>
      </details>

      {upcoming.length > 0 && (
        <section className="card p-5" aria-labelledby="sched-title">
          <h2 id="sched-title" className="font-display text-lg font-semibold text-fg">{tr('Próximos turnos', 'Upcoming shifts')}</h2>
          <ul className="mt-2 divide-y divide-line text-sm text-slate-300">
            {upcoming.map((s) => (
              <li key={s.id} className="py-2">
                <p>{f.date(localDay(s.starts_at, rules.timezone))} · {localTime(s.starts_at, rules.timezone, locale)}–{localTime(s.ends_at, rules.timezone, locale)}</p>
                {Date.parse(s.starts_at) > now.getTime() && (pendingShift.has(s.id)
                  ? <p className="text-xs text-warning">{tr('Cambio solicitado: pendiente de tu supervisor.', 'Change requested: pending your supervisor.')}</p>
                  : (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-blue-400">{tr('Pedir un cambio de este turno', 'Request a change to this shift')}</summary>
                      <form action={requestShiftChange} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <input type="hidden" name="shift_id" value={s.id} /><input type="hidden" name="back" value={back} />
                        <label className="field-label col-span-2 sm:col-span-1">{tr('Pedido', 'Request')}
                          <select name="kind" className="field mt-1"><option value="change">{tr('Cambiar horas', 'Change times')}</option><option value="drop">{tr('Quitar el turno', 'Drop the shift')}</option></select></label>
                        <label className="field-label">{tr('Día', 'Day')}<input name="day" type="date" defaultValue={localDay(s.starts_at, rules.timezone)} className="field mt-1" /></label>
                        <label className="field-label">{tr('Desde', 'From')}<input name="start" type="time" className="field mt-1" /></label>
                        <label className="field-label">{tr('Hasta', 'To')}<input name="end" type="time" className="field mt-1" /></label>
                        <label className="field-label col-span-2 sm:col-span-3">{tr('Motivo *', 'Reason *')}<input name="reason" required minLength={3} maxLength={300} className="field mt-1" /></label>
                        <div className="col-span-2 flex items-end sm:col-span-1"><SubmitButton pendingLabel="…" className="w-auto">{tr('Enviar', 'Send')}</SubmitButton></div>
                      </form>
                    </details>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}


      {(alerts.length > 0 || changes.length > 0) && (
        <div className="grid gap-5 md:grid-cols-2">
          <section className="card p-5" aria-labelledby="my-alerts-title" data-testid="my-alerts">
            <h2 id="my-alerts-title" className="font-display text-lg font-semibold text-fg">{tr('Mis alertas de comida', 'My meal alerts')}</h2>
            <ul className="mt-2 divide-y divide-line text-sm">
              {alerts.length === 0 && <li className="py-2 text-muted">{tr('Sin alertas.', 'No alerts.')}</li>}
              {alerts.map((a) => (
                <li key={a.id} className="py-2 text-slate-300">
                  <span className={a.kind === 'missed' ? 'badge-danger' : 'badge-warning'}>{a.kind === 'missed' ? tr('Incumplido', 'Missed') : tr('Se aproxima', 'Approaching')}</span>{' '}
                  {tr('comida antes de las', 'meal due by')} {localTime(a.due_at, rules.timezone, locale)} · {f.date(localDay(a.due_at, rules.timezone))}
                  {a.acknowledged_at && <span className="text-xs text-muted"> · {tr('atendida', 'handled')}{a.action_taken ? `: ${wfLabel(a.action_taken, locale)}` : ''}</span>}
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-5" aria-labelledby="my-changes-title" data-testid="my-shift-changes">
            <h2 id="my-changes-title" className="font-display text-lg font-semibold text-fg">{tr('Mis cambios de turno', 'My shift changes')}</h2>
            <ul className="mt-2 divide-y divide-line text-sm">
              {changes.length === 0 && <li className="py-2 text-muted">{tr('Sin solicitudes.', 'No requests.')}</li>}
              {changes.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-slate-300">{c.kind === 'drop' ? tr('Quitar', 'Drop') : tr('Cambiar', 'Change')} · {f.date(localDay(c.old_starts_at, rules.timezone))} {localTime(c.old_starts_at, rules.timezone, locale)}
                    {c.new_starts_at && c.new_ends_at ? ` → ${localTime(c.new_starts_at, rules.timezone, locale)}–${localTime(c.new_ends_at, rules.timezone, locale)}` : ''} · <span className="text-muted">{statusText(c.status)}</span>
                    {c.decision_note && <span className="block text-xs text-muted">“{c.decision_note}”</span>}</span>
                  {c.status === 'pending' && (
                    <form action={cancelShiftChange}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {stubs.length > 0 && (
        <section className="card p-5" aria-labelledby="my-pay-title" data-testid="my-payslips">
          <h2 id="my-pay-title" className="font-display text-lg font-semibold text-fg">{tr('Mis recibos de nómina', 'My pay stubs')}</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {stubs.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-slate-300">{f.date(l.run!.period_start)} – {f.date(l.run!.period_end)}</span>
                <a href={`/api/payroll/payslips/${l.id}`} className="font-semibold text-blue-400">{tr('Ver recibo (PDF)', 'View pay stub (PDF)')}</a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{tr('Impuestos y retenciones no calculados por BusinessAI.', 'Taxes and withholdings are not calculated by BusinessAI.')}</p>
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <section className="card p-5" aria-labelledby="my-docs-title" data-testid="my-documents">
          <h2 id="my-docs-title" className="font-display text-lg font-semibold text-fg">{tr('Mis documentos', 'My documents')}</h2>
          <p className="mt-1 text-xs text-muted">{tr('Documentos laborales que tu empresa compartió contigo.', 'Labor documents your company shared with you.')}</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {docs.length === 0 && <li className="py-2 text-muted">{tr('No hay documentos compartidos.', 'No shared documents.')}</li>}
            {docs.map((d) => <li key={d.id} className="py-2"><a href={`/api/workforce/documents/${d.id}`} className="font-semibold text-fg hover:text-blue-400">{d.title}</a> <span className="text-xs text-muted">· {wfLabel(d.category, locale)}</span></li>)}
          </ul>
        </section>
        <details className="card p-5" data-testid="my-contact">
          <summary className="cursor-pointer font-display text-lg font-semibold text-fg">{tr('Mi contacto de emergencia', 'My emergency contact')}</summary>
          <p className="mt-2 text-xs text-muted">{tr('Solo lo ven tú y los administradores de la empresa.', 'Only you and the company admins see it.')}</p>
          <form action={saveEmployeeContact} className="mt-3 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="employee_id" value={emp.id} /><input type="hidden" name="back" value={back} />
            <label className="field-label sm:col-span-2">{tr('Dirección', 'Address')}<input name="address" maxLength={300} defaultValue={contact?.address ?? ''} className="field mt-1" /></label>
            <label className="field-label">{tr('Nombre', 'Name')}<input name="emergency_contact_name" maxLength={120} defaultValue={contact?.emergency_contact_name ?? ''} className="field mt-1" /></label>
            <label className="field-label">{tr('Teléfono', 'Phone')}<input name="emergency_contact_phone" maxLength={40} defaultValue={contact?.emergency_contact_phone ?? ''} className="field mt-1" /></label>
            <label className="field-label">{tr('Relación', 'Relationship')}<input name="emergency_contact_relation" maxLength={60} defaultValue={contact?.emergency_contact_relation ?? ''} className="field mt-1" /></label>
            <div className="flex items-end"><SubmitButton pendingLabel="…" className="w-auto">{tr('Guardar', 'Save')}</SubmitButton></div>
          </form>
        </details>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <section className="card p-5" aria-labelledby="corr-title">
          <h2 id="corr-title" className="font-display text-lg font-semibold text-fg">{tr('Corregir un ponche', 'Correct a punch')}</h2>
          <p className="mt-1 text-xs text-muted">{tr('Tu supervisor debe aprobarlo. Queda registrado quién lo pidió y quién lo aprobó.', 'Your supervisor must approve it. Who asked and who approved are recorded.')}</p>
          <form action={requestCorrection} className="mt-3 space-y-3">
            <input type="hidden" name="employee_id" value={emp.id} />
            <input type="hidden" name="action" value="add" />
            <input type="hidden" name="back" value={back} />
            <label className="field-label">{tr('Ponche que falta', 'Missing punch')}
              <select name="kind" className="field mt-1" defaultValue="out">
                {(['in', 'break_start', 'break_end', 'out'] as const).map((k) => <option key={k} value={k}>{punchLabel(k, locale)}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="field-label">{tr('Fecha', 'Date')}<input name="day" type="date" required max={today} defaultValue={today} className="field mt-1" /></label>
              <label className="field-label">{tr('Hora', 'Time')}<input name="time" type="time" required className="field mt-1" /></label>
            </div>
            <label className="field-label">{tr('Motivo *', 'Reason *')}<input name="reason" required minLength={3} maxLength={300} className="field mt-1" /></label>
            <SubmitButton pendingLabel={tr('Enviando…', 'Sending…')}>{tr('Enviar corrección', 'Send correction')}</SubmitButton>
          </form>
          {corrections.length > 0 && (
            <ul className="mt-4 divide-y divide-line text-sm">
              {corrections.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-slate-300">{c.kind ? punchLabel(c.kind, locale) : tr('Anular ponche', 'Void punch')}{c.at ? ` · ${f.dateTime(c.at)}` : ''} · <span className="text-muted">{statusText(c.status)}</span></span>
                  {c.status === 'pending' && (
                    <form action={cancelCorrection}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5" aria-labelledby="leave-title">
          <h2 id="leave-title" className="font-display text-lg font-semibold text-fg">{tr('Vacaciones y permisos', 'Vacation and leave')}</h2>
          <form action={requestLeave} className="mt-3 space-y-3">
            <input type="hidden" name="employee_id" value={emp.id} />
            <input type="hidden" name="back" value={back} />
            <label className="field-label">{tr('Tipo', 'Type')}
              <select name="leave_type" className="field mt-1" defaultValue="vacation">
                {LEAVE_TYPES.map((t) => <option key={t} value={t}>{leaveLabel(t, locale)}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="field-label">{tr('Desde', 'From')}<input name="starts_on" type="date" required className="field mt-1" /></label>
              <label className="field-label">{tr('Hasta', 'To')}<input name="ends_on" type="date" className="field mt-1" /></label>
            </div>
            <label className="field-label">{tr('Horas (solo si es parte de un día)', 'Hours (only for part of a day)')}<input name="hours" inputMode="decimal" className="field mt-1" placeholder="2" /></label>
            <label className="field-label">{tr('Motivo', 'Reason')}<input name="reason" maxLength={300} className="field mt-1" /></label>
            <p className="text-xs text-muted">{tr('No escribas diagnósticos ni información médica: basta con el tipo de ausencia.', 'Do not write diagnoses or medical information: the type of leave is enough.')}</p>
            <SubmitButton pendingLabel={tr('Enviando…', 'Sending…')}>{tr('Solicitar', 'Request')}</SubmitButton>
          </form>
          {leaves.length > 0 && (
            <ul className="mt-4 divide-y divide-line text-sm">
              {leaves.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-slate-300">{leaveLabel(l.leave_type, locale)} · {f.date(l.starts_on)}{l.ends_on !== l.starts_on ? ` – ${f.date(l.ends_on)}` : ''} · <span className="text-muted">{statusText(l.status)}</span></span>
                  {l.status === 'pending' && (
                    <form action={cancelLeave}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}

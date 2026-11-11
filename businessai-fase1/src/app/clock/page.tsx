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
import { LEAVE_TYPES, leaveLabel, localTime, nextPunches, punchLabel, stateLabel, wfMessage, workforceRules } from '@/lib/workforce/context'
import { cancelCorrection, cancelLeave, punchAction, requestCorrection, requestLeave } from '@/app/actions/workforce'
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

  const rules = await workforceRules(supabase, emp.company_id)
  const now = new Date()
  const today = localDay(now, rules.timezone)
  const ws = weekStart(today, rules.weekStartsOn)
  const since = new Date(Date.parse(`${addDays(ws, -1)}T00:00:00Z`)).toISOString()
  const [{ data: punchData }, { data: shiftData }, { data: leaveData }, { data: corrData }, { data: company }] = await Promise.all([
    supabase.from('time_punches').select('id, kind, at, source, voided_at').eq('employee_id', emp.id).gte('at', since).order('at'),
    supabase.from('work_shifts').select('starts_at, ends_at, break_minutes').eq('employee_id', emp.id).gte('ends_at', since).order('starts_at').limit(60),
    supabase.from('leave_requests').select('id, leave_type, starts_on, ends_on, partial_minutes, status, reason').eq('employee_id', emp.id).order('starts_on', { ascending: false }).limit(20),
    supabase.from('punch_corrections').select('id, action, kind, at, reason, status, requested_at, decision_note').eq('employee_id', emp.id).order('requested_at', { ascending: false }).limit(10),
    supabase.from('companies').select('name').eq('id', emp.company_id).maybeSingle(),
  ])
  const punches = ((punchData ?? []) as P[]).filter((p) => !p.voided_at)
  const state = punches.at(-1)?.kind ?? 'out'
  const next = emp.status === 'active' ? nextPunches(state) : []
  const shifts = (shiftData ?? []) as { starts_at: string; ends_at: string; break_minutes: number }[]
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
    cancelled: tr('Solicitud cancelada.', 'Request cancelled.'), linked: tr('Tu cuenta quedó vinculada. Ya puedes ponchar.', 'Your account is linked. You can punch now.'),
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

      {upcoming.length > 0 && (
        <section className="card p-5" aria-labelledby="sched-title">
          <h2 id="sched-title" className="font-display text-lg font-semibold text-fg">{tr('Próximos turnos', 'Upcoming shifts')}</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-300">
            {upcoming.map((s) => <li key={s.starts_at}>{f.date(localDay(s.starts_at, rules.timezone))} · {localTime(s.starts_at, rules.timezone, locale)}–{localTime(s.ends_at, rules.timezone, locale)}</li>)}
          </ul>
        </section>
      )}

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

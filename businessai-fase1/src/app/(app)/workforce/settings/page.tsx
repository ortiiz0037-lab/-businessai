import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { wfMessage } from '@/lib/workforce/context'
import { roleLabel } from '@/lib/team'
import { cookies } from 'next/headers'
import { createDepartment, createKiosk, revokeKiosk, saveWorkforceSettings, setSupervisor } from '@/app/actions/workforce'

export const dynamic = 'force-dynamic'
const ZONES = ['America/Puerto_Rico', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Santo_Domingo', 'America/Mexico_City', 'America/Bogota', 'Europe/Madrid', 'UTC']

/** Labor rules, departments and supervisors (managers only). */
export default async function WorkforceSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, supabase, companyId, access, rules } = await workforcePage()
  if (!access.manages) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const [{ data: settings }, { data: deptData }, { data: supData }, { data: members }, { data: kioskData }] = await Promise.all([
    supabase.from('workforce_settings').select('overtime_multiplier').eq('company_id', companyId).maybeSingle(),
    supabase.from('departments').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name'),
    supabase.from('department_supervisors').select('department_id, user_id').eq('company_id', companyId),
    supabase.rpc('company_members', { target: companyId }),
    supabase.from('time_clock_kiosks').select('id, name, created_at, revoked_at, last_used_at').eq('company_id', companyId).order('created_at', { ascending: false }),
  ])
  const kiosks = (kioskData ?? []) as { id: string; name: string; created_at: string; revoked_at: string | null; last_used_at: string | null }[]
  const setupLink = (await cookies()).get('ba_kiosk_setup')?.value ?? null
  const depts = (deptData ?? []) as { id: string; name: string }[]
  const sups = (supData ?? []) as { department_id: string; user_id: string }[]
  const team = ((members ?? []) as { user_id: string; email: string | null; role: string; status: string }[]).filter((m) => m.status === 'active')
  const email = (id: string) => team.find((m) => m.user_id === id)?.email ?? id.slice(0, 8)
  const weekDays = locale === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
  const done: Record<string, string> = { kiosk: tr('Tableta registrada.', 'Tablet registered.'), kiosk_revoked: tr('Tableta desactivada.', 'Tablet deactivated.'),
    saved: tr('Reglas guardadas.', 'Rules saved.'), department: tr('Departamento creado.', 'Department created.'), supervisor: tr('Supervisores actualizados.', 'Supervisors updated.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Reglas, departamentos y supervisores', 'Rules, departments and supervisors')} />
      <WorkforceNav tr={tr} current="/workforce/settings" manages />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}

      <section className="card p-5" aria-labelledby="rules-title">
        <h2 id="rules-title" className="font-display text-lg font-semibold text-fg">{tr('Reglas laborales', 'Labor rules')}</h2>
        <div role="note" className="alert-warning mt-3 space-y-2 p-4 text-sm">
          <p>{tr('Los valores iniciales son una referencia general de Puerto Rico (horas extra después de 8 horas en un día o de 40 en una semana) y se pueden cambiar. Pueden no aplicar a tu empresa ni a todos tus empleados: por ejemplo empleados exentos, empleados contratados antes de 2017, decretos, convenios colectivos u otra jurisdicción.',
            'The defaults are a general Puerto Rico reference (overtime after 8 hours in a day or 40 in a week) and can be changed. They may not apply to your company or to all your employees: for example exempt employees, employees hired before 2017, decrees, collective agreements or another jurisdiction.')}</p>
          <p className="font-semibold">{tr('BusinessAI calcula con las reglas que configures aquí. No es asesoría legal ni garantiza el cumplimiento de leyes laborales; consulta con un asesor laboral o contable.',
            'BusinessAI calculates with the rules you configure here. It is not legal advice and does not guarantee compliance with labor laws; check with a labor or accounting advisor.')}</p>
          <p className="text-xs">{tr('Los periodos de comida obligatorios y el pago de las horas extra no se calculan todavía: el multiplicador se guarda para la futura nómina.',
            'Mandatory meal periods and overtime pay amounts are not calculated yet: the multiplier is stored for future payroll.')}</p>
        </div>
        <form action={saveWorkforceSettings} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="field-label">{tr('Zona horaria', 'Time zone')}
            <select name="timezone" defaultValue={rules.timezone} className="field mt-1">{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select>
          </label>
          <label className="field-label">{tr('La semana empieza el', 'Week starts on')}
            <select name="week_starts_on" defaultValue={rules.weekStartsOn} className="field mt-1">{weekDays.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          </label>
          <label className="field-label">{tr('Tolerancia de tardanza (min)', 'Late grace (min)')}<input name="grace_minutes" type="number" min={0} max={120} defaultValue={rules.graceMinutes} className="field mt-1" /></label>
          <label className="field-label">{tr('Extra después de (horas al día; vacío = no aplica)', 'Overtime after (hours a day; empty = none)')}
            <input name="daily_hours" inputMode="decimal" defaultValue={rules.dailyOvertimeAfter === null ? '' : rules.dailyOvertimeAfter / 60} className="field mt-1" /></label>
          <label className="field-label">{tr('Extra después de (horas a la semana; vacío = no aplica)', 'Overtime after (hours a week; empty = none)')}
            <input name="weekly_hours" inputMode="decimal" defaultValue={rules.weeklyOvertimeAfter === null ? '' : rules.weeklyOvertimeAfter / 60} className="field mt-1" /></label>
          <label className="field-label">{tr('Multiplicador de horas extra', 'Overtime multiplier')}
            <input name="overtime_multiplier" inputMode="decimal" defaultValue={settings?.overtime_multiplier ?? 1.5} className="field mt-1" /></label>
          <div className="sm:col-span-2 lg:col-span-3"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="sm:w-auto">{tr('Guardar reglas', 'Save rules')}</SubmitButton></div>
        </form>
      </section>

      <section className="card p-5" aria-labelledby="kiosk-title">
        <h2 id="kiosk-title" className="font-display text-lg font-semibold text-fg">{tr('Tabletas compartidas (modo PIN)', 'Shared tablets (PIN mode)')}</h2>
        <p className="mt-1 text-sm text-muted">{tr('Registra una tableta y abre el enlace en ella una sola vez. La tableta no usa ninguna cuenta: cada empleado poncha con su número y su PIN, y la pantalla no muestra datos de nadie. Desactívala si se pierde.',
          'Register a tablet and open the link on it once. The tablet uses no account: each employee punches with their number and PIN, and the screen shows nobody\'s data. Deactivate it if it is lost.')}</p>
        {setupLink && params.done === 'kiosk' && (
          <div className="alert-info mt-3 space-y-2 p-3 text-sm">
            <p>{tr('Abre este enlace en la tableta (se muestra durante 10 minutos):', 'Open this link on the tablet (shown for 10 minutes):')}</p>
            <input readOnly value={setupLink} aria-label={tr('Enlace de activación', 'Activation link')} className="field w-full font-mono text-xs" />
          </div>
        )}
        <form action={createKiosk} className="mt-4 flex gap-2">
          <input name="name" required maxLength={60} placeholder={tr('Ej. Tableta de la entrada', 'e.g. Front door tablet')} aria-label={tr('Nombre de la tableta', 'Tablet name')} className="field" />
          <button type="submit" className="btn-primary">{tr('Registrar', 'Register')}</button>
        </form>
        <ul className="mt-3 divide-y divide-line text-sm">
          {kiosks.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-2 py-2">
              <span className={k.revoked_at ? 'text-muted line-through' : 'text-slate-300'}>{k.name}
                <span className="text-xs text-muted"> · {k.last_used_at ? tr(`último uso ${new Date(k.last_used_at).toLocaleDateString()}`, `last used ${new Date(k.last_used_at).toLocaleDateString()}`) : tr('sin uso', 'unused')}</span></span>
              {!k.revoked_at && (
                <form action={revokeKiosk}><input type="hidden" name="id" value={k.id} /><button type="submit" className="btn-danger btn-sm">{tr('Desactivar', 'Deactivate')}</button></form>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-5" aria-labelledby="dept-title">
        <h2 id="dept-title" className="font-display text-lg font-semibold text-fg">{tr('Departamentos y supervisores', 'Departments and supervisors')}</h2>
        <p className="mt-1 text-sm text-muted">{tr('Un supervisor ve, ponchea, programa y aprueba solo a los empleados de su departamento, y nunca su propia asistencia.',
          'A supervisor sees, punches, schedules and approves only the employees of their department, and never their own attendance.')}</p>
        <form action={createDepartment} className="mt-4 flex gap-2">
          <input name="name" required maxLength={80} placeholder={tr('Nuevo departamento', 'New department')} aria-label={tr('Nombre del departamento', 'Department name')} className="field" />
          <button type="submit" className="btn-primary">{tr('Crear', 'Create')}</button>
        </form>
        <ul className="mt-4 divide-y divide-line">
          {depts.map((d) => {
            const current = sups.filter((s) => s.department_id === d.id)
            return (
              <li key={d.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold text-fg">{d.name}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {current.length === 0 && <span className="text-xs text-muted">{tr('Sin supervisor', 'No supervisor')}</span>}
                    {current.map((s) => (
                      <form key={s.user_id} action={setSupervisor} className="inline-flex">
                        <input type="hidden" name="department_id" value={d.id} /><input type="hidden" name="user_id" value={s.user_id} /><input type="hidden" name="remove" value="yes" />
                        <button type="submit" className="badge-accent" aria-label={tr(`Quitar a ${email(s.user_id)}`, `Remove ${email(s.user_id)}`)}>{email(s.user_id)} ×</button>
                      </form>
                    ))}
                  </div>
                </div>
                <form action={setSupervisor} className="flex gap-2">
                  <input type="hidden" name="department_id" value={d.id} />
                  <select name="user_id" required aria-label={tr('Miembro', 'Member')} className="field py-2 text-sm">
                    {team.filter((m) => !current.some((s) => s.user_id === m.user_id)).map((m) => <option key={m.user_id} value={m.user_id}>{m.email} · {roleLabel(m.role, locale)}</option>)}
                  </select>
                  <button type="submit" className="btn-secondary btn-sm">{tr('Asignar', 'Assign')}</button>
                </form>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

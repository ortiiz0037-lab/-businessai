import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoWorkforceAccess, WorkforceNav } from '@/components/workforce-nav'
import { workforcePage } from '@/lib/workforce/page'
import { wfMessage } from '@/lib/workforce/context'
import { roleLabel } from '@/lib/team'
import { cookies } from 'next/headers'
import { archiveRuleSet, createDepartment, createKiosk, revokeKiosk, saveRuleSet, setSupervisor } from '@/app/actions/workforce'
import { proposeCompanyRules, proposeGroupRules, proposeTemplate } from '@/app/actions/workforce-hr'
import { RuleProposals, RuleVersions, type Proposal, type Version } from '@/components/workforce/rule-proposals'
import { ruleSets } from '@/lib/workforce/context'
import { hhmm } from '@/lib/workforce/hours'

export const dynamic = 'force-dynamic'
const ZONES = ['America/Puerto_Rico', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Santo_Domingo', 'America/Mexico_City', 'America/Bogota', 'Europe/Madrid', 'UTC']

/** Labor rules, departments and supervisors (managers only). */
export default async function WorkforceSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; proposal?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, access, rules } = await workforcePage()
  if (!access.manages) return <NoWorkforceAccess tr={tr} unavailable={!access.available} />
  const [{ data: settings }, { data: deptData }, { data: supData }, { data: members }, { data: kioskData }] = await Promise.all([
    supabase.from('workforce_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('departments').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name'),
    supabase.from('department_supervisors').select('department_id, user_id').eq('company_id', companyId),
    supabase.rpc('company_members', { target: companyId }),
    supabase.from('time_clock_kiosks').select('id, name, created_at, revoked_at, last_used_at').eq('company_id', companyId).order('created_at', { ascending: false }),
  ])
  const [sets, { data: jurData }, { data: propData }, { data: verData }, { data: empData }] = await Promise.all([ruleSets(supabase, companyId), supabase.from('labor_jurisdictions').select('*').order('code'),
    supabase.from('labor_rule_changes').select('id, scope, scope_id, changes, note, proposed_at, proposed_by, base_version').eq('company_id', companyId).eq('status', 'pending').order('proposed_at'),
    supabase.from('labor_rule_versions').select('id, scope, scope_id, version, rule_values, actor, created_at, change_id').eq('company_id', companyId).order('id', { ascending: false }).limit(60),
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId)])
  const jurisdictions = (jurData ?? []) as { code: string; name_es: string; name_en: string; note_es: string; note_en: string; verification_status?: string }[]
  const proposals = (propData ?? []) as Proposal[]
  const versions = (verData ?? []) as Version[]
  const empName = new Map(((empData ?? []) as { id: string; first_name: string; last_name: string }[]).map((e) => [e.id, `${e.first_name} ${e.last_name}`]))
  const scopeTitle = (scope: string, id: string) => scope === 'company' ? tr('Reglas de la empresa', 'Company rules')
    : scope === 'rule_set' ? `${tr('Grupo', 'Group')}: ${sets.find((g) => g.id === id)?.name ?? '—'}` : `${tr('Excepciones de', 'Exceptions of')} ${empName.get(id) ?? '—'}`
  // without a settings row the company runs on the table defaults (0020 / 0022 / 0033)
  const COMPANY_DEFAULTS = { jurisdiction: null, timezone: 'America/Puerto_Rico', week_starts_on: 1, daily_overtime_after_minutes: 480, weekly_overtime_after_minutes: 2400,
    overtime_multiplier: 1.5, grace_minutes: 5, meal_break_after_minutes: null, meal_break_min_minutes: null, meal_alert_before_minutes: 15, overnight_attribution: 'start_day' }
  const currentOf = (p: Proposal): Record<string, unknown> => p.scope === 'company' ? ((settings ?? COMPANY_DEFAULTS) as Record<string, unknown>)
    : p.scope === 'rule_set' ? ((sets.find((g) => g.id === p.scope_id) ?? {}) as Record<string, unknown>) : {}
  const ws = (settings ?? {}) as { jurisdiction?: string | null; meal_break_after_minutes?: number | null; meal_break_min_minutes?: number | null; meal_alert_before_minutes?: number | null; overtime_multiplier?: number | null }
  const hrs = (m: number | null | undefined) => (m === null || m === undefined ? '' : String(m / 60))
  const kiosks = (kioskData ?? []) as { id: string; name: string; created_at: string; revoked_at: string | null; last_used_at: string | null }[]
  const setupLink = (await cookies()).get('ba_kiosk_setup')?.value ?? null
  const depts = (deptData ?? []) as { id: string; name: string }[]
  const sups = (supData ?? []) as { department_id: string; user_id: string }[]
  const team = ((members ?? []) as { user_id: string; email: string | null; role: string; status: string }[]).filter((m) => m.status === 'active')
  const email = (id: string) => team.find((m) => m.user_id === id)?.email ?? id.slice(0, 8)
  const weekDays = locale === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
  const done: Record<string, string> = { proposed: tr('Cambio propuesto: revísalo y aplícalo abajo. Todavía no cambió nada.', 'Change proposed: review and apply it below. Nothing has changed yet.'),
    rules_applied: tr('Cambio aplicado; se creó una nueva versión de las reglas.', 'Change applied; a new rule version was created.'), rules_discarded: tr('Propuesta descartada.', 'Proposal discarded.'),
    no_changes: tr('No hay cambios que proponer.', 'There are no changes to propose.'), template: tr('Plantilla aplicada; revisa los valores.', 'Template applied; review the values.'), group: tr('Grupo guardado.', 'Group saved.'), kiosk: tr('Tableta registrada.', 'Tablet registered.'), kiosk_revoked: tr('Tableta desactivada.', 'Tablet deactivated.'),
    saved: tr('Reglas guardadas.', 'Rules saved.'), department: tr('Departamento creado.', 'Department created.'), supervisor: tr('Supervisores actualizados.', 'Supervisors updated.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Personal', 'Workforce')} title={tr('Reglas, departamentos y supervisores', 'Rules, departments and supervisors')} />
      <WorkforceNav tr={tr} current="/workforce/settings" manages />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{wfMessage(params.error, locale)}</div>}
      <RuleProposals tr={tr} locale={locale} proposals={proposals} current={currentOf} title={(p) => scopeTitle(p.scope, p.scope_id)} back="/workforce/settings"
        highlight={params.proposal ?? null} who={(id) => (id ? email(id) : tr('sistema', 'system'))} date={(d) => f.dateTime(d)} />

      <section className="card p-5" aria-labelledby="rules-title">
        <h2 id="rules-title" className="font-display text-lg font-semibold text-fg">{tr('Reglas laborales', 'Labor rules')}</h2>
        <div role="note" className="alert-warning mt-3 space-y-2 p-4 text-sm">
          <p>{tr('Los valores iniciales son una referencia general de Puerto Rico (horas extra después de 8 horas en un día o de 40 en una semana) y se pueden cambiar. Pueden no aplicar a tu empresa ni a todos tus empleados: por ejemplo empleados exentos, empleados contratados antes de 2017, decretos, convenios colectivos u otra jurisdicción.',
            'The defaults are a general Puerto Rico reference (overtime after 8 hours in a day or 40 in a week) and can be changed. They may not apply to your company or to all your employees: for example exempt employees, employees hired before 2017, decrees, collective agreements or another jurisdiction.')}</p>
          <p className="font-semibold">{tr('BusinessAI calcula con las reglas que configures aquí. No es asesoría legal ni garantiza el cumplimiento de leyes laborales; consulta con un asesor laboral o contable.',
            'BusinessAI calculates with the rules you configure here. It is not legal advice and does not guarantee compliance with labor laws; check with a labor or accounting advisor.')}</p>
          <p className="text-xs">{tr('Las reglas de comida generan alertas (no sanciones automáticas). El pago de horas extra no se calcula: el multiplicador se guarda para la futura nómina. Los cambios se proponen y solo surten efecto cuando un administrador los aplica; cada aplicación queda como versión.',
            'Meal rules produce alerts (no automatic penalties). Overtime pay amounts are not calculated: the multiplier is stored for future payroll. Changes are proposed and only take effect when an admin applies them; each one is kept as a version.')}</p>
        </div>
        <form action={proposeCompanyRules} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <input name="overtime_multiplier" inputMode="decimal" defaultValue={ws.overtime_multiplier ?? 1.5} className="field mt-1" /></label>
          {jurisdictions.length > 0 && (
            <>
              <label className="field-label">{tr('Comida antes de (horas de trabajo continuo; vacío = sin regla)', 'Meal before (hours of continuous work; empty = no rule)')}
                <input name="meal_after_hours" inputMode="decimal" defaultValue={hrs(ws.meal_break_after_minutes)} className="field mt-1" /></label>
              <label className="field-label">{tr('Duración mínima de la comida (min)', 'Minimum meal length (min)')}
                <input name="meal_min_minutes" type="number" min={10} max={180} defaultValue={ws.meal_break_min_minutes ?? ''} className="field mt-1" /></label>
              <label className="field-label">{tr('Avisar antes (min)', 'Alert before (min)')}
                <input name="meal_alert_before" type="number" min={0} max={120} defaultValue={ws.meal_alert_before_minutes ?? 15} className="field mt-1" /></label>
            </>
          )}
          <label className="field-label">{tr('Turnos que cruzan la medianoche', 'Shifts that cross midnight')}
            <select name="overnight_attribution" defaultValue={rules.overnight ?? 'start_day'} className="field mt-1">
              <option value="start_day">{tr('Cuentan el día en que empiezan', 'Count on the day they start')}</option>
              <option value="split_midnight">{tr('Se dividen a medianoche', 'Split at midnight')}</option>
            </select></label>
          <label className="field-label sm:col-span-2">{tr('Motivo del cambio (opcional)', 'Reason for the change (optional)')}<input name="note" maxLength={300} className="field mt-1" /></label>
          <div className="sm:col-span-2 lg:col-span-3"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="sm:w-auto">{tr('Proponer cambio de reglas', 'Propose rule change')}</SubmitButton></div>
        </form>
      </section>

      {jurisdictions.length > 0 && (
        <section className="card p-5" aria-labelledby="jur-title">
          <h2 id="jur-title" className="font-display text-lg font-semibold text-fg">{tr('Jurisdicción y grupos de reglas', 'Jurisdiction and rule groups')}</h2>
          <p className="mt-1 text-sm text-muted">{tr(`Jurisdicción actual de la empresa: ${ws.jurisdiction ?? 'sin elegir'}. Las plantillas solo copian valores de referencia que puedes cambiar; nunca se aplican solas.`,
            `Current company jurisdiction: ${ws.jurisdiction ?? 'not chosen'}. Templates only copy reference values you can change; they are never applied on their own.`)}</p>
          <form action={proposeTemplate} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <select name="code" aria-label={tr('Plantilla', 'Template')} className="field">
              {jurisdictions.map((j) => <option key={j.code} value={j.code}>{locale === 'en' ? j.name_en : j.name_es}</option>)}
            </select>
            <select name="rule_set_id" aria-label={tr('Aplicar a', 'Apply to')} className="field">
              <option value="">{tr('Valores de la empresa', 'Company defaults')}</option>
              {sets.filter((g) => !g.archived_at).map((g) => <option key={g.id} value={g.id}>{tr('Grupo', 'Group')}: {g.name}</option>)}
            </select>
            <button type="submit" className="btn-secondary">{tr('Ver plantilla como propuesta', 'Show template as a proposal')}</button>
          </form>
          <ul className="mt-2 space-y-1 text-xs text-muted">{jurisdictions.map((j) => <li key={j.code}><strong>{j.code}</strong>: {locale === 'en' ? j.note_en : j.note_es}{j.verification_status !== 'verified' && <span className="badge-warning ml-1">{tr('vigencia no verificada', 'validity not verified')}</span>}</li>)}</ul>
          <p className="mt-2 text-xs text-warning">{tr('Las plantillas son referencias generales cuya vigencia actual BusinessAI no ha verificado. Confirma los valores con un asesor laboral antes de aplicarlos.',
            'Templates are general references whose current validity BusinessAI has not verified. Confirm the values with a labor advisor before applying them.')}</p>

          <h3 className="mt-5 font-semibold text-fg">{tr('Grupos de reglas', 'Rule groups')}</h3>
          <p className="text-xs text-muted">{tr('Para empleados exentos, acuerdos especiales u otras condiciones. Un empleado sin grupo usa los valores de la empresa. Horas vacías = no aplica.',
            'For exempt employees, special agreements or other conditions. An employee without a group uses the company defaults. Empty hours = does not apply.')}</p>
          <div className="mt-3 space-y-3">
            {[...sets, null].map((g) => (
              <form key={g?.id ?? 'new'} action={g ? proposeGroupRules : saveRuleSet} className={`grid gap-2 rounded-xl border p-3 sm:grid-cols-4 ${g?.archived_at ? 'border-line opacity-60' : 'border-line'}`}>
                {g && <input type="hidden" name="id" value={g.id} />}
                <label className="field-label sm:col-span-2">{g ? tr('Grupo', 'Group') : tr('Nuevo grupo', 'New group')}<input name="name" required maxLength={80} defaultValue={g?.name ?? ''} className="field mt-1" /></label>
                <label className="field-label">{tr('Jurisdicción', 'Jurisdiction')}
                  <select name="jurisdiction" defaultValue={g?.jurisdiction ?? ''} className="field mt-1"><option value="">—</option>{jurisdictions.map((j) => <option key={j.code} value={j.code}>{j.code}</option>)}</select></label>
                <label className="field-label">{tr('Exento de extras', 'Overtime exempt')}
                  <select name="exempt" defaultValue={g?.exempt ? 'yes' : 'no'} className="field mt-1"><option value="no">{tr('No', 'No')}</option><option value="yes">{tr('Sí', 'Yes')}</option></select></label>
                <label className="field-label">{tr('Extra/día (h)', 'OT/day (h)')}<input name="daily_hours" inputMode="decimal" defaultValue={hrs(g?.daily_overtime_after_minutes)} className="field mt-1" /></label>
                <label className="field-label">{tr('Extra/semana (h)', 'OT/week (h)')}<input name="weekly_hours" inputMode="decimal" defaultValue={hrs(g?.weekly_overtime_after_minutes)} className="field mt-1" /></label>
                <label className="field-label">{tr('Comida antes de (h)', 'Meal before (h)')}<input name="meal_after_hours" inputMode="decimal" defaultValue={hrs(g?.meal_break_after_minutes)} className="field mt-1" /></label>
                <label className="field-label">{tr('Comida mín. (min)', 'Meal min (min)')}<input name="meal_min_minutes" type="number" min={10} max={180} defaultValue={g?.meal_break_min_minutes ?? ''} className="field mt-1" /></label>
                <div className="flex items-end gap-2 sm:col-span-4">
                  <button type="submit" className="btn-primary btn-sm">{g ? tr('Proponer cambios', 'Propose changes') : tr('Crear grupo', 'Create group')}</button>
                  {g && <span className="text-xs text-muted">{g.exempt ? tr('Exento', 'Exempt') : `${g.daily_overtime_after_minutes ? hhmm(g.daily_overtime_after_minutes) : '—'} / ${g.weekly_overtime_after_minutes ? hhmm(g.weekly_overtime_after_minutes) : '—'}`}</span>}
                </div>
              </form>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {sets.map((g) => (
              <form key={g.id} action={archiveRuleSet}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="restore" value={g.archived_at ? 'yes' : 'no'} />
                <button type="submit" className="btn-secondary btn-sm">{g.archived_at ? tr(`Restaurar ${g.name}`, `Restore ${g.name}`) : tr(`Archivar ${g.name}`, `Archive ${g.name}`)}</button></form>
            ))}
          </div>
        </section>
      )}

      <RuleVersions tr={tr} locale={locale} versions={versions} title={(v) => scopeTitle(v.scope, v.scope_id)} who={(id) => (id ? email(id) : tr('sistema', 'system'))} date={(d) => f.dateTime(d)} />

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

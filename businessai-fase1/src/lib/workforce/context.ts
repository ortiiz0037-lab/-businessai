/**
 * Workforce (migration 0020): who the signed-in user is for the module and
 * the company rules. RLS and the 0020 functions decide every read and write;
 * this only chooses what to show.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { DEFAULT_RULES, type Rules } from '@/lib/workforce/hours'

export type WorkforceAccess = { companyId: string; manages: boolean; supervisedDepartments: string[]; directReports: number; available: boolean }

export async function workforceAccess(supabase: SupabaseClient, companyId: string, userId: string): Promise<WorkforceAccess> {
  const [{ data: manages, error }, { data: sup }, direct] = await Promise.all([
    supabase.rpc('wf_manages', { target: companyId }),
    supabase.from('department_supervisors').select('department_id').eq('company_id', companyId).eq('user_id', userId),
    // direct reports (0033): employees whose direct supervisor is this member
    supabase.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('supervisor_user_id', userId),
  ])
  return {
    companyId,
    manages: !error && manages === true,
    supervisedDepartments: ((sup ?? []) as { department_id: string }[]).map((r) => r.department_id),
    directReports: direct.error ? 0 : direct.count ?? 0,
    available: !error,
  }
}

/** Supervises someone (department or direct reports) or manages the module. */
export const supervisesAnyone = (a: WorkforceAccess) => a.manages || a.supervisedDepartments.length > 0 || a.directReports > 0

export async function workforceRules(supabase: SupabaseClient, companyId: string): Promise<Rules> {
  const { data } = await supabase.from('workforce_settings').select('*').eq('company_id', companyId).maybeSingle()
  if (!data) return DEFAULT_RULES
  return {
    timezone: data.timezone ?? DEFAULT_RULES.timezone,
    weekStartsOn: data.week_starts_on ?? 1,
    dailyOvertimeAfter: data.daily_overtime_after_minutes ?? null,
    weeklyOvertimeAfter: data.weekly_overtime_after_minutes ?? null,
    graceMinutes: data.grace_minutes ?? 5,
    mealAfterMinutes: data.meal_break_after_minutes ?? null,
    mealMinMinutes: data.meal_break_min_minutes ?? null,
    overnight: data.overnight_attribution === 'split_midnight' ? 'split_midnight' : 'start_day',
  }
}

export type RuleSet = {
  id: string; name: string; jurisdiction: string | null; exempt: boolean; daily_overtime_after_minutes: number | null
  weekly_overtime_after_minutes: number | null; overtime_multiplier: number; meal_break_after_minutes: number | null
  meal_break_min_minutes: number | null; meal_alert_before_minutes: number; archived_at: string | null
}

/** Exceptions of one employee (0033): a present key replaces the inherited value (null = does not apply). */
export type RuleOverrides = Partial<{ exempt: boolean | null; daily_overtime_after_minutes: number | null; weekly_overtime_after_minutes: number | null
  overtime_multiplier: number | null; meal_break_after_minutes: number | null; meal_break_min_minutes: number | null; meal_alert_before_minutes: number | null }>

/**
 * Rules of one employee: its exceptions (0033), then its classification
 * (exempt), then its group (0022), else the company defaults. Mirrors public.wf_rules.
 */
export function rulesFor(defaults: Rules, set: RuleSet | null | undefined, overrides?: RuleOverrides | null, classification?: string | null): Rules {
  const base: Rules = !set || set.archived_at ? { ...defaults } : {
    ...defaults,
    exempt: set.exempt,
    dailyOvertimeAfter: set.daily_overtime_after_minutes,
    weeklyOvertimeAfter: set.weekly_overtime_after_minutes,
    mealAfterMinutes: set.meal_break_after_minutes,
    mealMinMinutes: set.meal_break_min_minutes,
  }
  if (classification === 'exempt') base.exempt = true
  const o = overrides ?? {}
  if ('exempt' in o && typeof o.exempt === 'boolean') base.exempt = o.exempt
  if ('daily_overtime_after_minutes' in o) base.dailyOvertimeAfter = o.daily_overtime_after_minutes ?? null
  if ('weekly_overtime_after_minutes' in o) base.weeklyOvertimeAfter = o.weekly_overtime_after_minutes ?? null
  if ('meal_break_after_minutes' in o) base.mealAfterMinutes = o.meal_break_after_minutes ?? null
  if ('meal_break_min_minutes' in o) base.mealMinMinutes = o.meal_break_min_minutes ?? null
  return base
}

/** Per-employee exceptions and classification (empty without migration 0033). */
export async function employeeRuleInputs(supabase: SupabaseClient, companyId: string, ids: string[]) {
  if (!ids.length) return { overrides: new Map<string, RuleOverrides>(), classification: new Map<string, string>() }
  const [o, c] = await Promise.all([
    supabase.from('employee_rule_overrides').select('employee_id, overrides').eq('company_id', companyId).in('employee_id', ids),
    supabase.from('employees').select('id, classification').in('id', ids),
  ])
  return {
    overrides: new Map(o.error ? [] : ((o.data ?? []) as { employee_id: string; overrides: RuleOverrides }[]).map((r) => [r.employee_id, r.overrides])),
    classification: new Map(c.error ? [] : ((c.data ?? []) as { id: string; classification: string }[]).map((r) => [r.id, r.classification])),
  }
}

/** Rule groups of a company (empty without migration 0022). */
export async function ruleSets(supabase: SupabaseClient, companyId: string): Promise<RuleSet[]> {
  const { data, error } = await supabase.from('labor_rule_sets').select('*').eq('company_id', companyId).order('name')
  return error ? [] : ((data ?? []) as RuleSet[])
}

export const LEAVE_TYPES = ['vacation', 'sick', 'personal', 'unpaid', 'day_off', 'bereavement', 'jury_duty', 'parental', 'military', 'other'] as const
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'temporary', 'seasonal', 'contractor', 'intern'] as const
export const EMPLOYEE_STATUSES = ['active', 'suspended', 'inactive', 'terminated'] as const
export const DOC_CATEGORIES = ['contract', 'policy', 'evaluation', 'certification', 'training', 'other'] as const
export const ALERT_ACTIONS = ['break_taken_late', 'schedule_adjusted', 'employee_reminded', 'no_action_needed', 'other'] as const
export const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0] as const

const LABELS: Record<string, [string, string]> = {
  full_time: ['Tiempo completo', 'Full time'], part_time: ['Tiempo parcial', 'Part time'], temporary: ['Temporal', 'Temporary'], seasonal: ['De temporada', 'Seasonal'],
  contractor: ['Contratista', 'Contractor'], intern: ['Práctica', 'Intern'], non_exempt: ['No exento', 'Non-exempt'], exempt: ['Exento', 'Exempt'],
  active: ['Activo', 'Active'], suspended: ['Suspendido', 'Suspended'], inactive: ['Inactivo', 'Inactive'], terminated: ['Baja', 'Terminated'],
  contract: ['Contrato', 'Contract'], policy: ['Política firmada', 'Signed policy'], evaluation: ['Evaluación', 'Evaluation'], certification: ['Certificación', 'Certification'],
  training: ['Adiestramiento', 'Training'], other: ['Otro', 'Other'],
  break_taken_late: ['Tomó la comida tarde', 'Meal taken late'], schedule_adjusted: ['Horario ajustado', 'Schedule adjusted'], employee_reminded: ['Se le recordó al empleado', 'Employee reminded'],
  no_action_needed: ['No requiere acción', 'No action needed'],
}
/** Label of a workforce code (types, classification, status, document category, alert action). */
export const wfLabel = (code: string, locale: Locale) => LABELS[code]?.[locale === 'en' ? 1 : 0] ?? code
export const weekdayLabel = (n: number, locale: Locale) =>
  (locale === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'])[n] ?? String(n)
export const PUNCH_KINDS = ['in', 'break_start', 'break_end', 'out'] as const

export function leaveLabel(t: string, locale: Locale): string {
  const es: Record<string, string> = { vacation: 'Vacaciones', sick: 'Enfermedad', personal: 'Asunto personal', unpaid: 'Sin sueldo', day_off: 'Día libre', other: 'Otro',
    bereavement: 'Duelo', jury_duty: 'Servicio de jurado', parental: 'Licencia parental', military: 'Servicio militar' }
  const en: Record<string, string> = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', day_off: 'Day off', other: 'Other',
    bereavement: 'Bereavement', jury_duty: 'Jury duty', parental: 'Parental leave', military: 'Military service' }
  return (locale === 'en' ? en : es)[t] ?? t
}

export function punchLabel(k: string, locale: Locale): string {
  const es: Record<string, string> = { in: 'Entrada', out: 'Salida', break_start: 'Inicio de descanso', break_end: 'Fin de descanso' }
  const en: Record<string, string> = { in: 'Clock in', out: 'Clock out', break_start: 'Break start', break_end: 'Break end' }
  return (locale === 'en' ? en : es)[k] ?? k
}

/** State after the last punch → what the employee can do next. */
export function nextPunches(state: string | null): string[] {
  if (!state || state === 'out') return ['in']
  if (state === 'in' || state === 'break_end') return ['break_start', 'out']
  if (state === 'break_start') return ['break_end']
  return []
}

export function stateLabel(state: string | null, locale: Locale): string {
  const es: Record<string, string> = { in: 'Trabajando', break_end: 'Trabajando', break_start: 'En descanso', out: 'Fuera' }
  const en: Record<string, string> = { in: 'Working', break_end: 'Working', break_start: 'On break', out: 'Out' }
  return (locale === 'en' ? en : es)[state ?? 'out'] ?? state ?? ''
}

const CODES = [
  'AUTH_REQUIRED', 'EMPLOYEE_NOT_FOUND', 'EMPLOYEE_INACTIVE', 'EMPLOYEE_LINK_LOCKED', 'EMPLOYEE_EMAIL_REQUIRED', 'PUNCH_KIND_INVALID',
  'PUNCH_SEQUENCE', 'PUNCH_NOT_FOUND', 'TIME_CLOCK_UNAVAILABLE', 'PLAN_LIMIT_EMPLOYEES', 'PLAN_FEATURE_UNAVAILABLE',
  'CORRECTION_INVALID_SEQUENCE', 'CORRECTION_INVALID', 'CORRECTION_TIME_INVALID', 'CORRECTION_REASON_REQUIRED', 'CORRECTION_LIMIT',
  'CORRECTION_NOT_FOUND', 'CORRECTION_NOT_PENDING', 'SELF_APPROVAL_FORBIDDEN', 'LEAVE_TYPE_INVALID', 'LEAVE_DATES_INVALID',
  'LEAVE_OVERLAP', 'LEAVE_NOT_FOUND', 'LEAVE_NOT_PENDING', 'SHIFT_OVERLAP', 'ACCESS_INVALID', 'ACCESS_EXPIRED',
  'ACCESS_EMAIL_MISMATCH', 'ACCESS_ALREADY_LINKED', 'ACCESS_USED', 'COMPANY_IMMUTABLE',
  'RULE_SET_INVALID', 'JURISDICTION_INVALID', 'MEAL_ALERT_NOT_FOUND', 'PIN_INVALID', 'PIN_TOO_SIMPLE', 'KIOSK_NAME_INVALID', 'KIOSK_LIMIT', 'KIOSK_NOT_FOUND', 'HISTORY_IMMUTABLE',
  // 0033
  'SUPERVISOR_INVALID', 'EMPLOYEE_ARCHIVED', 'EMPLOYEE_ACTIVE', 'EMPLOYEE_STATUS_INVALID', 'REASON_REQUIRED', 'DOCUMENT_PATH_INVALID', 'DOCUMENT_FILE_MISSING',
  'DOCUMENT_NOT_FOUND', 'DOCUMENT_ARCHIVED', 'PATTERN_INVALID', 'PATTERN_NOT_FOUND', 'PATTERN_ENDED', 'PATTERN_EMPLOYEE_LOCKED', 'RANGE_INVALID',
  'SHIFT_NOT_FOUND', 'SHIFT_STARTED', 'SHIFT_CHANGE_INVALID', 'SHIFT_CHANGE_PENDING', 'SHIFT_CHANGE_NOT_FOUND', 'SHIFT_CHANGE_NOT_PENDING', 'SHIFT_CHANGED',
  'RULE_SCOPE_INVALID', 'RULE_VALUES_INVALID', 'RULE_CHANGE_NOT_FOUND', 'RULE_CHANGE_NOT_PENDING', 'RULES_CHANGED_SINCE', 'ALERT_ACTION_INVALID', 'MEAL_ALERT_HANDLED',
] as const

export function wfErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/employees_number_uidx/.test(m)) return 'employee_number_taken'
  if (/departments_company_id_name_key/.test(m)) return 'department_exists'
  if (/work_shifts_check/.test(m)) return 'shift_invalid'
  if (error?.code === '42501' || /row-level security/.test(m)) return 'forbidden'
  if (error?.code === '23514') return 'invalid'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    auth_required: 'Inicia sesión para continuar.', forbidden: 'Tu rol no permite hacer esto.', invalid: 'Revisa los datos.',
    employee_not_found: 'No encontramos ese empleado (o no está a tu cargo).', employee_inactive: 'El empleado no está activo.',
    employee_link_locked: 'El acceso del empleado solo se cambia con su enlace.', employee_email_required: 'El empleado necesita un correo para recibir su acceso.',
    punch_kind_invalid: 'Ese ponche no es válido.', punch_sequence: 'Ese ponche no corresponde ahora (por ejemplo, ya marcaste la entrada).',
    punch_not_found: 'No encontramos ese ponche.', time_clock_unavailable: 'El reloj ponchador no está disponible: la suscripción de la empresa no está activa.',
    plan_limit_employees: 'Tu plan alcanzó el máximo de empleados activos. Desactiva alguno o mejora el plan.',
    plan_feature_unavailable: 'Tu plan no incluye esta función o la suscripción no está activa.',
    correction_invalid_sequence: 'Con esa corrección los ponches no quedarían en orden (entrada, descanso, salida). Revisa la hora.',
    correction_invalid: 'Completa el tipo de ponche y la hora.', correction_time_invalid: 'La hora debe estar en los últimos 62 días y no en el futuro.',
    correction_reason_required: 'Escribe el motivo (entre 3 y 300 caracteres).', correction_limit: 'Hay demasiadas correcciones pendientes para este empleado.',
    correction_not_found: 'No encontramos esa corrección (o no te corresponde decidirla).', correction_not_pending: 'Esa corrección ya fue decidida.',
    self_approval_forbidden: 'No puedes aprobar tu propia asistencia: debe decidirla otra persona.',
    leave_type_invalid: 'Elige el tipo de ausencia.', leave_dates_invalid: 'Revisa las fechas (un permiso parcial es de un solo día).',
    leave_overlap: 'Ya hay una solicitud en esas fechas.', leave_not_found: 'No encontramos esa solicitud (o no te corresponde decidirla).',
    leave_not_pending: 'Esa solicitud ya no se puede cambiar.', shift_overlap: 'Ese turno se cruza con otro del mismo empleado.',
    shift_invalid: 'El turno debe terminar después de empezar y durar como máximo 24 horas.',
    access_invalid: 'Este enlace ya no es válido: ya se usó, o tu empresa creó uno más reciente o retiró el acceso. Si ya vinculaste tu cuenta, abre tu reloj ponchador; si no, pide a tu supervisor el último enlace.',
    access_used: 'Este enlace ya se usó con otra cuenta. Pide un enlace nuevo a tu supervisor.', access_expired: 'El enlace de acceso expiró. Pide uno nuevo a tu supervisor.',
    access_email_mismatch: 'Este enlace es para otro correo. Inicia sesión con el correo que dio tu empresa.',
    access_already_linked: 'Tu cuenta ya está vinculada a otro empleado de esta empresa.',
    employee_number_taken: 'Ese número de empleado ya existe.', department_exists: 'Ya existe un departamento con ese nombre.',
    company_immutable: 'Los registros no se pueden mover a otra empresa.',
    unavailable: 'El módulo de personal todavía no está activado en esta base de datos.',
    pin_invalid: 'El PIN debe tener exactamente 6 dígitos.', pin_too_simple: 'Ese PIN es demasiado fácil (por ejemplo 123456 o 000000). Elige otro.',
    pin_mismatch: 'Los dos PIN no coinciden.', rule_set_invalid: 'Ese grupo de reglas no pertenece a la empresa.',
    jurisdiction_invalid: 'Esa jurisdicción no existe.', meal_alert_not_found: 'No encontramos esa alerta (o no te corresponde).',
    kiosk_name_invalid: 'Escribe un nombre para la tableta (máximo 60 caracteres).', kiosk_limit: 'Máximo 20 tabletas activas por empresa.',
    kiosk_not_found: 'No encontramos esa tableta.', history_immutable: 'Los registros de asistencia y su historial no se modifican.',
    confirm: 'Marca la casilla de confirmación.', save: 'No se pudo completar la acción. Inténtalo nuevamente.',
    supervisor_invalid: 'El supervisor debe ser un miembro activo de la empresa y no el propio empleado.', employee_archived: 'El empleado está archivado: desarchívalo primero.',
    employee_active: 'Solo se archiva un empleado inactivo o dado de baja.', employee_status_invalid: 'Ese estado no es válido.',
    reason_required: 'Escribe el motivo (al menos 3 caracteres).', document_path_invalid: 'El archivo no corresponde a ese empleado.',
    document_file_missing: 'El archivo no se subió. Inténtalo de nuevo.', document_not_found: 'No encontramos ese documento.', document_archived: 'El documento está archivado.',
    document_type: 'Solo PDF o imágenes (JPG, PNG, WEBP) de hasta 10 MB.',
    pattern_invalid: 'Revisa el patrón: días, horas y un descanso menor que el turno.', pattern_not_found: 'No encontramos ese patrón (o no está a tu cargo).',
    pattern_ended: 'Ese patrón ya terminó.', pattern_employee_locked: 'Un patrón no se mueve a otro empleado.', range_invalid: 'El periodo es demasiado largo o no es válido.',
    shift_not_found: 'No encontramos ese turno.', shift_started: 'Ese turno ya empezó: no se puede cambiar.', shift_change_invalid: 'Revisa las horas propuestas (futuras, máximo 24 horas).',
    shift_change_pending: 'Ese turno ya tiene una solicitud pendiente.', shift_change_not_found: 'No encontramos esa solicitud (o no te corresponde decidirla).',
    shift_change_not_pending: 'Esa solicitud ya fue decidida.', shift_changed: 'El turno cambió después de la solicitud: revísalo y decide de nuevo.',
    rule_scope_invalid: 'Ese grupo o empleado no pertenece a la empresa.', rule_values_invalid: 'Algún valor está fuera de rango.',
    rule_change_not_found: 'No encontramos ese cambio.', rule_change_not_pending: 'Ese cambio ya fue aplicado o descartado.',
    rules_changed_since: 'Las reglas cambiaron después de esta propuesta. Descártala y propón de nuevo con los valores actuales.',
    alert_action_invalid: 'Elige la acción tomada.', meal_alert_handled: 'Esa alerta ya fue atendida.',
  },
  en: {
    auth_required: 'Sign in to continue.', forbidden: 'Your role cannot do this.', invalid: 'Check the details.',
    employee_not_found: 'We could not find that employee (or they are not under you).', employee_inactive: 'The employee is not active.',
    employee_link_locked: 'An employee login is only changed with their link.', employee_email_required: 'The employee needs an email to receive access.',
    punch_kind_invalid: 'That punch is not valid.', punch_sequence: 'That punch does not apply now (for example, you already clocked in).',
    punch_not_found: 'We could not find that punch.', time_clock_unavailable: 'The time clock is unavailable: the company subscription is not active.',
    plan_limit_employees: 'Your plan reached its active employee limit. Deactivate one or upgrade the plan.',
    plan_feature_unavailable: 'Your plan does not include this feature or the subscription is not active.',
    correction_invalid_sequence: 'With that correction the punches would be out of order (in, break, out). Check the time.',
    correction_invalid: 'Fill in the punch type and the time.', correction_time_invalid: 'The time must be within the last 62 days and not in the future.',
    correction_reason_required: 'Write the reason (3 to 300 characters).', correction_limit: 'There are too many pending corrections for this employee.',
    correction_not_found: 'We could not find that correction (or it is not yours to decide).', correction_not_pending: 'That correction was already decided.',
    self_approval_forbidden: 'You cannot approve your own attendance: someone else must decide it.',
    leave_type_invalid: 'Choose the type of leave.', leave_dates_invalid: 'Check the dates (a partial leave is a single day).',
    leave_overlap: 'There is already a request on those dates.', leave_not_found: 'We could not find that request (or it is not yours to decide).',
    leave_not_pending: 'That request can no longer be changed.', shift_overlap: 'That shift overlaps another one of the same employee.',
    shift_invalid: 'The shift must end after it starts and last 24 hours at most.',
    access_invalid: 'This link is no longer valid: it was already used, or your company created a newer one or removed the access. If you already linked your account, open your time clock; otherwise ask your supervisor for the latest link.',
    access_used: 'This link was already used with another account. Ask your supervisor for a new link.', access_expired: 'The access link expired. Ask your supervisor for a new one.',
    access_email_mismatch: 'This link is for another email. Sign in with the email your company gave.',
    access_already_linked: 'Your account is already linked to another employee of this company.',
    employee_number_taken: 'That employee number already exists.', department_exists: 'A department with that name already exists.',
    company_immutable: 'Records cannot be moved to another company.',
    unavailable: 'The workforce module is not enabled in this database yet.',
    pin_invalid: 'The PIN must have exactly 6 digits.', pin_too_simple: 'That PIN is too easy (for example 123456 or 000000). Choose another.',
    pin_mismatch: 'The two PINs do not match.', rule_set_invalid: 'That rule group does not belong to the company.',
    jurisdiction_invalid: 'That jurisdiction does not exist.', meal_alert_not_found: 'We could not find that alert (or it is not yours).',
    kiosk_name_invalid: 'Write a name for the tablet (60 characters max).', kiosk_limit: 'Up to 20 active tablets per company.',
    kiosk_not_found: 'We could not find that tablet.', history_immutable: 'Attendance records and their history are never changed.',
    confirm: 'Tick the confirmation box.', save: 'The action could not be completed. Please try again.',
    supervisor_invalid: 'The supervisor must be an active member of the company and not the employee.', employee_archived: 'The employee is archived: unarchive first.',
    employee_active: 'Only an inactive or terminated employee can be archived.', employee_status_invalid: 'That status is not valid.',
    reason_required: 'Write the reason (at least 3 characters).', document_path_invalid: 'The file does not belong to that employee.',
    document_file_missing: 'The file was not uploaded. Try again.', document_not_found: 'We could not find that document.', document_archived: 'The document is archived.',
    document_type: 'Only PDF or images (JPG, PNG, WEBP) up to 10 MB.',
    pattern_invalid: 'Check the pattern: days, times and a break shorter than the shift.', pattern_not_found: 'We could not find that pattern (or it is not under you).',
    pattern_ended: 'That pattern has ended.', pattern_employee_locked: 'A pattern cannot move to another employee.', range_invalid: 'The period is too long or not valid.',
    shift_not_found: 'We could not find that shift.', shift_started: 'That shift already started: it cannot be changed.', shift_change_invalid: 'Check the proposed times (future, 24 hours at most).',
    shift_change_pending: 'That shift already has a pending request.', shift_change_not_found: 'We could not find that request (or it is not yours to decide).',
    shift_change_not_pending: 'That request was already decided.', shift_changed: 'The shift changed after the request: review it and decide again.',
    rule_scope_invalid: 'That group or employee does not belong to the company.', rule_values_invalid: 'A value is out of range.',
    rule_change_not_found: 'We could not find that change.', rule_change_not_pending: 'That change was already applied or discarded.',
    rules_changed_since: 'The rules changed after this proposal. Discard it and propose again with the current values.',
    alert_action_invalid: 'Choose the action taken.', meal_alert_handled: 'That alert was already handled.',
  },
}

export function wfMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

/** Local date + time ('YYYY-MM-DD', 'HH:MM') in a time zone → ISO instant. */
export function zonedToIso(day: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null
  const guess = Date.parse(`${day}T${time}:00Z`)
  if (Number.isNaN(guess)) return null
  // Offset of the zone at that moment (two passes cover DST edges).
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t))
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t
  }
  let t = guess - offset(guess)
  t = guess - offset(t)
  return new Date(t).toISOString()
}

/** Instant → local 'HH:MM' in a time zone. */
export function localTime(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

/** Kiosk answers (kiosk_punch status) → message. One message for every credential failure. */
export function kioskMessage(status: string, locale: Locale): string {
  const es: Record<string, string> = {
    invalid: 'Número o PIN incorrecto, o acceso bloqueado temporalmente. Inténtalo de nuevo o avisa a tu supervisor.',
    kiosk_invalid: 'Esta tableta no está activada o fue desactivada. Pide a un administrador que la active.',
    kiosk_locked: 'Demasiados intentos fallidos en esta tableta. Espera 10 minutos.',
    sequence: 'Ese ponche no corresponde ahora (por ejemplo, ya marcaste la entrada).',
    unavailable: 'El reloj ponchador no está disponible ahora.',
  }
  const en: Record<string, string> = {
    invalid: 'Wrong number or PIN, or access temporarily locked. Try again or tell your supervisor.',
    kiosk_invalid: 'This tablet is not activated or was deactivated. Ask an admin to activate it.',
    kiosk_locked: 'Too many failed attempts on this tablet. Wait 10 minutes.',
    sequence: 'That punch does not apply now (for example, you already clocked in).',
    unavailable: 'The time clock is not available right now.',
  }
  return (locale === 'en' ? en : es)[status] ?? (locale === 'en' ? en : es).invalid
}

export const KIOSK_COOKIE = 'ba_kiosk'

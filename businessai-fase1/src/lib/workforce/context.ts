/**
 * Workforce (migration 0020): who the signed-in user is for the module and
 * the company rules. RLS and the 0020 functions decide every read and write;
 * this only chooses what to show.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { DEFAULT_RULES, type Rules } from '@/lib/workforce/hours'

export type WorkforceAccess = { companyId: string; manages: boolean; supervisedDepartments: string[]; available: boolean }

export async function workforceAccess(supabase: SupabaseClient, companyId: string, userId: string): Promise<WorkforceAccess> {
  const [{ data: manages, error }, { data: sup }] = await Promise.all([
    supabase.rpc('wf_manages', { target: companyId }),
    supabase.from('department_supervisors').select('department_id').eq('company_id', companyId).eq('user_id', userId),
  ])
  return {
    companyId,
    manages: !error && manages === true,
    supervisedDepartments: ((sup ?? []) as { department_id: string }[]).map((r) => r.department_id),
    available: !error,
  }
}

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
  }
}

export type RuleSet = {
  id: string; name: string; jurisdiction: string | null; exempt: boolean; daily_overtime_after_minutes: number | null
  weekly_overtime_after_minutes: number | null; overtime_multiplier: number; meal_break_after_minutes: number | null
  meal_break_min_minutes: number | null; meal_alert_before_minutes: number; archived_at: string | null
}

/** Rules of one employee: its group (0022) over the company defaults. Mirrors public.wf_rules. */
export function rulesFor(defaults: Rules, set: RuleSet | null | undefined): Rules {
  if (!set || set.archived_at) return defaults
  return {
    ...defaults,
    exempt: set.exempt,
    dailyOvertimeAfter: set.daily_overtime_after_minutes,
    weeklyOvertimeAfter: set.weekly_overtime_after_minutes,
    mealAfterMinutes: set.meal_break_after_minutes,
    mealMinMinutes: set.meal_break_min_minutes,
  }
}

/** Rule groups of a company (empty without migration 0022). */
export async function ruleSets(supabase: SupabaseClient, companyId: string): Promise<RuleSet[]> {
  const { data, error } = await supabase.from('labor_rule_sets').select('*').eq('company_id', companyId).order('name')
  return error ? [] : ((data ?? []) as RuleSet[])
}

export const LEAVE_TYPES = ['vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other'] as const
export const PUNCH_KINDS = ['in', 'break_start', 'break_end', 'out'] as const

export function leaveLabel(t: string, locale: Locale): string {
  const es: Record<string, string> = { vacation: 'Vacaciones', sick: 'Enfermedad', personal: 'Asunto personal', unpaid: 'Sin sueldo', day_off: 'Día libre', other: 'Otro' }
  const en: Record<string, string> = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', day_off: 'Day off', other: 'Other' }
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
  'ACCESS_EMAIL_MISMATCH', 'ACCESS_ALREADY_LINKED', 'COMPANY_IMMUTABLE',
  'RULE_SET_INVALID', 'JURISDICTION_INVALID', 'MEAL_ALERT_NOT_FOUND', 'PIN_INVALID', 'PIN_TOO_SIMPLE', 'KIOSK_NAME_INVALID', 'KIOSK_LIMIT', 'KIOSK_NOT_FOUND', 'HISTORY_IMMUTABLE',
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
    access_invalid: 'El enlace de acceso no es válido.', access_expired: 'El enlace de acceso expiró. Pide uno nuevo a tu supervisor.',
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
    access_invalid: 'The access link is not valid.', access_expired: 'The access link expired. Ask your supervisor for a new one.',
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

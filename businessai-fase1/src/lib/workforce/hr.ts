/**
 * Workforce / HR helpers (migration 0033) shared by the server actions, the
 * pages and the browser uploader. Pure functions: no database access.
 */
export const HR_BUCKET = 'HR-documents'
export const HR_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export const HR_DOC_MAX_BYTES = 10 * 1024 * 1024

export function validateHrDocument(file: { type: string; size: number }): 'document_type' | null {
  if (!(HR_DOC_TYPES as readonly string[]).includes(file.type) || file.size <= 0 || file.size > HR_DOC_MAX_BYTES) return 'document_type'
  return null
}

/** Storage path <company>/<employee>/<uuid>-<safe name> (the database checks company and employee). */
export function hrDocumentPath(companyId: string, employeeId: string, uuid: string, fileName: string): string {
  const safe = fileName.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'documento'
  return `${companyId}/${employeeId}/${uuid}-${safe}`
}

/** Keys a rule change may carry per scope (mirrors public.wf_rule_values_problem). */
export const RULE_KEYS = {
  company: ['jurisdiction', 'timezone', 'week_starts_on', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', 'overtime_multiplier',
    'grace_minutes', 'meal_break_after_minutes', 'meal_break_min_minutes', 'meal_alert_before_minutes', 'overnight_attribution'],
  rule_set: ['jurisdiction', 'exempt', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', 'overtime_multiplier',
    'meal_break_after_minutes', 'meal_break_min_minutes', 'meal_alert_before_minutes'],
  employee: ['exempt', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', 'overtime_multiplier',
    'meal_break_after_minutes', 'meal_break_min_minutes', 'meal_alert_before_minutes'],
} as const
export type RuleScope = keyof typeof RULE_KEYS
export type RuleValues = Record<string, string | number | boolean | null>

/** Only the keys whose proposed value differs from the current one (a proposal shows exactly what changes). */
export function ruleDiff(current: RuleValues, proposed: RuleValues): RuleValues {
  const out: RuleValues = {}
  for (const [k, v] of Object.entries(proposed)) {
    const a = current[k] ?? null
    const b = v ?? null
    if (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-9 : String(a) !== String(b)) out[k] = b
  }
  return out
}

/** Hours typed in a form ("8", "7.5", "") → minutes or null; invalid → undefined. */
export function hoursToMinutes(raw: string): number | null | undefined {
  const t = raw.trim()
  if (t === '') return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined
  return Math.round(Number(t) * 60)
}

/** A whole number typed in a form, or null when empty; invalid → undefined. */
export function wholeNumber(raw: string): number | null | undefined {
  const t = raw.trim()
  if (t === '') return null
  return /^\d{1,5}$/.test(t) ? Number(t) : undefined
}

/** Human value of a rule for the proposal diff (minutes shown as hours where it reads better). */
export function ruleValueLabel(key: string, value: unknown, locale: 'es' | 'en'): string {
  if (value === null || value === undefined) return locale === 'en' ? 'does not apply' : 'no aplica'
  if (typeof value === 'boolean') return value ? (locale === 'en' ? 'yes' : 'sí') : 'no'
  if (typeof value === 'number' && /_after_minutes$/.test(key)) return `${Math.round((value / 60) * 100) / 100} h`
  if (typeof value === 'number' && /_minutes$/.test(key)) return `${value} min`
  if (key === 'overnight_attribution') return value === 'split_midnight' ? (locale === 'en' ? 'split at midnight' : 'dividir a medianoche') : (locale === 'en' ? 'day it starts' : 'día en que empieza')
  if (key === 'week_starts_on') return (locale === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'])[Number(value)] ?? String(value)
  return String(value)
}

export function ruleKeyLabel(key: string, locale: 'es' | 'en'): string {
  const es: Record<string, string> = {
    jurisdiction: 'Jurisdicción', timezone: 'Zona horaria', week_starts_on: 'Inicio de semana', daily_overtime_after_minutes: 'Extra después de (día)',
    weekly_overtime_after_minutes: 'Extra después de (semana)', overtime_multiplier: 'Multiplicador', grace_minutes: 'Tolerancia de tardanza',
    meal_break_after_minutes: 'Comida antes de', meal_break_min_minutes: 'Comida mínima', meal_alert_before_minutes: 'Avisar antes',
    overnight_attribution: 'Turnos nocturnos', exempt: 'Exento de extras', overrides: 'Excepciones', reason: 'Motivo', name: 'Nombre', archived: 'Archivado',
  }
  const en: Record<string, string> = {
    jurisdiction: 'Jurisdiction', timezone: 'Time zone', week_starts_on: 'Week starts', daily_overtime_after_minutes: 'Overtime after (day)',
    weekly_overtime_after_minutes: 'Overtime after (week)', overtime_multiplier: 'Multiplier', grace_minutes: 'Late grace',
    meal_break_after_minutes: 'Meal before', meal_break_min_minutes: 'Minimum meal', meal_alert_before_minutes: 'Alert before',
    overnight_attribution: 'Overnight shifts', exempt: 'Overtime exempt', overrides: 'Exceptions', reason: 'Reason', name: 'Name', archived: 'Archived',
  }
  return (locale === 'en' ? en : es)[key] ?? key
}

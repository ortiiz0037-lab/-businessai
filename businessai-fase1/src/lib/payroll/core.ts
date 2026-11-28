/**
 * Payroll (migration 0034) — pure helpers shared by the server actions, the
 * pages, the CSV export and the pay stub. The database computes and stores
 * every amount (public.payroll_prepare); these helpers only mirror its rules
 * for presentation, suggest periods and turn Workforce hours into the input
 * the database verifies against the time clock.
 */
import type { Locale } from '@/lib/i18n/app'
import type { ReportRow } from '@/lib/workforce/report'
import { addDays } from '@/lib/workforce/hours'

export const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
export type Frequency = (typeof FREQUENCIES)[number]
export const PERIODS_PER_YEAR: Record<Frequency, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

/** Half away from zero to whole cents (public.payroll_round). Exact with bigint arithmetic on a rational value. */
export function roundCents(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator')
  const neg = numerator < 0n
  const n = neg ? -numerator : numerator
  const q = n / denominator
  const r = n % denominator
  const out = r * 2n >= denominator ? q + 1n : q
  return neg ? -out : out
}

/** Minutes × rate in cents per hour (× multiplier as a 2-decimal number) → cents, rounded once. Mirrors payroll_prepare. */
export function minutesPay(minutes: number, rateCents: bigint, multiplier = 1): bigint {
  const m100 = BigInt(Math.round(multiplier * 100))
  return roundCents(BigInt(minutes) * rateCents * m100, 60n * 100n)
}
export const salaryPerPeriod = (annualCents: bigint, f: Frequency) => roundCents(annualCents, BigInt(PERIODS_PER_YEAR[f]))
export const percentOf = (cents: bigint, bp: number) => roundCents(cents * BigInt(bp), 10000n)

const lastDay = (day: string) => addDays(`${addDays(`${day.slice(0, 7)}-01`, 32).slice(0, 7)}-01`, -1)

/** Is [start, end] a valid period for the frequency? Mirrors public.payroll_period_ok. */
export function periodOk(f: Frequency, start: string, end: string): boolean {
  const d = Number(start.slice(8, 10)), e = Number(end.slice(8, 10))
  if (f === 'weekly') return end === addDays(start, 6)
  if (f === 'biweekly') return end === addDays(start, 13)
  if (f === 'monthly') return d === 1 && end === lastDay(start)
  return start.slice(0, 7) === end.slice(0, 7) && ((d === 1 && e === 15) || (d === 16 && end === lastDay(start)))
}

/** The period that contains `day` (weekly / biweekly anchored on `anchor`, a period start). */
export function periodContaining(f: Frequency, day: string, anchor: string): { start: string; end: string } {
  if (f === 'monthly') return { start: `${day.slice(0, 7)}-01`, end: lastDay(day) }
  if (f === 'semimonthly') return Number(day.slice(8, 10)) <= 15 ? { start: `${day.slice(0, 7)}-01`, end: `${day.slice(0, 7)}-15` } : { start: `${day.slice(0, 7)}-16`, end: lastDay(day) }
  const len = f === 'weekly' ? 7 : 14
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000)
  const start = addDays(anchor, Math.floor(diff / len) * len)
  return { start, end: addDays(start, len - 1) }
}
/** The last closed period before `today` (a payroll is prepared once the period is over). */
export function lastClosedPeriod(f: Frequency, today: string, anchor: string) {
  const cur = periodContaining(f, today, anchor)
  return periodContaining(f, addDays(cur.start, -1), anchor)
}

/** Workforce report rows → the hours payload the database verifies (regular / overtime minutes per employee). */
export function hoursPayload(rows: Pick<ReportRow, 'id' | 'totals'>[]) {
  return rows.filter((r) => r.totals.workedMinutes > 0)
    .map((r) => ({ employee_id: r.id, regular_minutes: r.totals.regularMinutes, overtime_minutes: r.totals.overtimeMinutes }))
}

export const hoursLabel = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`

const LABELS: Record<string, [string, string]> = {
  weekly: ['Semanal', 'Weekly'], biweekly: ['Cada dos semanas', 'Every two weeks'], semimonthly: ['Quincenal (1–15 y 16–fin)', 'Semimonthly (1–15, 16–end)'],
  monthly: ['Mensual', 'Monthly'], draft: ['Borrador', 'Draft'], approved: ['Aprobada', 'Approved'], paid: ['Pagada', 'Paid'], reversed: ['Revertida', 'Reversed'],
  discarded: ['Descartada', 'Discarded'], regular: ['Ordinaria', 'Regular'], correction: ['Corrección', 'Correction'], hourly: ['Por hora', 'Hourly'], salary: ['Salario fijo', 'Salary'],
  earning: ['Ingreso', 'Earning'], deduction: ['Deducción', 'Deduction'], fixed: ['Monto fijo', 'Fixed amount'], percent: ['Porcentaje del bruto', 'Percent of gross'],
  no_compensation: ['Sin compensación registrada', 'No compensation on record'], open_session: ['Ponche sin salida en el periodo', 'A session without clock-out'],
  net_negative: ['Las deducciones superan el bruto', 'Deductions exceed gross'], salaried_overtime_rate_missing: ['Asalariado no exento con horas extra: falta su tarifa de extra', 'Salaried non-exempt with overtime: overtime rate missing'],
  rules_unavailable: ['Reglas de horas no disponibles para este empleado', 'Hour rules unavailable for this employee'],
  rate_changed_in_period: ['La tarifa cambió dentro del periodo (se usa la vigente al cierre)', 'The rate changed within the period (the one in effect at the end is used)'],
  partial_period_review: ['Ingreso o baja dentro del periodo: revisar (no se prorratea)', 'Hired or terminated within the period: review (no proration)'],
}
export const payrollLabel = (code: string, locale: Locale) => LABELS[code]?.[locale === 'en' ? 1 : 0] ?? code
export const BLOCKING_ISSUES = new Set(['no_compensation', 'open_session', 'net_negative', 'salaried_overtime_rate_missing', 'rules_unavailable'])

const CODES = ['FORBIDDEN', 'EMPLOYEE_NOT_FOUND', 'REASON_REQUIRED', 'EFFECTIVE_DATE_INVALID', 'COMPENSATION_INVALID', 'COMPENSATION_PERIOD_LOCKED',
  'PAYROLL_ITEM_EXISTS', 'PAYROLL_ITEM_INVALID', 'PAYROLL_ITEM_NOT_FOUND', 'PAYROLL_PERIOD_INVALID', 'PAYROLL_PERIOD_EXISTS', 'PAYROLL_RUN_NOT_FOUND',
  'PAYROLL_RUN_LOCKED', 'PAYROLL_RUN_NOT_CORRECTABLE', 'PAYROLL_HOURS_INVALID', 'PAYROLL_HOURS_MISMATCH', 'PAYROLL_TAX_ENGINE_NOT_AVAILABLE',
  'PAYROLL_ALREADY_APPROVED', 'PAYROLL_NOT_PREPARED', 'PAYROLL_PREVIEW_STALE', 'PAYROLL_BLOCKING_ISSUES', 'SELF_APPROVAL_FORBIDDEN', 'PAYROLL_ALREADY_PAID',
  'PAYMENT_DATE_INVALID', 'PAYROLL_HAS_CORRECTIONS', 'ACCOUNT_INVALID', 'PAYROLL_SETTINGS_INVALID', 'PAYROLL_ACCOUNTS_MISSING', 'PERIOD_CLOSED', 'LEDGER_NOT_INITIALIZED'] as const

export function payrollErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === 'PGRST202' || /could not find the function/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    forbidden: 'Tu rol o tu plan no permite hacer esto en nómina.', employee_not_found: 'No encontramos ese empleado (o tu rol no gestiona la nómina).',
    reason_required: 'Escribe el motivo (al menos 3 caracteres).', effective_date_invalid: 'Revisa la fecha efectiva.',
    compensation_invalid: 'Completa la tarifa por hora o el salario anual según el tipo de pago.',
    compensation_period_locked: 'Esa fecha cae en un periodo ya aprobado: corrígelo con una nómina de corrección.',
    payroll_item_exists: 'Ya existe un concepto con ese código.', payroll_item_invalid: 'Revisa el concepto y su monto o porcentaje.', payroll_item_not_found: 'No encontramos ese concepto.',
    payroll_period_invalid: 'El periodo no corresponde a la frecuencia (o la fecha de pago no es válida).', payroll_period_exists: 'Ya hay una nómina para ese periodo.',
    payroll_run_not_found: 'No encontramos esa nómina (o tu rol no lo permite).', payroll_run_locked: 'La nómina ya no es un borrador: no se modifica.',
    payroll_run_not_correctable: 'Solo se corrige una nómina ordinaria aprobada o pagada.', payroll_hours_invalid: 'Las horas enviadas no son válidas.',
    payroll_hours_mismatch: 'Las horas no coinciden con el reloj ponchador. Vuelve a preparar la nómina.',
    payroll_tax_engine_not_available: 'Hay una regla de impuestos activada sin un cálculo verificado: la nómina se detuvo para no adivinar.',
    payroll_already_approved: 'Esta nómina ya fue aprobada.', payroll_not_prepared: 'Prepara la nómina antes de aprobarla.',
    payroll_preview_stale: 'La vista previa cambió (alguien la recalculó o añadió ajustes). Revísala de nuevo y aprueba.',
    payroll_blocking_issues: 'Hay empleados con problemas que impiden aprobar. Resuélvelos primero.',
    self_approval_forbidden: 'Debe aprobarla otra persona (se requiere un segundo aprobador).', payroll_already_paid: 'El pago ya fue registrado.',
    payment_date_invalid: 'La fecha de pago no puede ser futura ni anterior al periodo.', payroll_has_corrections: 'Revierte primero sus nóminas de corrección.',
    account_invalid: 'Elige cuentas activas del tipo correcto.', payroll_settings_invalid: 'Revisa la configuración.', payroll_accounts_missing: 'Faltan cuentas contables para la nómina.',
    period_closed: 'El periodo contable está cerrado.', ledger_not_initialized: 'Inicia la contabilidad antes de usar la nómina.',
    unavailable: 'La nómina todavía no está activada en esta base de datos.', confirm: 'Marca la casilla de confirmación.', invalid: 'Revisa los datos.',
    save: 'No se pudo completar la acción. Inténtalo nuevamente.',
  },
  en: {
    forbidden: 'Your role or plan cannot do this in payroll.', employee_not_found: 'We could not find that employee (or your role does not manage payroll).',
    reason_required: 'Write the reason (at least 3 characters).', effective_date_invalid: 'Check the effective date.',
    compensation_invalid: 'Fill in the hourly rate or the annual salary for the pay type.',
    compensation_period_locked: 'That date falls in an approved period: fix it with a correction run.',
    payroll_item_exists: 'An item with that code already exists.', payroll_item_invalid: 'Check the item and its amount or percentage.', payroll_item_not_found: 'We could not find that item.',
    payroll_period_invalid: 'The period does not match the frequency (or the pay date is not valid).', payroll_period_exists: 'There is already a payroll for that period.',
    payroll_run_not_found: 'We could not find that payroll (or your role does not allow it).', payroll_run_locked: 'The payroll is no longer a draft: it cannot be changed.',
    payroll_run_not_correctable: 'Only an approved or paid regular payroll can be corrected.', payroll_hours_invalid: 'The submitted hours are not valid.',
    payroll_hours_mismatch: 'The hours do not match the time clock. Prepare the payroll again.',
    payroll_tax_engine_not_available: 'A tax rule is enabled without a verified calculation: payroll stopped rather than guess.',
    payroll_already_approved: 'This payroll was already approved.', payroll_not_prepared: 'Prepare the payroll before approving it.',
    payroll_preview_stale: 'The preview changed (someone recalculated it or added adjustments). Review it again and approve.',
    payroll_blocking_issues: 'Some employees have issues that prevent approval. Resolve them first.',
    self_approval_forbidden: 'Someone else must approve it (a second approver is required).', payroll_already_paid: 'The payment was already recorded.',
    payment_date_invalid: 'The payment date cannot be in the future or before the period.', payroll_has_corrections: 'Reverse its correction runs first.',
    account_invalid: 'Choose active accounts of the right type.', payroll_settings_invalid: 'Check the settings.', payroll_accounts_missing: 'Payroll ledger accounts are missing.',
    period_closed: 'The accounting period is closed.', ledger_not_initialized: 'Start the accounting before using payroll.',
    unavailable: 'Payroll is not enabled in this database yet.', confirm: 'Tick the confirmation box.', invalid: 'Check the details.',
    save: 'The action could not be completed. Please try again.',
  },
}
export const payrollMessage = (code: string | null | undefined, locale: Locale) => (code ? MESSAGES[locale][code] ?? MESSAGES[locale].save : null)

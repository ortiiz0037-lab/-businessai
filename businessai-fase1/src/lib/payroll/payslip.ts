/**
 * Pay stub as a Document Studio document (blocks drawn by the Studio layout
 * engine and PDF writer — the same rendering as every Studio document).
 * Built from the stored payroll line: nothing is recomputed here.
 */
import type { DocContent } from '@/lib/studio/model'
import type { Locale } from '@/lib/i18n/app'
import { formatCents } from '@/lib/finance/money'
import { hoursLabel, payrollLabel } from '@/lib/payroll/core'

export type PayslipLine = { employee_name: string; employee_number: string | null; pay_type: string | null; hourly_rate_cents: string | null; annual_salary_cents: string | null
  overtime_multiplier: string | null; regular_minutes: number; overtime_minutes: number; leave_paid_minutes: number; regular_pay_cents: string; overtime_pay_cents: string
  leave_pay_cents: string; salary_pay_cents: string; other_earnings_cents: string; gross_cents: string; deductions_cents: string; taxes_cents: string; net_cents: string }
export type PayslipRun = { period_start: string; period_end: string; pay_date: string; status: string; run_type: string; payment_date: string | null }
export type PayslipItem = { kind: string; label: string; amount_cents: string }

/** Plain text for a Studio block (no markup characters a block would refuse). */
const safe = (s: string) => s.replace(/[<>{}]/g, '').slice(0, 300)

export function payslipContent(line: PayslipLine, run: PayslipRun, items: PayslipItem[], company: string, locale: Locale, currency: string): DocContent {
  const tr = (es: string, en: string) => (locale === 'en' ? en : es)
  const m = (c: string | null) => formatCents(c ?? 0, locale, currency)
  const rows: string[][] = [[tr('Concepto', 'Item'), tr('Horas', 'Hours'), tr('Importe', 'Amount')]]
  if (BigInt(line.regular_pay_cents) > 0n) rows.push([tr('Horas regulares', 'Regular hours'), hoursLabel(line.regular_minutes), m(line.regular_pay_cents)])
  if (BigInt(line.overtime_pay_cents) > 0n) rows.push([`${tr('Horas extra', 'Overtime')}${line.overtime_multiplier ? ` ×${Number(line.overtime_multiplier)}` : ''}`, hoursLabel(line.overtime_minutes), m(line.overtime_pay_cents)])
  if (BigInt(line.leave_pay_cents) > 0n) rows.push([tr('Licencia pagada', 'Paid leave'), hoursLabel(line.leave_paid_minutes), m(line.leave_pay_cents)])
  if (BigInt(line.salary_pay_cents) > 0n) rows.push([tr('Salario del periodo', 'Salary for the period'), '', m(line.salary_pay_cents)])
  for (const i of items.filter((x) => x.kind === 'earning')) rows.push([safe(i.label), '', m(i.amount_cents)])
  rows.push([tr('BRUTO', 'GROSS'), '', m(line.gross_cents)])
  for (const i of items.filter((x) => x.kind === 'deduction')) rows.push([`− ${safe(i.label)}`, '', m(i.amount_cents)])
  rows.push([tr('Impuestos y retenciones', 'Taxes and withholdings'), '', tr('no calculados', 'not calculated')])
  rows.push([tr('NETO', 'NET'), '', m(line.net_cents)])
  const rate = line.pay_type === 'hourly' ? `${m(line.hourly_rate_cents)} / h` : line.pay_type === 'salary' ? `${m(line.annual_salary_cents)} / ${tr('año', 'year')}` : '—'
  return { v: 1, blocks: [
    { type: 'heading', level: 1, text: tr('Recibo de nómina', 'Pay stub') },
    { type: 'paragraph', text: safe(company) },
    { type: 'fields', rows: [
      [tr('Empleado', 'Employee'), safe(line.employee_name)], [tr('Número', 'Number'), safe(line.employee_number ?? '—')],
      [tr('Periodo', 'Period'), `${run.period_start} – ${run.period_end}`], [tr('Fecha de pago', 'Pay date'), run.payment_date ?? run.pay_date],
      [tr('Tipo de pago', 'Pay type'), line.pay_type ? payrollLabel(line.pay_type, locale) : '—'], [tr('Tarifa', 'Rate'), rate],
      [tr('Estado', 'Status'), payrollLabel(run.status, locale) + (run.run_type === 'correction' ? ` · ${payrollLabel('correction', locale)}` : '')],
    ] },
    { type: 'spacer', size: 4 },
    { type: 'table', header: true, widths: [55, 15, 30], rows },
    { type: 'spacer', size: 4 },
    { type: 'paragraph', size: 8, text: tr('Impuestos y retenciones no calculados: las reglas de Puerto Rico y federales están desactivadas hasta contar con reglas verificadas y aprobadas. Este recibo no es asesoría legal ni contributiva.',
      'Taxes and withholdings not calculated: Puerto Rico and federal rules stay disabled until verified and approved rules exist. This pay stub is not legal or tax advice.') },
  ] }
}

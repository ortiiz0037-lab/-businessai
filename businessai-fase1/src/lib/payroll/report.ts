/**
 * Payroll reports (0034), read with the user's session (payroll.view): per
 * period (approved / paid runs) and per employee over a date range. Reversed,
 * discarded and draft runs are never counted. Amounts are integer cents.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { toCsv } from '@/lib/workforce/hours'
import { hoursLabel } from '@/lib/payroll/core'

export type RunRow = { id: string; run_type: string; pay_frequency: string; period_start: string; period_end: string; pay_date: string; status: string
  gross_cents: string; deductions_cents: string; net_cents: string; employees: number; payment_date: string | null; payment_reference: string | null }
export type EmployeeTotals = { employee_id: string; name: string; number: string | null; runs: number; regular_minutes: number; overtime_minutes: number
  leave_minutes: number; gross: bigint; deductions: bigint; net: bigint }

export async function payrollSummary(supabase: SupabaseClient, companyId: string, from: string, to: string) {
  const { data: runData } = await supabase.from('payroll_runs')
    .select('id, run_type, pay_frequency, period_start, period_end, pay_date, status, gross_cents, deductions_cents, net_cents, employees, payment_date, payment_reference')
    .eq('company_id', companyId).in('status', ['approved', 'paid']).gte('period_end', from).lte('period_end', to).order('period_end')
  const runs = (runData ?? []) as RunRow[]
  const ids = runs.map((r) => r.id)
  const { data: lineData } = ids.length
    ? await supabase.from('payroll_lines').select('run_id, employee_id, employee_name, employee_number, regular_minutes, overtime_minutes, leave_paid_minutes, gross_cents, deductions_cents, net_cents').in('run_id', ids)
    : { data: [] }
  const by = new Map<string, EmployeeTotals>()
  for (const l of (lineData ?? []) as { employee_id: string; employee_name: string; employee_number: string | null; regular_minutes: number; overtime_minutes: number; leave_paid_minutes: number; gross_cents: string; deductions_cents: string; net_cents: string }[]) {
    const t = by.get(l.employee_id) ?? { employee_id: l.employee_id, name: l.employee_name, number: l.employee_number, runs: 0, regular_minutes: 0, overtime_minutes: 0, leave_minutes: 0, gross: 0n, deductions: 0n, net: 0n }
    t.runs += 1; t.regular_minutes += l.regular_minutes; t.overtime_minutes += l.overtime_minutes; t.leave_minutes += l.leave_paid_minutes
    t.gross += BigInt(l.gross_cents); t.deductions += BigInt(l.deductions_cents); t.net += BigInt(l.net_cents)
    by.set(l.employee_id, t)
  }
  const employees = [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
  const totals = runs.reduce((t, r) => ({ gross: t.gross + BigInt(r.gross_cents), deductions: t.deductions + BigInt(r.deductions_cents), net: t.net + BigInt(r.net_cents) }), { gross: 0n, deductions: 0n, net: 0n })
  return { runs, employees, totals }
}

const dec = (c: bigint | string) => { const v = BigInt(c); const s = v < 0n ? '-' : ''; const a = v < 0n ? -v : v; return `${s}${a / 100n}.${String(a % 100n).padStart(2, '0')}` }
const NOTE = { es: 'Impuestos no calculados (reglas desactivadas). No es asesoría legal ni contributiva.', en: 'Taxes not calculated (rules disabled). Not legal or tax advice.' }

export function employeesCsv(rows: EmployeeTotals[], locale: 'es' | 'en') {
  const en = locale === 'en'
  return toCsv([
    en ? ['Employee', 'Number', 'Runs', 'Regular hours', 'Overtime hours', 'Paid leave hours', 'Gross', 'Deductions', 'Taxes', 'Net']
       : ['Empleado', 'Número', 'Nóminas', 'Horas regulares', 'Horas extra', 'Horas de licencia pagada', 'Bruto', 'Deducciones', 'Impuestos', 'Neto'],
    ...rows.map((r) => [r.name, r.number, r.runs, hoursLabel(r.regular_minutes), hoursLabel(r.overtime_minutes), hoursLabel(r.leave_minutes), dec(r.gross), dec(r.deductions), en ? 'not calculated' : 'no calculados', dec(r.net)]),
    [NOTE[locale]],
  ])
}

export function runCsv(run: RunRow, lines: { employee_name: string; employee_number: string | null; pay_type: string | null; regular_minutes: number; overtime_minutes: number; leave_paid_minutes: number
  regular_pay_cents: string; overtime_pay_cents: string; leave_pay_cents: string; salary_pay_cents: string; other_earnings_cents: string; gross_cents: string; deductions_cents: string; net_cents: string; issues: string[] }[], locale: 'es' | 'en') {
  const en = locale === 'en'
  return toCsv([
    [en ? 'Period' : 'Periodo', `${run.period_start} – ${run.period_end}`, en ? 'Status' : 'Estado', run.status, en ? 'Pay date' : 'Fecha de pago', run.pay_date],
    en ? ['Employee', 'Number', 'Pay type', 'Regular hours', 'Overtime hours', 'Paid leave hours', 'Regular pay', 'Overtime pay', 'Leave pay', 'Salary', 'Other earnings', 'Gross', 'Deductions', 'Taxes', 'Net', 'Review']
       : ['Empleado', 'Número', 'Tipo de pago', 'Horas regulares', 'Horas extra', 'Horas de licencia', 'Pago regular', 'Pago extra', 'Pago de licencia', 'Salario', 'Otros ingresos', 'Bruto', 'Deducciones', 'Impuestos', 'Neto', 'Revisión'],
    ...lines.map((l) => [l.employee_name, l.employee_number, l.pay_type, hoursLabel(l.regular_minutes), hoursLabel(l.overtime_minutes), hoursLabel(l.leave_paid_minutes),
      dec(l.regular_pay_cents), dec(l.overtime_pay_cents), dec(l.leave_pay_cents), dec(l.salary_pay_cents), dec(l.other_earnings_cents), dec(l.gross_cents), dec(l.deductions_cents),
      en ? 'not calculated' : 'no calculados', dec(l.net_cents), l.issues.join(' ')]),
    [NOTE[locale]],
  ])
}

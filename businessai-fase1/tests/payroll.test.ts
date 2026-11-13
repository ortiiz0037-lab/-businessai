/** Payroll helpers (lib/payroll): exact cents, periods, hours payload, pay stub content, messages. */
import { describe, expect, it } from 'vitest'
import { hoursPayload, lastClosedPeriod, minutesPay, payrollErrorCode, payrollLabel, payrollMessage, percentOf, periodContaining, periodOk, roundCents, salaryPerPeriod } from '@/lib/payroll/core'
import { payslipContent } from '@/lib/payroll/payslip'
import { parseContent } from '@/lib/studio/model'

describe('money: integer cents, rounded once, half away from zero (same as public.payroll_round)', () => {
  it('rounds rationals exactly', () => {
    expect(roundCents(1n, 2n)).toBe(1n)          // 0.5 → 1
    expect(roundCents(5n, 2n)).toBe(3n)          // 2.5 → 3
    expect(roundCents(24999n, 10000n)).toBe(2n)  // 2.4999 → 2
    expect(roundCents(-1n, 2n)).toBe(-1n)        // −0.5 → −1
  })
  it('the amounts of the SQL suite (hand-checked)', () => {
    expect(minutesPay(960, 1525n)).toBe(24400n)          // 16 h × $15.25
    expect(minutesPay(150, 1525n, 1.5)).toBe(5719n)      // 2.5 h × $15.25 × 1.5 = $57.1875 → $57.19
    expect(minutesPay(480, 1525n)).toBe(12200n)
    expect(percentOf(47319n, 250)).toBe(1183n)           // 2.5 % of $473.19 = $11.82975 → $11.83
    expect(salaryPerPeriod(5200000n, 'weekly')).toBe(100000n)
    expect(salaryPerPeriod(5200000n, 'semimonthly')).toBe(216667n)   // 52,000 / 24 = 2,166.666… → 2,166.67
    expect(salaryPerPeriod(5200000n, 'biweekly')).toBe(200000n)
  })
  it('no floating point drift on large values', () => {
    expect(minutesPay(60 * 2080, 99_999_999n)).toBe(207_999_997_920n)
  })
})

describe('pay periods (same shapes as public.payroll_period_ok)', () => {
  it('validates each frequency', () => {
    expect(periodOk('weekly', '2026-11-02', '2026-11-08')).toBe(true)
    expect(periodOk('weekly', '2026-11-02', '2026-11-09')).toBe(false)
    expect(periodOk('biweekly', '2026-11-02', '2026-11-15')).toBe(true)
    expect(periodOk('semimonthly', '2026-02-16', '2026-02-28')).toBe(true)
    expect(periodOk('semimonthly', '2026-02-01', '2026-02-15')).toBe(true)
    expect(periodOk('semimonthly', '2026-02-01', '2026-02-16')).toBe(false)
    expect(periodOk('monthly', '2028-02-01', '2028-02-29')).toBe(true)     // leap year
  })
  it('suggests the last closed period', () => {
    expect(lastClosedPeriod('weekly', '2026-11-13', '2026-11-09')).toEqual({ start: '2026-11-02', end: '2026-11-08' })
    expect(lastClosedPeriod('biweekly', '2026-11-13', '2026-11-02')).toEqual({ start: '2026-10-19', end: '2026-11-01' })
    expect(lastClosedPeriod('semimonthly', '2026-11-13', '2026-11-09')).toEqual({ start: '2026-10-16', end: '2026-10-31' })
    expect(lastClosedPeriod('monthly', '2026-11-13', '2026-11-09')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(periodContaining('biweekly', '2026-11-20', '2026-11-02')).toEqual({ start: '2026-11-16', end: '2026-11-29' })
  })
})

describe('hours from Workforce → the payload the database verifies', () => {
  it('regular / overtime per employee; nothing for people without hours', () => {
    const t = (w: number, r: number, o: number) => ({ workedMinutes: w, regularMinutes: r, overtimeMinutes: o }) as never
    expect(hoursPayload([{ id: 'a', totals: t(1110, 960, 150) }, { id: 'b', totals: t(0, 0, 0) }]))
      .toEqual([{ employee_id: 'a', regular_minutes: 960, overtime_minutes: 150 }])
  })
})

describe('pay stub (Document Studio content)', () => {
  const line = { employee_name: 'Ana <Horas>', employee_number: '1', pay_type: 'hourly', hourly_rate_cents: '1525', annual_salary_cents: null, overtime_multiplier: '1.50',
    regular_minutes: 960, overtime_minutes: 150, leave_paid_minutes: 480, regular_pay_cents: '24400', overtime_pay_cents: '5719', leave_pay_cents: '12200', salary_pay_cents: '0',
    other_earnings_cents: '5000', gross_cents: '47319', deductions_cents: '1183', taxes_cents: '0', net_cents: '46136' }
  const run = { period_start: '2026-10-26', period_end: '2026-11-01', pay_date: '2026-11-04', status: 'approved', run_type: 'regular', payment_date: null }
  const items = [{ kind: 'earning', label: 'Bonificación', amount_cents: '5000' }, { kind: 'deduction', label: 'Plan de retiro', amount_cents: '1183' }]
  it('is a valid Studio document (passes the same content validation) with the stored amounts', () => {
    const c = payslipContent(line, run, items, 'Empresa {{x}}', 'es', 'USD')
    expect(parseContent(c).ok).toBe(true)
    const text = JSON.stringify(c)
    for (const v of ['$244.00', '$57.19', '$122.00', '$50.00', '$473.19', '$11.83', '$461.36']) expect(text).toContain(v)
    expect(text).toContain('no calculados')
    expect(text).not.toMatch(/<Horas>|\{\{x\}\}/)
  })
  it('English', () => {
    expect(JSON.stringify(payslipContent(line, run, items, 'Co', 'en', 'USD'))).toMatch(/Pay stub.*not calculated/)
  })
})

describe('messages', () => {
  it('maps database errors and has both languages', () => {
    expect(payrollErrorCode({ message: 'PAYROLL_PREVIEW_STALE' })).toBe('payroll_preview_stale')
    expect(payrollErrorCode({ message: 'x', code: '42501' })).toBe('forbidden')
    for (const c of ['payroll_hours_mismatch', 'payroll_blocking_issues', 'compensation_period_locked', 'payroll_tax_engine_not_available']) {
      expect(payrollMessage(c, 'es')).not.toBe(payrollMessage('save', 'es'))
      expect(payrollMessage(c, 'en')).not.toBe(payrollMessage(c, 'es'))
    }
    expect(payrollLabel('semimonthly', 'es')).toMatch(/Quincenal/)
  })
})

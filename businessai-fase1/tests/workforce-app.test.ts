/** Workforce app helpers: local times, next punches, error messages, CSV report. */
import { describe, expect, it } from 'vitest'
import { leaveLabel, localTime, nextPunches, punchLabel, rulesFor, stateLabel, wfErrorCode, wfMessage, zonedToIso } from '@/lib/workforce/context'
import { DEFAULT_RULES } from '@/lib/workforce/hours'
import { reportCsv, type ReportRow } from '@/lib/workforce/report'

describe('company time zone', () => {
  it('a local date and time in Puerto Rico → the right instant (UTC−4)', () => {
    expect(zonedToIso('2026-11-09', '08:30', 'America/Puerto_Rico')).toBe('2026-11-09T12:30:00.000Z')
  })
  it('handles daylight saving zones on both sides of the change', () => {
    expect(zonedToIso('2026-07-01', '09:00', 'America/New_York')).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedToIso('2026-12-01', '09:00', 'America/New_York')).toBe('2026-12-01T14:00:00.000Z')
  })
  it('refuses malformed input', () => {
    expect(zonedToIso('2026-13-40', 'xx', 'America/Puerto_Rico')).toBeNull()
  })
  it('shows instants in the company zone, not the server zone', () => {
    expect(localTime('2026-11-09T12:30:00Z', 'America/Puerto_Rico', 'en')).toBe('8:30 AM')
  })
})

describe('what the employee can punch next (mirrors the database sequence)', () => {
  it('out → in; in → break or out; on break → back', () => {
    expect(nextPunches(null)).toEqual(['in'])
    expect(nextPunches('out')).toEqual(['in'])
    expect(nextPunches('in')).toEqual(['break_start', 'out'])
    expect(nextPunches('break_start')).toEqual(['break_end'])
    expect(nextPunches('break_end')).toEqual(['break_start', 'out'])
  })
  it('labels in both languages', () => {
    expect(punchLabel('in', 'es')).toBe('Entrada')
    expect(punchLabel('break_start', 'en')).toBe('Break start')
    expect(stateLabel('break_start', 'es')).toBe('En descanso')
    expect(leaveLabel('day_off', 'en')).toBe('Day off')
  })
})

describe('database errors → messages', () => {
  it('maps the 0020 rules; longer codes first', () => {
    expect(wfErrorCode({ message: 'CORRECTION_INVALID_SEQUENCE' })).toBe('correction_invalid_sequence')
    expect(wfErrorCode({ message: 'CORRECTION_INVALID' })).toBe('correction_invalid')
    expect(wfErrorCode({ message: 'SELF_APPROVAL_FORBIDDEN' })).toBe('self_approval_forbidden')
    expect(wfErrorCode({ message: 'PLAN_LIMIT_EMPLOYEES' })).toBe('plan_limit_employees')
    expect(wfErrorCode({ message: 'new row violates row-level security policy for table "work_shifts"' })).toBe('forbidden')
    expect(wfErrorCode({ message: 'duplicate key value violates unique constraint "employees_number_uidx"' })).toBe('employee_number_taken')
  })
  it('every message exists in Spanish and English', () => {
    for (const c of ['punch_sequence', 'self_approval_forbidden', 'time_clock_unavailable', 'plan_limit_employees', 'access_email_mismatch']) {
      expect(wfMessage(c, 'es')).not.toBe(wfMessage(c, 'en'))
    }
  })
})

describe('CSV export', () => {
  const row: ReportRow = {
    id: '1', name: 'Pérez, Ana', number: '7', department: 'Taller',
    totals: { workedMinutes: 2880, regularMinutes: 2400, overtimeMinutes: 480, breakMinutes: 300, scheduledMinutes: 2400, lateDays: 1, lateMinutes: 20, absences: 0, leaveDays: 0, openSessions: 0, reviewDays: 0, mealMissedDays: 0 },
    days: [{ day: '2026-11-09', firstIn: '2026-11-09T12:00:00Z', lastOut: '2026-11-09T21:00:00Z', workedMinutes: 480, breakMinutes: 60, regularMinutes: 480, overtimeMinutes: 0, scheduledMinutes: 480, lateMinutes: 0, absent: false, leave: null, openSession: false, needsReview: false, mealMissed: false }],
    correctedPunches: 2, voidedPunches: 1,
  }
  it('summary per employee with Spanish headers', () => {
    const csv = reportCsv([row], false, 'es')
    expect(csv.split('\r\n')[0]).toContain('Empleado,Número,Departamento,Trabajado,Regular,Extra')
    expect(csv).toContain('"Pérez, Ana",7,Taller,48:00,40:00,8:00')
    expect(csv.split('\r\n')[0]).toContain('Ponches corregidos,Ponches anulados')
    expect(csv.split('\r\n')[1].endsWith(',2,1')).toBe(true)
    expect(csv).toContain('No es una nómina oficial')
  })
  it('daily detail with English headers', () => {
    const csv = reportCsv([row], true, 'en')
    expect(csv.split('\r\n')[0]).toContain('Employee,Number,Department,Day,First in')
    expect(csv.split('\r\n')[1]).toContain('2026-11-09')
  })
})

import { kioskMessage } from '@/lib/workforce/context'
describe('kiosk answers (0021)', () => {
  it('one message for wrong number, wrong PIN or lock: no employee enumeration', () => {
    expect(kioskMessage('invalid', 'es')).toMatch(/Número o PIN incorrecto/)
    expect(kioskMessage('unknown-status', 'en')).toBe(kioskMessage('invalid', 'en'))
    expect(kioskMessage('kiosk_locked', 'en')).toMatch(/10 minutes/)
  })
  it('PIN errors in both languages', () => {
    expect(wfMessage('pin_too_simple', 'es')).toMatch(/1234/)
    expect(wfMessage('history_immutable', 'en')).toMatch(/never changed/)
  })
})

describe('rules of one employee (0033): exceptions > classification > group > company', () => {
  const company = { ...DEFAULT_RULES, mealAfterMinutes: 300, mealMinMinutes: 60 }
  const group = { id: 'g', name: 'G', jurisdiction: null, exempt: false, daily_overtime_after_minutes: 600, weekly_overtime_after_minutes: 2400,
    overtime_multiplier: 1.5, meal_break_after_minutes: 360, meal_break_min_minutes: 30, meal_alert_before_minutes: 15, archived_at: null }
  it('a group replaces the company values; an archived group does not', () => {
    expect(rulesFor(company, group).dailyOvertimeAfter).toBe(600)
    expect(rulesFor(company, { ...group, archived_at: '2026-01-01' }).dailyOvertimeAfter).toBe(480)
  })
  it('an exempt classification exempts; an explicit exception wins', () => {
    expect(rulesFor(company, null, null, 'exempt').exempt).toBe(true)
    expect(rulesFor(company, null, { exempt: false }, 'exempt').exempt).toBe(false)
  })
  it('a present key replaces the value (null = does not apply); absent keys are inherited', () => {
    const r = rulesFor(company, group, { daily_overtime_after_minutes: null, weekly_overtime_after_minutes: 2700 })
    expect(r).toMatchObject({ dailyOvertimeAfter: null, weeklyOvertimeAfter: 2700, mealAfterMinutes: 360, mealMinMinutes: 30 })
  })
  it('new messages exist in both languages', () => {
    for (const c of ['rules_changed_since', 'shift_change_pending', 'supervisor_invalid', 'employee_archived', 'document_file_missing', 'meal_alert_handled']) {
      expect(wfMessage(c, 'es')).not.toBe(wfMessage('save', 'es'))
      expect(wfMessage(c, 'en')).not.toBe(wfMessage(c, 'es'))
    }
    expect(wfErrorCode({ message: 'RULES_CHANGED_SINCE' })).toBe('rules_changed_since')
  })
})

/** Attendance calculations (lib/workforce/hours): Puerto Rico rules by default. */
import { describe, expect, it } from 'vitest'
import { addDays, attendance, DEFAULT_RULES, hhmm, localDay, periodFor, sessions, toCsv, weekStart, type Punch } from '@/lib/workforce/hours'

// Puerto Rico is UTC−4 all year (no daylight saving).
const pr = (day: string, time: string) => new Date(`${day}T${time}:00-04:00`).toISOString()
const shift = (day: string, from: string, to: string, br = 60) => ({ starts_at: pr(day, from), ends_at: pr(day, to), break_minutes: br })
const workDay = (day: string, from: string, to: string, br?: [string, string]): Punch[] => [
  { kind: 'in', at: pr(day, from) },
  ...(br ? [{ kind: 'break_start' as const, at: pr(day, br[0]) }, { kind: 'break_end' as const, at: pr(day, br[1]) }] : []),
  { kind: 'out', at: pr(day, to) },
]
const NOW = new Date('2026-11-30T12:00:00-04:00')

describe('local days and weeks', () => {
  it('a punch at 23:30 PR is that local day, not the next UTC day', () => {
    expect(localDay(pr('2026-11-09', '23:30'), 'America/Puerto_Rico')).toBe('2026-11-09')
    expect(localDay(pr('2026-11-09', '23:30'), 'UTC')).toBe('2026-11-10')
  })
  it('weeks start on the configured day', () => {
    expect(weekStart('2026-11-11', 1)).toBe('2026-11-09')   // Wednesday → Monday
    expect(weekStart('2026-11-11', 0)).toBe('2026-11-08')   // → Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('report periods cover whole weeks', () => {
    expect(periodFor('week', '2026-11-11', 1)).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(periodFor('last_week', '2026-11-11', 1)).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    expect(periodFor('month', '2026-11-11', 1)).toEqual({ from: '2026-10-26', to: '2026-11-30' })
  })
})

describe('sessions', () => {
  it('worked = out − in − breaks', () => {
    const [s] = sessions(workDay('2026-11-09', '08:00', '17:00', ['12:00', '13:00']), 'America/Puerto_Rico', NOW)
    expect(s).toMatchObject({ workedMinutes: 480, breakMinutes: 60, open: false, day: '2026-11-09' })
  })
  it('an open session counts until now and is flagged', () => {
    const now = new Date(pr('2026-11-09', '10:30'))
    const [s] = sessions([{ kind: 'in', at: pr('2026-11-09', '08:00') }, { kind: 'break_start', at: pr('2026-11-09', '10:00') }], 'America/Puerto_Rico', now)
    expect(s).toMatchObject({ open: true, workedMinutes: 120, breakMinutes: 30 })
  })
  it('a night shift belongs to the day it started', () => {
    const [s] = sessions([{ kind: 'in', at: pr('2026-11-09', '22:00') }, { kind: 'out', at: pr('2026-11-10', '06:00') }], 'America/Puerto_Rico', NOW)
    expect(s).toMatchObject({ day: '2026-11-09', workedMinutes: 480 })
  })
})

describe('regular hours and overtime (PR defaults: >8 h/day, >40 h/week)', () => {
  it('a 10-hour day: 8 regular + 2 overtime', () => {
    const r = attendance({ punches: workDay('2026-11-09', '07:00', '17:30', ['12:00', '12:30']), shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-09', now: NOW })
    expect(r.days[0]).toMatchObject({ workedMinutes: 600, regularMinutes: 480, overtimeMinutes: 120 })
  })
  it('six 8-hour days: 40 regular, the 6th day is weekly overtime (no double counting)', () => {
    const punches = [0, 1, 2, 3, 4, 5].flatMap((i) => workDay(addDays('2026-11-09', i), '08:00', '16:00'))
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    expect(r.totals).toMatchObject({ workedMinutes: 2880, regularMinutes: 2400, overtimeMinutes: 480 })
    expect(r.days[5]).toMatchObject({ regularMinutes: 0, overtimeMinutes: 480 })
  })
  it('daily overtime is not counted again in the weekly total', () => {
    // five 10-hour days = 50 h: 10 h daily overtime; regular 40 h → no weekly extra
    const punches = [0, 1, 2, 3, 4].flatMap((i) => workDay(addDays('2026-11-09', i), '07:00', '17:00'))
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    expect(r.totals).toMatchObject({ workedMinutes: 3000, regularMinutes: 2400, overtimeMinutes: 600 })
  })
  it('weeks are separate', () => {
    const punches = [0, 1, 2, 3, 4, 7].flatMap((i) => workDay(addDays('2026-11-09', i), '08:00', '16:00'))
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-22', now: NOW })
    expect(r.totals.overtimeMinutes).toBe(0)
  })
  it('rules are configurable (no daily overtime, 44 h weekly)', () => {
    const rules = { ...DEFAULT_RULES, dailyOvertimeAfter: null, weeklyOvertimeAfter: 44 * 60 }
    const punches = [0, 1, 2, 3, 4].flatMap((i) => workDay(addDays('2026-11-09', i), '07:00', '17:00'))
    const r = attendance({ punches, shifts: [], leaves: [], rules, from: '2026-11-09', to: '2026-11-15', now: NOW })
    expect(r.totals).toMatchObject({ regularMinutes: 2640, overtimeMinutes: 360 })
  })
})

describe('schedules: lateness, absences, leave', () => {
  const shifts = [shift('2026-11-09', '08:00', '17:00'), shift('2026-11-10', '08:00', '17:00'), shift('2026-11-11', '08:00', '17:00')]
  const leaves = [{ leave_type: 'vacation', starts_on: '2026-11-11', ends_on: '2026-11-11', partial_minutes: null }]
  const punches = [...workDay('2026-11-09', '08:20', '17:00')]
  const r = attendance({ punches, shifts, leaves, rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-11', now: NOW })
  it('late beyond the grace minutes', () => {
    expect(r.days[0]).toMatchObject({ lateMinutes: 20, scheduledMinutes: 480 })
  })
  it('a scheduled day without punches is an absence', () => {
    expect(r.days[1]).toMatchObject({ absent: true })
  })
  it('a scheduled day on approved leave is not an absence', () => {
    expect(r.days[2]).toMatchObject({ absent: false, leave: 'vacation' })
    expect(r.totals).toMatchObject({ absences: 1, lateDays: 1, leaveDays: 1 })
  })
  it('within the grace period is not late; a shift still to come is not an absence', () => {
    const now = new Date(pr('2026-11-12', '07:00'))
    const x = attendance({ punches: workDay('2026-11-09', '08:04', '17:00'), shifts: [shift('2026-11-09', '08:00', '17:00'), shift('2026-11-12', '08:00', '17:00')],
      leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-12', now })
    expect(x.days[0].lateMinutes).toBe(0)
    expect(x.days[3].absent).toBe(false)
  })
})

describe('formatting and export', () => {
  it('hh:mm', () => {
    expect(hhmm(450)).toBe('7:30')
    expect(hhmm(5)).toBe('0:05')
  })
  it('CSV quotes and neutralises spreadsheet formulas', () => {
    expect(toCsv([['Nombre', 'Horas'], ['Pérez, Ana', '8:00'], ['=HYPERLINK("x")', 1]])).toBe(
      'Nombre,Horas\r\n"Pérez, Ana",8:00\r\n"\'=HYPERLINK(""x"")",1\r\n')
  })
})

describe('review 1: no hour is counted twice (night shifts, weeks, partial periods)', () => {
  const total = (r: ReturnType<typeof attendance>) => r.totals.regularMinutes + r.totals.overtimeMinutes
  it('regular + overtime always equals the hours worked', () => {
    const punches = [0, 1, 2, 3, 4, 5].flatMap((i) => workDay(addDays('2026-11-09', i), '07:00', '17:30'))
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    expect(total(r)).toBe(r.totals.workedMinutes)
    for (const d of r.days) expect(d.regularMinutes + d.overtimeMinutes).toBe(d.workedMinutes)
  })
  it('a night shift crossing midnight counts once, on the day it started (not split, not repeated)', () => {
    const punches: Punch[] = [{ kind: 'in', at: pr('2026-11-10', '22:00') }, { kind: 'out', at: pr('2026-11-11', '08:00') }]
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    expect(r.days.find((d) => d.day === '2026-11-10')).toMatchObject({ workedMinutes: 600, regularMinutes: 480, overtimeMinutes: 120 })
    expect(r.days.find((d) => d.day === '2026-11-11')).toMatchObject({ workedMinutes: 0 })
    expect(r.totals.workedMinutes).toBe(600)
  })
  it('a night shift crossing into the next WEEK counts once, in the week it started', () => {
    // Sunday 22:00 → Monday 06:00, weeks start on Monday
    const punches: Punch[] = [{ kind: 'in', at: pr('2026-11-15', '22:00') }, { kind: 'out', at: pr('2026-11-16', '06:00') }]
    const a = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    const b = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-16', to: '2026-11-22', now: NOW })
    expect(a.totals.workedMinutes).toBe(480)
    expect(b.totals.workedMinutes).toBe(0)
    const both = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-22', now: NOW })
    expect(both.totals.workedMinutes).toBe(a.totals.workedMinutes + b.totals.workedMinutes)
  })
  it('splitting a period in two gives the same totals as the whole period', () => {
    const punches = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].flatMap((i) => workDay(addDays('2026-11-09', i), '07:00', '17:00'))
    const whole = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-22', now: NOW })
    const w1 = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-15', now: NOW })
    const w2 = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-16', to: '2026-11-22', now: NOW })
    expect(w1.totals.overtimeMinutes + w2.totals.overtimeMinutes).toBe(whole.totals.overtimeMinutes)
    expect(w1.totals.regularMinutes + w2.totals.regularMinutes).toBe(whole.totals.regularMinutes)
  })
  it('a period starting mid-week still counts the earlier days of that week toward the 40 hours', () => {
    // Mon–Fri 8 h = 40 h; Saturday 8 h is all weekly overtime even if the report starts on Saturday
    const punches = [0, 1, 2, 3, 4, 5].flatMap((i) => workDay(addDays('2026-11-09', i), '08:00', '16:00'))
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-14', to: '2026-11-14', now: NOW })
    expect(r.days).toHaveLength(1)
    expect(r.days[0]).toMatchObject({ day: '2026-11-14', workedMinutes: 480, regularMinutes: 0, overtimeMinutes: 480 })
  })
  it('a forgotten clock-out (session over 16 h) is flagged for review, never silently accepted', () => {
    const punches: Punch[] = [{ kind: 'in', at: pr('2026-11-09', '08:00') }, { kind: 'out', at: pr('2026-11-10', '09:00') }]
    const r = attendance({ punches, shifts: [], leaves: [], rules: DEFAULT_RULES, from: '2026-11-09', to: '2026-11-10', now: NOW })
    expect(r.days[0].needsReview).toBe(true)
    expect(r.totals.reviewDays).toBe(1)
  })
  it('daylight saving: hours are real elapsed time (New York, 2026-11-01 has 25 hours)', () => {
    const rules = { ...DEFAULT_RULES, timezone: 'America/New_York' }
    const punches: Punch[] = [{ kind: 'in', at: '2026-11-01T04:30:00Z' }, { kind: 'out', at: '2026-11-01T13:30:00Z' }]   // 00:30 EDT → 08:30 EST
    const r = attendance({ punches, shifts: [], leaves: [], rules, from: '2026-11-01', to: '2026-11-01', now: NOW })
    expect(r.days[0].workedMinutes).toBe(540)
  })
})

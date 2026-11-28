/**
 * Attendance calculations (pure, no I/O). Inputs come from migration 0020:
 * punches (server times), shifts, approved leave and the company rules
 * (workforce_settings). Every day is the LOCAL day in the company time
 * zone; worked time belongs to the day the session started (a night shift
 * that crosses midnight counts on the day it began).
 *
 * Overtime (configurable; defaults = Puerto Rico: over 8 h a day and over
 * 40 h a week): daily overtime first, then the regular minutes that exceed
 * the weekly threshold become weekly overtime — never counted twice.
 */
export type PunchKind = 'in' | 'out' | 'break_start' | 'break_end'
export type Punch = { kind: PunchKind; at: string }
export type Shift = { starts_at: string; ends_at: string; break_minutes: number }
export type Leave = { leave_type: string; starts_on: string; ends_on: string; partial_minutes: number | null }
export type Rules = {
  timezone: string
  weekStartsOn: number              // 0 Sunday … 6 Saturday
  dailyOvertimeAfter: number | null // minutes
  weeklyOvertimeAfter: number | null
  graceMinutes: number
  /** Exempt from overtime (rule group): every worked minute is regular. */
  exempt?: boolean
  /** Meal period rule: a break of at least mealMinMinutes before mealAfterMinutes of continuous work. */
  mealAfterMinutes?: number | null
  mealMinMinutes?: number | null
  /**
   * Overnight sessions (0033): 'start_day' (default) counts the whole session
   * on the day it began; 'split_midnight' splits it at local midnight.
   */
  overnight?: 'start_day' | 'split_midnight'
}
export const DEFAULT_RULES: Rules = { timezone: 'America/Puerto_Rico', weekStartsOn: 1, dailyOvertimeAfter: 480, weeklyOvertimeAfter: 2400, graceMinutes: 5 }

/**
 * Meal period missed in a session? Continuous work longer than `after`
 * minutes without a break of at least `min` minutes (a shorter break does
 * not reset the count). Mirrors public.wf_meal_eval (migration 0022).
 */
export function mealMissed(punches: Punch[], after: number | null | undefined, min: number | null | undefined, now: Date = new Date()): boolean {
  if (!after || !min) return false
  const sorted = [...punches].sort((a, b) => a.at.localeCompare(b.at))
  let seg: number | null = null
  let brk: number | null = null
  for (const p of sorted) {
    const t = Date.parse(p.at)
    if (p.kind === 'in') { seg = t; brk = null }
    else if (p.kind === 'break_start' && seg !== null) { if (t - seg >= after * MIN) return true; brk = t }
    else if (p.kind === 'break_end' && seg !== null && brk !== null) { if (t - brk >= min * MIN) seg = t; brk = null }
    else if (p.kind === 'out' && seg !== null) { if (brk === null && t - seg >= after * MIN) return true; seg = null; brk = null }
  }
  return seg !== null && brk === null && now.getTime() - seg >= after * MIN
}

export type Session = { start: string; end: string | null; breakMinutes: number; workedMinutes: number; open: boolean; day: string; breaks?: [number, number][] }
export type DayRow = {
  day: string
  firstIn: string | null
  lastOut: string | null
  workedMinutes: number
  breakMinutes: number
  regularMinutes: number
  overtimeMinutes: number
  scheduledMinutes: number
  lateMinutes: number
  absent: boolean
  leave: string | null
  openSession: boolean
  /** A session longer than LONG_SESSION_MINUTES (probably a forgotten clock-out): review it. */
  needsReview: boolean
  /** A session of this day missed the meal period (when meal rules are set). */
  mealMissed: boolean
}
export type Totals = {
  workedMinutes: number; regularMinutes: number; overtimeMinutes: number; breakMinutes: number; scheduledMinutes: number
  lateDays: number; lateMinutes: number; absences: number; leaveDays: number; openSessions: number; reviewDays: number; mealMissedDays: number
}

const MIN = 60_000
export const LONG_SESSION_MINUTES = 16 * 60

/** 'YYYY-MM-DD' of an instant in a time zone. */
export function localDay(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T12:00:00Z`) + n * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/** First day of the week containing `day`. */
export function weekStart(day: string, weekStartsOn: number): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay()
  return addDays(day, -((dow - weekStartsOn + 7) % 7))
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

const minutes = (a: number, b: number) => Math.max(0, Math.round((b - a) / MIN))

/**
 * Punches → work sessions. The database guarantees the order
 * in → (break_start → break_end)* → out; an unfinished session (no out yet)
 * is counted up to `now` and flagged open; an open break likewise.
 */
export function sessions(punches: Punch[], timezone: string, now: Date = new Date()): Session[] {
  const sorted = [...punches].sort((a, b) => a.at.localeCompare(b.at))
  const out: Session[] = []
  let start: number | null = null
  let startIso = ''
  let breakStart: number | null = null
  let breaks = 0
  let intervals: [number, number][] = []
  for (const p of sorted) {
    const t = Date.parse(p.at)
    if (p.kind === 'in') { start = t; startIso = p.at; breaks = 0; breakStart = null; intervals = [] }
    else if (p.kind === 'break_start' && start !== null) breakStart = t
    else if (p.kind === 'break_end' && breakStart !== null) { breaks += minutes(breakStart, t); intervals.push([breakStart, t]); breakStart = null }
    else if (p.kind === 'out' && start !== null) {
      if (breakStart !== null) { breaks += minutes(breakStart, t); intervals.push([breakStart, t]); breakStart = null }
      out.push({ start: startIso, end: p.at, breakMinutes: breaks, workedMinutes: Math.max(0, minutes(start, t) - breaks), open: false, day: localDay(startIso, timezone), breaks: intervals })
      start = null
    }
  }
  if (start !== null) {
    const t = now.getTime()
    const b = breaks + (breakStart !== null ? minutes(breakStart, t) : 0)
    const iv: [number, number][] = breakStart !== null ? [...intervals, [breakStart, t]] : intervals
    out.push({ start: startIso, end: null, breakMinutes: b, workedMinutes: Math.max(0, minutes(start, t) - b), open: true, day: localDay(startIso, timezone), breaks: iv })
  }
  return out
}

/** The instant of local midnight that starts `day` in a time zone. */
export function zonedMidnight(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`)
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t
  }
  let t = guess - offset(guess)
  t = guess - offset(t)
  return t
}

export type DayPiece = { day: string; workedMinutes: number; breakMinutes: number }
/**
 * Worked and break minutes per local day. 'start_day': the whole session on
 * the day it began. 'split_midnight': cut at each local midnight (breaks go
 * to the day in which they happened). Totals are identical either way.
 */
export function sessionPieces(s: Session, timezone: string, overnight: Rules['overnight'], now: Date = new Date()): DayPiece[] {
  if (overnight !== 'split_midnight') return [{ day: s.day, workedMinutes: s.workedMinutes, breakMinutes: s.breakMinutes }]
  const start = Date.parse(s.start)
  const end = s.end ? Date.parse(s.end) : now.getTime()
  const pieces: DayPiece[] = []
  let from = start
  let day = s.day
  while (from < end) {
    const next = zonedMidnight(addDays(day, 1), timezone)
    const to = Math.min(end, next)
    const brk = (s.breaks ?? []).reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0) / MIN
    pieces.push({ day, workedMinutes: 0, breakMinutes: brk })
    pieces[pieces.length - 1].workedMinutes = Math.max(0, (to - from) / MIN - brk)
    from = to
    day = addDays(day, 1)
  }
  // whole minutes, adjusted so the pieces add up exactly to the session totals
  const rounded = pieces.map((p) => ({ ...p, workedMinutes: Math.round(p.workedMinutes), breakMinutes: Math.round(p.breakMinutes) }))
  if (rounded.length) {
    const last = rounded[rounded.length - 1]
    last.workedMinutes += s.workedMinutes - rounded.reduce((n, p) => n + p.workedMinutes, 0)
    last.breakMinutes += s.breakMinutes - rounded.reduce((n, p) => n + p.breakMinutes, 0)
  }
  return rounded.length ? rounded : [{ day: s.day, workedMinutes: s.workedMinutes, breakMinutes: s.breakMinutes }]
}

/** Daily rows for [from, to] (local days) and totals. */
export function attendance(input: {
  punches: Punch[]; shifts: Shift[]; leaves: Leave[]; rules: Rules; from: string; to: string; now?: Date
}): { days: DayRow[]; totals: Totals } {
  const { rules } = input
  const now = input.now ?? new Date()
  const today = localDay(now, rules.timezone)
  const list = sessions(input.punches, rules.timezone, now)
  const pieces = list.flatMap((x) => sessionPieces(x, rules.timezone, rules.overnight, now))
  // Weekly overtime needs the whole week: compute from the first day of the
  // week that contains `from`, then return only [from, to]. The caller must
  // pass the punches from that week start (see weekStart / buildReport).
  const computeFrom = weekStart(input.from, rules.weekStartsOn)
  const allDays = daysBetween(computeFrom, input.to).map((day): DayRow => {
    const daySessions = list.filter((s) => s.day === day)
    const dayPieces = pieces.filter((p) => p.day === day)
    const worked = dayPieces.reduce((n, p) => n + p.workedMinutes, 0)
    const daily = !rules.exempt && rules.dailyOvertimeAfter !== null ? Math.max(0, worked - rules.dailyOvertimeAfter) : 0
    const dayShifts = input.shifts.filter((s) => localDay(s.starts_at, rules.timezone) === day)
    const scheduled = dayShifts.reduce((n, s) => n + Math.max(0, minutes(Date.parse(s.starts_at), Date.parse(s.ends_at)) - s.break_minutes), 0)
    const leave = input.leaves.find((l) => l.starts_on <= day && day <= l.ends_on) ?? null
    const firstShift = dayShifts.sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]
    const firstIn = daySessions[0]?.start ?? null
    let late = 0
    if (firstShift && firstIn) {
      const diff = minutes(Date.parse(firstShift.starts_at), Date.parse(firstIn))
      late = diff > rules.graceMinutes ? diff : 0
    }
    const shiftOver = dayShifts.some((s) => Date.parse(s.ends_at) <= now.getTime())
    const absent = dayShifts.length > 0 && daySessions.length === 0 && dayPieces.length === 0 && !(leave && leave.partial_minutes === null) && (day < today || shiftOver)
    const last = daySessions[daySessions.length - 1]
    return {
      day,
      firstIn,
      lastOut: last?.end ?? null,
      workedMinutes: worked,
      breakMinutes: dayPieces.reduce((n, p) => n + p.breakMinutes, 0),
      regularMinutes: worked - daily,
      overtimeMinutes: daily,
      scheduledMinutes: scheduled,
      lateMinutes: late,
      absent,
      leave: leave?.leave_type ?? null,
      openSession: daySessions.some((s) => s.open),
      needsReview: daySessions.some((s) => s.workedMinutes + s.breakMinutes > LONG_SESSION_MINUTES),
      mealMissed: daySessions.some((s) => mealMissed(
        input.punches.filter((p) => p.at >= s.start && (s.end === null || p.at <= s.end)), rules.mealAfterMinutes, rules.mealMinMinutes, now)),
    }
  })
  // Weekly overtime over the regular minutes, week by week, in day order.
  if (rules.weeklyOvertimeAfter !== null && !rules.exempt) {
    const limit = rules.weeklyOvertimeAfter
    const running = new Map<string, number>()   // regular minutes so far in each week
    for (const d of allDays) {
      const wk = weekStart(d.day, rules.weekStartsOn)
      const before = running.get(wk) ?? 0
      const regular = Math.min(d.regularMinutes, Math.max(0, limit - before))
      d.overtimeMinutes += d.regularMinutes - regular
      d.regularMinutes = regular
      running.set(wk, before + regular)
    }
  }
  const days = allDays.filter((d) => d.day >= input.from)
  const totals = days.reduce<Totals>((t, d) => ({
    workedMinutes: t.workedMinutes + d.workedMinutes,
    regularMinutes: t.regularMinutes + d.regularMinutes,
    overtimeMinutes: t.overtimeMinutes + d.overtimeMinutes,
    breakMinutes: t.breakMinutes + d.breakMinutes,
    scheduledMinutes: t.scheduledMinutes + d.scheduledMinutes,
    lateDays: t.lateDays + (d.lateMinutes > 0 ? 1 : 0),
    lateMinutes: t.lateMinutes + d.lateMinutes,
    absences: t.absences + (d.absent ? 1 : 0),
    leaveDays: t.leaveDays + (d.leave ? 1 : 0),
    openSessions: t.openSessions + (d.openSession ? 1 : 0),
    reviewDays: t.reviewDays + (d.needsReview ? 1 : 0),
    mealMissedDays: t.mealMissedDays + (d.mealMissed ? 1 : 0),
  }), { workedMinutes: 0, regularMinutes: 0, overtimeMinutes: 0, breakMinutes: 0, scheduledMinutes: 0, lateDays: 0, lateMinutes: 0, absences: 0, leaveDays: 0, openSessions: 0, reviewDays: 0, mealMissedDays: 0 })
  return { days, totals }
}

/** A report period aligned to whole weeks (so weekly overtime is exact). */
export function periodFor(kind: 'week' | 'last_week' | 'two_weeks' | 'month', today: string, weekStartsOn: number): { from: string; to: string } {
  const ws = weekStart(today, weekStartsOn)
  if (kind === 'week') return { from: ws, to: addDays(ws, 6) }
  if (kind === 'last_week') return { from: addDays(ws, -7), to: addDays(ws, -1) }
  if (kind === 'two_weeks') return { from: addDays(ws, -7), to: addDays(ws, 6) }
  const first = `${today.slice(0, 8)}01`
  const fromWeek = weekStart(first, weekStartsOn)
  const nextMonth = addDays(`${today.slice(0, 8)}28`, 4).slice(0, 8) + '01'
  return { from: fromWeek, to: addDays(nextMonth, -1) }
}

/** 450 → "7:30" */
export function hhmm(mins: number): string {
  const m = Math.max(0, Math.round(mins))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** CSV with a header row; values quoted when needed; formulas neutralised. */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v === null) return ''
    let s = String(v)
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`   // CSV injection (spreadsheets)
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

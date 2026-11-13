'use server'
/**
 * Workforce / HR actions (migration 0033): employment status and archive,
 * private contacts and documents, recurring schedules and shift changes,
 * rule proposals (explicit apply) and alert handling. Every write runs with
 * the user's own session; the database decides who may do it and records it.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { ALERT_ACTIONS, DOC_CATEGORIES, EMPLOYEE_STATUSES, wfErrorCode, workforceRules, zonedToIso } from '@/lib/workforce/context'
import { HR_BUCKET, RULE_KEYS, hoursToMinutes, ruleDiff, validateHrDocument, wholeNumber, type RuleScope, type RuleValues } from '@/lib/workforce/hr'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const opt = (f: FormData, k: string, max = 300) => (text(f, k) ? text(f, k).slice(0, max) : null)

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/(workforce(\/[\w\-/]*)?|clock)(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
}
function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error', 'proposal']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
function refresh() {
  revalidatePath('/workforce', 'layout')
  revalidatePath('/clock')
}
async function session() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return { supabase, user }
}
async function company() {
  const s = await session()
  const m = await getActiveMembership(s.supabase, s.user.id)
  if (!m) redirect('/onboarding')
  return { ...s, companyId: m.companyId }
}

// ------------------------------------------------------------- employment status and archive
export async function setEmployeeStatus(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/workforce/employees/${UUID.test(id) ? id : ''}`
  const status = text(formData, 'status')
  if (!UUID.test(id) || !(EMPLOYEE_STATUSES as readonly string[]).includes(status)) go(back, { error: 'employee_status_invalid' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('set_employee_status', { emp: id, new_status: status, reason: opt(formData, 'reason') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: `status_${status}` })
}

export async function archiveEmployee(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/workforce/employees/${UUID.test(id) ? id : ''}`
  if (!UUID.test(id)) go('/workforce/employees', { error: 'employee_not_found' })
  const archive = text(formData, 'archive') === 'yes'
  const { supabase } = await session()
  const { error } = await supabase.rpc('archive_employee', { emp: id, archive })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: archive ? 'archived' : 'unarchived' })
}

// ------------------------------------------------------------- private contact data (managers and the employee)
export async function saveEmployeeContact(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = backTo(formData, `/workforce/employees/${UUID.test(emp) ? emp : ''}`)
  if (!UUID.test(emp)) go(back, { error: 'employee_not_found' })
  const { supabase } = await session()
  const { data: e } = await supabase.from('employees').select('company_id').eq('id', emp).maybeSingle()
  if (!e) go(back, { error: 'employee_not_found' })
  const row = {
    address: opt(formData, 'address', 300), emergency_contact_name: opt(formData, 'emergency_contact_name', 120),
    emergency_contact_phone: opt(formData, 'emergency_contact_phone', 40), emergency_contact_relation: opt(formData, 'emergency_contact_relation', 60),
  }
  const { data: existing } = await supabase.from('employee_contacts').select('employee_id').eq('employee_id', emp).maybeSingle()
  const { error } = existing
    ? await supabase.from('employee_contacts').update(row).eq('employee_id', emp)
    : await supabase.from('employee_contacts').insert({ employee_id: emp, company_id: e.company_id, ...row })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'contact_saved' })
}

// ------------------------------------------------------------- private labour documents
/** Registers a file the browser already uploaded with the user's session (storage policies decide). */
export async function registerEmployeeDocument(input: { employeeId: string; path: string; fileName: string; type: string; size: number; category: string; title: string; shared: boolean }):
  Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(input.employeeId)) return { ok: false, error: 'employee_not_found' }
  if (validateHrDocument({ type: input.type, size: input.size })) return { ok: false, error: 'document_type' }
  if (!(DOC_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, error: 'invalid' }
  const title = input.title.trim().slice(0, 160)
  if (!title) return { ok: false, error: 'invalid' }
  const { supabase, companyId } = await company()
  if (!input.path.startsWith(`${companyId}/${input.employeeId}/`) || input.path.split('/').length !== 3) return { ok: false, error: 'forbidden' }
  const { error } = await supabase.from('employee_documents').insert({
    company_id: companyId, employee_id: input.employeeId, category: input.category, title, storage_path: input.path,
    file_name: input.fileName.slice(0, 200), content_type: input.type, size_bytes: input.size, visible_to_employee: input.shared,
  })
  if (error) {
    await supabase.storage.from(HR_BUCKET).remove([input.path])   // allowed: not registered
    return { ok: false, error: wfErrorCode(error) }
  }
  refresh()
  return { ok: true }
}

export async function updateEmployeeDocument(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = `/workforce/employees/${UUID.test(emp) ? emp : ''}`
  const id = text(formData, 'id')
  if (!UUID.test(id)) go(back, { error: 'document_not_found' })
  const archive = text(formData, 'archive') === 'yes'
  const shared = formData.has('shared') ? text(formData, 'shared') === 'yes' : null
  const { supabase } = await session()
  const { error } = await supabase.rpc('set_employee_document', { doc: id, shared, archive })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: archive ? 'document_archived' : 'document_updated' })
}

// ------------------------------------------------------------- recurring schedules
export async function createShiftPattern(formData: FormData) {
  const back = backTo(formData, '/workforce/schedule')
  const emp = text(formData, 'employee_id')
  const days = formData.getAll('weekdays').map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  const start = text(formData, 'start'); const end = text(formData, 'end')
  const from = text(formData, 'starts_on'); const until = text(formData, 'ends_on')
  if (!UUID.test(emp) || !days.length || !TIME.test(start) || !TIME.test(end) || start === end || !DAY.test(from) || (until && (!DAY.test(until) || until < from))) {
    go(back, { error: 'pattern_invalid' })
  }
  const { supabase } = await session()
  const { data: e } = await supabase.from('employees').select('company_id').eq('id', emp).maybeSingle()
  if (!e) go(back, { error: 'employee_not_found' })
  const { error } = await supabase.from('shift_patterns').insert({
    company_id: e.company_id, employee_id: emp, name: opt(formData, 'name', 80), weekdays: days, start_time: start, end_time: end,
    break_minutes: Math.min(Math.max(Number(text(formData, 'break_minutes') || 0), 0), 480), starts_on: from, ends_on: until || null, notes: opt(formData, 'notes'),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'pattern_created' })
}

export async function endShiftPattern(formData: FormData) {
  const back = backTo(formData, '/workforce/schedule')
  const { supabase } = await session()
  const { data, error } = await supabase.from('shift_patterns').update({ status: 'ended' }).eq('id', text(formData, 'id')).select('id')
  if (error || !data?.length) go(back, { error: error ? wfErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: 'pattern_ended' })
}

export async function generatePatternShifts(formData: FormData) {
  const back = backTo(formData, '/workforce/schedule')
  const from = text(formData, 'from'); const to = text(formData, 'to')
  if (!UUID.test(text(formData, 'id')) || !DAY.test(from) || !DAY.test(to)) go(back, { error: 'range_invalid' })
  const { supabase } = await session()
  const { data, error } = await supabase.rpc('generate_pattern_shifts', { pattern: text(formData, 'id'), from_day: from, to_day: to })
  if (error) go(back, { error: wfErrorCode(error) })
  const r = (Array.isArray(data) ? data[0] : data) as { created: number; skipped_conflict: number; skipped_leave: number } | null
  refresh()
  go(back, { done: 'generated', created: String(r?.created ?? 0), conflicts: String(r?.skipped_conflict ?? 0), leave: String(r?.skipped_leave ?? 0) })
}

// ------------------------------------------------------------- shift change requests
export async function requestShiftChange(formData: FormData) {
  const back = backTo(formData, '/clock')
  const shift = text(formData, 'shift_id')
  const kind = text(formData, 'kind') === 'drop' ? 'drop' : 'change'
  if (!UUID.test(shift)) go(back, { error: 'shift_not_found' })
  const { supabase } = await session()
  const { data: s } = await supabase.from('work_shifts').select('company_id').eq('id', shift).maybeSingle()
  if (!s) go(back, { error: 'shift_not_found' })
  let newStart: string | null = null, newEnd: string | null = null
  if (kind === 'change') {
    const rules = await workforceRules(supabase, s.company_id)
    newStart = zonedToIso(text(formData, 'day'), text(formData, 'start'), rules.timezone)
    newEnd = zonedToIso(text(formData, 'day'), text(formData, 'end'), rules.timezone)
    if (!newStart || !newEnd) go(back, { error: 'shift_change_invalid' })
    if (newEnd! <= newStart!) newEnd = new Date(Date.parse(newEnd!) + 86_400_000).toISOString()   // ends the next day
  }
  const brk = text(formData, 'break_minutes')
  const { error } = await supabase.rpc('request_shift_change', {
    shift, change_kind: kind, new_start: newStart, new_end: newEnd, new_break: brk && /^\d{1,3}$/.test(brk) ? Number(brk) : null, why: text(formData, 'reason'),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'shift_change_requested' })
}

export async function decideShiftChange(formData: FormData) {
  const back = backTo(formData, '/workforce/requests')
  const { supabase } = await session()
  const approve = text(formData, 'decision') === 'approve'
  const { error } = await supabase.rpc('decide_shift_change', { request: text(formData, 'id'), approve, note: opt(formData, 'note') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: approve ? 'approved' : 'rejected' })
}

export async function cancelShiftChange(formData: FormData) {
  const back = backTo(formData, '/clock')
  const { supabase } = await session()
  const { error } = await supabase.rpc('cancel_shift_change', { request: text(formData, 'id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'cancelled' })
}

// ------------------------------------------------------------- rules: proposals, explicit apply
/** Reads the rule fields present in a form (hours → minutes); invalid → null result. */
function ruleValuesFrom(f: FormData, scope: RuleScope): RuleValues | null {
  const v: RuleValues = {}
  const keys = RULE_KEYS[scope] as readonly string[]
  const hours: [string, string][] = [['daily_hours', 'daily_overtime_after_minutes'], ['weekly_hours', 'weekly_overtime_after_minutes'], ['meal_after_hours', 'meal_break_after_minutes']]
  for (const [field, key] of hours) {
    if (!f.has(field) || !keys.includes(key)) continue
    const m = hoursToMinutes(text(f, field))
    if (m === undefined) return null
    v[key] = m
  }
  for (const [field, key] of [['meal_min_minutes', 'meal_break_min_minutes'], ['meal_alert_before', 'meal_alert_before_minutes'], ['grace_minutes', 'grace_minutes']] as const) {
    if (!f.has(field) || !keys.includes(key)) continue
    const n = wholeNumber(text(f, field))
    if (n === undefined) return null
    if (n === null && key !== 'meal_break_min_minutes') continue   // required values keep their current value when empty
    v[key] = n
  }
  if (f.has('overtime_multiplier') && keys.includes('overtime_multiplier')) {
    const t = text(f, 'overtime_multiplier')
    if (t && !/^\d(\.\d{1,2})?$/.test(t)) return null
    if (t) v.overtime_multiplier = Number(t)
  }
  if (f.has('timezone') && keys.includes('timezone')) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: text(f, 'timezone') }) } catch { return null }
    v.timezone = text(f, 'timezone')
  }
  if (f.has('week_starts_on') && keys.includes('week_starts_on')) v.week_starts_on = Math.min(Math.max(Number(text(f, 'week_starts_on') || 1), 0), 6)
  if (f.has('overnight_attribution') && keys.includes('overnight_attribution')) v.overnight_attribution = text(f, 'overnight_attribution') === 'split_midnight' ? 'split_midnight' : 'start_day'
  if (f.has('jurisdiction') && keys.includes('jurisdiction')) v.jurisdiction = text(f, 'jurisdiction') || null
  if (f.has('exempt') && keys.includes('exempt')) {
    const e = text(f, 'exempt')
    if (scope === 'employee') { if (e === 'yes' || e === 'no') v.exempt = e === 'yes' }
    else v.exempt = e === 'yes'
  }
  return v
}

async function propose(scope: RuleScope, targetId: string, values: RuleValues, note: string | null, back: string) {
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('propose_rule_change', { target: companyId, change_scope: scope, target_id: targetId, change_values: values, change_note: note })
  if (error || typeof data !== 'string') go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'proposed', proposal: data })
}

/** Company rules: proposes only what changed; nothing changes until a manager applies it. */
export async function proposeCompanyRules(formData: FormData) {
  const back = '/workforce/settings'
  const values = ruleValuesFrom(formData, 'company')
  if (!values) go(back, { error: 'rule_values_invalid' })
  const { supabase, companyId } = await company()
  const { data: current } = await supabase.from('workforce_settings').select('*').eq('company_id', companyId).maybeSingle()
  const cur = (current ?? { timezone: 'America/Puerto_Rico', week_starts_on: 1, daily_overtime_after_minutes: 480, weekly_overtime_after_minutes: 2400,
    overtime_multiplier: 1.5, grace_minutes: 5, meal_break_after_minutes: null, meal_break_min_minutes: null, meal_alert_before_minutes: 15, overnight_attribution: 'start_day', jurisdiction: null }) as RuleValues
  const diff = ruleDiff(cur, values!)
  if (!Object.keys(diff).length) go(back, { done: 'no_changes' })
  await propose('company', companyId, diff, opt(formData, 'note'), back)
}

/** A rule group's values (name and notes are saved directly; rule values go through a proposal). */
export async function proposeGroupRules(formData: FormData) {
  const back = '/workforce/settings'
  const id = text(formData, 'id')
  if (!UUID.test(id)) go(back, { error: 'rule_scope_invalid' })
  const values = ruleValuesFrom(formData, 'rule_set')
  if (!values) go(back, { error: 'rule_values_invalid' })
  const { supabase } = await session()
  const { data: g } = await supabase.from('labor_rule_sets').select('*').eq('id', id).maybeSingle()
  if (!g) go(back, { error: 'rule_scope_invalid' })
  const name = text(formData, 'name').slice(0, 80)
  if (name && name !== g.name) {
    const { error } = await supabase.from('labor_rule_sets').update({ name, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) go(back, { error: wfErrorCode(error) })
  }
  const diff = ruleDiff(g as RuleValues, values!)
  if (!Object.keys(diff).length) { refresh(); go(back, { done: name && name !== g.name ? 'group' : 'no_changes' }) }
  await propose('rule_set', id, diff, opt(formData, 'note'), back)
}

/** Exceptions of one employee: the proposal is the complete set (keys left on "inherit" are not included). */
export async function proposeEmployeeRules(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = `/workforce/employees/${UUID.test(emp) ? emp : ''}`
  if (!UUID.test(emp)) go('/workforce/employees', { error: 'employee_not_found' })
  const v: RuleValues = {}
  for (const [field, key] of [['daily_hours', 'daily_overtime_after_minutes'], ['weekly_hours', 'weekly_overtime_after_minutes'], ['meal_after_hours', 'meal_break_after_minutes']] as const) {
    const mode = text(formData, `${field}_mode`)          // inherit | none | value
    if (mode === 'none') v[key] = null
    else if (mode === 'value') { const m = hoursToMinutes(text(formData, field)); if (m === undefined || m === null) go(back, { error: 'rule_values_invalid' }); v[key] = m! }
  }
  const ex = text(formData, 'exempt')
  if (ex === 'yes' || ex === 'no') v.exempt = ex === 'yes'
  const reason = text(formData, 'reason')
  if (reason.length < 3) go(back, { error: 'reason_required' })
  await propose('employee', emp, v, reason.slice(0, 300), back)
}

export async function proposeTemplate(formData: FormData) {
  const back = '/workforce/settings'
  const { supabase, companyId } = await company()
  const set = text(formData, 'rule_set_id')
  const { data, error } = await supabase.rpc('propose_jurisdiction_template', { target: companyId, code: text(formData, 'code'), rule_set: UUID.test(set) ? set : null })
  if (error || typeof data !== 'string') go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'proposed', proposal: data })
}

export async function applyRuleChange(formData: FormData) {
  const back = backTo(formData, '/workforce/settings')
  if (formData.get('confirm') !== 'on') go(back, { error: 'confirm' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('apply_rule_change', { change: text(formData, 'id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'rules_applied' })
}

export async function discardRuleChange(formData: FormData) {
  const back = backTo(formData, '/workforce/settings')
  const { supabase } = await session()
  const { error } = await supabase.rpc('discard_rule_change', { change: text(formData, 'id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'rules_discarded' })
}

// ------------------------------------------------------------- alerts
export async function resolveMealAlert(formData: FormData) {
  const back = backTo(formData, '/workforce')
  const action = text(formData, 'action')
  if (!(ALERT_ACTIONS as readonly string[]).includes(action)) go(back, { error: 'alert_action_invalid' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('resolve_meal_alert', { alert: text(formData, 'id'), action, resolve_note: opt(formData, 'note') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'alert_resolved' })
}

'use server'
/**
 * Workforce actions (migration 0020). Every write goes through RLS or a
 * 0020 function with the user's own session: the database decides who may
 * punch, approve, schedule or manage, and keeps the history.
 */
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { resolveAppOrigin } from '@/lib/app-origin'
import { LEAVE_TYPES, PUNCH_KINDS, wfErrorCode, workforceRules, zonedToIso } from '@/lib/workforce/context'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const opt = (f: FormData, k: string, max = 200) => (text(f, k) ? text(f, k).slice(0, max) : null)

/** Return path chosen by the form, limited to the workforce pages and /clock. */
function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/(workforce(\/[\w\-/]*)?|clock)(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
}
function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
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

// ------------------------------------------------------------- time clock
export async function punchAction(formData: FormData) {
  const back = backTo(formData, '/clock')
  const emp = text(formData, 'employee_id')
  const kind = text(formData, 'kind')
  if (!UUID.test(emp) || !(PUNCH_KINDS as readonly string[]).includes(kind)) go(back, { error: 'punch_kind_invalid' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('punch', { emp, punch_kind: kind, punch_note: opt(formData, 'note', 300) })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: `punch_${kind}` })
}

// ------------------------------------------------------------- employees
function employeeFields(f: FormData) {
  const email = text(f, 'email').toLowerCase()
  const rate = text(f, 'hourly_rate')
  return {
    employee_number: opt(f, 'employee_number', 30),
    first_name: text(f, 'first_name').slice(0, 80),
    last_name: text(f, 'last_name').slice(0, 80),
    email: email || null,
    phone: opt(f, 'phone', 40),
    department_id: UUID.test(text(f, 'department_id')) ? text(f, 'department_id') : null,
    position: opt(f, 'position', 80),
    hire_date: /^\d{4}-\d{2}-\d{2}$/.test(text(f, 'hire_date')) ? text(f, 'hire_date') : null,
    pay_type: text(f, 'pay_type') === 'salary' ? 'salary' : 'hourly',
    hourly_rate: rate && /^\d+(\.\d{1,2})?$/.test(rate) ? Number(rate) : null,
    notes: opt(f, 'notes', 2000),
  }
}

export async function createEmployee(formData: FormData) {
  const { supabase, companyId } = await company()
  const fields = employeeFields(formData)
  if (!fields.first_name || !fields.last_name) go('/workforce/employees', { error: 'invalid' })
  if (fields.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email)) go('/workforce/employees', { error: 'invalid' })
  const { data, error } = await supabase.from('employees').insert({ company_id: companyId, ...fields }).select('id').single()
  if (error || !data) go('/workforce/employees', { error: wfErrorCode(error) })
  refresh()
  redirect(`/workforce/employees/${data.id}?done=created`)
}

export async function updateEmployee(formData: FormData) {
  const id = text(formData, 'id')
  if (!UUID.test(id)) go('/workforce/employees', { error: 'employee_not_found' })
  const { supabase } = await session()
  const fields = employeeFields(formData)
  const status = text(formData, 'status')
  const update = {
    ...fields,
    ...(['active', 'inactive', 'terminated'].includes(status) ? { status } : {}),
    termination_date: /^\d{4}-\d{2}-\d{2}$/.test(text(formData, 'termination_date')) ? text(formData, 'termination_date') : null,
  }
  if (!fields.first_name || !fields.last_name) go(`/workforce/employees/${id}`, { error: 'invalid' })
  const { data, error } = await supabase.from('employees').update(update).eq('id', id).select('id')
  if (error || !data?.length) go(`/workforce/employees/${id}`, { error: error ? wfErrorCode(error) : 'forbidden' })
  refresh()
  go(`/workforce/employees/${id}`, { done: 'updated' })
}

export async function createEmployeeAccess(formData: FormData) {
  const id = text(formData, 'id')
  const { supabase } = await session()
  const { data, error } = await supabase.rpc('create_employee_access', { emp: id })
  if (error || typeof data !== 'string') go(`/workforce/employees/${id}`, { error: wfErrorCode(error) })
  const origin = resolveAppOrigin(process.env, (await headers()).get('host'))
  if (!origin) go(`/workforce/employees/${id}`, { error: 'save' })
  // Shown once on the employee page (not stored anywhere readable).
  const { cookies } = await import('next/headers')
  ;(await cookies()).set('ba_employee_link', `${origin}/clock/link?token=${data}`, {
    httpOnly: true, secure: true, sameSite: 'lax', path: `/workforce/employees/${id}`, maxAge: 600,
  })
  go(`/workforce/employees/${id}`, { done: 'link' })
}

export async function revokeEmployeeAccess(formData: FormData) {
  const id = text(formData, 'id')
  const { supabase } = await session()
  const { error } = await supabase.rpc('revoke_employee_access', { emp: id })
  if (error) go(`/workforce/employees/${id}`, { error: wfErrorCode(error) })
  refresh()
  go(`/workforce/employees/${id}`, { done: 'unlinked' })
}

export async function claimEmployeeAccess(formData: FormData) {
  const token = text(formData, 'token')
  const here = `/clock/link?token=${encodeURIComponent(token)}`
  if (!/^[0-9a-f]{64}$/.test(token)) go('/clock/link', { error: 'access_invalid' })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(here)}`)
  const { error } = await supabase.rpc('claim_employee_access', { raw_token: token })
  if (error) go('/clock/link', { token, error: wfErrorCode(error) })
  redirect('/clock?done=linked')
}

// ------------------------------------------------------------- corrections
export async function requestCorrection(formData: FormData) {
  const back = backTo(formData, '/clock')
  const emp = text(formData, 'employee_id')
  const action = text(formData, 'action')
  const punch = text(formData, 'punch_id')
  const kind = text(formData, 'kind')
  const { supabase } = await session()
  const { data: e } = await supabase.from('employees').select('company_id').eq('id', emp).maybeSingle()
  if (!e) go(back, { error: 'employee_not_found' })
  const rules = await workforceRules(supabase, e.company_id)
  const at = action === 'void' ? null : zonedToIso(text(formData, 'day'), text(formData, 'time'), rules.timezone)
  if (action !== 'void' && !at) go(back, { error: 'correction_invalid' })
  const { error } = await supabase.rpc('request_punch_correction', {
    emp, corr_action: action, target_punch: UUID.test(punch) ? punch : null, corr_kind: action === 'void' ? null : kind,
    corr_at: at, corr_reason: text(formData, 'reason'),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'correction_requested' })
}

export async function decideCorrection(formData: FormData) {
  const back = backTo(formData, '/workforce/requests')
  const { supabase } = await session()
  const { error } = await supabase.rpc('decide_punch_correction', {
    correction: text(formData, 'id'), approve: text(formData, 'decision') === 'approve', note: opt(formData, 'note', 300),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: text(formData, 'decision') === 'approve' ? 'approved' : 'rejected' })
}

export async function cancelCorrection(formData: FormData) {
  const back = backTo(formData, '/clock')
  const { supabase } = await session()
  const { error } = await supabase.rpc('cancel_punch_correction', { correction: text(formData, 'id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'cancelled' })
}

// ------------------------------------------------------------- leave
export async function requestLeave(formData: FormData) {
  const back = backTo(formData, '/clock')
  const kind = text(formData, 'leave_type')
  const hours = text(formData, 'hours')
  if (!(LEAVE_TYPES as readonly string[]).includes(kind)) go(back, { error: 'leave_type_invalid' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('request_leave', {
    emp: text(formData, 'employee_id'), kind, from_day: text(formData, 'starts_on') || null, to_day: text(formData, 'ends_on') || text(formData, 'starts_on') || null,
    minutes: hours && /^\d+(\.\d{1,2})?$/.test(hours) ? Math.round(Number(hours) * 60) : null, why: opt(formData, 'reason', 300),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'leave_requested' })
}

export async function decideLeave(formData: FormData) {
  const back = backTo(formData, '/workforce/requests')
  const { supabase } = await session()
  const { error } = await supabase.rpc('decide_leave', {
    request: text(formData, 'id'), approve: text(formData, 'decision') === 'approve', note: opt(formData, 'note', 300),
  })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: text(formData, 'decision') === 'approve' ? 'approved' : 'rejected' })
}

export async function cancelLeave(formData: FormData) {
  const back = backTo(formData, '/clock')
  const { supabase } = await session()
  const { error } = await supabase.rpc('cancel_leave', { request: text(formData, 'id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'cancelled' })
}

// ------------------------------------------------------------- shifts
export async function createShift(formData: FormData) {
  const back = backTo(formData, '/workforce/schedule')
  const emp = text(formData, 'employee_id')
  const { supabase } = await session()
  const { data: e } = await supabase.from('employees').select('company_id').eq('id', emp).maybeSingle()
  if (!e) go(back, { error: 'employee_not_found' })
  const rules = await workforceRules(supabase, e.company_id)
  const day = text(formData, 'day')
  const start = zonedToIso(day, text(formData, 'start'), rules.timezone)
  let end = zonedToIso(day, text(formData, 'end'), rules.timezone)
  if (!start || !end) go(back, { error: 'shift_invalid' })
  if (end! <= start!) end = new Date(Date.parse(end!) + 86_400_000).toISOString()   // overnight shift
  const repeat = Math.min(Math.max(Number(text(formData, 'repeat_days') || 1), 1), 14)
  for (let i = 0; i < repeat; i++) {
    const shiftBy = (iso: string) => new Date(Date.parse(iso) + i * 86_400_000).toISOString()
    const { error } = await supabase.from('work_shifts').insert({
      company_id: e.company_id, employee_id: emp, starts_at: shiftBy(start!), ends_at: shiftBy(end!),
      break_minutes: Math.min(Math.max(Number(text(formData, 'break_minutes') || 0), 0), 480), notes: opt(formData, 'notes', 300),
    })
    if (error) go(back, { error: wfErrorCode(error), created: String(i) })
  }
  refresh()
  go(back, { done: 'shift' })
}

export async function deleteShift(formData: FormData) {
  const back = backTo(formData, '/workforce/schedule')
  const { supabase } = await session()
  const { data, error } = await supabase.from('work_shifts').delete().eq('id', text(formData, 'id')).select('id')
  if (error || !data?.length) go(back, { error: error ? wfErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: 'shift_deleted' })
}

// ------------------------------------------------------------- settings
export async function saveWorkforceSettings(formData: FormData) {
  const { supabase, companyId } = await company()
  const num = (k: string) => (text(formData, k) === '' ? null : Number(text(formData, k)))
  const daily = num('daily_hours'); const weekly = num('weekly_hours')
  const tz = text(formData, 'timezone')
  let validTz = true
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { validTz = false }
  if (!validTz) go('/workforce/settings', { error: 'invalid' })
  const row = {
    company_id: companyId, timezone: tz,
    week_starts_on: Math.min(Math.max(Number(text(formData, 'week_starts_on') || 1), 0), 6),
    daily_overtime_after_minutes: daily === null ? null : Math.round(daily * 60),
    weekly_overtime_after_minutes: weekly === null ? null : Math.round(weekly * 60),
    overtime_multiplier: Number(text(formData, 'overtime_multiplier') || 1.5),
    grace_minutes: Number(text(formData, 'grace_minutes') || 5),
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('workforce_settings').upsert(row, { onConflict: 'company_id' })
  if (error) go('/workforce/settings', { error: wfErrorCode(error) })
  refresh()
  go('/workforce/settings', { done: 'saved' })
}

export async function createDepartment(formData: FormData) {
  const { supabase, companyId } = await company()
  const name = text(formData, 'name').slice(0, 80)
  if (!name) go('/workforce/settings', { error: 'invalid' })
  const { error } = await supabase.from('departments').insert({ company_id: companyId, name })
  if (error) go('/workforce/settings', { error: wfErrorCode(error) })
  refresh()
  go('/workforce/settings', { done: 'department' })
}

export async function setSupervisor(formData: FormData) {
  const { supabase, companyId } = await company()
  const dept = text(formData, 'department_id'); const user = text(formData, 'user_id')
  if (!UUID.test(dept) || !UUID.test(user)) go('/workforce/settings', { error: 'invalid' })
  const { error } = text(formData, 'remove') === 'yes'
    ? await supabase.from('department_supervisors').delete().eq('department_id', dept).eq('user_id', user)
    : await supabase.from('department_supervisors').insert({ company_id: companyId, department_id: dept, user_id: user })
  if (error) go('/workforce/settings', { error: wfErrorCode(error) })
  refresh()
  go('/workforce/settings', { done: 'supervisor' })
}

// ------------------------------------------------------------- PIN mode (0021)
export async function setEmployeePin(formData: FormData) {
  const back = backTo(formData, '/clock')
  const emp = text(formData, 'employee_id')
  const pin = text(formData, 'pin')
  if (pin !== text(formData, 'pin_confirm')) go(back, { error: 'pin_mismatch' })
  const { supabase } = await session()
  const { error } = await supabase.rpc('set_employee_pin', { emp, pin })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'pin_set' })
}

export async function clearEmployeePin(formData: FormData) {
  const back = backTo(formData, '/workforce/employees')
  const { supabase } = await session()
  const { error } = await supabase.rpc('clear_employee_pin', { emp: text(formData, 'employee_id') })
  if (error) go(back, { error: wfErrorCode(error) })
  refresh()
  go(back, { done: 'pin_cleared' })
}

export async function createKiosk(formData: FormData) {
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('create_kiosk', { target: companyId, kiosk_name: text(formData, 'name') })
  if (error || typeof data !== 'string') go('/workforce/settings', { error: wfErrorCode(error) })
  const origin = resolveAppOrigin(process.env, (await headers()).get('host'))
  if (!origin) go('/workforce/settings', { error: 'save' })
  const { cookies } = await import('next/headers')
  // Shown once to the manager, to open on the tablet; never in the URL.
  ;(await cookies()).set('ba_kiosk_setup', `${origin}/kiosk/setup?token=${data}`, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/workforce/settings', maxAge: 600,
  })
  refresh()
  go('/workforce/settings', { done: 'kiosk' })
}

export async function revokeKiosk(formData: FormData) {
  const { supabase } = await session()
  const { error } = await supabase.rpc('revoke_kiosk', { kiosk: text(formData, 'id') })
  if (error) go('/workforce/settings', { error: wfErrorCode(error) })
  refresh()
  go('/workforce/settings', { done: 'kiosk_revoked' })
}

/** Activates THIS tablet: stores the kiosk token in an httpOnly cookie (no account). */
export async function activateKiosk(formData: FormData) {
  const token = text(formData, 'token')
  if (!/^[0-9a-f]{64}$/.test(token)) redirect('/kiosk?status=kiosk_invalid')
  const supabase = await createClient()
  const { data } = await supabase.rpc('kiosk_info', { raw_token: token })
  if (!Array.isArray(data) || !data.length) redirect('/kiosk?status=kiosk_invalid')
  const { cookies } = await import('next/headers')
  ;(await cookies()).set('ba_kiosk', token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/kiosk', maxAge: 60 * 60 * 24 * 400 })
  redirect('/kiosk')
}

/** A punch at the shared tablet: employee number + PIN; the tablet learns only the first name. */
export async function kioskPunch(formData: FormData) {
  const kind = text(formData, 'kind')
  const { cookies } = await import('next/headers')
  const token = (await cookies()).get('ba_kiosk')?.value ?? ''
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('kiosk_punch', {
    raw_token: token, emp_number: text(formData, 'number').slice(0, 30), emp_pin: text(formData, 'pin').slice(0, 8), punch_kind: kind,
  })
  const row = Array.isArray(data) ? (data[0] as { status: string; first_name: string | null; kind: string | null; punched_at: string | null } | undefined) : undefined
  if (error || !row) redirect('/kiosk?status=unavailable')
  const sp = new URLSearchParams({ status: row.status })
  if (row.status === 'ok' && row.first_name && row.kind && row.punched_at) {
    sp.set('name', row.first_name.slice(0, 40)); sp.set('kind', row.kind); sp.set('at', row.punched_at)
  }
  redirect(`/kiosk?${sp}`)
}

'use server'
/**
 * Payroll actions (migration 0034). The database computes, checks and
 * records everything with the user's own session (payroll.view / manage /
 * approve, plan, company). The only thing computed here is the Workforce
 * hours split (regular / overtime with the company rules) — the database
 * verifies it against the punches and refuses any mismatch.
 */
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { parseCents } from '@/lib/finance/money'
import { workforceRules } from '@/lib/workforce/context'
import { buildReport } from '@/lib/workforce/report'
import { FREQUENCIES, hoursPayload, payrollErrorCode, type Frequency } from '@/lib/payroll/core'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
const backTo = (f: FormData, fallback: string) => (/^\/payroll(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(text(f, 'back')) ? text(f, 'back') : fallback)
function refresh() { revalidatePath('/payroll', 'layout'); revalidatePath('/clock') }
async function company() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/payroll')
  const m = await getActiveMembership(supabase, user.id)
  if (!m) redirect('/onboarding')
  return { supabase, user, companyId: m.companyId }
}

// ------------------------------------------------------------- compensation and items
export async function setCompensation(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = `/payroll/employees?employee=${UUID.test(emp) ? emp : ''}`
  const kind = text(formData, 'pay_type') === 'salary' ? 'salary' : 'hourly'
  const freq = text(formData, 'pay_frequency') as Frequency
  const amount = parseCents(text(formData, 'amount'))
  const ot = text(formData, 'overtime_rate') ? parseCents(text(formData, 'overtime_rate')) : null
  if (!UUID.test(emp) || !(FREQUENCIES as readonly string[]).includes(freq) || !DAY.test(text(formData, 'effective_from'))) go(back, { error: 'invalid' })
  if (amount === null || amount <= 0n || (text(formData, 'overtime_rate') && (ot === null || ot <= 0n))) go(back, { error: 'compensation_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('set_compensation', {
    emp, effective: text(formData, 'effective_from'), kind, frequency: freq,
    rate_cents: kind === 'hourly' ? amount!.toString() : null, annual_cents: kind === 'salary' ? amount!.toString() : null,
    ot_rate_cents: kind === 'salary' && ot ? ot.toString() : null, why: text(formData, 'reason'),
  })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'compensation_saved' })
}

export async function saveItem(formData: FormData) {
  const back = '/payroll/settings'
  const calc = text(formData, 'calc') === 'percent' ? 'percent' : 'fixed'
  const kind = text(formData, 'kind') === 'deduction' ? 'deduction' : 'earning'
  const amount = text(formData, 'amount') ? parseCents(text(formData, 'amount')) : null
  const pct = text(formData, 'percent')
  const bp = pct && /^\d{1,3}(\.\d{1,2})?$/.test(pct) ? Math.round(Number(pct) * 100) : null
  if ((calc === 'percent' && !bp) || (text(formData, 'amount') && (amount === null || amount < 0n))) go(back, { error: 'payroll_item_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('payroll_save_item', {
    target: companyId, item_code: text(formData, 'code'), item_name: text(formData, 'name'), item_kind: kind, item_calc: calc,
    amount: calc === 'fixed' && amount !== null ? amount.toString() : null, rate: calc === 'percent' ? bp : null,
  })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'item_saved' })
}

export async function assignItem(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = `/payroll/employees?employee=${UUID.test(emp) ? emp : ''}`
  const amount = text(formData, 'amount') ? parseCents(text(formData, 'amount')) : null
  const pct = text(formData, 'percent')
  const bp = pct && /^\d{1,3}(\.\d{1,2})?$/.test(pct) ? Math.round(Number(pct) * 100) : null
  if (!UUID.test(emp) || !UUID.test(text(formData, 'item_id')) || !DAY.test(text(formData, 'starts_on'))) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('assign_payroll_item', {
    emp, item: text(formData, 'item_id'), amount: amount !== null && amount > 0n ? amount.toString() : null, rate: bp, from_day: text(formData, 'starts_on'),
  })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'item_assigned' })
}

export async function endItem(formData: FormData) {
  const emp = text(formData, 'employee_id')
  const back = `/payroll/employees?employee=${UUID.test(emp) ? emp : ''}`
  const { supabase } = await company()
  const { error } = await supabase.rpc('end_payroll_item', { assignment: text(formData, 'id'), last_day: text(formData, 'last_day') })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'item_ended' })
}

export async function saveSettings(formData: FormData) {
  const back = '/payroll/settings'
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('payroll_save_settings', {
    target: companyId, expense: text(formData, 'expense_account_id'), wages: text(formData, 'wages_account_id'),
    deductions: text(formData, 'deductions_account_id'), payment: text(formData, 'payment_account_id'),
    leave_types: formData.getAll('paid_leave_types').map(String), second_approver: formData.get('second_approver') === 'on',
  })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'settings_saved' })
}

// ------------------------------------------------------------- runs
export async function createRun(formData: FormData) {
  const freq = text(formData, 'pay_frequency') as Frequency
  if (!(FREQUENCIES as readonly string[]).includes(freq) || !DAY.test(text(formData, 'period_start')) || !DAY.test(text(formData, 'period_end')) || !DAY.test(text(formData, 'pay_date'))) {
    go('/payroll', { error: 'payroll_period_invalid' })
  }
  const { supabase, companyId } = await company()
  // a fresh key per form view: a double submit returns the same run
  const idem = /^[\w-]{8,100}$/.test(text(formData, 'idem')) ? text(formData, 'idem') : randomUUID()
  const { data, error } = await supabase.rpc('payroll_create_run', {
    target: companyId, frequency: freq, p_start: text(formData, 'period_start'), p_end: text(formData, 'period_end'), p_pay_date: text(formData, 'pay_date'), idem,
  })
  if (error || typeof data !== 'string') go('/payroll', { error: payrollErrorCode(error) })
  refresh()
  redirect(`/payroll/runs/${data}?done=created`)
}

/** Hours from Workforce for the run's period (all employees the user may see, terminated included). */
async function workforceHours(supabase: Awaited<ReturnType<typeof createClient>>, companyId: string, from: string, to: string) {
  const rules = await workforceRules(supabase, companyId)
  const rows = await buildReport(supabase, { companyId, from, to, rules, includeTerminated: true })
  return hoursPayload(rows)
}

export async function prepareRun(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/payroll/runs/${UUID.test(id) ? id : ''}`
  const { supabase, companyId } = await company()
  const { data: run } = await supabase.from('payroll_runs').select('period_start, period_end, run_type').eq('id', id).maybeSingle()
  if (!run) go('/payroll', { error: 'payroll_run_not_found' })
  const hours = run.run_type === 'correction' ? [] : await workforceHours(supabase, companyId, run.period_start, run.period_end)
  const { error } = await supabase.rpc('payroll_prepare', { run: id, hours })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'prepared' })
}

export async function addAdjustment(formData: FormData) {
  const id = text(formData, 'run_id')
  const back = `/payroll/runs/${UUID.test(id) ? id : ''}`
  const amount = parseCents(text(formData, 'amount'))
  if (amount === null || amount <= 0n) go(back, { error: 'payroll_item_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_add_adjustment', {
    run: id, emp: text(formData, 'employee_id'), item: text(formData, 'item_id'), amount: amount!.toString(), adj_note: text(formData, 'note').slice(0, 200) || null,
  })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'adjustment_added' })
}

export async function removeAdjustment(formData: FormData) {
  const back = `/payroll/runs/${UUID.test(text(formData, 'run_id')) ? text(formData, 'run_id') : ''}`
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_remove_adjustment', { adjustment: text(formData, 'id') })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'adjustment_removed' })
}

export async function approveRun(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/payroll/runs/${UUID.test(id) ? id : ''}`
  if (formData.get('confirm') !== 'on') go(back, { error: 'confirm' })
  const version = Number.parseInt(text(formData, 'version'), 10)
  if (!Number.isInteger(version)) go(back, { error: 'payroll_preview_stale' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_approve', { run: id, expected_version: version })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'approved' })
}

export async function recordPayment(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/payroll/runs/${UUID.test(id) ? id : ''}`
  if (!DAY.test(text(formData, 'paid_on'))) go(back, { error: 'payment_date_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_record_payment', { run: id, paid_on: text(formData, 'paid_on'), reference: text(formData, 'reference').slice(0, 100) || null })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'paid' })
}

export async function reverseRun(formData: FormData) {
  const id = text(formData, 'id')
  const back = `/payroll/runs/${UUID.test(id) ? id : ''}`
  if (formData.get('confirm') !== 'on') go(back, { error: 'confirm' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_reverse', { run: id, why: text(formData, 'reason') })
  if (error) go(back, { error: payrollErrorCode(error) })
  refresh()
  go(back, { done: 'reversed' })
}

export async function discardRun(formData: FormData) {
  const id = text(formData, 'id')
  const { supabase } = await company()
  const { error } = await supabase.rpc('payroll_discard', { run: id })
  if (error) go(`/payroll/runs/${UUID.test(id) ? id : ''}`, { error: payrollErrorCode(error) })
  refresh()
  go('/payroll', { done: 'discarded' })
}

export async function createCorrection(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/payroll/runs/${UUID.test(id) ? id : ''}`)
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('payroll_create_correction', { run: id, p_pay_date: DAY.test(text(formData, 'pay_date')) ? text(formData, 'pay_date') : null })
  if (error || typeof data !== 'string') go(back, { error: payrollErrorCode(error) })
  refresh()
  redirect(`/payroll/runs/${data}?done=created`)
}

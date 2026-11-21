'use server'
/**
 * Payables actions (migration 0024). Every write runs with the user's own
 * session through RLS or a 0024 function: PostgreSQL checks roles, limits,
 * self-approval, balances, closed periods and posts to the ledger (0023).
 */
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { isoDay } from '@/lib/finance/ledger'
import { parseCents } from '@/lib/finance/money'
import { ATTACHMENT_BUCKET, FREQUENCIES, PAY_METHODS, parseBillLines, payablesErrorCode, validateAttachment } from '@/lib/finance/payables'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const opt = (f: FormData, k: string, max = 200) => (text(f, k) ? text(f, k).slice(0, max) : null)

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/payables(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
}
function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
async function company() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const m = await getActiveMembership(supabase, user.id)
  if (!m) redirect('/onboarding')
  return { supabase, companyId: m.companyId, userId: user.id }
}
const refresh = () => { revalidatePath('/payables', 'layout'); revalidatePath('/accounting', 'layout') }

export async function initPayables(formData: FormData) {
  const back = backTo(formData, '/payables')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('payables_init', { target: companyId })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'initialized' })
}

// ------------------------------------------------------------- vendors
export async function saveVendor(formData: FormData) {
  const back = backTo(formData, '/payables/vendors')
  const id = text(formData, 'id')
  const name = text(formData, 'name').slice(0, 160)
  if (!name) go(back, { error: 'invalid' })
  const row = { name, tax_id: opt(formData, 'tax_id', 40), email: opt(formData, 'email', 200), phone: opt(formData, 'phone', 40),
    address: opt(formData, 'address', 400), notes: opt(formData, 'notes', 1000) }
  const { supabase, companyId } = await company()
  if (id) {
    if (!UUID.test(id)) go(back, { error: 'invalid' })
    const { data, error } = await supabase.from('vendors').update(row).eq('id', id).eq('company_id', companyId).select('id')
    if (error || !data?.length) go(back, { error: error ? payablesErrorCode(error) : 'forbidden' })
  } else {
    const { error } = await supabase.from('vendors').insert({ ...row, company_id: companyId })
    if (error) go(back, { error: payablesErrorCode(error) })
  }
  refresh()
  go(back, { done: id ? 'vendor_saved' : 'vendor_created' })
}

export async function setVendorStatus(formData: FormData) {
  const back = backTo(formData, '/payables/vendors')
  const id = text(formData, 'id')
  const status = text(formData, 'status')
  if (!UUID.test(id) || !['active', 'archived'].includes(status)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.from('vendors').update({ status }).eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) go(back, { error: error ? payablesErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: status === 'archived' ? 'vendor_archived' : 'vendor_restored' })
}

// ------------------------------------------------------------- categories and settings
export async function saveCategory(formData: FormData) {
  const back = backTo(formData, '/payables/settings')
  const id = text(formData, 'id')
  const name = text(formData, 'name').slice(0, 120)
  const account = text(formData, 'account_id')
  if (!name || !UUID.test(account)) go(back, { error: 'invalid' })
  const row = { name, name_en: opt(formData, 'name_en', 120), account_id: account }
  const { supabase, companyId } = await company()
  const { error } = id
    ? (UUID.test(id) ? await supabase.from('expense_categories').update(row).eq('id', id).eq('company_id', companyId) : { error: { message: 'invalid', code: '23514' } })
    : await supabase.from('expense_categories').insert({ ...row, company_id: companyId })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'category_saved' })
}

export async function setCategoryStatus(formData: FormData) {
  const back = backTo(formData, '/payables/settings')
  const id = text(formData, 'id')
  const status = text(formData, 'status')
  if (!UUID.test(id) || !['active', 'archived'].includes(status)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.from('expense_categories').update({ status }).eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) go(back, { error: error ? payablesErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: 'category_saved' })
}

export async function saveApprovalSettings(formData: FormData) {
  const back = backTo(formData, '/payables/settings')
  const limit = (k: string) => {
    const v = text(formData, `${k}_limit`)
    if (!v) return { ok: true, cents: null as string | null }
    const c = parseCents(v)
    return c === null ? { ok: false, cents: null } : { ok: true, cents: c.toString() }
  }
  const admin = limit('admin')
  const member = limit('member')
  if (!admin.ok || !member.ok) go(back, { error: 'amount_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('payables_save_settings', {
    target: companyId, self_approval: formData.get('self_approval') === 'on',
    admin_limit: admin.cents, admin_can: formData.get('admin_can') === 'on',
    member_limit: member.cents, member_can: formData.get('member_can') === 'on',
  })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'settings_saved' })
}

// ------------------------------------------------------------- bills
export async function saveBill(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, id ? `/payables/${id}/edit` : '/payables/new')
  const vendor = text(formData, 'vendor_id')
  const billDate = isoDay(text(formData, 'bill_date'))
  const dueDate = text(formData, 'due_date') ? isoDay(text(formData, 'due_date')) : null
  const description = text(formData, 'description').slice(0, 300)
  if (!UUID.test(vendor)) go(back, { error: 'vendor_invalid' })
  if (!billDate || (text(formData, 'due_date') && !dueDate) || (dueDate && dueDate < billDate)) go(back, { error: 'date_invalid' })
  if (!description) go(back, { error: 'invalid' })
  if (id && !UUID.test(id)) go(back, { error: 'bill_not_found' })
  const parsed = parseBillLines(formData)
  if ('error' in parsed) go(back, { error: parsed.error })
  const key = UUID.test(text(formData, 'idempotency_key')) ? text(formData, 'idempotency_key') : randomUUID()
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('bill_save_draft', {
    target: companyId, bill: id || null, vendor, invoice_number: opt(formData, 'vendor_invoice_number', 60),
    bill_date: billDate, due_date: dueDate, description, notes: opt(formData, 'notes', 1000),
    lines: parsed.lines, idempotency_key: id ? null : key,
  })
  if (error) go(back, { error: payablesErrorCode(error) })
  const billId = String(data)
  const intent = text(formData, 'intent')
  if (intent === 'submit' || intent === 'submit_approve') {
    const { error: e1 } = await supabase.rpc('bill_submit', { bill: billId })
    if (e1) { refresh(); go(`/payables/${billId}`, { error: payablesErrorCode(e1) }) }
    if (intent === 'submit_approve') {
      const { error: e2 } = await supabase.rpc('bill_approve', { bill: billId })
      if (e2) { refresh(); go(`/payables/${billId}`, { error: payablesErrorCode(e2), done: 'submitted' }) }
    }
  }
  refresh()
  go(`/payables/${billId}`, { done: intent === 'submit_approve' ? 'approved' : intent === 'submit' ? 'submitted' : 'saved' })
}

async function billCall(formData: FormData, fn: string, args: (id: string) => Record<string, unknown>, done: string) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/payables/${id}`)
  if (!UUID.test(id)) go(back, { error: 'bill_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc(fn, args(id))
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done })
}

export async function submitBill(formData: FormData) { await billCall(formData, 'bill_submit', (bill) => ({ bill }), 'submitted') }
export async function approveBill(formData: FormData) { await billCall(formData, 'bill_approve', (bill) => ({ bill }), 'approved') }
export async function rejectBill(formData: FormData) {
  const reason = text(formData, 'reason').slice(0, 300)
  if (reason.length < 3) go(backTo(formData, `/payables/${text(formData, 'id')}`), { error: 'reason_required' })
  await billCall(formData, 'bill_reject', (bill) => ({ bill, reason }), 'rejected')
}
export async function voidBill(formData: FormData) {
  const reason = text(formData, 'reason').slice(0, 300)
  if (reason.length < 3) go(backTo(formData, `/payables/${text(formData, 'id')}`), { error: 'reason_required' })
  await billCall(formData, 'bill_void', (bill) => ({ bill, reason }), 'voided')
}
export async function scheduleBill(formData: FormData) {
  const raw = text(formData, 'pay_on')
  const day = raw ? isoDay(raw) : null
  if (raw && !day) go(backTo(formData, `/payables/${text(formData, 'id')}`), { error: 'date_invalid' })
  await billCall(formData, 'bill_schedule', (bill) => ({ bill, pay_on: day }), day ? 'scheduled' : 'unscheduled')
}

export async function deleteDraft(formData: FormData) {
  const id = text(formData, 'id')
  if (!UUID.test(id)) go('/payables', { error: 'bill_not_found' })
  const { supabase, companyId } = await company()
  // Files of the draft first (the database keeps them only while registered).
  const { data: files } = await supabase.from('bill_attachments').select('storage_path').eq('bill_id', id)
  const { data, error } = await supabase.from('bills').delete().eq('id', id).eq('company_id', companyId).eq('status', 'draft').select('id')
  if (error || !data?.length) go(`/payables/${id}`, { error: error ? payablesErrorCode(error) : 'bill_not_draft' })
  const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path)
  if (paths.length) await supabase.storage.from(ATTACHMENT_BUCKET).remove(paths)
  refresh()
  go('/payables', { done: 'deleted' })
}

export async function payBill(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/payables/${id}`)
  const cents = parseCents(text(formData, 'amount'))
  const day = isoDay(text(formData, 'paid_on'))
  const account = text(formData, 'account_id')
  const method = text(formData, 'method')
  if (!UUID.test(id)) go(back, { error: 'bill_not_found' })
  if (cents === null || cents <= 0n) go(back, { error: 'amount_invalid' })
  if (!day) go(back, { error: 'date_invalid' })
  if (!UUID.test(account)) go(back, { error: 'payment_account_invalid' })
  const key = UUID.test(text(formData, 'idempotency_key')) ? text(formData, 'idempotency_key') : randomUUID()
  const { supabase } = await company()
  const { error } = await supabase.rpc('bill_pay', {
    bill: id, amount_cents: cents.toString(), paid_on: day, account,
    method: (PAY_METHODS as readonly string[]).includes(method) ? method : null, reference: opt(formData, 'reference', 100), idempotency_key: key,
  })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'paid' })
}

export async function voidPayment(formData: FormData) {
  const payment = text(formData, 'payment_id')
  const back = backTo(formData, '/payables')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(payment)) go(back, { error: 'payment_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bill_payment_void', { payment, reason })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'payment_voided' })
}

// ------------------------------------------------------------- attachments
/** Registers a file the browser already uploaded with the user's session (storage RLS). */
export async function registerAttachment(input: { billId: string; path: string; fileName: string; type: string; size: number }): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(input.billId)) return { ok: false, error: 'bill_not_found' }
  const invalid = validateAttachment({ type: input.type, size: input.size })
  if (invalid) return { ok: false, error: invalid }
  const { supabase, companyId } = await company()
  if (!input.path.startsWith(`${companyId}/${input.billId}/`) || input.path.split('/').length !== 3) return { ok: false, error: 'forbidden' }
  const { error } = await supabase.from('bill_attachments').insert({
    company_id: companyId, bill_id: input.billId, storage_path: input.path, file_name: input.fileName.slice(0, 200),
    content_type: input.type, size_bytes: input.size,
  })
  if (error) {
    await supabase.storage.from(ATTACHMENT_BUCKET).remove([input.path])   // allowed: not registered
    return { ok: false, error: payablesErrorCode(error) }
  }
  refresh()
  return { ok: true }
}

export async function removeAttachment(formData: FormData) {
  const id = text(formData, 'attachment_id')
  const bill = text(formData, 'id')
  const back = `/payables/${UUID.test(bill) ? bill : ''}`
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.from('bill_attachments').delete().eq('id', id).select('storage_path')
  if (error || !data?.length) go(back, { error: error ? payablesErrorCode(error) : 'forbidden' })
  await supabase.storage.from(ATTACHMENT_BUCKET).remove([(data[0] as { storage_path: string }).storage_path])
  refresh()
  go(back, { done: 'attachment_removed' })
}

// ------------------------------------------------------------- recurring
export async function saveRecurring(formData: FormData) {
  const back = backTo(formData, '/payables/recurring')
  const vendor = text(formData, 'vendor_id')
  const category = text(formData, 'category_id')
  const frequency = text(formData, 'frequency')
  const start = isoDay(text(formData, 'start_date'))
  const end = text(formData, 'end_date') ? isoDay(text(formData, 'end_date')) : null
  const cents = parseCents(text(formData, 'amount'))
  const description = text(formData, 'description').slice(0, 300)
  const dueDays = Math.max(0, Math.min(365, Number.parseInt(text(formData, 'due_days') || '0', 10) || 0))
  if (!UUID.test(vendor) || !UUID.test(category) || !(FREQUENCIES as readonly string[]).includes(frequency) || !description) go(back, { error: 'invalid' })
  if (!start || (text(formData, 'end_date') && (!end || end < start))) go(back, { error: 'date_invalid' })
  if (cents === null || cents <= 0n) go(back, { error: 'amount_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.from('recurring_expenses').insert({
    company_id: companyId, vendor_id: vendor, category_id: category, description, amount_cents: cents.toString(), frequency,
    start_date: start, end_date: end, due_days: dueDays, auto_submit: formData.get('auto_submit') === 'on',
  })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'recurring_saved' })
}

export async function setRecurringStatus(formData: FormData) {
  const back = backTo(formData, '/payables/recurring')
  const id = text(formData, 'id')
  const status = text(formData, 'status')
  if (!UUID.test(id) || !['active', 'paused'].includes(status)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.from('recurring_expenses').update({ status }).eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) go(back, { error: error ? payablesErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: status === 'paused' ? 'recurring_paused' : 'recurring_resumed' })
}

export async function generateRecurring(formData: FormData) {
  const back = backTo(formData, '/payables/recurring')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('recurring_generate', { target: companyId })
  if (error) go(back, { error: payablesErrorCode(error) })
  refresh()
  go(back, { done: 'generated', n: String(Number(data ?? 0)) })
}

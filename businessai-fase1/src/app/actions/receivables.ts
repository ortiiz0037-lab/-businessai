'use server'
/**
 * Receivables actions (migration 0025). Every write runs with the user's own
 * session through a 0025 function: PostgreSQL checks roles, balances,
 * concurrency and posts reversals to the ledger. Email goes out only when
 * an email provider is configured; nothing is marked sent otherwise.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { isoDay } from '@/lib/finance/ledger'
import { parseCents } from '@/lib/finance/money'
import { arErrorCode, COLLECTION_STATUSES, parseOffsets, renderReminder } from '@/lib/finance/receivables'
import { sendEmail } from '@/lib/email/resend'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/(receivables|documents)(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
  return { supabase, companyId: m.companyId }
}
function refresh() {
  revalidatePath('/receivables', 'layout'); revalidatePath('/accounting', 'layout'); revalidatePath('/payments'); revalidatePath('/documents', 'layout')
}

export async function refreshCollections(formData: FormData) {
  const back = backTo(formData, '/receivables')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('ar_refresh', { target: companyId })
  if (error) go(back, { error: arErrorCode(error) })
  const r = ((data ?? []) as { promises_resolved: number; reminders_queued: number }[])[0]
  refresh()
  go(back, { done: 'refreshed', p: String(r?.promises_resolved ?? 0), r: String(r?.reminders_queued ?? 0) })
}

export async function voidClientPayment(formData: FormData) {
  const back = backTo(formData, '/receivables')
  const payment = text(formData, 'payment_id')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(payment)) go(back, { error: 'payment_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('payment_void', { payment, reason })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'payment_voided' })
}

export async function setCollectionStatus(formData: FormData) {
  const doc = text(formData, 'document_id')
  const back = backTo(formData, `/receivables/invoices/${doc}`)
  const status = text(formData, 'status')
  if (!UUID.test(doc) || !(COLLECTION_STATUSES as readonly string[]).includes(status)) go(back, { error: 'status_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('ar_set_status', { doc, new_status: status })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'status' })
}

export async function addCollectionNote(formData: FormData) {
  const doc = text(formData, 'document_id')
  const client = text(formData, 'client_id')
  const back = backTo(formData, '/receivables')
  const body = text(formData, 'body').slice(0, 2000)
  if (!body) go(back, { error: 'note_invalid' })
  if ((doc && !UUID.test(doc)) || (client && !UUID.test(client)) || (!doc && !client)) go(back, { error: 'client_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('ar_add_note', { target: companyId, client: client || null, doc: doc || null, body })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'note' })
}

export async function addPromise(formData: FormData) {
  const doc = text(formData, 'document_id')
  const back = backTo(formData, `/receivables/invoices/${doc}`)
  const day = isoDay(text(formData, 'promised_date'))
  const cents = parseCents(text(formData, 'amount'))
  if (!UUID.test(doc)) go(back, { error: 'invoice_not_found' })
  if (!day) go(back, { error: 'date_invalid' })
  if (cents === null || cents <= 0n) go(back, { error: 'amount_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('ar_add_promise', { doc, promised_date: day, amount_cents: cents.toString(), note: text(formData, 'note').slice(0, 500) || null })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'promise' })
}

export async function cancelPromise(formData: FormData) {
  const back = backTo(formData, '/receivables')
  const promise = text(formData, 'promise_id')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(promise)) go(back, { error: 'promise_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('ar_cancel_promise', { promise, reason })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'promise_cancelled' })
}

export async function markReminder(formData: FormData) {
  const back = backTo(formData, '/receivables')
  const reminder = text(formData, 'reminder_id')
  const status = text(formData, 'status')
  if (!UUID.test(reminder) || !['sent_manual', 'cancelled'].includes(status)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('ar_mark_reminder', { reminder, new_status: status, error: null })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: status === 'cancelled' ? 'reminder_cancelled' : 'reminder_marked' })
}

/** Sends one prepared reminder by email (only with a configured provider). */
export async function sendReminder(formData: FormData) {
  const back = backTo(formData, '/receivables')
  const reminder = text(formData, 'reminder_id')
  if (!UUID.test(reminder)) go(back, { error: 'reminder_not_found' })
  const { supabase, companyId } = await company()
  const { data: r } = await supabase.from('collection_reminders').select('*').eq('id', reminder).eq('company_id', companyId).maybeSingle()
  if (!r || !['pending', 'failed'].includes(r.status)) go(back, { error: 'reminder_closed' })
  const [{ data: doc }, { data: client }, { data: settings }, { data: co }, { data: bal }] = await Promise.all([
    supabase.from('documents').select('document_number, due_date, issue_date').eq('id', r.document_id).maybeSingle(),
    supabase.from('clients').select('name').eq('id', r.client_id).maybeSingle(),
    supabase.from('collection_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }),
  ])
  const row = ((bal ?? []) as { document_id: string; balance_cents: number }[]).find((b) => b.document_id === r.document_id)
  if (!row || Number(row.balance_cents) <= 0) go(back, { error: 'invoice_not_open' })
  const lang = (r.language === 'en' ? 'en' : 'es') as 'es' | 'en'
  const s = settings as { message_es?: string | null; message_en?: string | null; sender_name?: string | null; reply_to?: string | null } | null
  const msg = renderReminder({
    locale: lang, template: lang === 'en' ? s?.message_en : s?.message_es, client: client?.name ?? '', invoice: doc?.document_number ?? '',
    balanceCents: row.balance_cents, due: doc?.due_date ?? doc?.issue_date ?? '', company: s?.sender_name || co?.name || '',
  })
  const result = await sendEmail({ to: r.to_email ?? '', subject: msg.subject, text: msg.text, replyTo: s?.reply_to, fromName: s?.sender_name || co?.name })
  if (!result.ok && result.notConfigured) go(back, { error: 'email_not_configured' })
  const { error } = await supabase.rpc('ar_mark_reminder', { reminder, new_status: result.ok ? 'sent' : 'failed', error: result.ok ? null : result.error })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, result.ok ? { done: 'reminder_sent' } : { error: 'email_failed' })
}

export async function saveCollectionSettings(formData: FormData) {
  const back = backTo(formData, '/receivables/settings')
  const offsets = parseOffsets(text(formData, 'offsets'))
  if (!offsets) go(back, { error: 'invalid' })
  const lang = text(formData, 'language') === 'en' ? 'en' : 'es'
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('ar_save_settings', {
    target: companyId, enabled: formData.get('enabled') === 'on', offsets, lang,
    sender: text(formData, 'sender_name').slice(0, 100) || null, reply: text(formData, 'reply_to').slice(0, 200) || null,
    msg_es: text(formData, 'message_es').slice(0, 2000) || null, msg_en: text(formData, 'message_en').slice(0, 2000) || null,
  })
  if (error) go(back, { error: arErrorCode(error) })
  refresh()
  go(back, { done: 'settings' })
}

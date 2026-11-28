'use server'
/**
 * Accounting actions (migration 0023). Every write runs with the user's own
 * session through RLS or a 0023 function: PostgreSQL checks the balance,
 * the roles, closed periods and immutability, and records the history.
 */
import { STATEMENT_CLASSES } from '@/lib/finance/statements'
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { ACCOUNT_TYPES, isoDay, ledgerErrorCode, monthStart, parseEntryLines } from '@/lib/finance/ledger'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const opt = (f: FormData, k: string, max = 200) => (text(f, k) ? text(f, k).slice(0, max) : null)

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/accounting(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
const refresh = () => revalidatePath('/accounting', 'layout')

export async function initLedger(formData: FormData) {
  const back = backTo(formData, '/accounting')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('ledger_init', { target: companyId })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: 'initialized' })
}

export async function importHistory(formData: FormData) {
  const back = backTo(formData, '/accounting')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('ledger_import_history', { target: companyId })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: 'imported', n: String(Number(data ?? 0)) })
}

export async function saveAccount(formData: FormData) {
  const back = backTo(formData, '/accounting/accounts')
  const id = text(formData, 'id')
  const type = text(formData, 'type')
  const code = text(formData, 'code')
  const name = text(formData, 'name').slice(0, 120)
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/.test(code) || !name || !(ACCOUNT_TYPES as readonly string[]).includes(type)) go(back, { error: 'invalid' })
  const row: Record<string, string | null> = { code, name, name_en: opt(formData, 'name_en', 120), type, description: opt(formData, 'description', 500) }
  // statement_class (0027) is sent only by forms that show it; '' = automatic
  if (id && formData.has('statement_class')) {
    const sc = text(formData, 'statement_class')
    if (sc && !(STATEMENT_CLASSES[type] ?? []).includes(sc)) go(back, { error: 'invalid' })
    row.statement_class = sc || null
  }
  const { supabase, companyId } = await company()
  const { error } = id
    ? (UUID.test(id) ? await supabase.from('ledger_accounts').update(row).eq('id', id).eq('company_id', companyId) : { error: { message: 'ACCOUNT_INVALID' } })
    : await supabase.from('ledger_accounts').insert({ ...row, company_id: companyId })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: id ? 'account_saved' : 'account_created' })
}

export async function setAccountStatus(formData: FormData) {
  const back = backTo(formData, '/accounting/accounts')
  const id = text(formData, 'id')
  const status = text(formData, 'status')
  if (!UUID.test(id) || !['active', 'archived'].includes(status)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.from('ledger_accounts').update({ status }).eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) go(back, { error: error ? ledgerErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: status === 'archived' ? 'account_archived' : 'account_restored' })
}

export async function deleteAccount(formData: FormData) {
  const back = backTo(formData, '/accounting/accounts')
  const id = text(formData, 'id')
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.from('ledger_accounts').delete().eq('id', id).eq('company_id', companyId).select('id')
  if (error || !data?.length) go(back, { error: error ? ledgerErrorCode(error) : 'forbidden' })
  refresh()
  go(back, { done: 'account_deleted' })
}

export async function postManualEntry(formData: FormData) {
  const back = backTo(formData, '/accounting/journal/new')
  const day = isoDay(text(formData, 'entry_date'))
  const description = text(formData, 'description').slice(0, 300)
  if (!day) go(back, { error: 'entry_date_invalid' })
  if (!description) go(back, { error: 'entry_description_required' })
  const parsed = parseEntryLines(formData)
  if ('error' in parsed) go(back, { error: parsed.error })
  // One key per form: a double submission returns the same entry.
  const key = UUID.test(text(formData, 'idempotency_key')) ? text(formData, 'idempotency_key') : randomUUID()
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('ledger_post_manual', {
    target: companyId, entry_date: day, description, reference: opt(formData, 'reference', 100),
    lines: parsed.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, memo: l.memo })),
    idempotency_key: key,
  })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go('/accounting/journal', { done: 'posted', entry: String(data ?? '') })
}

export async function reverseEntry(formData: FormData) {
  const back = backTo(formData, '/accounting/journal')
  const id = text(formData, 'id')
  const reason = text(formData, 'reason').slice(0, 300)
  const day = text(formData, 'reversal_date') ? isoDay(text(formData, 'reversal_date')) : null
  if (!UUID.test(id)) go(back, { error: 'entry_not_found' })
  if (reason.length < 3) go(back, { error: 'reversal_reason_required' })
  if (text(formData, 'reversal_date') && !day) go(back, { error: 'entry_date_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('ledger_reverse_entry', { entry: id, reason, reversal_date: day })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: 'reversed' })
}

export async function closePeriod(formData: FormData) {
  const back = backTo(formData, '/accounting/periods')
  const month = monthStart(text(formData, 'month'))
  if (!month) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('ledger_close_period', { target: companyId, month })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: 'closed' })
}

export async function reopenPeriod(formData: FormData) {
  const back = backTo(formData, '/accounting/periods')
  const month = monthStart(text(formData, 'month'))
  const reason = text(formData, 'reason').slice(0, 300)
  if (!month) go(back, { error: 'invalid' })
  if (reason.length < 3) go(back, { error: 'reopen_reason_required' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('ledger_reopen_period', { target: companyId, month, reason })
  if (error) go(back, { error: ledgerErrorCode(error) })
  refresh()
  go(back, { done: 'reopened' })
}

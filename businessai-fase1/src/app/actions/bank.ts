'use server'
/**
 * Bank actions (migration 0026). Every write runs with the user's session
 * through a 0026 function: PostgreSQL checks roles, sums, duplicates, locks
 * and closed periods, and posts only balanced ledger entries.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { isoDay } from '@/lib/finance/ledger'
import { parseCents } from '@/lib/finance/money'
import { bankErrorCode } from '@/lib/finance/bank'
import { decodeBytes, MAX_FILE_BYTES, normalize, parseCsv, parseSignedCents, sha256Hex, validateMapping, type Mapping } from '@/lib/finance/bank-csv'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/bank(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
const refresh = () => { revalidatePath('/bank', 'layout'); revalidatePath('/accounting', 'layout') }

export async function initBank(formData: FormData) {
  const back = backTo(formData, '/bank')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('bank_init', { target: companyId })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'initialized' })
}

export async function saveBankAccount(formData: FormData) {
  const back = backTo(formData, '/bank/accounts')
  const id = text(formData, 'id')
  const ledger = text(formData, 'ledger_account_id')
  const name = text(formData, 'name').slice(0, 120)
  if (!name || !UUID.test(ledger) || (id && !UUID.test(id))) go(back, { error: 'bank_ledger_account_invalid' })
  const { supabase, companyId } = await company()
  await supabase.rpc('bank_init', { target: companyId })
  const { error } = await supabase.rpc('bank_save_account', {
    target: companyId, account: id || null, account_name: name, bank: text(formData, 'bank_name').slice(0, 120) || null,
    digits: text(formData, 'last4') || null, ledger_account: ledger, currency_code: null,
  })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: id ? 'account_saved' : 'account_created' })
}

export async function setBankAccountStatus(formData: FormData) {
  const back = backTo(formData, '/bank/accounts')
  const id = text(formData, 'id')
  const status = text(formData, 'status')
  if (!UUID.test(id) || !['active', 'archived'].includes(status)) go(back, { error: 'save' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_set_account_status', { account: id, new_status: status })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: status === 'archived' ? 'account_archived' : 'account_restored' })
}

/**
 * Imports a CSV statement. The server re-reads and re-parses the file with
 * the confirmed mapping (the browser preview is only a preview), hashes it
 * and hands normalized rows to bank_import, which validates them again.
 */
export async function importStatement(formData: FormData) {
  const back = backTo(formData, '/bank/import')
  const account = text(formData, 'bank_account_id')
  const file = formData.get('file')
  if (!UUID.test(account)) go(back, { error: 'bank_account_not_found' })
  if (!(file instanceof File) || file.size === 0) go(back, { error: 'file_missing' })
  if (file.size > MAX_FILE_BYTES) go(back, { error: 'file_too_large' })
  let mapping: Mapping
  try { mapping = JSON.parse(text(formData, 'mapping')) as Mapping } catch { go(back, { error: 'mapping_format' }) }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { text: content, encoding } = decodeBytes(bytes)
  const table = parseCsv(content)
  const header = table[Math.max(0, mapping.skipRows ?? 0)] ?? []
  const invalid = validateMapping(mapping, header.length)
  if (invalid) go(back, { error: invalid })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000))
  const parsed = normalize(table, mapping, { today })
  if (parsed.errors.length) go(back, { error: 'file_rows_invalid' })
  if (parsed.rows.length === 0) go(back, { error: 'import_invalid' })
  const sha = await sha256Hex(bytes)
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('bank_import', {
    account, file_name: file.name.slice(0, 200), file_sha256: sha, mapping: { ...mapping, encoding },
    rows: parsed.rows, allow_identical: formData.get('allow_identical') === 'on',
  })
  if (error) go(back, { error: bankErrorCode(error) })
  const r = ((data ?? []) as { import_id: string; imported: number; duplicates: number; already: boolean }[])[0]
  refresh()
  go(`/bank/accounts/${account}`, r?.already ? { done: 'already_imported' } : { done: 'imported', n: String(r?.imported ?? 0), d: String(r?.duplicates ?? 0) })
}

export async function revertImport(formData: FormData) {
  const back = backTo(formData, '/bank/reports')
  const id = text(formData, 'import_id')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(id)) go(back, { error: 'import_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_import_revert', { import: id, reason })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'import_reverted' })
}

export async function autoMatch(formData: FormData) {
  const account = text(formData, 'bank_account_id')
  const back = backTo(formData, `/bank/accounts/${account}`)
  if (!UUID.test(account)) go(back, { error: 'bank_account_not_found' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('bank_auto_match', { account })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'auto_matched', n: String(Number(data ?? 0)) })
}

export async function matchLines(formData: FormData) {
  const back = backTo(formData, '/bank')
  const bankLines = formData.getAll('bank_line').map(String).filter((x) => UUID.test(x))
  const journalLines = formData.getAll('journal_line').map(String).filter((x) => /^\d{1,18}$/.test(x))
  const method = text(formData, 'method') === 'suggestion' ? 'suggestion' : 'manual'
  const confidence = Number.parseInt(text(formData, 'confidence') || '', 10)
  if (bankLines.length === 0 || journalLines.length === 0) go(back, { error: 'match_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_match', {
    bank_lines: bankLines, journal_lines: journalLines, note: text(formData, 'note').slice(0, 300) || null, method,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : null,
  })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'matched' })
}

export async function unmatch(formData: FormData) {
  const back = backTo(formData, '/bank')
  const group = text(formData, 'group_id')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(group)) go(back, { error: 'match_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_unmatch', { match_group: group, reason })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'unmatched' })
}

/** Fee, interest, transfer or unknown item: balanced entry + match. */
export async function postBankLine(formData: FormData) {
  const back = backTo(formData, '/bank')
  const line = text(formData, 'bank_line_id')
  const counter = text(formData, 'counter_account_id')
  const description = text(formData, 'description').slice(0, 300)
  if (!UUID.test(line) || !UUID.test(counter)) go(back, { error: 'account_invalid' })
  if (description.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_line_post', { bank_line: line, counter_account: counter, description })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'posted' })
}

function cents(f: FormData, k: string): string | null {
  const v = text(f, k)
  const c = v ? parseSignedCents(v, '.') ?? (() => { const p = parseCents(v); return p === null ? null : p })() : null
  return c === null ? null : c.toString()
}

export async function createReconciliation(formData: FormData) {
  const account = text(formData, 'bank_account_id')
  const back = backTo(formData, '/bank/reconciliations')
  const from = isoDay(text(formData, 'period_start'))
  const to = isoDay(text(formData, 'period_end'))
  const opening = cents(formData, 'opening')
  const closing = cents(formData, 'closing')
  if (!UUID.test(account)) go(back, { error: 'bank_account_not_found' })
  if (!from || !to || to < from) go(back, { error: 'date_invalid' })
  if (opening === null || closing === null) go(back, { error: 'amount_invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('bank_reconciliation_create', {
    account, period_start: from, period_end: to, opening_cents: opening, closing_cents: closing, note: text(formData, 'note').slice(0, 500) || null,
  })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(`/bank/reconciliations/${data}`, { done: 'created' })
}

export async function updateReconciliation(formData: FormData) {
  const rec = text(formData, 'id')
  const back = `/bank/reconciliations/${UUID.test(rec) ? rec : ''}`
  const opening = cents(formData, 'opening')
  const closing = cents(formData, 'closing')
  if (!UUID.test(rec)) go('/bank/reconciliations', { error: 'reconciliation_not_found' })
  if (opening === null || closing === null) go(back, { error: 'amount_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_reconciliation_update', { rec, opening_cents: opening, closing_cents: closing, note: text(formData, 'note').slice(0, 500) || null })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'updated' })
}

export async function adjustReconciliation(formData: FormData) {
  const rec = text(formData, 'id')
  const back = `/bank/reconciliations/${UUID.test(rec) ? rec : ''}`
  const counter = text(formData, 'counter_account_id')
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(rec) || !UUID.test(counter)) go(back, { error: 'account_invalid' })
  if (reason.length < 10) go(back, { error: 'adjustment_reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_reconciliation_adjust', { rec, counter_account: counter, reason })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'adjusted' })
}

export async function closeReconciliation(formData: FormData) {
  const rec = text(formData, 'id')
  const back = `/bank/reconciliations/${UUID.test(rec) ? rec : ''}`
  if (!UUID.test(rec)) go('/bank/reconciliations', { error: 'reconciliation_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_reconciliation_close', { rec })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'closed' })
}

export async function reopenReconciliation(formData: FormData) {
  const rec = text(formData, 'id')
  const back = `/bank/reconciliations/${UUID.test(rec) ? rec : ''}`
  const reason = text(formData, 'reason').slice(0, 300)
  if (!UUID.test(rec)) go('/bank/reconciliations', { error: 'reconciliation_not_found' })
  if (reason.length < 3) go(back, { error: 'reason_required' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_reconciliation_reopen', { rec, reason })
  if (error) go(back, { error: bankErrorCode(error) })
  refresh()
  go(back, { done: 'reopened' })
}

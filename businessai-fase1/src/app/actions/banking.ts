'use server'
/**
 * Banking actions (S6, migration 0042). Every write runs with the user's
 * session through a 0042 function: PostgreSQL checks permissions, company and
 * branch, amounts, balances and duplicates. Provider calls happen here, on the
 * server: the access token is decrypted only in memory and never logged or
 * returned; bank passwords never reach BusinessAI (Plaid Link collects them).
 */
import { createHash, randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { readBankingConfig, readOcrConfig } from '@/lib/banking/config'
import { decryptToken, encryptToken } from '@/lib/banking/crypto'
import { bankingErrorCode } from '@/lib/banking/messages'
import { ocrFor, parseConfirmed } from '@/lib/banking/ocr'
import { PlaidError, RECONNECT_CODES } from '@/lib/banking/plaid'
import { BankSigner } from '@/lib/banking/signer'
import { plaidFor, syncConnection } from '@/lib/banking/sync'
import { ATTACHMENT_BUCKET } from '@/lib/finance/payables'
import { EVIDENCE_BUCKET, EVIDENCE_MAX_BYTES, sniff } from '@/lib/banking/files'
import { getLocale } from '@/lib/i18n/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/(bank|payments)(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
  return { supabase, user, companyId: m.companyId }
}
const refresh = () => { revalidatePath('/bank', 'layout'); revalidatePath('/payments'); revalidatePath('/documents', 'layout') }

// ------------------------------------------------------------- connections
type Result = { ok: true } | { ok: false; error: string }

/** A Link token for the browser (new connection, or update mode to reconnect). Only bank.manage. */
export async function createLinkToken(connectionId?: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const cfg = readBankingConfig()
  if (!cfg.configured) return { ok: false, error: 'not_configured' }
  const { supabase, user, companyId } = await company()
  const { data: can } = await supabase.rpc('has_permission', { target: companyId, permission: 'bank.manage' })
  if (can !== true) return { ok: false, error: 'forbidden' }
  let accessToken: string | undefined
  if (connectionId) {
    if (!UUID.test(connectionId)) return { ok: false, error: 'bank_connection_not_found' }
    const s = new BankSigner(cfg.serverKeys[0]).context(connectionId)
    const { data, error } = await supabase.rpc('bank_sync_context', { connection: connectionId, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (error || !data?.token_ciphertext) return { ok: false, error: error ? bankingErrorCode(error) : 'disconnected' }
    try { accessToken = decryptToken(data.token_ciphertext, cfg.tokenKeys) } catch { return { ok: false, error: 'save' } }
  }
  try {
    const r = await plaidFor(cfg).linkToken({ userId: user.id, language: (await getLocale()) === 'en' ? 'en' : 'es', accessToken })
    return { ok: true, token: r.link_token }
  } catch (e) {
    return { ok: false, error: e instanceof PlaidError ? 'provider_error' : 'save' }
  }
}

/** Public token from Link (or the sandbox) → access token (encrypted) → connection + accounts, saved with the server signature. */
async function finishConnection(publicToken: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const cfg = readBankingConfig()
  if (!cfg.configured) return { ok: false, error: 'not_configured' }
  const { supabase, user, companyId } = await company()
  const { data: can } = await supabase.rpc('has_permission', { target: companyId, permission: 'bank.manage' })
  if (can !== true) return { ok: false, error: 'forbidden' }
  const plaid = plaidFor(cfg)
  let payload: string
  try {
    const ex = await plaid.exchange(publicToken)
    const acc = await plaid.accounts(ex.access_token)
    const institutionId = acc.item.institution_id ?? null
    const institution = institutionId ? await plaid.institutionName(institutionId) : null
    const enc = encryptToken(ex.access_token, cfg.tokenKeys)
    payload = JSON.stringify({
      provider: 'plaid', environment: cfg.environment, item_id: ex.item_id, institution_id: institutionId, institution_name: institution,
      token_ciphertext: enc.ciphertext, key_version: enc.keyVersion,
      accounts: acc.accounts.slice(0, 50).map((a) => ({ id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, currency: a.balances?.iso_currency_code ?? null })),
    })
  } catch (e) {
    return { ok: false, error: e instanceof PlaidError ? 'provider_error' : 'save' }
  }
  const s = new BankSigner(cfg.serverKeys[0]).connect(user.id, companyId, payload)
  const { data, error } = await supabase.rpc('bank_connection_save', { target: companyId, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
  if (error) return { ok: false, error: bankingErrorCode(error) }
  refresh()
  return { ok: true, id: data as string }
}

export async function completeConnection(publicToken: string): Promise<Result> {
  if (typeof publicToken !== 'string' || !/^public-[A-Za-z0-9-]{8,200}$/.test(publicToken)) return { ok: false, error: 'bank_connection_invalid' }
  const r = await finishConnection(publicToken)
  return r.ok ? { ok: true } : r
}

/** Sandbox / local test double only: a test connection without the Link interface (clearly labelled as test data). */
export async function connectTestBank() {
  const cfg = readBankingConfig()
  if (!cfg.configured || cfg.environment === 'production') go('/bank/connections', { error: 'not_configured' })
  let token: string
  try { token = (await plaidFor(cfg).sandboxPublicToken()).public_token } catch { go('/bank/connections', { error: 'provider_error' }) }
  const r = await finishConnection(token!)
  if (!r.ok) go('/bank/connections', { error: r.error })
  go('/bank/connections', { done: 'connected' })
}

export async function linkProviderAccount(formData: FormData) {
  const back = backTo(formData, '/bank/connections')
  const pa = text(formData, 'provider_account_id'), account = text(formData, 'bank_account_id')
  if (!UUID.test(pa) || (account && !UUID.test(account))) go(back, { error: 'bank_account_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_link_provider_account', { provider_account: pa, account: account || null })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  go(back, { done: account ? 'linked' : 'unlinked' })
}

export async function syncNow(formData: FormData) {
  const back = backTo(formData, '/bank/connections')
  const id = text(formData, 'connection_id')
  if (!UUID.test(id)) go(back, { error: 'bank_connection_not_found' })
  const { supabase, companyId } = await company()
  const { data: can } = await supabase.rpc('has_permission', { target: companyId, permission: 'bank.manage' })
  if (can !== true) go(back, { error: 'forbidden' })
  const r = await syncConnection(supabase, readBankingConfig(), id, 'manual')
  refresh()
  if (!r.ok) go(back, { error: r.reason === 'provider_error' && r.code && RECONNECT_CODES.has(r.code) ? 'provider_error' : r.reason })
  go(back, { done: 'synced', added: String(r.added), dup: String(r.duplicates) })
}

export async function disconnectConnection(formData: FormData) {
  const back = backTo(formData, '/bank/connections')
  const id = text(formData, 'connection_id')
  if (!UUID.test(id)) go(back, { error: 'bank_connection_not_found' })
  if (formData.get('confirm') !== 'on') go(back, { error: 'confirm_required' })
  const cfg = readBankingConfig()
  if (!cfg.configured) go(back, { error: 'not_configured' })
  const { supabase, user } = await company()
  const signer = new BankSigner(cfg.serverKeys[0])
  const c = signer.context(id)
  const { data, error } = await supabase.rpc('bank_sync_context', { connection: id, key: c.key, ts: c.ts, nonce: c.nonce, mac: c.mac })
  if (error) go(back, { error: bankingErrorCode(error) })
  // first at the provider (the item stops existing there), then locally (the token is erased)
  if (data?.token_ciphertext) {
    try {
      await plaidFor(cfg).remove(decryptToken(data.token_ciphertext, cfg.tokenKeys))
    } catch (e) {
      const gone = e instanceof PlaidError && ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(e.code)
      if (!gone) go(back, { error: 'provider_error' })
    }
  }
  const d = signer.disconnect(user.id, id)
  const r = await supabase.rpc('bank_connection_disconnect', { connection: id, key: d.key, ts: d.ts, nonce: d.nonce, mac: d.mac })
  if (r.error) go(back, { error: bankingErrorCode(r.error) })
  refresh()
  go(back, { done: 'disconnected' })
}

// ------------------------------------------------------------- branches
export async function setAccountBranch(formData: FormData) {
  const back = backTo(formData, '/bank/accounts')
  const account = text(formData, 'bank_account_id'), branch = text(formData, 'branch_id')
  if (!UUID.test(account) || (branch && !UUID.test(branch))) go(back, { error: 'branch_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_account_set_branch', { account, branch: branch || null })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  go(back, { done: 'branch_set' })
}
export async function setLineBranch(formData: FormData) {
  const back = backTo(formData, '/bank/deposits')
  const line = text(formData, 'line_id'), branch = text(formData, 'branch_id')
  if (!UUID.test(line) || (branch && !UUID.test(branch))) go(back, { error: 'branch_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_line_set_branch', { line, branch: branch || null })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  go(back, { done: 'branch_set' })
}

// ------------------------------------------------------------- deposits (human decisions)
const METHODS = ['bank_transfer', 'ath_movil', 'check', 'cash', 'credit_card', 'debit_card', 'other']
export async function applyDeposit(formData: FormData) {
  const line = text(formData, 'line_id')
  const back = backTo(formData, `/bank/deposits/${UUID.test(line) ? line : ''}`)
  if (!UUID.test(line)) go(back, { error: 'bank_line_not_found' })
  const docs = formData.getAll('alloc_doc').map(String), amounts = formData.getAll('alloc_amount').map(String)
  const confidence = Number(text(formData, 'confidence'))
  const reasons = text(formData, 'reasons').split(',').map((r) => r.trim()).filter((r) => /^[a-z_]{1,40}$/.test(r)).slice(0, 10)
  const allocations: { document_id: string; amount_cents: number; confidence: number | null; reasons: string[] }[] = []
  for (let i = 0; i < docs.length; i++) {
    const a = (amounts[i] ?? '').replace(/[$,\s]/g, '')
    if (!docs[i] && !a) continue
    if (!UUID.test(docs[i]) || !/^\d{1,12}(\.\d{1,2})?$/.test(a) || Number(a) <= 0) go(back, { error: 'deposit_invalid' })
    allocations.push({ document_id: docs[i], amount_cents: Math.round(Number(a) * 100), confidence: Number.isFinite(confidence) && confidence > 0 ? Math.min(100, Math.round(confidence)) : null, reasons })
  }
  if (!allocations.length || new Set(allocations.map((a) => a.document_id)).size !== allocations.length) go(back, { error: 'deposit_invalid' })
  const method = text(formData, 'method')
  const idem = text(formData, 'idempotency_key')
  if (!/^[A-Za-z0-9-]{8,80}$/.test(idem)) go(back, { error: 'deposit_invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('bank_apply_deposit', {
    line, allocations, idem, method_code: METHODS.includes(method) ? method : 'bank_transfer',
  })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  const r = data as { remaining_cents?: number }
  go(back, { done: r?.remaining_cents ? 'applied_partial' : 'applied' })
}

export async function linkDepositPayment(formData: FormData) {
  const line = text(formData, 'line_id'), payment = text(formData, 'payment_id')
  const back = backTo(formData, `/bank/deposits/${UUID.test(line) ? line : ''}`)
  if (!UUID.test(line) || !UUID.test(payment)) go(back, { error: 'payment_not_found' })
  const c = Number(text(formData, 'confidence'))
  const reasons = text(formData, 'reasons').split(',').map((r) => r.trim()).filter((r) => /^[a-z_]{1,40}$/.test(r)).slice(0, 10)
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_link_payment', { line, payment, confidence: Number.isFinite(c) && c > 0 ? Math.round(c) : null, reasons })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  go(back, { done: 'linked_payment' })
}

export async function voidAllocation(formData: FormData) {
  const id = text(formData, 'allocation_id')
  const back = backTo(formData, '/bank/deposits')
  if (!UUID.test(id)) go(back, { error: 'allocation_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('bank_allocation_void', { allocation: id, reason: text(formData, 'reason') })
  if (error) go(back, { error: bankingErrorCode(error) })
  refresh()
  go(back, { done: 'allocation_voided' })
}

// ------------------------------------------------------------- receipts
/**
 * Registers a receipt the browser uploaded (with the user's session) to the
 * private evidence bucket: the server reads it back, checks its real type and
 * size, hashes it (the same file twice is the same receipt), registers it and,
 * when an OCR provider is configured, stores the provider's suggestions.
 */
export async function registerReceipt(input: { path: string; fileName: string; branchId?: string | null }): Promise<{ ok: true; id: string; duplicate: boolean } | { ok: false; error: string }> {
  const { supabase, companyId } = await company()
  if (typeof input?.path !== 'string' || !new RegExp(`^${companyId}/receipts/[0-9a-f-]{36}\\.(jpg|png|webp|pdf)$`).test(input.path)) return { ok: false, error: 'receipt_invalid' }
  const cleanup = () => supabase.storage.from(EVIDENCE_BUCKET).remove([input.path])
  const dl = await supabase.storage.from(EVIDENCE_BUCKET).download(input.path)
  if (dl.error || !dl.data) return { ok: false, error: 'receipt_invalid' }
  const bytes = new Uint8Array(await dl.data.arrayBuffer())
  const type = sniff(bytes)
  if (!type || bytes.length === 0 || bytes.length > EVIDENCE_MAX_BYTES) { await cleanup(); return { ok: false, error: 'file' } }
  const sha = createHash('sha256').update(bytes).digest('hex')
  const { data, error } = await supabase.rpc('receipt_register', {
    target: companyId, path: input.path, name: String(input.fileName || 'recibo').slice(0, 200), mime: type, bytes: bytes.length, digest: sha,
    branch: input.branchId && UUID.test(input.branchId) ? input.branchId : null,
  })
  if (error) { await cleanup(); return { ok: false, error: bankingErrorCode(error) } }
  const r = data as { id: string; duplicate: boolean }
  if (r.duplicate) { await cleanup(); return { ok: true, id: r.id, duplicate: true } }
  const cfg = readOcrConfig()
  const result = await ocrFor(cfg).analyze(bytes, type)
  await supabase.rpc('receipt_set_extraction', {
    capture: r.id, provider: cfg.configured ? (cfg.testDouble ? 'test_double' : result.provider) : 'none',
    status: result.status, error: result.status === 'failed' ? result.error : null, fields: result.status === 'succeeded' ? result.fields : {},
  })
  refresh()
  return { ok: true, id: r.id, duplicate: false }
}

export async function confirmReceipt(formData: FormData) {
  const id = text(formData, 'capture_id')
  const back = `/bank/receipts/${UUID.test(id) ? id : ''}`
  if (!UUID.test(id)) go('/bank/receipts', { error: 'receipt_not_found' })
  const parsed = parseConfirmed({
    date: text(formData, 'date'), total: text(formData, 'total'), tax: text(formData, 'tax'), currency: text(formData, 'currency'), merchant: text(formData, 'merchant'),
    receipt_number: text(formData, 'receipt_number'), payment_method: text(formData, 'payment_method'), reference: text(formData, 'reference'), notes: text(formData, 'notes'),
  })
  if (!parsed.ok) go(back, { error: parsed.error })
  const bill = text(formData, 'bill_id'), payment = text(formData, 'payment_id')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('receipt_confirm', {
    capture: id, data: { ...parsed.data, total_cents: String(parsed.data.total_cents), tax_cents: parsed.data.tax_cents === null ? undefined : String(parsed.data.tax_cents) },
    bill: UUID.test(bill) ? bill : null, payment: UUID.test(payment) ? payment : null,
  })
  if (error) go(back, { error: bankingErrorCode(error) })
  // linked to an expense: the original is also attached to the bill (Finance keeps its own copy and rules)
  let attached = ''
  if (UUID.test(bill)) {
    const { data: cap } = await supabase.from('receipt_captures').select('storage_path, file_name, content_type, size_bytes').eq('id', id).single()
    const dl = cap ? await supabase.storage.from(EVIDENCE_BUCKET).download(cap.storage_path) : null
    if (cap && dl?.data) {
      const ext = cap.storage_path.split('.').pop()
      const path = `${companyId}/${bill}/${randomUUID()}.${ext}`
      const up = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, dl.data, { upsert: false, contentType: cap.content_type })
      const reg = up.error ? up : await supabase.from('bill_attachments').insert({ company_id: companyId, bill_id: bill, storage_path: path, file_name: cap.file_name, content_type: cap.content_type, size_bytes: cap.size_bytes })
      if (reg.error) { if (!up.error) await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]); attached = 'not_attached' } else attached = 'attached'
    }
  }
  refresh()
  go(back, { done: attached ? `confirmed_${attached}` : 'confirmed' })
}

export async function discardReceipt(formData: FormData) {
  const id = text(formData, 'capture_id')
  if (!UUID.test(id)) go('/bank/receipts', { error: 'receipt_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('receipt_discard', { capture: id })
  if (error) go(`/bank/receipts/${id}`, { error: bankingErrorCode(error) })
  refresh()
  go('/bank/receipts', { done: 'discarded' })
}

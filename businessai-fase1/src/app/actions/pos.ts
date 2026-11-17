'use server'
/**
 * Point of sale actions (S8, migration 0044). Every write runs with the user's session through a 0044
 * function: PostgreSQL prices the cart from the catalog, checks permissions, branch scope, the shift,
 * stock (available = on hand − reserved), approvals and idempotency, and posts stock and the ledger in
 * the same transaction. The browser never sends an amount the database trusts.
 */
import { fetchAllPages } from '@/lib/supabase/paged'
import { createHash } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { parseCents } from '@/lib/finance/money'
import { normalizeScan } from '@/lib/inventory/codes'
import { posErrorCode } from '@/lib/pos/labels'
import { parseRegisterCsv } from '@/lib/pos/csv'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDEM = /^[A-Za-z0-9:_-]{8,80}$/
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const uuidOr = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null)
const cents = (v: string) => { const c = parseCents(v); return c === null ? null : c.toString() }

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/pos(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
const refresh = () => { revalidatePath('/pos', 'layout'); revalidatePath('/inventory', 'layout') }
const fail = (back: string, error: { message?: string; code?: string } | null): never => go(back, { error: posErrorCode(error) })

// ------------------------------------------------------------- register screen (called from the client component)
export type ProductHit = { item: string; variant: string | null; name: string; sku: string; priceCents: string; taxRate: string; tracked: boolean; available: string | null }
export type SaleResult = { ok: true; id: string; number: string; changeCents: string; already: boolean } | { ok: false; error: string }

/** search by scanned / typed code (barcode, variant SKU, catalog code) or by name */
export async function posSearch(raw: string, branch: string | null): Promise<ProductHit[]> {
  const q = String(raw ?? '').trim().slice(0, 80)
  if (!q) return []
  const { supabase, companyId } = await company()
  const code = normalizeScan(q)
  type Row = { id: string; code: string; name: string; price_cents: number; tax_rate: number | null; track_inventory: boolean; kind: string }
  let rows: { item: Row; variant: { id: string; sku: string; attributes: Record<string, string>; price_cents: number | null } | null }[] = []
  const { data: hit } = code ? await supabase.rpc('inventory_lookup', { target: companyId, p_code: code }) : { data: null }
  const h = (hit as { item_id: string; variant_id: string | null }[] | null)?.[0]
  const itemSel = 'id, code, name, price_cents, tax_rate, track_inventory, kind'
  if (h) {
    const { data: it } = await supabase.from('catalog_items').select(itemSel).eq('id', h.item_id).eq('status', 'active').maybeSingle()
    const { data: v } = h.variant_id ? await supabase.from('catalog_variants').select('id, sku, attributes, price_cents').eq('id', h.variant_id).maybeSingle() : { data: null }
    if (it) rows = [{ item: it as Row, variant: v as never }]
  }
  if (!rows.length) {
    const safe = q.replace(/[%_,()]/g, ' ')
    const { data: items } = await supabase.from('catalog_items').select(itemSel).eq('company_id', companyId).eq('status', 'active').or(`name.ilike.%${safe}%,code.ilike.%${safe}%`).order('name').limit(20)
    const list = (items ?? []) as Row[]
    const { data: vars } = list.length ? await supabase.from('catalog_variants').select('id, item_id, sku, attributes, price_cents').in('item_id', list.map((i) => i.id)).eq('status', 'active') : { data: [] }
    for (const it of list) {
      const vs = ((vars ?? []) as { id: string; item_id: string; sku: string; attributes: Record<string, string>; price_cents: number | null }[]).filter((v) => v.item_id === it.id)
      if (vs.length) for (const v of vs) rows.push({ item: it, variant: v }); else rows.push({ item: it, variant: null })
    }
  }
  const [{ data: taxes }, { data: deft }, levels] = await Promise.all([
    supabase.from('pos_item_taxes').select('item_id, pos_tax_rates(rate)').eq('company_id', companyId).in('item_id', rows.map((r) => r.item.id)),
    supabase.from('pos_tax_rates').select('rate').eq('company_id', companyId).eq('is_default', true).is('archived_at', null).maybeSingle(),
    branch && UUID.test(branch) ? fetchAllPages((a, b) => supabase.rpc('inventory_levels', { target: companyId, branch }).order('branch_id').order('item_id').order('variant_key').range(a, b)).then((r) => ({ data: r.rows, error: r.error })) : Promise.resolve({ data: [] }),
  ])
  const itemTax = new Map(((taxes ?? []) as unknown as { item_id: string; pos_tax_rates: { rate: number } | null }[]).map((t) => [t.item_id, t.pos_tax_rates?.rate]))
  const avail = new Map(((levels.data ?? []) as { item_id: string; variant_key: string; available: number }[]).map((l) => [`${l.item_id}:${l.variant_key}`, l.available]))
  return rows.slice(0, 30).map(({ item, variant }) => {
    const rate = itemTax.get(item.id) ?? item.tax_rate ?? (deft as { rate: number } | null)?.rate ?? 0
    const a = avail.get(`${item.id}:${variant?.id ?? '00000000-0000-0000-0000-000000000000'}`)
    return { item: item.id, variant: variant?.id ?? null, name: variant ? `${item.name} · ${Object.values(variant.attributes).join(' / ')}` : item.name, sku: variant?.sku ?? item.code,
      priceCents: String(variant?.price_cents ?? item.price_cents), taxRate: String(rate), tracked: item.track_inventory && item.kind === 'product',
      available: item.track_inventory ? String(a ?? 0) : null }
  })
}

/** the server's price (the same function the sale uses) */
export async function posQuote(lines: { item: string; variant: string | null; qty: string; discount_pct?: string }[], cartPct: string | null) {
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('pos_quote', { target: companyId, lines, cart_discount_cents: null, cart_discount_pct: cartPct ? Number(cartPct) : null })
  if (error) return { ok: false as const, error: posErrorCode(error) }
  return { ok: true as const, quote: data as { subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number; discount_pct: number } }
}

export async function posCreateSale(input: { branch: string; register: string; shift: string | null; client: string | null; lines: { item: string; variant: string | null; qty: string; discount_pct?: string }[]
  cartPct: string | null; discountReason: string | null; approvalCode: string | null; note: string | null
  payments: { method: string; amount_cents: string; tendered_cents?: string | null; reference?: string | null; card_last4?: string | null; card_brand?: string | null }[]; idem: string }): Promise<SaleResult> {
  if (!IDEM.test(input.idem ?? '') || !uuidOr(input.branch) || !uuidOr(input.register)) return { ok: false, error: 'pos_invalid' }
  const { supabase, companyId } = await company()
  const payload = { branch: input.branch, register: input.register, shift: uuidOr(input.shift), client: uuidOr(input.client), lines: input.lines.slice(0, 200),
    cart_discount_pct: input.cartPct && /^\d{1,3}(\.\d{1,2})?$/.test(input.cartPct) ? input.cartPct : undefined, discount_reason: input.discountReason?.slice(0, 200) || undefined,
    approval_code: input.approvalCode?.replace(/\D/g, '').slice(0, 8) || undefined, note: input.note?.slice(0, 500) || undefined,
    payments: input.payments.slice(0, 10).map((p) => ({ method: p.method, amount_cents: p.amount_cents, tendered_cents: p.tendered_cents || undefined, reference: p.reference?.slice(0, 120) || undefined,
      card_last4: p.card_last4 && /^\d{4}$/.test(p.card_last4) ? p.card_last4 : undefined, card_brand: p.card_brand?.slice(0, 30) || undefined })) }
  const { data, error } = await supabase.rpc('pos_sale_create', { target: companyId, payload, idem: input.idem })
  if (error) return { ok: false, error: posErrorCode(error) }
  const r = data as { id?: string; number?: string; change_cents?: number; already?: boolean; error?: string }
  if (r.error) return { ok: false, error: r.error.toLowerCase() }
  refresh()
  return { ok: true, id: r.id!, number: r.number ?? '', changeCents: String(r.change_cents ?? 0), already: !!r.already }
}

// ------------------------------------------------------------- shifts and cash
export async function openShift(formData: FormData) {
  const back = backTo(formData, '/pos/register')
  const c = cents(text(formData, 'float') || '0'), idem = text(formData, 'idempotency_key')
  if (c === null || !IDEM.test(idem)) go(back, { error: 'pos_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_shift_open', { register: uuidOr(text(formData, 'register_id')), float_cents: Number(c), idem })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'shift_open' })
}
export async function cashMove(formData: FormData) {
  const back = backTo(formData, '/pos/shifts')
  const c = cents(text(formData, 'amount')), idem = text(formData, 'idempotency_key')
  if (c === null || !IDEM.test(idem)) go(back, { error: 'pos_invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('pos_cash_move', { shift: uuidOr(text(formData, 'shift_id')), p_kind: text(formData, 'kind'), amount: Number(c), reason: text(formData, 'reason'),
    approval_code: text(formData, 'approval_code').replace(/\D/g, '') || null, idem })
  if (error) fail(back, error)
  if ((data as { error?: string })?.error) go(back, { error: 'pos_approval_required' })
  refresh(); go(back, { done: 'cash' })
}
export async function closeShift(formData: FormData) {
  const back = backTo(formData, '/pos/shifts')
  // blind count by denomination: {"10000": 2, "2000": 3, …} (cents → pieces)
  const detail: Record<string, number> = {}
  let total = 0n
  for (const d of ['10000', '5000', '2000', '1000', '500', '100', '25', '10', '5', '1']) {
    const n = text(formData, `d_${d}`)
    if (!n) continue
    if (!/^\d{1,5}$/.test(n)) go(back, { error: 'pos_invalid' })
    detail[d] = Number(n); total += BigInt(d) * BigInt(n)
  }
  const typed = text(formData, 'counted')
  if (typed) { const c = parseCents(typed); if (c === null) go(back, { error: 'pos_invalid' }); total = c }
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_shift_close', { shift: uuidOr(text(formData, 'shift_id')), counted: Number(total), detail: Object.keys(detail).length ? detail : null,
    note: text(formData, 'note') || null })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'shift_closed' })
}
export async function reviewShift(formData: FormData) {
  const back = backTo(formData, '/pos/shifts')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_shift_review', { shift: uuidOr(text(formData, 'shift_id')), note: text(formData, 'note') })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'reviewed' })
}

/** a one-time supervisor code (returned to the approver's screen only) */
export async function issueApprovalCode(input: { branch: string | null; scope: string; maxCents: string | null; maxPct: string | null; minutes: number }) {
  const { supabase, companyId } = await company()
  const max = input.maxCents ? parseCents(input.maxCents) : null
  const { data, error } = await supabase.rpc('pos_approval_issue', { target: companyId, branch: uuidOr(input.branch), p_scope: input.scope, p_max_cents: max === null ? null : Number(max),
    p_max_pct: input.maxPct ? Number(input.maxPct) : null, minutes: Math.min(60, Math.max(1, Math.round(input.minutes || 10))) })
  if (error) return { ok: false as const, error: posErrorCode(error) }
  const r = data as { code: string; expires_at: string }
  return { ok: true as const, code: r.code, expiresAt: r.expires_at }
}

// ------------------------------------------------------------- voids, refunds, blocked stock
export async function voidSale(formData: FormData) {
  const id = uuidOr(text(formData, 'sale_id')) ?? ''
  const back = backTo(formData, `/pos/sales/${id}`)
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('pos_sale_void', { sale: id, reason: text(formData, 'reason'), approval_code: text(formData, 'approval_code').replace(/\D/g, '') || null })
  if (error) fail(back, error)
  if ((data as { error?: string })?.error) go(back, { error: 'pos_approval_required' })
  refresh(); go(back, { done: 'voided' })
}
export async function refundSale(formData: FormData) {
  const id = uuidOr(text(formData, 'sale_id')) ?? ''
  const back = backTo(formData, `/pos/sales/${id}`)
  const idem = text(formData, 'idempotency_key')
  const lines: { line: string; qty: string }[] = []
  for (const [k, v] of formData.entries()) {
    const m = /^qty_(\d{1,18})$/.exec(k)
    const q = String(v).trim().replace(',', '.')
    if (m && q && q !== '0') { if (!/^\d{1,7}(\.\d{1,3})?$/.test(q)) go(back, { error: 'pos_lines_invalid' }); lines.push({ line: m[1], qty: q }) }
  }
  if (!lines.length || !IDEM.test(idem)) go(back, { error: 'pos_lines_invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('pos_refund_create', { sale: id, payload: { lines, method: text(formData, 'method'), reference: text(formData, 'reference') || null,
    restock: formData.get('restock') === 'on', reason: text(formData, 'reason') }, approval_code: text(formData, 'approval_code').replace(/\D/g, '') || null, idem })
  if (error) fail(back, error)
  if ((data as { error?: string })?.error) go(back, { error: 'pos_approval_required' })
  refresh(); go(back, { done: 'refunded' })
}
export async function postBlockedInventory(formData: FormData) {
  const id = uuidOr(text(formData, 'sale_id')) ?? ''
  const back = backTo(formData, `/pos/sales/${id}`)
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('pos_sale_post_inventory', { sale: id })
  if (error) fail(back, error)
  if ((data as { error?: string })?.error) go(back, { error: 'pos_stock_unavailable' })
  refresh(); go(back, { done: 'stock_posted' })
}

// ------------------------------------------------------------- configuration
export async function savePosSettings(formData: FormData) {
  const back = backTo(formData, '/pos/settings')
  const tol = parseCents(text(formData, 'cash_tolerance') || '0')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('pos_settings_save', { target: companyId, p: { max_discount_pct: text(formData, 'max_discount_pct') || '0', require_shift: formData.get('require_shift') === 'on',
    cash_tolerance_cents: tol === null ? 'x' : tol.toString(), receipt_header: text(formData, 'receipt_header'), receipt_footer: text(formData, 'receipt_footer'),
    allow_card_external: formData.get('allow_card_external') === 'on' } })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'settings' })
}
export async function saveTaxRate(formData: FormData) {
  const back = backTo(formData, '/pos/settings')
  const rate = text(formData, 'rate').replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(rate)) go(back, { error: 'pos_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('pos_tax_rate_save', { target: companyId, rate_id: uuidOr(text(formData, 'rate_id')), p_code: text(formData, 'code'), p_name: text(formData, 'name'),
    p_rate: Number(rate), p_default: formData.get('is_default') === 'on', archived: formData.get('archived') === 'on' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'tax' })
}
export async function setItemTax(formData: FormData) {
  const back = backTo(formData, '/pos/settings')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('pos_item_tax_set', { target: companyId, item: uuidOr(text(formData, 'item_id')), rate_id: uuidOr(text(formData, 'rate_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'tax' })
}
export async function saveRegister(formData: FormData) {
  const back = backTo(formData, '/pos/settings')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('pos_register_save', { target: companyId, register: uuidOr(text(formData, 'register_id')), branch: uuidOr(text(formData, 'branch_id')),
    p_code: text(formData, 'code'), p_name: text(formData, 'name'), archived: formData.get('archived') === 'on' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'register' })
}
export async function assignRegister(formData: FormData) {
  const back = backTo(formData, '/pos/settings')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_register_assign', { register: uuidOr(text(formData, 'register_id')), p_user: uuidOr(text(formData, 'user_id')), assigned: text(formData, 'assigned') === '1' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'register' })
}

// ------------------------------------------------------------- integrations
export async function importSalesCsv(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0 || file.size > 5 * 1024 * 1024) go(back, { error: 'pos_import_invalid' })
  const raw = Buffer.from(await (file as File).arrayBuffer())
  const parsed = parseRegisterCsv(raw.toString('utf8'))
  if (parsed.issues.length) go(back, { error: 'pos_import_invalid', lines: parsed.issues.slice(0, 10).map((i) => `${i.line}:${i.problem}`).join(' ') })
  if (!parsed.sales.length) go(back, { error: 'pos_import_invalid' })
  const { supabase, companyId } = await company()
  const sha = createHash('sha256').update(raw).digest('hex')
  const { data, error } = await supabase.rpc('pos_import_sales', { target: companyId, integration: uuidOr(text(formData, 'integration_id')), p_file_name: (file as File).name.slice(0, 200),
    p_file_sha: sha, sales: parsed.sales })
  if (error) fail(back, error)
  const r = data as { already: boolean; counts?: Record<string, number> }
  refresh()
  go(back, r.already ? { done: 'import_already' } : { done: 'imported', counts: Object.entries(r.counts ?? {}).map(([k, v]) => `${k}:${v}`).join(' ') })
}
export async function mapLocation(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_location_map', { integration: uuidOr(text(formData, 'integration_id')), external_location: text(formData, 'external_location'), branch: uuidOr(text(formData, 'branch_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'mapped' })
}
export async function mapItem(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const [item, variant] = text(formData, 'target').split('|')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_item_map', { integration: uuidOr(text(formData, 'integration_id')), p_external_ref: text(formData, 'external_ref'), item: uuidOr(item), variant: uuidOr(variant) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'mapped' })
}
export async function retrySyncEvent(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const id = text(formData, 'event_id')
  if (!/^\d{1,18}$/.test(id)) go(back, { error: 'pos_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_sync_retry', { event: Number(id) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'retry' })
}
export async function disconnectIntegration(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_integration_disconnect', { integration: uuidOr(text(formData, 'integration_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'disconnected' })
}
export async function issueBridgeToken(integration: string) {
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('pos_bridge_token_issue', { integration: uuidOr(integration) })
  if (error) return { ok: false as const, error: posErrorCode(error) }
  return { ok: true as const, token: data as string }
}
export async function reconcileSettlement(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const { supabase } = await company()
  const { error } = await supabase.rpc('pos_settlement_reconcile', { settlement: uuidOr(text(formData, 'settlement_id')), line: uuidOr(text(formData, 'bank_line_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'reconciled' })
}

/** a local-bridge integration (server-signed creation), then its token is issued separately */
export async function createBridgeIntegration(formData: FormData) {
  const back = backTo(formData, '/pos/integrations')
  const { readPosConfig } = await import('@/lib/pos/config')
  const { PosSigner } = await import('@/lib/pos/signer')
  const cfg = readPosConfig()
  if (!cfg.core || !cfg.bridge) go(back, { error: 'not_configured' })
  const { supabase, user, companyId } = await company()
  const name = text(formData, 'name').slice(0, 80) || 'Puente local'
  const payload = JSON.stringify({ provider: 'bridge', environment: 'local', external_account_id: `bridge:${companyId}:${Date.now().toString(36)}`, display_name: name, settings: {} })
  const s = new PosSigner(cfg.core!.serverKeys[0]).connect(user.id, companyId, payload)
  const { error } = await supabase.rpc('pos_integration_connect', { target: companyId, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'bridge' })
}

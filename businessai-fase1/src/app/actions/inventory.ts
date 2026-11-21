'use server'
/**
 * Inventory actions (S7, migration 0043). Every write runs with the user's session through a
 * 0043 function: PostgreSQL checks permissions, branch scope, stock (never negative unless the
 * company allows it), duplicates (idempotency keys) and keeps the movement ledger append-only.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { ADJUSTMENT_KINDS, inventoryErrorCode, parseQty } from '@/lib/inventory/labels'
import { normalizeScan, SYMBOLOGIES, type Symbology } from '@/lib/inventory/codes'
import { parsePriceCents } from '@/lib/catalog'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDEM = /^[A-Za-z0-9:_-]{8,80}$/
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const uuidOr = (v: string) => (UUID.test(v) ? v : null)

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/(inventory|catalog)(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
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
const refresh = () => { revalidatePath('/inventory', 'layout'); revalidatePath('/catalog', 'layout') }
const fail = (back: string, error: { message?: string; code?: string } | null): never => go(back, { error: inventoryErrorCode(error) })

/** Lines from a form: repeated "line" = "item|variant", "qty", optional "cost" (dollars). */
function linesFrom(f: FormData, withCost = false): { item: string; variant: string | null; qty: string; unit_cost?: string }[] | null {
  const ls = f.getAll('line').map(String), qs = f.getAll('qty').map(String), cs = f.getAll('cost').map(String)
  const out: { item: string; variant: string | null; qty: string; unit_cost?: string }[] = []
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i] && !qs[i]) continue
    const [item, variant] = ls[i].split('|')
    const q = parseQty(qs[i])
    if (!UUID.test(item ?? '') || (variant && !UUID.test(variant)) || q === null) return null
    const row: { item: string; variant: string | null; qty: string; unit_cost?: string } = { item, variant: variant || null, qty: String(q) }
    if (withCost && cs[i]) { const c = parsePriceCents(cs[i]); if (c === null) return null; row.unit_cost = String(c) }
    out.push(row)
  }
  return out.length ? out : null
}

// ------------------------------------------------------------- scanning
export type LookupResult = { ok: true; item: string; variant: string | null; name: string; sku: string; matched_by: string; attributes: Record<string, string>; unit: string; tracked: boolean; status: string }
  | { ok: false; error: 'unknown_code' | 'invalid' | 'unavailable' }

/** A scanned or typed code → the product (barcode, then variant SKU, then catalog code). */
export async function lookupCode(raw: string): Promise<LookupResult> {
  const code = normalizeScan(String(raw ?? ''))
  if (!code) return { ok: false, error: 'invalid' }
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('inventory_lookup', { target: companyId, p_code: code })
  if (error) return { ok: false, error: 'unavailable' }
  const r = (data as { item_id: string; variant_id: string | null; matched_by: string; name: string; sku: string; attributes: Record<string, string>; unit: string; track_inventory: boolean; status: string }[])?.[0]
  if (!r) return { ok: false, error: 'unknown_code' }
  return { ok: true, item: r.item_id, variant: r.variant_id, name: r.name, sku: r.sku, matched_by: r.matched_by, attributes: r.attributes ?? {}, unit: r.unit, tracked: r.track_inventory, status: r.status }
}

// ------------------------------------------------------------- settings
export async function saveInventorySettings(formData: FormData) {
  const back = backTo(formData, '/inventory/settings')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('inventory_settings_save', { target: companyId, p_allow_negative: formData.get('allow_negative') === 'on',
    p_method: text(formData, 'method') === 'fifo' ? 'fifo' : 'average' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'settings' })
}
export async function saveLocation(formData: FormData) {
  const back = backTo(formData, '/inventory/settings')
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('inventory_location_save', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), location: uuidOr(text(formData, 'location_id')),
    p_code: text(formData, 'code'), p_name: text(formData, 'name'), archived: formData.get('archived') === 'on' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'location' })
}
export async function saveItemSettings(formData: FormData) {
  const back = backTo(formData, '/inventory/stock')
  const num = (k: string) => { const t = text(formData, k).replace(',', '.'); return t === '' ? null : /^\d{1,10}(\.\d{1,3})?$/.test(t) ? Number(t) : NaN }
  const vals = { min: num('min_qty'), max: num('max_qty'), rp: num('reorder_point'), rq: num('reorder_qty'), lt: num('lead_time_days') }
  if (Object.values(vals).some((v) => Number.isNaN(v))) go(back, { error: 'inventory_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('inventory_item_settings_save', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), item: uuidOr(text(formData, 'item_id')),
    variant: uuidOr(text(formData, 'variant_id')), p_min: vals.min, p_max: vals.max, p_reorder_point: vals.rp, p_reorder_qty: vals.rq || null,
    p_vendor: uuidOr(text(formData, 'vendor_id')), p_lead_days: vals.lt === null ? null : Math.round(vals.lt) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'rules' })
}

// ------------------------------------------------------------- movements and adjustments
export async function recordMovement(formData: FormData) {
  const back = backTo(formData, '/inventory/movements/new')
  const kind = text(formData, 'kind')
  const branch = uuidOr(text(formData, 'branch_id'))
  const idem = text(formData, 'idempotency_key')
  const direct = kind === 'sale' || kind === 'customer_return'
  if (!branch || !IDEM.test(idem) || (!direct && !(ADJUSTMENT_KINDS as readonly string[]).includes(kind))) go(back, { error: 'inventory_invalid' })
  const lines = linesFrom(formData, !direct)
  if (!lines) go(back, { error: 'inventory_lines_invalid' })
  const { supabase, companyId } = await company()
  const location = uuidOr(text(formData, 'location_id')), doc = uuidOr(text(formData, 'document_id')), reason = text(formData, 'reason').slice(0, 300)
  if (direct) {
    const { error } = await supabase.rpc('inventory_move', { target: companyId, branch, location, p_kind: kind, lines, reason: reason || null, doc, idem })
    if (error) fail(back, error)
    refresh(); go('/inventory/movements', { done: 'recorded' })
  }
  const { data, error } = await supabase.rpc('inventory_adjust', { target: companyId, branch, location, p_kind: kind, lines, reason, vendor: uuidOr(text(formData, 'vendor_id')), doc, idem })
  if (error) fail(back, error)
  refresh()
  go('/inventory/movements', { done: (data as { status: string })?.status === 'approved' ? 'recorded' : 'requested' })
}
export async function decideAdjustment(formData: FormData) {
  const back = backTo(formData, '/inventory/adjustments')
  const { supabase } = await company()
  const { error } = await supabase.rpc('inventory_adjustment_decide', { adjustment: uuidOr(text(formData, 'adjustment_id')), approve: text(formData, 'decision') === 'approve', note: text(formData, 'note') || null })
  if (error) fail(back, error)
  refresh(); go(back, { done: text(formData, 'decision') === 'approve' ? 'approved' : 'rejected' })
}
export async function correctMovement(formData: FormData) {
  const back = backTo(formData, '/inventory/movements')
  const id = Number(text(formData, 'movement_id'))
  if (!Number.isInteger(id) || id <= 0) go(back, { error: 'inventory_not_found' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('inventory_correct', { movement: id, reason: text(formData, 'reason') })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'corrected' })
}
export async function revalueItem(formData: FormData) {
  const back = backTo(formData, '/inventory/stock')
  const cost = parsePriceCents(text(formData, 'cost'))
  if (cost === null) go(back, { error: 'inventory_cost_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('inventory_revalue', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), item: uuidOr(text(formData, 'item_id')),
    variant: uuidOr(text(formData, 'variant_id')), new_cost: cost, reason: text(formData, 'reason') })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'revalued' })
}
export async function issueDocument(formData: FormData) {
  const back = backTo(formData, '/inventory/movements/new?kind=sale')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('inventory_issue_document', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), doc: uuidOr(text(formData, 'document_id')) })
  if (error) fail(back, error)
  refresh(); go('/inventory/movements', { done: 'issued', n: String((data as { lines: number })?.lines ?? 0) })
}
export async function reserveStock(formData: FormData) {
  const back = backTo(formData, '/inventory/stock')
  const q = parseQty(text(formData, 'qty'))
  const idem = text(formData, 'idempotency_key')
  if (q === null || !IDEM.test(idem)) go(back, { error: 'inventory_qty_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('inventory_reserve', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), item: uuidOr(text(formData, 'item_id')),
    variant: uuidOr(text(formData, 'variant_id')), qty: q, p_kind: text(formData, 'kind') === 'committed' ? 'committed' : 'reserved', p_reference: text(formData, 'reference') || null, doc: null, idem })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'reserved' })
}
export async function releaseReservation(formData: FormData) {
  const back = backTo(formData, '/inventory/stock')
  const { supabase } = await company()
  const { error } = await supabase.rpc('inventory_release', { reservation: uuidOr(text(formData, 'reservation_id')), fulfilled: text(formData, 'fulfilled') === '1' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'released' })
}

// ------------------------------------------------------------- purchase orders
export async function savePurchaseOrder(formData: FormData) {
  const id = uuidOr(text(formData, 'po_id'))
  const back = backTo(formData, id ? `/inventory/purchase-orders/${id}` : '/inventory/purchase-orders/new')
  const lines = linesFrom(formData, true)
  if (!lines || lines.some((l) => l.unit_cost === undefined)) go(back, { error: 'inventory_lines_invalid' })
  const expected = text(formData, 'expected_date')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('purchase_order_save', { target: companyId, po: id, vendor: uuidOr(text(formData, 'vendor_id')), branch: uuidOr(text(formData, 'branch_id')),
    p_expected: /^\d{4}-\d{2}-\d{2}$/.test(expected) ? expected : null, p_notes: text(formData, 'notes') || null, lines,
    expected_version: id ? Number(text(formData, 'version')) : null })
  if (error) fail(back, error)
  refresh()
  const target = data as string
  if (text(formData, 'then') === 'submit') {
    const r = await supabase.rpc('purchase_order_transition', { po: target, p_action: 'submit', reason: null })
    if (r.error) go(`/inventory/purchase-orders/${target}`, { error: inventoryErrorCode(r.error) })
  }
  go(`/inventory/purchase-orders/${target}`, { done: id ? 'saved' : 'created' })
}
export async function purchaseOrderTransition(formData: FormData) {
  const id = uuidOr(text(formData, 'po_id'))
  const back = `/inventory/purchase-orders/${id ?? ''}`
  const { supabase } = await company()
  const { error } = await supabase.rpc('purchase_order_transition', { po: id, p_action: text(formData, 'action'), reason: text(formData, 'reason') || null })
  if (error) fail(back, error)
  refresh(); go(back, { done: text(formData, 'action') })
}
export async function receivePurchaseOrder(formData: FormData) {
  const id = uuidOr(text(formData, 'po_id'))
  const back = `/inventory/purchase-orders/${id ?? ''}`
  const idem = text(formData, 'idempotency_key')
  if (!id || !IDEM.test(idem)) go(back, { error: 'inventory_invalid' })
  const lines: { po_line: string; qty: string; damaged: string; note: string | null }[] = []
  for (const lineId of formData.getAll('po_line').map(String)) {
    if (!UUID.test(lineId)) go(back, { error: 'inventory_lines_invalid' })
    const q = text(formData, `qty_${lineId}`), d = text(formData, `dmg_${lineId}`)
    const qv = q === '' ? 0 : parseQty(q), dv = d === '' ? 0 : parseQty(d)
    if (qv === null || dv === null) go(back, { error: 'inventory_qty_invalid' })
    if (qv! + dv! > 0) lines.push({ po_line: lineId, qty: String(qv), damaged: String(dv), note: text(formData, `note_${lineId}`) || null })
  }
  if (!lines.length) go(back, { error: 'inventory_lines_invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('purchase_order_receive', { po: id, lines, notes: text(formData, 'notes') || null, idem })
  if (error) fail(back, error)
  refresh(); go(back, { done: (data as { status: string })?.status === 'received' ? 'received' : 'partially_received' })
}
export async function linkPurchaseBill(formData: FormData) {
  const id = uuidOr(text(formData, 'po_id'))
  const back = `/inventory/purchase-orders/${id ?? ''}`
  const { supabase } = await company()
  const { error } = await supabase.rpc('purchase_order_link_bill', { po: id, bill: uuidOr(text(formData, 'bill_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'bill_linked' })
}
export async function ordersFromSuggestions(formData: FormData) {
  const back = '/inventory/replenishment'
  const lines: Record<string, string | null>[] = []
  for (const v of formData.getAll('pick').map(String)) {
    const [branch, item, variant, vendor] = v.split('|')
    const qty = parseQty(text(formData, `qty_${branch}_${item}_${variant || 'none'}`))
    const cost = Number(text(formData, `cost_${branch}_${item}_${variant || 'none'}`) || 0)
    if (!UUID.test(branch) || !UUID.test(item) || (variant && !UUID.test(variant)) || !UUID.test(vendor ?? '') || qty === null) go(back, { error: 'inventory_lines_invalid' })
    lines.push({ branch, item, variant: variant || null, vendor, qty: String(qty), unit_cost: String(Math.max(0, Math.round(cost))) })
  }
  if (!lines.length) go(back, { error: 'inventory_lines_invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('purchase_orders_from_suggestions', { target: companyId, lines })
  if (error) fail(back, error)
  refresh(); go('/inventory/purchase-orders', { done: 'drafts', n: String((data as string[])?.length ?? 0) })
}

// ------------------------------------------------------------- transfers
export async function createTransfer(formData: FormData) {
  const back = backTo(formData, '/inventory/transfers/new')
  const lines = linesFrom(formData)
  const idem = text(formData, 'idempotency_key')
  if (!lines || !IDEM.test(idem)) go(back, { error: 'inventory_lines_invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('inventory_transfer_request', { target: companyId, from_branch: uuidOr(text(formData, 'from_branch')), to_branch: uuidOr(text(formData, 'to_branch')),
    lines, p_notes: text(formData, 'notes') || null, idem })
  if (error) fail(back, error)
  refresh(); go(`/inventory/transfers/${data as string}`, { done: 'requested' })
}
export async function transferStep(formData: FormData) {
  const id = uuidOr(text(formData, 'transfer_id'))
  const back = `/inventory/transfers/${id ?? ''}`
  const action = text(formData, 'action')
  let lines: Record<string, string>[] | null = null
  if (action === 'prepare' || action === 'receive') {
    lines = []
    for (const lineId of formData.getAll('transfer_line').map(String)) {
      if (!UUID.test(lineId)) go(back, { error: 'inventory_lines_invalid' })
      const q = text(formData, `qty_${lineId}`), d = text(formData, `dmg_${lineId}`)
      const qv = q === '' ? 0 : /^\d{1,10}(\.\d{1,3})?$/.test(q.replace(',', '.')) ? Number(q.replace(',', '.')) : NaN
      const dv = d === '' ? 0 : parseQty(d) ?? NaN
      if (Number.isNaN(qv) || Number.isNaN(dv)) go(back, { error: 'inventory_qty_invalid' })
      lines.push({ line: lineId, qty: String(qv), damaged: String(dv) })
    }
  }
  const { supabase } = await company()
  const { error } = await supabase.rpc('inventory_transfer_step', { transfer: id, p_action: action, lines, note: text(formData, 'note') || null })
  if (error) fail(back, error)
  refresh(); go(back, { done: action })
}

// ------------------------------------------------------------- counts
export async function startCount(formData: FormData) {
  const back = backTo(formData, '/inventory/counts')
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('inventory_count_start', { target: companyId, branch: uuidOr(text(formData, 'branch_id')), location: uuidOr(text(formData, 'location_id')),
    p_scope: text(formData, 'scope') === 'full' ? 'full' : 'partial', p_notes: text(formData, 'notes') || null })
  if (error) fail(back, error)
  refresh(); go(`/inventory/counts/${data as string}`, { done: 'started' })
}
/** One scan (adds 1) or a typed quantity (sets it). Called from the scanner screen. */
export async function countRecord(input: { count: string; item: string; variant: string | null; qty: number; mode: 'add' | 'set' }): Promise<{ ok: true; counted: number } | { ok: false; error: string }> {
  if (!UUID.test(input?.count ?? '') || !UUID.test(input?.item ?? '') || (input.variant && !UUID.test(input.variant)) || !(input.qty >= 0) || !['add', 'set'].includes(input.mode)) return { ok: false, error: 'inventory_invalid' }
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('inventory_count_record', { count: input.count, item: input.item, variant: input.variant, qty: input.qty, p_mode: input.mode })
  if (error) return { ok: false, error: inventoryErrorCode(error) }
  revalidatePath(`/inventory/counts/${input.count}`)
  return { ok: true, counted: Number(data) }
}
export async function countSetLine(formData: FormData) {
  const id = uuidOr(text(formData, 'count_id'))
  const back = `/inventory/counts/${id ?? ''}`
  const [item, variant] = text(formData, 'line').split('|')
  const t = text(formData, 'qty').replace(',', '.')
  if (!/^\d{1,10}(\.\d{1,3})?$/.test(t)) go(back, { error: 'inventory_qty_invalid' })
  const r = await countRecord({ count: id ?? '', item, variant: variant || null, qty: Number(t), mode: 'set' })
  if (!r.ok) go(back, { error: r.error })
  go(back, { done: 'counted' })
}
export async function countStep(formData: FormData) {
  const id = uuidOr(text(formData, 'count_id'))
  const back = `/inventory/counts/${id ?? ''}`
  const { supabase } = await company()
  const { error } = await supabase.rpc('inventory_count_step', { count: id, p_action: text(formData, 'action') })
  if (error) fail(back, error)
  refresh(); go(back, { done: text(formData, 'action') })
}

// ------------------------------------------------------------- catalog: cost, variants, barcodes
export async function setItemCost(formData: FormData) {
  const id = uuidOr(text(formData, 'item_id'))
  const back = backTo(formData, `/catalog/${id ?? ''}`)
  const cost = parsePriceCents(text(formData, 'cost'))
  if (cost === null) go(back, { error: 'inventory_cost_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_set_cost', { item: id, variant: uuidOr(text(formData, 'variant_id')), cost, reason: text(formData, 'reason') || null })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'cost' })
}
export async function saveVariant(formData: FormData) {
  const id = uuidOr(text(formData, 'item_id'))
  const back = backTo(formData, `/catalog/${id ?? ''}`)
  const attrs: Record<string, string> = {}
  for (const [k, v] of [['talla', text(formData, 'size')], ['color', text(formData, 'color')], ['modelo', text(formData, 'model')]]) if (v) attrs[k] = v.slice(0, 60)
  const price = text(formData, 'price') ? parsePriceCents(text(formData, 'price')) : null
  const cost = text(formData, 'cost') ? parsePriceCents(text(formData, 'cost')) : null
  if ((text(formData, 'price') && price === null) || (text(formData, 'cost') && cost === null)) go(back, { error: 'catalog_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_variant_save', { item: id, variant: uuidOr(text(formData, 'variant_id')), p_sku: text(formData, 'sku'), p_attributes: attrs, p_price: price, p_cost: cost })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'variant' })
}
export async function setVariantStatus(formData: FormData) {
  const back = backTo(formData, '/catalog')
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_variant_set_status', { variant: uuidOr(text(formData, 'variant_id')), p_status: text(formData, 'status') === 'archived' ? 'archived' : 'active' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'variant' })
}
export async function addBarcode(formData: FormData) {
  const id = uuidOr(text(formData, 'item_id'))
  const back = backTo(formData, `/catalog/${id ?? ''}`)
  const sym = text(formData, 'symbology') as Symbology
  if (!(SYMBOLOGIES as readonly string[]).includes(sym)) go(back, { error: 'barcode_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_barcode_add', { item: id, variant: uuidOr(text(formData, 'variant_id')), p_code: normalizeScan(text(formData, 'code')), p_symbology: sym,
    p_primary: formData.get('primary') === 'on' })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'barcode' })
}
export async function removeBarcode(formData: FormData) {
  const back = backTo(formData, '/catalog')
  const { supabase } = await company()
  const { error } = await supabase.rpc('catalog_barcode_remove', { barcode: uuidOr(text(formData, 'barcode_id')) })
  if (error) fail(back, error)
  refresh(); go(back, { done: 'barcode_removed' })
}

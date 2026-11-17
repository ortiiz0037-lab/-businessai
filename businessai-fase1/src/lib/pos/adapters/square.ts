/**
 * Square adapter (SERVER ONLY), REST over fetch. Documented API (developer.squareup.com):
 *   OAuth      GET  {connect}/oauth2/authorize?client_id&scope&session=false&state
 *              POST {connect}/oauth2/token  (authorization_code / refresh_token) → access_token, refresh_token, expires_at, merchant_id
 *   Orders     GET  /v2/orders/{order_id}            POST /v2/orders/search (location_ids, updated_at filter, cursor)
 *   Locations  GET  /v2/locations
 *   Payouts    GET  /v2/payouts?location_id         GET /v2/payouts/{id}/payout-entries
 *   Webhooks   header x-square-hmacsha256-signature = base64(HMAC-SHA256(signature key, notification URL + raw body));
 *              events order.created / order.updated / order.fulfillment.updated / refund.created / refund.updated / payment.updated
 * Amounts are integer cents (Money.amount). Returns are separate orders whose `returns[].source_order_id`
 * points to the original sale; normalizeReturn turns them into a refund of that sale.
 * Verified against the local test double only (no Square account was used).
 */
import type { NormalizedLine, NormalizedPayment, NormalizedRefund, NormalizedSale, WebhookEvent } from '@/lib/pos/types'
import { arr, brand, hmacB64, last4, methodFromLabel, msOf, obj, safeEqual, str, type PosAdapter } from '@/lib/pos/adapters/common'
import { qtyText } from '@/lib/pos/money'

export const SQUARE_VERSION = '2025-01-23'
export const SQUARE_SCOPES = ['MERCHANT_PROFILE_READ', 'ORDERS_READ', 'ITEMS_READ', 'PAYMENTS_READ', 'INVENTORY_READ', 'EMPLOYEES_READ'] as const

const cents = (m: unknown): bigint => { const a = obj(m).amount; return typeof a === 'number' && Number.isSafeInteger(a) ? BigInt(a) : typeof a === 'string' && /^-?\d+$/.test(a) ? BigInt(a) : 0n }

function tenderMethod(t: Record<string, unknown>): NormalizedPayment['method'] {
  switch (t.type) {
    case 'CASH': return 'cash'
    case 'CARD': return 'card'
    case 'SQUARE_GIFT_CARD': return 'gift_card'
    case 'BANK_ACCOUNT': return 'transfer'
    default: return methodFromLabel(str(t.note) ?? str(t.type))   // OTHER / EXTERNAL tenders: e.g. "ATH Móvil"
  }
}

export function normalizeSquareOrder(order: unknown): NormalizedSale | null {
  const o = obj(order)
  const id = str(o.id), loc = str(o.location_id)
  if (!id || !loc) return null
  const state = o.state === 'COMPLETED' ? 'completed' : o.state === 'CANCELED' ? 'voided' : 'open'
  if (state === 'open') return null
  if (arr(o.returns).length && !arr(o.line_items).length) return null   // a return order: see normalizeReturn
  const lines: NormalizedLine[] = []
  for (const li of arr(o.line_items).map(obj)) {
    const qty = qtyText(str(li.quantity))
    const uid = str(li.uid)
    if (!qty || !uid) return null
    const unit = cents(li.base_price_money)
    const name = [str(li.name, 120) ?? 'Artículo', str(li.variation_name, 60)].filter(Boolean).join(' · ')
    lines.push({ external_line_id: uid, item_ref: str(li.catalog_object_id), sku: null, name, qty, unit_price_cents: unit.toString(),
      discount_cents: cents(li.total_discount_money).toString(), tax_cents: cents(li.total_tax_money).toString(), catalog_required: !!str(li.catalog_object_id) })
  }
  const payments: NormalizedPayment[] = arr(o.tenders).map(obj).map((t) => {
    const card = obj(obj(t.card_details).card)
    return { method: tenderMethod(t), amount_cents: cents(t.amount_money).toString(), provider_payment_id: str(t.payment_id) ?? str(t.id),
      card_brand: brand(card.card_brand), card_last4: last4(card.last_4), status: 'captured' as const }
  })
  const refunds: NormalizedRefund[] = []   // refunds of a sale come from its return orders (normalizeReturn)
  const version = typeof o.version === 'number' ? String(o.version) : msOf(str(o.updated_at)) ?? '0'
  return { external_id: id, version, state, occurred_at: str(o.closed_at) ?? str(o.created_at) ?? new Date().toISOString(), location_id: loc,
    register_ref: str(obj(o.source).name), cashier_ref: null, currency: str(obj(o.total_money).currency) ?? 'USD', total_cents: cents(o.total_money).toString(),
    note: null, lines, payments, refunds }
}

/** a Square return order → {source order id, refund} */
export function normalizeSquareReturn(order: unknown): { sourceOrderId: string; refund: NormalizedRefund; version: string } | null {
  const o = obj(order)
  const ret = obj(arr(o.returns)[0])
  const src = str(ret.source_order_id), id = str(o.id)
  if (!src || !id || o.state !== 'COMPLETED') return null
  const lines = arr(ret.return_line_items).map(obj).map((l) => ({ external_line_id: str(l.source_line_item_uid) ?? '', qty: qtyText(str(l.quantity)) ?? '' }))
  if (!lines.length || lines.some((l) => !l.external_line_id || !l.qty)) return null
  const tender = obj(arr(o.tenders)[0] ?? arr(o.refunds)[0])
  return { sourceOrderId: src, version: typeof o.version === 'number' ? String(o.version) : msOf(str(o.updated_at)) ?? '0',
    refund: { external_id: id, method: tender.type ? tenderMethod(tender) : 'other', reason: str(obj(arr(o.refunds)[0]).reason, 300), occurred_at: str(o.closed_at) ?? str(o.created_at), restock: true, lines } }
}

export const squareAdapter: PosAdapter = {
  info: { id: 'square', name: 'Square', status: 'implemented', verifiedWith: 'test_double', webhookHeader: 'x-square-hmacsha256-signature' },
  verifyWebhook({ headers, rawBody, secret, url }) {
    const sig = headers.get('x-square-hmacsha256-signature')
    if (!sig || !url) return false
    return safeEqual(hmacB64(secret, url + rawBody), sig)
  },
  parseWebhook(rawBody): WebhookEvent[] {
    let b: Record<string, unknown>
    try { b = obj(JSON.parse(rawBody)) } catch { return [] }
    const data = obj(b.data), inner = obj(data.object)
    const type = str(b.type, 80) ?? ''
    const ev = str(b.event_id), merchant = str(b.merchant_id)
    if (!ev || !merchant) return []
    // order events carry the order id and version; refund / payment events point to their order
    const order = obj(inner.order_created ?? inner.order_updated ?? inner.order_fulfillment_updated)
    const refund = obj(inner.refund), payment = obj(inner.payment)
    const objectId = str(order.order_id) ?? str(refund.order_id) ?? str(payment.order_id) ?? str(data.id)
    if (!objectId) return []
    return [{ eventKey: `sq:${ev}`, accountId: merchant, eventType: type, objectType: 'order', objectId,
      version: typeof order.version === 'number' ? String(order.version) : null }]
  },
  normalize: normalizeSquareOrder,
}

export class SquareError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }

export class SquareClient {
  constructor(private readonly baseURL: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response
    try {
      res = await this.fetcher(`${this.baseURL}${path}`, { method: init.method ?? 'GET', signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${this.token}`, 'square-version': SQUARE_VERSION, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    } catch { throw new SquareError('PROVIDER_UNREACHABLE', 0) }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !data) {
      const code = str(obj(arr(data?.errors)[0]).code, 80)
      throw new SquareError(code && /^[A-Z0-9_]+$/.test(code) ? code : `HTTP_${res.status}`, res.status)
    }
    return data as T
  }
  order(id: string) { return this.call<{ order: unknown }>(`/v2/orders/${encodeURIComponent(id)}`).then((r) => r.order) }
  locations() { return this.call<{ locations?: { id: string; name: string; status?: string }[] }>('/v2/locations').then((r) => r.locations ?? []) }
  /** completed / canceled orders updated since `since`, newest last, one page */
  searchOrders(locationIds: string[], since: string, cursor: string | null) {
    return this.call<{ orders?: unknown[]; cursor?: string }>('/v2/orders/search', { method: 'POST', body: {
      location_ids: locationIds.slice(0, 10), cursor: cursor ?? undefined, limit: 100,
      query: { filter: { state_filter: { states: ['COMPLETED', 'CANCELED'] }, date_time_filter: { updated_at: { start_at: since } } }, sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' } } } })
  }
  payouts(locationId: string, cursor: string | null) {
    return this.call<{ payouts?: unknown[]; cursor?: string }>(`/v2/payouts?location_id=${encodeURIComponent(locationId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
  }
  payoutEntries(id: string) { return this.call<{ payout_entries?: unknown[] }>(`/v2/payouts/${encodeURIComponent(id)}/payout-entries`).then((r) => r.payout_entries ?? []) }
}

/** a Square payout + its entries → the settlement payload of pos_settlement_record */
export function squarePayoutToSettlement(payout: unknown, entries: unknown[]) {
  const p = obj(payout)
  const gross = entries.map(obj).reduce((s, e) => s + cents(e.gross_amount_money), 0n)
  const fees = entries.map(obj).reduce((s, e) => s - cents(e.fee_amount_money), 0n)   // fees arrive negative
  const net = cents(p.amount_money)
  const status = p.status === 'PAID' ? 'paid' : p.status === 'FAILED' ? 'failed' : 'in_transit'
  const paymentIds = entries.map(obj).map((e) => str(obj(e.type_charge_details).payment_id)).filter((x): x is string => !!x)
  return { payout_id: str(p.id), payout_date: str(p.arrival_date) ?? str(p.created_at)?.slice(0, 10), gross_cents: gross.toString(), fees_cents: fees.toString(),
    net_cents: net.toString(), status, payment_ids: paymentIds, consistent: gross - fees === net }
}

/** OAuth: the authorize URL (state bound to the user's session cookie) and the code exchange */
export function squareAuthorizeUrl(oauthURL: string, appId: string, state: string) {
  const u = new URL(`${oauthURL}/oauth2/authorize`)
  u.searchParams.set('client_id', appId); u.searchParams.set('scope', SQUARE_SCOPES.join(' ')); u.searchParams.set('session', 'false'); u.searchParams.set('state', state)
  return u.toString()
}
export async function squareExchangeCode(oauthURL: string, appId: string, secret: string, code: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`${oauthURL}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'square-version': SQUARE_VERSION },
    body: JSON.stringify({ client_id: appId, client_secret: secret, code, grant_type: 'authorization_code' }) }).catch(() => null)
  const data = res ? obj(await res.json().catch(() => null)) : {}
  if (!res?.ok || !str(data.access_token) || !str(data.merchant_id)) throw new SquareError(str(data.error, 80) ?? 'OAUTH_FAILED', res?.status ?? 0)
  return { accessToken: str(data.access_token, 2000)!, refreshToken: str(data.refresh_token, 2000), expiresAt: str(data.expires_at), merchantId: str(data.merchant_id)! }
}

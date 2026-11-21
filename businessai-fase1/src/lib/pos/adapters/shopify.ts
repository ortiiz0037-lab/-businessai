/**
 * Shopify POS adapter (SERVER ONLY). Shopify POS sales are Shopify orders (source_name "pos") with a
 * location_id. Webhooks (orders/create, orders/updated, orders/cancelled, refunds/create) carry the
 * whole order in the REST JSON shape, so no extra fetch is needed:
 *   header X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app client secret, raw body))
 *   X-Shopify-Webhook-Id (delivery id: the idempotency key), X-Shopify-Shop-Domain (the account), X-Shopify-Topic
 * Amounts are decimal strings ("12.34") converted exactly to cents. Order version: updated_at in ms.
 * Production reads of past orders must use the GraphQL Admin API (REST is legacy for new public apps):
 * not implemented here (docs/POS.md). Verified against the local test double only.
 */
import type { NormalizedLine, NormalizedPayment, NormalizedRefund, NormalizedSale, WebhookEvent } from '@/lib/pos/types'
import { arr, hmacB64, methodFromLabel, msOf, obj, safeEqual, str, type PosAdapter, providerFetch } from '@/lib/pos/adapters/common'
import { decimalToCents, qtyText } from '@/lib/pos/money'

const c = (v: unknown) => decimalToCents(typeof v === 'number' || typeof v === 'string' ? v : null) ?? 0n

export function normalizeShopifyOrder(order: unknown, opts: { posOnly?: boolean } = { posOnly: true }): NormalizedSale | null {
  const o = obj(order)
  const id = str(o.id), loc = str(o.location_id)
  if (!id) return null
  if (opts.posOnly !== false && o.source_name !== 'pos') return null
  if (!loc) return null
  if (!['paid', 'partially_refunded', 'refunded', 'voided'].includes(String(o.financial_status))) return null
  const lines: NormalizedLine[] = []
  for (const li of arr(o.line_items).map(obj)) {
    const qty = qtyText(str(li.quantity)), lid = str(li.id)
    if (!qty || !lid) return null
    const tax = arr(li.tax_lines).map(obj).reduce((s, t) => s + c(t.price), 0n)
    const rate = arr(li.tax_lines).map(obj).reduce((s, t) => s + (typeof t.rate === 'number' ? t.rate : 0), 0)
    lines.push({ external_line_id: lid, item_ref: str(li.variant_id) ? `variant:${str(li.variant_id)}` : null, sku: str(li.sku, 60), name: [str(li.title, 120) ?? 'Artículo', str(li.variant_title, 60)].filter(Boolean).join(' · '),
      qty, unit_price_cents: c(li.price).toString(), discount_cents: c(li.total_discount).toString(), tax_cents: tax.toString(), tax_rate: rate ? (rate * 100).toFixed(3) : null,
      catalog_required: !!(str(li.variant_id) || str(li.sku)) })
  }
  const gateways = arr(o.payment_gateway_names).map((g) => String(g))
  const total = c(o.total_price)
  // a POS order lists its gateways; amounts per gateway come from transactions when present
  const tx = arr(o.transactions).map(obj).filter((t) => t.kind === 'sale' || t.kind === 'capture').filter((t) => t.status === 'success')
  const payments: NormalizedPayment[] = tx.length
    ? tx.map((t) => ({ method: methodFromLabel(str(t.gateway)), amount_cents: c(t.amount).toString(), provider_payment_id: str(t.id), status: 'captured' as const,
        card_last4: (() => { const n = str(obj(t.payment_details).credit_card_number, 30); const m = n ? /(\d{4})$/.exec(n) : null; return m ? m[1] : null })(),
        card_brand: str(obj(t.payment_details).credit_card_company, 30) }))
    : [{ method: methodFromLabel(gateways[0]), amount_cents: total.toString(), provider_payment_id: `order:${id}`, status: 'captured' as const }]
  const refunds: NormalizedRefund[] = arr(o.refunds).map(obj).map((r) => ({ external_id: str(r.id) ?? '', reason: str(r.note, 300), occurred_at: str(r.created_at),
    method: methodFromLabel(str(obj(arr(r.transactions)[0]).gateway)),
    restock: arr(r.refund_line_items).map(obj).some((l) => l.restock_type === 'return' || l.restock_type === 'cancel'),
    lines: arr(r.refund_line_items).map(obj).map((l) => ({ external_line_id: str(l.line_item_id) ?? '', qty: qtyText(str(l.quantity)) ?? '' })) }))
    .filter((r) => r.external_id && r.lines.length && r.lines.every((l) => l.external_line_id && l.qty))
  const voided = o.financial_status === 'voided' || !!str(o.cancelled_at) && !refunds.length
  return { external_id: id, version: msOf(str(o.updated_at)) ?? '0', state: voided ? 'voided' : 'completed', occurred_at: str(o.processed_at) ?? str(o.created_at) ?? new Date().toISOString(),
    location_id: loc, register_ref: str(o.device_id), cashier_ref: str(o.user_id), currency: str(o.currency) ?? 'USD', total_cents: total.toString(), note: str(o.name, 60),
    lines, payments, refunds }
}

export const shopifyAdapter: PosAdapter = {
  info: { id: 'shopify', name: 'Shopify POS', status: 'implemented', verifiedWith: 'test_double', webhookHeader: 'x-shopify-hmac-sha256' },
  verifyWebhook({ headers, rawBody, secret }) {
    const sig = headers.get('x-shopify-hmac-sha256')
    return !!sig && safeEqual(hmacB64(secret, rawBody), sig)
  },
  parseWebhook(rawBody, headers): WebhookEvent[] {
    const id = str(headers.get('x-shopify-webhook-id')), shop = str(headers.get('x-shopify-shop-domain')), topic = str(headers.get('x-shopify-topic'), 80)
    if (!id || !shop || !topic) return []
    let b: Record<string, unknown>
    try { b = obj(JSON.parse(rawBody)) } catch { return [] }
    const orderId = topic.startsWith('refunds/') ? str(b.order_id) : str(b.id)
    if (!orderId) return []
    return [{ eventKey: `sh:${id}`, accountId: shop, eventType: topic, objectType: 'order', objectId: orderId, version: topic.startsWith('orders/') ? msOf(str(b.updated_at)) : null }]
  },
  normalize: (o) => normalizeShopifyOrder(o),
}

// --------------------------------------------------------------------------- historical reads (GraphQL Admin API)
export const SHOPIFY_API_VERSION = '2025-01'
const gid = (v: unknown) => { const m = /\/(\d+)$/.exec(String(v ?? '')); return m ? m[1] : null }
const money = (v: unknown) => str(obj(obj(v).shopMoney).amount)
const nodes = (v: unknown) => arr(obj(v).nodes).map(obj)
const FIN: Record<string, string> = { PAID: 'paid', PARTIALLY_REFUNDED: 'partially_refunded', REFUNDED: 'refunded', VOIDED: 'voided' }

/** a GraphQL order → the REST / webhook shape normalizeShopifyOrder already reads */
export function shopifyGqlToRest(o: unknown): Record<string, unknown> {
  const x = obj(o)
  return {
    id: gid(x.id), name: x.name, source_name: str(x.sourceName)?.toLowerCase() ?? null, location_id: gid(obj(x.retailLocation ?? x.physicalLocation).id),
    currency: x.currencyCode, financial_status: FIN[String(x.displayFinancialStatus)] ?? String(x.displayFinancialStatus ?? '').toLowerCase(),
    updated_at: x.updatedAt, processed_at: x.processedAt, cancelled_at: x.cancelledAt ?? null, total_price: money(x.totalPriceSet),
    line_items: nodes(x.lineItems).map((l) => ({ id: gid(l.id), variant_id: gid(obj(l.variant).id), sku: l.sku, title: l.name, variant_title: l.variantTitle, quantity: l.quantity,
      price: money(l.originalUnitPriceSet), total_discount: money(l.totalDiscountSet) ?? '0', tax_lines: arr(l.taxLines).map(obj).map((t) => ({ rate: t.rate, price: money(t.priceSet) })) })),
    transactions: arr(x.transactions).map(obj).map((t) => ({ id: gid(t.id), kind: String(t.kind ?? '').toLowerCase(), status: String(t.status ?? '').toLowerCase(), gateway: t.gateway, amount: money(t.amountSet) })),
    refunds: arr(x.refunds).map(obj).map((r) => ({ id: gid(r.id), created_at: r.createdAt, note: r.note,
      refund_line_items: nodes(r.refundLineItems).map((l) => ({ line_item_id: gid(obj(l.lineItem).id), quantity: l.quantity, restock_type: String(l.restockType ?? '').toLowerCase() })) })),
  }
}

const ORDERS_QUERY = `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { id name sourceName updatedAt processedAt cancelledAt displayFinancialStatus currencyCode retailLocation { id }
    totalPriceSet { shopMoney { amount } }
    lineItems(first: 250) { nodes { id sku name variantTitle quantity variant { id } originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } taxLines { rate priceSet { shopMoney { amount } } } } }
    transactions { id kind status gateway amountSet { shopMoney { amount } } }
    refunds { id createdAt note refundLineItems(first: 250) { nodes { quantity restockType lineItem { id } } } } } } }`

export class ShopifyClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  /** POS orders updated since `since` (ISO), one page of 50 */
  async ordersSince(since: string, after: string | null): Promise<{ orders: unknown[]; next: string | null }> {
    const res = await providerFetch(this.fetcher, `${this.base}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': this.token },
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { q: `updated_at:>='${since}' source_name:pos`, after } }) }).catch(() => null)
    if (!res?.ok) throw new Error(`SHOPIFY_${res?.status ?? 'UNREACHABLE'}`)
    const j = obj(await res.json())
    if (arr(j.errors).length) throw new Error('SHOPIFY_GRAPHQL')
    const o = obj(obj(j.data).orders), pi = obj(o.pageInfo)
    return { orders: arr(o.nodes), next: pi.hasNextPage ? str(pi.endCursor, 500) : null }
  }
}
export const shopifyBase = (shopDomain: string, override: string | null) => override ?? `https://${shopDomain.replace(/[^a-z0-9.-]/gi, '')}`

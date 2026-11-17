/**
 * Lightspeed Retail X-Series adapter (SERVER ONLY). Documented API (x-series-api.lightspeedhq.com):
 *   OAuth 2.0 per retailer (domain_prefix); sales: GET https://{domain_prefix}.retail.lightspeed.app/api/2.0/sales/{id}
 *   Webhooks (sale.update …) arrive form-encoded: payload=<json>&type=sale.update&domain_prefix=…,
 *   signed for OAuth apps: header X-Signature "signature=<hex>, algorithm=HMAC-SHA256" over the raw body
 *   with the app's client secret. Lightspeed states delivery is not guaranteed: polling is required too.
 * A sale has outlet_id (the location), register_id, user_name, status (CLOSED / ONACCOUNT_CLOSED /
 * LAYBY_CLOSED / VOIDED / SAVED…), version, line_items (price = unit excl. tax, tax per unit,
 * discount per unit) and payments. A return is a new sale with negative quantities and return_for.
 * Lightspeed R-Series (the former Retail POS) is a different API: evaluated, NOT implemented.
 * Verified against the local test double only (no Lightspeed account was used).
 */
import type { NormalizedLine, NormalizedPayment, NormalizedRefund, NormalizedSale, WebhookEvent } from '@/lib/pos/types'
import { arr, hmacHex, methodFromLabel, msOf, obj, safeEqual, str, type PosAdapter, providerFetch } from '@/lib/pos/adapters/common'
import { decimalToCents, qtyText } from '@/lib/pos/money'

const c = (v: unknown) => decimalToCents(typeof v === 'number' || typeof v === 'string' ? v : null) ?? 0n
const DONE = ['CLOSED', 'ONACCOUNT_CLOSED', 'LAYBY_CLOSED']

/** unit amounts × quantity, rounded half up (Lightspeed works with unit amounts) */
const times = (unit: bigint, qty: string) => { const [i, d = ''] = qty.split('.'); const milli = BigInt(i) * 1000n + BigInt(d.padEnd(3, '0') || '0'); return (unit * milli + 500n) / 1000n }

export function normalizeLightspeedSale(sale: unknown): NormalizedSale | null {
  const s = obj(sale)
  const id = str(s.id), outlet = str(s.outlet_id)
  if (!id || !outlet) return null
  const status = String(s.status ?? '')
  if (!DONE.includes(status) && status !== 'VOIDED') return null
  if (str(s.return_for)) return null   // a return: see normalizeLightspeedReturn
  const lines: NormalizedLine[] = []
  for (const li of arr(s.line_items).map(obj)) {
    const qty = qtyText(str(li.quantity)), lid = str(li.id)
    if (!qty || !lid) return null
    lines.push({ external_line_id: lid, item_ref: str(li.product_id), sku: str(li.sku, 60), name: str(li.name, 160) ?? str(li.product_name, 160) ?? 'Artículo', qty,
      unit_price_cents: c(li.price).toString(), discount_cents: times(c(li.discount), qty).toString(), tax_cents: times(c(li.tax), qty).toString(), catalog_required: !!str(li.product_id) })
  }
  const payments: NormalizedPayment[] = arr(s.payments).map(obj).filter((p) => !p.deleted_at).map((p) => ({ method: methodFromLabel(str(p.name) ?? str(p.payment_type_id)),
    amount_cents: c(p.amount).toString(), provider_payment_id: str(p.id), status: 'captured' as const }))
  const total = c(s.total_price) + c(s.total_tax)
  return { external_id: id, version: typeof s.version === 'number' ? String(s.version) : msOf(str(s.updated_at)) ?? '0', state: status === 'VOIDED' ? 'voided' : 'completed',
    occurred_at: str(s.sale_date) ?? str(s.created_at) ?? new Date().toISOString(), location_id: outlet, register_ref: str(s.register_id), cashier_ref: str(s.user_name, 120) ?? str(s.user_id),
    currency: 'USD', total_cents: total.toString(), note: str(s.invoice_number, 60), lines, payments, refunds: [] }
}

/** a return sale (negative quantities, return_for) → a refund of the original sale */
export function normalizeLightspeedReturn(sale: unknown): { sourceSaleId: string; refund: NormalizedRefund; version: string } | null {
  const s = obj(sale)
  const src = str(s.return_for), id = str(s.id)
  if (!src || !id || !DONE.includes(String(s.status ?? ''))) return null
  const lines = arr(s.line_items).map(obj).map((l) => ({ external_line_id: str(l.return_for_line_item_id) ?? str(l.original_line_item_id) ?? '', qty: qtyText(str(l.quantity)?.replace(/^-/, '')) ?? '' }))
  if (!lines.length || lines.some((l) => !l.external_line_id || !l.qty)) return null
  return { sourceSaleId: src, version: typeof s.version === 'number' ? String(s.version) : '0',
    refund: { external_id: id, method: methodFromLabel(str(obj(arr(s.payments)[0]).name)), reason: str(s.note, 300), occurred_at: str(s.sale_date), restock: true, lines } }
}

export const lightspeedAdapter: PosAdapter = {
  info: { id: 'lightspeed_x', name: 'Lightspeed Retail (X-Series)', status: 'implemented', verifiedWith: 'test_double', webhookHeader: 'x-signature' },
  verifyWebhook({ headers, rawBody, secret }) {
    const h = headers.get('x-signature') ?? ''
    const m = /signature=([0-9a-f]{64})/i.exec(h)
    if (!m || !/algorithm=HMAC-SHA256/i.test(h)) return false
    return safeEqual(hmacHex(secret, rawBody), m[1].toLowerCase())
  },
  parseWebhook(rawBody): WebhookEvent[] {
    const form = new URLSearchParams(rawBody)
    const type = str(form.get('type'), 80), prefix = str(form.get('domain_prefix'))
    let p: Record<string, unknown>
    try { p = obj(JSON.parse(form.get('payload') ?? '')) } catch { return [] }
    const id = str(p.id)
    if (!type || !prefix || !id || !type.startsWith('sale.')) return []
    const version = typeof p.version === 'number' ? String(p.version) : msOf(str(p.updated_at))
    return [{ eventKey: `ls:${prefix}:${id}:${version ?? '0'}`, accountId: prefix, eventType: type, objectType: 'sale', objectId: id, version }]
  },
  normalize: normalizeLightspeedSale,
}

/**
 * Polling: GET https://{domain_prefix}.retail.lightspeed.app/api/2.0/sales?after=<version>&page_size=…
 * returns sales whose version is above `after`, ordered by version (`version.max` = the next cursor).
 * `baseFor` lets the local double replace the host (outside production only).
 */
export class LightspeedClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async salesAfter(after: number, pageSize = 200): Promise<{ sales: unknown[]; max: number | null }> {
    const res = await providerFetch(this.fetcher, `${this.base}/api/2.0/sales?after=${Math.max(0, Math.floor(after))}&page_size=${pageSize}`,
      { headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }).catch(() => null)
    if (!res?.ok) throw new Error(`LIGHTSPEED_${res?.status ?? 'UNREACHABLE'}`)
    const j = obj(await res.json())
    const max = obj(j.version).max
    return { sales: arr(j.data), max: typeof max === 'number' ? max : null }
  }
}
export const lightspeedBase = (domainPrefix: string, override: string | null) =>
  override ?? `https://${domainPrefix.replace(/[^a-z0-9-]/gi, '')}.retail.lightspeed.app`

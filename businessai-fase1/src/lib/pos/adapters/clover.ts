/**
 * Clover adapter (SERVER ONLY). Documented API (docs.clover.com, Platform API v3):
 *   GET {base}/v3/merchants/{mId}/orders/{orderId}?expand=lineItems,payments,payments.tender,payments.cardTransaction,refunds,employee,device
 *   Webhooks: POST {"appId", "merchants": {"<mId>": [{"objectId": "O:<orderId>", "type": "CREATE"|"UPDATE"|"DELETE", "ts": <ms>}]}}
 *             authenticated by the header X-Clover-Auth = the verification code shown when the URL was verified
 *             (a shared secret, not an HMAC). Webhooks carry ids only: the order is fetched afterwards.
 * Amounts in cents; quantities in thousandths (unitQty). Taxes are per payment (taxAmount); they are
 * allocated to the lines by largest remainder so the sale adds up. A merchant is one location.
 * Verified against the local test double only (no Clover account was used).
 */
import type { NormalizedLine, NormalizedPayment, NormalizedRefund, NormalizedSale, WebhookEvent } from '@/lib/pos/types'
import { arr, brand, last4, methodFromLabel, obj, safeEqual, str, type PosAdapter } from '@/lib/pos/adapters/common'
import { allocate, fromThousandths, lineGross } from '@/lib/pos/money'

const int = (v: unknown): bigint => (typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : 0n)
const elements = (v: unknown) => arr(obj(v).elements).map(obj)

export function normalizeCloverOrder(order: unknown, merchantId: string): NormalizedSale | null {
  const o = obj(order)
  const id = str(o.id)
  if (!id) return null
  const pays = elements(o.payments).filter((p) => p.result === 'SUCCESS' || p.result === undefined)
  if (o.state !== 'locked' && o.state !== 'paid' && !pays.length) return null      // an open ticket is not a sale yet
  const items = elements(o.lineItems)
  const base: { li: Record<string, unknown>; qty: string; unit: bigint; gross: bigint; disc: bigint }[] = []
  for (const li of items) {
    const qty = typeof li.unitQty === 'number' ? fromThousandths(li.unitQty) : '1'
    if (!qty || !str(li.id)) return null
    const unit = int(li.price)
    const gross = typeof li.unitQty === 'number' ? lineGross(qty, unit) : unit
    const disc = elements(li.discounts).reduce((s, d) => s + (typeof d.amount === 'number' ? -int(d.amount) : typeof d.percentage === 'number' ? (gross * int(d.percentage)) / 100n : 0n), 0n)
    base.push({ li, qty, unit, gross, disc: disc < 0n ? 0n : disc > gross ? gross : disc })
  }
  const taxTotal = pays.reduce((s, p) => s + int(p.taxAmount), 0n)
  const taxes = allocate(taxTotal, base.map((b) => b.gross - b.disc))
  const lines: NormalizedLine[] = base.map((b, i) => ({ external_line_id: str(b.li.id)!, item_ref: str(obj(b.li.item).id), sku: str(b.li.alternateName, 60) ?? null,
    name: str(b.li.name, 160) ?? 'Artículo', qty: b.qty, unit_price_cents: b.unit.toString(), discount_cents: b.disc.toString(), tax_cents: taxes[i].toString(),
    catalog_required: !!str(obj(b.li.item).id) }))
  const payments: NormalizedPayment[] = pays.map((p) => {
    const tender = obj(p.tender), ct = obj(p.cardTransaction)
    const key = str(tender.labelKey) ?? ''
    const method: NormalizedPayment['method'] = key === 'com.clover.tender.cash' ? 'cash' : /credit_card|debit_card/.test(key) ? 'card' : methodFromLabel(str(tender.label))
    return { method, amount_cents: int(p.amount).toString(), provider_payment_id: str(p.id), card_brand: brand(ct.cardType), card_last4: last4(ct.last4), status: 'captured' as const }
  })
  const refunds: NormalizedRefund[] = elements(o.refunds).map((r) => ({ external_id: str(r.id) ?? '', reason: null, occurred_at: typeof r.createdTime === 'number' ? new Date(r.createdTime).toISOString() : null,
    method: 'card' as const, restock: true,
    lines: arr(r.lineItems ? obj(r.lineItems).elements : []).map(obj).map((l) => ({ external_line_id: str(l.id) ?? '', qty: typeof l.unitQty === 'number' ? fromThousandths(l.unitQty) ?? '' : '1' })) }))
    .filter((r) => r.external_id && r.lines.length)
  const occurred = typeof o.clientCreatedTime === 'number' ? o.clientCreatedTime : typeof o.createdTime === 'number' ? o.createdTime : Date.now()
  const total = typeof o.total === 'number' ? BigInt(o.total) : null
  return { external_id: id, version: typeof o.modifiedTime === 'number' ? String(o.modifiedTime) : '0', state: 'completed', occurred_at: new Date(occurred).toISOString(),
    location_id: merchantId, register_ref: str(obj(o.device).id), cashier_ref: str(obj(o.employee).name, 120) ?? str(obj(o.employee).id), currency: str(o.currency) ?? 'USD',
    total_cents: total?.toString(), note: null, lines, payments, refunds }
}

export const cloverAdapter: PosAdapter = {
  info: { id: 'clover', name: 'Clover', status: 'implemented', verifiedWith: 'test_double', webhookHeader: 'x-clover-auth' },
  verifyWebhook({ headers, secret }) {
    const h = headers.get('x-clover-auth')
    return !!h && safeEqual(h, secret)
  },
  parseWebhook(rawBody): WebhookEvent[] {
    let b: Record<string, unknown>
    try { b = obj(JSON.parse(rawBody)) } catch { return [] }
    const out: WebhookEvent[] = []
    for (const [mId, evs] of Object.entries(obj(b.merchants))) {
      for (const e of arr(evs).map(obj)) {
        const oid = str(e.objectId) ?? ''
        if (!oid.startsWith('O:') || typeof e.ts !== 'number') continue   // orders only; payments arrive with their order
        out.push({ eventKey: `cl:${mId}:${oid}:${e.type}:${e.ts}`, accountId: mId, eventType: `order.${String(e.type).toLowerCase()}`, objectType: 'order',
          objectId: oid.slice(2), version: String(e.ts) })
      }
    }
    return out
  },
  normalize: () => null,   // needs the merchant id: normalizeCloverOrder(order, mId)
}

export class CloverClient {
  constructor(private readonly baseURL: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async order(merchantId: string, orderId: string): Promise<unknown> {
    const u = `${this.baseURL}/v3/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}?expand=lineItems,payments,payments.tender,payments.cardTransaction,refunds,employee,device`
    const res = await this.fetcher(u, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) }).catch(() => null)
    if (!res?.ok) throw new Error(`CLOVER_${res?.status ?? 'UNREACHABLE'}`)
    return res.json()
  }
}

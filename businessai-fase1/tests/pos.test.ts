/**
 * Point of sale (S8) pure logic and the provider adapters, with controlled doubles built from the
 * providers' documented payloads (no real account, no network): cart pricing identical to the
 * database (same carts as supabase/tests/local/124_pos.test.sql), exact money, webhook signatures
 * (valid, tampered, wrong key), normalization of Square / Shopify / Clover / Lightspeed orders,
 * returns and voids, CSV files of traditional registers, the server signer (byte-for-byte message
 * of 0044), token encryption, configuration closed by default, and the full webhook path
 * (verify → record → fetch → ingest) against a fake database and a fake Square API.
 */
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { allocate, decimalToCents, fromThousandths, lineGross, percentOf, qtyText } from '@/lib/pos/money'
import { changeFor, priceCart, quickCash } from '@/lib/pos/pricing'
import { squareAdapter, normalizeSquareOrder, normalizeSquareReturn, squareAuthorizeUrl, squarePayoutToSettlement } from '@/lib/pos/adapters/square'
import { shopifyAdapter, normalizeShopifyOrder } from '@/lib/pos/adapters/shopify'
import { cloverAdapter, normalizeCloverOrder } from '@/lib/pos/adapters/clover'
import { lightspeedAdapter, normalizeLightspeedReturn, normalizeLightspeedSale } from '@/lib/pos/adapters/lightspeed'
import { methodFromLabel } from '@/lib/pos/adapters/common'
import { parseCsvRows, parseRegisterCsv, prDateToIso } from '@/lib/pos/csv'
import { PosSigner } from '@/lib/pos/signer'
import { readPosConfig } from '@/lib/pos/config'
import { decryptPosToken, encryptPosToken } from '@/lib/pos/crypto'
import { handlePosWebhook } from '@/lib/pos/sync'
import { posErrorCode, posMessage } from '@/lib/pos/labels'
import { PROVIDERS } from '@/lib/pos/providers'

const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

describe('money', () => {
  it('decimal amounts → cents without floating point', () => {
    expect(decimalToCents('12.34')).toBe(1234n); expect(decimalToCents('0.1')).toBe(10n); expect(decimalToCents('7')).toBe(700n)
    expect(decimalToCents('-0.50')).toBe(-50n); expect(decimalToCents('19.990')).toBe(1999n); expect(decimalToCents('1.234')).toBeNull(); expect(decimalToCents('abc')).toBeNull()
  })
  it('quantities and Clover thousandths', () => {
    expect(qtyText('2')).toBe('2'); expect(qtyText('1.500')).toBe('1.5'); expect(qtyText('1.2345')).toBeNull(); expect(fromThousandths(2500)).toBe('2.5'); expect(fromThousandths(1000)).toBe('1')
  })
  it('rounding half away from zero like PostgreSQL round()', () => {
    expect(lineGross('3', 1250n)).toBe(3750n); expect(lineGross('0.5', 999n)).toBe(500n)      // 499.5 → 500
    expect(percentOf(1900n, '11.5')).toBe(219n); expect(percentOf(1425n, '11.5')).toBe(164n); expect(percentOf(999n, '4')).toBe(40n)
  })
  it('largest-remainder allocation never loses or invents a cent', () => {
    expect(allocate(1n, [1000n, 1000n, 1000n])).toEqual([1n, 0n, 0n])
    expect(allocate(175n, [2000n, 1500n])).toEqual([100n, 75n])
    expect(allocate(10n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(10n)
  })
})

describe('cart pricing (mirror of ba_private.pos_price)', () => {
  it('the same cart as the SQL suite: 37.08', () => {
    const p = priceCart([{ key: 'a', name: 'Café', qty: '2', unitCents: 1000n, taxRate: '11.5' }, { key: 'b', name: 'Camiseta', qty: '1', unitCents: 1500n, taxRate: '11.5' }], { pct: '5' })
    expect([p.subtotal, p.discount, p.tax, p.total]).toEqual([3500n, 175n, 383n, 3708n])
    expect(p.lines.map((l) => [l.discount, l.tax])).toEqual([[100n, 219n], [75n, 164n]])
  })
  it('one cent of cart discount goes to the first line; line discounts in percent', () => {
    const p = priceCart([1, 2, 3].map((i) => ({ key: String(i), name: 'x', qty: '1', unitCents: 1000n, taxRate: '0' })), { cents: 1n })
    expect(p.lines.map((l) => l.discount)).toEqual([1n, 0n, 0n])
    const q = priceCart([{ key: 'a', name: 'x', qty: '1', unitCents: 999n, taxRate: '4', discountPct: '10' }])
    expect([q.discount, q.tax, q.total]).toEqual([100n, 36n, 935n])
  })
  it('a 20 % discount is reported as 20 (approval above the limit); invalid discounts throw', () => {
    expect(priceCart([{ key: 'a', name: 'x', qty: '1', unitCents: 1250n, taxRate: '11.5' }], { pct: '20' }).discountPct).toBe(20)
    expect(() => priceCart([{ key: 'a', name: 'x', qty: '1', unitCents: 100n, taxRate: '0', discountCents: 101n }])).toThrow('POS_DISCOUNT_INVALID')
    expect(() => priceCart([{ key: 'a', name: 'x', qty: '0', unitCents: 100n, taxRate: '0' }])).toThrow('POS_QTY_INVALID')
  })
  it('change and quick-cash buttons', () => {
    expect(changeFor(3708n, 4000n)).toBe(292n); expect(changeFor(3708n, 3000n)).toBeNull()
    expect(quickCash(3708n)).toEqual([3708n, 3800n, 4000n, 5000n])
  })
})

// --------------------------------------------------------------------------- Square (test double payloads)
const SQ_KEY = 'sq-signature-key-test'
const SQ_URL = 'https://app.example.test/api/pos/webhooks/square'
const sqOrder = (over: Record<string, unknown> = {}) => ({
  id: 'ORD-1', location_id: 'LOC-SJ', state: 'COMPLETED', version: 4, created_at: '2026-11-16T13:00:00Z', closed_at: '2026-11-16T13:01:00Z', source: { name: 'Square POS iPad' },
  line_items: [{ uid: 'L1', catalog_object_id: 'VAR-COFFEE', name: 'Café molido', variation_name: 'Regular', quantity: '2', base_price_money: { amount: 1000, currency: 'USD' },
    total_discount_money: { amount: 0, currency: 'USD' }, total_tax_money: { amount: 230, currency: 'USD' }, total_money: { amount: 2230, currency: 'USD' } }],
  tenders: [{ id: 'T1', type: 'CARD', amount_money: { amount: 2230, currency: 'USD' }, payment_id: 'PAY-1', card_details: { card: { card_brand: 'VISA', last_4: '1111', exp_month: 12 } } }],
  total_money: { amount: 2230, currency: 'USD' }, ...over })

describe('Square adapter', () => {
  it('webhook signature: base64 HMAC-SHA256 of URL + raw body; tampering and wrong keys fail', () => {
    const body = JSON.stringify({ merchant_id: 'M1', type: 'order.updated', event_id: 'ev-1', data: { type: 'order', id: 'ORD-1', object: { order_updated: { order_id: 'ORD-1', version: 4 } } } })
    const sig = createHmac('sha256', SQ_KEY).update(SQ_URL + body).digest('base64')
    expect(squareAdapter.verifyWebhook({ headers: H({ 'x-square-hmacsha256-signature': sig }), rawBody: body, secret: SQ_KEY, url: SQ_URL })).toBe(true)
    expect(squareAdapter.verifyWebhook({ headers: H({ 'x-square-hmacsha256-signature': sig }), rawBody: body + ' ', secret: SQ_KEY, url: SQ_URL })).toBe(false)
    expect(squareAdapter.verifyWebhook({ headers: H({ 'x-square-hmacsha256-signature': sig }), rawBody: body, secret: 'other', url: SQ_URL })).toBe(false)
    expect(squareAdapter.verifyWebhook({ headers: H({}), rawBody: body, secret: SQ_KEY, url: SQ_URL })).toBe(false)
    expect(squareAdapter.parseWebhook(body, H({}))).toEqual([{ eventKey: 'sq:ev-1', accountId: 'M1', eventType: 'order.updated', objectType: 'order', objectId: 'ORD-1', version: '4' }])
  })
  it('a completed order: lines, tax, card brand and last four (never the expiry or the number)', () => {
    const s = normalizeSquareOrder(sqOrder())!
    expect(s).toMatchObject({ external_id: 'ORD-1', version: '4', state: 'completed', location_id: 'LOC-SJ', total_cents: '2230', register_ref: 'Square POS iPad' })
    expect(s.lines[0]).toMatchObject({ external_line_id: 'L1', item_ref: 'VAR-COFFEE', name: 'Café molido · Regular', qty: '2', unit_price_cents: '1000', tax_cents: '230' })
    expect(s.payments[0]).toEqual({ method: 'card', amount_cents: '2230', provider_payment_id: 'PAY-1', card_brand: 'VISA', card_last4: '1111', status: 'captured' })
    expect(JSON.stringify(s)).not.toContain('exp_month')
  })
  it('open orders are not sales; canceled orders are voids; an OTHER tender named ATH is ATH Móvil', () => {
    expect(normalizeSquareOrder(sqOrder({ state: 'OPEN' }))).toBeNull()
    expect(normalizeSquareOrder(sqOrder({ state: 'CANCELED' }))!.state).toBe('voided')
    expect(normalizeSquareOrder(sqOrder({ tenders: [{ id: 'T2', type: 'OTHER', note: 'ATH Móvil 7788', amount_money: { amount: 2230 } }] }))!.payments[0].method).toBe('ath_movil')
  })
  it('a return order becomes a refund of the original sale', () => {
    const r = normalizeSquareReturn({ id: 'RET-1', state: 'COMPLETED', version: 2, returns: [{ source_order_id: 'ORD-1', return_line_items: [{ source_line_item_uid: 'L1', quantity: '1' }] }],
      tenders: [{ type: 'CARD' }], refunds: [{ reason: 'Dañado' }] })
    expect(r).toEqual({ sourceOrderId: 'ORD-1', version: '2', refund: { external_id: 'RET-1', method: 'card', reason: 'Dañado', occurred_at: null, restock: true, lines: [{ external_line_id: 'L1', qty: '1' }] } })
  })
  it('payouts: gross − fees = net, the payment ids link the settlement', () => {
    const st = squarePayoutToSettlement({ id: 'PO-1', status: 'PAID', arrival_date: '2026-11-17', amount_money: { amount: 2165 } },
      [{ gross_amount_money: { amount: 2230 }, fee_amount_money: { amount: -65 }, type_charge_details: { payment_id: 'PAY-1' } }])
    expect(st).toMatchObject({ payout_id: 'PO-1', gross_cents: '2230', fees_cents: '65', net_cents: '2165', status: 'paid', payment_ids: ['PAY-1'], consistent: true })
  })
  it('OAuth URL asks only for read scopes and carries the state', () => {
    const u = new URL(squareAuthorizeUrl('https://connect.squareupsandbox.com', 'sq0idp-app', 'state-123'))
    expect(u.searchParams.get('scope')).toContain('ORDERS_READ'); expect(u.searchParams.get('scope')).not.toMatch(/WRITE/); expect(u.searchParams.get('state')).toBe('state-123')
  })
})

describe('Shopify POS adapter', () => {
  const order = { id: 5001, name: '#1001', source_name: 'pos', location_id: 777, currency: 'USD', financial_status: 'partially_refunded', updated_at: '2026-11-16T14:00:00Z', processed_at: '2026-11-16T13:00:00Z',
    total_price: '22.30', line_items: [{ id: 9001, variant_id: 333, sku: '4006381333931', title: 'Café molido', quantity: 2, price: '10.00', total_discount: '0.00', tax_lines: [{ price: '2.30', rate: 0.115 }] }],
    transactions: [{ id: 71, kind: 'sale', status: 'success', gateway: 'cash', amount: '22.30' }],
    refunds: [{ id: 81, created_at: '2026-11-16T15:00:00Z', note: 'Devuelto', refund_line_items: [{ line_item_id: 9001, quantity: 1, restock_type: 'return' }], transactions: [{ gateway: 'cash' }] }] }
  it('signature on the raw body with the app secret', () => {
    const body = JSON.stringify(order), sig = createHmac('sha256', 'shp-secret').update(body).digest('base64')
    expect(shopifyAdapter.verifyWebhook({ headers: H({ 'x-shopify-hmac-sha256': sig }), rawBody: body, secret: 'shp-secret' })).toBe(true)
    expect(shopifyAdapter.verifyWebhook({ headers: H({ 'x-shopify-hmac-sha256': sig }), rawBody: body.replace('22.30', '2.30'), secret: 'shp-secret' })).toBe(false)
    expect(shopifyAdapter.parseWebhook(body, H({ 'x-shopify-webhook-id': 'wh-1', 'x-shopify-shop-domain': 'tienda.myshopify.com', 'x-shopify-topic': 'orders/updated' }))[0])
      .toMatchObject({ eventKey: 'sh:wh-1', accountId: 'tienda.myshopify.com', objectId: '5001', version: String(Date.parse('2026-11-16T14:00:00Z')) })
  })
  it('a POS order with its refund; online orders are not POS sales', () => {
    const s = normalizeShopifyOrder(order)!
    expect(s).toMatchObject({ external_id: '5001', location_id: '777', total_cents: '2230', state: 'completed' })
    expect(s.lines[0]).toMatchObject({ item_ref: 'variant:333', sku: '4006381333931', unit_price_cents: '1000', tax_cents: '230', tax_rate: '11.500' })
    expect(s.payments).toEqual([{ method: 'cash', amount_cents: '2230', provider_payment_id: '71', status: 'captured', card_last4: null, card_brand: null }])
    expect(s.refunds).toEqual([{ external_id: '81', reason: 'Devuelto', occurred_at: '2026-11-16T15:00:00Z', method: 'cash', restock: true, lines: [{ external_line_id: '9001', qty: '1' }] }])
    expect(normalizeShopifyOrder({ ...order, source_name: 'web' })).toBeNull()
    expect(normalizeShopifyOrder({ ...order, financial_status: 'pending' })).toBeNull()
  })
})

describe('Clover adapter', () => {
  it('the X-Clover-Auth code (constant time) and order ids from the webhook', () => {
    const body = JSON.stringify({ appId: 'APP', merchants: { MID1: [{ objectId: 'O:ORD9', type: 'UPDATE', ts: 1763300000000 }, { objectId: 'P:PAY1', type: 'CREATE', ts: 1763300000001 }] } })
    expect(cloverAdapter.verifyWebhook({ headers: H({ 'x-clover-auth': 'code-123' }), rawBody: body, secret: 'code-123' })).toBe(true)
    expect(cloverAdapter.verifyWebhook({ headers: H({ 'x-clover-auth': 'code-124' }), rawBody: body, secret: 'code-123' })).toBe(false)
    expect(cloverAdapter.parseWebhook(body, H({}))).toEqual([{ eventKey: 'cl:MID1:O:ORD9:UPDATE:1763300000000', accountId: 'MID1', eventType: 'order.update', objectType: 'order', objectId: 'ORD9', version: '1763300000000' }])
  })
  it('an order: thousandths quantities, tax per payment allocated to lines, card last four', () => {
    const s = normalizeCloverOrder({ id: 'ORD9', state: 'locked', total: 3345, modifiedTime: 1763300000500, createdTime: 1763299990000, employee: { name: 'Luis' }, device: { id: 'DEV1' },
      lineItems: { elements: [{ id: 'LI1', name: 'Café', price: 1000, unitQty: 2000, item: { id: 'IT1' } }, { id: 'LI2', name: 'Pan', price: 1000 }] },
      payments: { elements: [{ id: 'PY1', amount: 3345, taxAmount: 345, result: 'SUCCESS', tender: { labelKey: 'com.clover.tender.credit_card' }, cardTransaction: { cardType: 'MC', last4: '4444' } }] } }, 'MID1')!
    expect(s.lines.map((l) => [l.qty, l.unit_price_cents, l.tax_cents])).toEqual([['2', '1000', '230'], ['1', '1000', '115']])
    expect(s.payments[0]).toMatchObject({ method: 'card', amount_cents: '3345', card_last4: '4444' })
    expect(s).toMatchObject({ location_id: 'MID1', cashier_ref: 'Luis', register_ref: 'DEV1', total_cents: '3345' })
    expect(normalizeCloverOrder({ id: 'X', state: 'open', lineItems: { elements: [] } }, 'MID1')).toBeNull()
  })
})

describe('Lightspeed X-Series adapter', () => {
  const sale = { id: 'S-1', outlet_id: 'OUT-1', register_id: 'REG-1', user_name: 'Ana', status: 'CLOSED', version: 7, sale_date: '2026-11-16T13:00:00Z', total_price: '20.00', total_tax: '2.30',
    line_items: [{ id: 'LI-1', product_id: 'P-1', quantity: 2, price: '10.00', discount: '0', tax: '1.15' }], payments: [{ id: 'PM-1', name: 'Cash', amount: '22.30' }] }
  it('form-encoded webhook signed with HMAC-SHA256 hex', () => {
    const raw = new URLSearchParams({ payload: JSON.stringify(sale), type: 'sale.update', domain_prefix: 'tienda' }).toString()
    const sig = createHmac('sha256', 'ls-secret').update(raw).digest('hex')
    expect(lightspeedAdapter.verifyWebhook({ headers: H({ 'x-signature': `signature=${sig}, algorithm=HMAC-SHA256` }), rawBody: raw, secret: 'ls-secret' })).toBe(true)
    expect(lightspeedAdapter.verifyWebhook({ headers: H({ 'x-signature': `signature=${sig}, algorithm=HMAC-SHA1` }), rawBody: raw, secret: 'ls-secret' })).toBe(false)
    expect(lightspeedAdapter.parseWebhook(raw, H({}))[0]).toMatchObject({ eventKey: 'ls:tienda:S-1:7', accountId: 'tienda', objectId: 'S-1', version: '7' })
  })
  it('sale with per-unit tax; returns point to the original; voided sales', () => {
    const s = normalizeLightspeedSale(sale)!
    expect(s.lines[0]).toMatchObject({ qty: '2', unit_price_cents: '1000', tax_cents: '230' }); expect(s.total_cents).toBe('2230'); expect(s.payments[0].method).toBe('cash')
    expect(normalizeLightspeedSale({ ...sale, status: 'VOIDED' })!.state).toBe('voided'); expect(normalizeLightspeedSale({ ...sale, status: 'SAVED' })).toBeNull()
    expect(normalizeLightspeedReturn({ id: 'S-2', return_for: 'S-1', status: 'CLOSED', version: 1, line_items: [{ return_for_line_item_id: 'LI-1', quantity: -1 }], payments: [{ name: 'Cash' }] }))
      .toMatchObject({ sourceSaleId: 'S-1', refund: { external_id: 'S-2', lines: [{ external_line_id: 'LI-1', qty: '1' }], method: 'cash' } })
  })
  it('tender names recognised (ATH Móvil arrives as a custom tender)', () => {
    expect(methodFromLabel('ATH Movil')).toBe('ath_movil'); expect(methodFromLabel('Efectivo')).toBe('cash'); expect(methodFromLabel('Visa')).toBe('card'); expect(methodFromLabel('Zelle')).toBe('other')
  })
})

describe('CSV of a traditional register', () => {
  it('quotes, semicolons and BOM', () => {
    expect(parseCsvRows('﻿a;b\n"x;1";"he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x;1', 'he said "hi"']])
  })
  it('Puerto Rico local time (UTC−4, no daylight saving) and invalid dates', () => {
    expect(prDateToIso('2026-11-16 09:15')).toBe('2026-11-16T13:15:00.000Z'); expect(prDateToIso('2026-07-01 23:00')).toBe('2026-07-02T03:00:00.000Z')
    expect(prDateToIso('2026-02-30')).toBeNull(); expect(prDateToIso('16/11/2026')).toBeNull()
  })
  it('rows grouped by receipt with exact totals; bad rows are reported, never guessed', () => {
    const csv = 'recibo,fecha,ubicacion,codigo,descripcion,cantidad,precio,impuesto,pago\n' +
      'Z-1,2026-11-16 09:15,CAJA-1,4006381333931,Café,2,10.00,2.30,efectivo\nZ-1,2026-11-16 09:15,CAJA-1,,Depto 3,1,5.00,0,\n' +
      'Z-2,2026-11-16 10:00,CAJA-1,P-1,Pan,1,1.25,0.14,ATH Movil\nZ-3,mañana,CAJA-1,P-1,Pan,1,1.25,,\n'
    const r = parseRegisterCsv(csv)
    expect(r.rows).toBe(4); expect(r.issues).toEqual([{ line: 5, problem: 'date' }])
    expect(r.sales.map((s) => [s.external_id, s.total_cents, s.payments[0]?.method])).toEqual([['CAJA-1:Z-1', '2730', 'cash'], ['CAJA-1:Z-2', '139', 'ath_movil']])
    expect(r.sales[0].lines[1]).toMatchObject({ sku: null, catalog_required: false })
    expect(parseRegisterCsv('a,b\n1,2').issues[0].problem).toMatch(/^missing_columns/)
  })
})

describe('server signatures, tokens and configuration', () => {
  it('the signed message matches 0044 byte for byte', () => {
    const secret = Buffer.from('k'.repeat(32))
    const s = new PosSigner({ id: 'k1', secret }, () => 1763300000).ingest('int-1', '{"a":1}')
    const sha = createHash('sha256').update('{"a":1}').digest('hex')
    expect(s.mac).toBe(createHmac('sha256', secret).update(`pos_ingest|v1|k1|int-1|1763300000|${s.nonce}|${sha}`).digest('hex'))
  })
  it('provider tokens: AES-256-GCM bound to the POS module; a banking ciphertext or another key fails', () => {
    const keys = [{ id: 'p1', key: Buffer.alloc(32, 7) }]
    const { ciphertext } = encryptPosToken('EAAA-secret-token', keys)
    expect(ciphertext).not.toContain('secret'); expect(decryptPosToken(ciphertext, keys)).toBe('EAAA-secret-token')
    expect(() => decryptPosToken(ciphertext, [{ id: 'p1', key: Buffer.alloc(32, 8) }])).toThrow('POS_TOKEN_INVALID')
  })
  it('closed by default; loopback doubles only outside production', () => {
    expect(readPosConfig({}).core).toBeNull(); expect(readPosConfig({}).square.configured).toBe(false)
    const base = { POS_SERVER_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`, POS_TOKEN_KEYS: `t1:${Buffer.alloc(32, 2).toString('base64')}`, SQUARE_APPLICATION_ID: 'id', SQUARE_APPLICATION_SECRET: 's' }
    expect(readPosConfig({ ...base, APP_ENV: 'development', SQUARE_BASE_URL: 'http://127.0.0.1:9' }).square).toMatchObject({ configured: true, environment: 'test_double' })
    expect(readPosConfig({ ...base, APP_ENV: 'production', SQUARE_BASE_URL: 'http://127.0.0.1:9' }).square).toMatchObject({ configured: false, reason: 'invalid_base_url' })
    expect(readPosConfig({ ...base, APP_ENV: 'production' }).square).toMatchObject({ configured: true, environment: 'sandbox', baseURL: 'https://connect.squareupsandbox.com' })
  })
  it('database errors become messages in both languages', () => {
    expect(posErrorCode({ message: 'POS_APPROVAL_REQUIRED' })).toBe('pos_approval_required'); expect(posErrorCode({ code: '42501', message: 'x' })).toBe('forbidden')
    expect(posMessage('pos_stock_unavailable', 'en')).toMatch(/available stock/); expect(posMessage('pos_stock_unavailable', 'es')).toMatch(/existencias/)
  })
  it('the provider table never claims more than a test double', () => {
    for (const p of PROVIDERS) expect(['adapter_test_double', 'not_implemented', 'file_import', 'bridge']).toContain(p.businessai.status)
    expect(PROVIDERS.find((p) => p.id === 'lightspeed_r')!.businessai.status).toBe('not_implemented')
  })
})

describe('webhook path end to end (fake database + fake Square API)', () => {
  const POS_SERVER_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`, POS_TOKEN_KEYS = `t1:${Buffer.alloc(32, 2).toString('base64')}`
  const env = { APP_ENV: 'development', POS_SERVER_KEYS, POS_TOKEN_KEYS, SQUARE_APPLICATION_ID: 'id', SQUARE_APPLICATION_SECRET: 's', SQUARE_BASE_URL: 'http://127.0.0.1:9',
    SQUARE_WEBHOOK_SIGNATURE_KEY: SQ_KEY, SQUARE_WEBHOOK_URL: SQ_URL }
  function fakeDb() {
    const events = new Map<string, number>(), calls: { fn: string; args: Record<string, unknown> }[] = []
    const token = encryptPosToken('sq-access-token', [{ id: 't1', key: Buffer.alloc(32, 2) }]).ciphertext
    return { calls, rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (fn === 'pos_webhook_record') {
        const k = String(args.event_key)
        if (events.has(k)) return { data: { already: true }, error: null }
        events.set(k, events.size + 1)
        return { data: { already: false, event_id: events.size, integration_id: 'int-1', status: 'received' }, error: null }
      }
      if (fn === 'pos_integration_context') return { data: { company_id: 'co', provider: 'square', status: 'active', external_account_id: 'M1', token_ciphertext: token, settings: {} }, error: null }
      if (fn === 'pos_ingest_batch') return { data: { run: 'r', counts: { created: 1 }, results: [] }, error: null }
      return { data: null, error: { message: 'unknown' } }
    } }
  }
  const fakeSquare: typeof fetch = async (url, init) => {
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== 'Bearer sq-access-token') return new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }), { status: 401 })
    if (String(url).endsWith('/v2/orders/ORD-1')) return new Response(JSON.stringify({ order: sqOrder() }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  const body = JSON.stringify({ merchant_id: 'M1', type: 'order.updated', event_id: 'ev-9', data: { type: 'order', id: 'ORD-1', object: { order_updated: { order_id: 'ORD-1', version: 4 } } } })
  const headers = H({ 'x-square-hmacsha256-signature': createHmac('sha256', SQ_KEY).update(SQ_URL + body).digest('base64') })

  it('verified → recorded (signed) → fetched with the decrypted token → ingested with its event id; a redelivery does nothing', async () => {
    const db = fakeDb(), cfg = readPosConfig(env)
    const r1 = await handlePosWebhook({ provider: 'square', rawBody: body, headers, url: SQ_URL, cfg, supabase: db as never, fetcher: fakeSquare })
    expect(r1).toEqual({ status: 200, body: { ok: true, events: 1 } })
    const ingest = db.calls.find((c) => c.fn === 'pos_ingest_batch')!
    const payload = JSON.parse(String(ingest.args.payload))
    expect(payload.sales[0]).toMatchObject({ external_id: 'ORD-1', event_id: '1', total_cents: '2230' })
    expect(String(ingest.args.mac)).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(db.calls)).not.toContain('sq-access-token')
    const n = db.calls.length
    const r2 = await handlePosWebhook({ provider: 'square', rawBody: body, headers, url: SQ_URL, cfg, supabase: db as never, fetcher: fakeSquare })
    expect(r2.status).toBe(200); expect(db.calls.slice(n).map((c) => c.fn)).toEqual(['pos_webhook_record'])
  })
  it('a bad signature is refused before anything is written; unconfigured servers answer 503', async () => {
    const db = fakeDb()
    expect(await handlePosWebhook({ provider: 'square', rawBody: body, headers: H({ 'x-square-hmacsha256-signature': 'AAAA' }), url: SQ_URL, cfg: readPosConfig(env), supabase: db as never }))
      .toEqual({ status: 401, body: { ok: false, error: 'invalid_signature' } })
    expect(db.calls).toHaveLength(0)
    expect((await handlePosWebhook({ provider: 'square', rawBody: body, headers, url: SQ_URL, cfg: readPosConfig({}), supabase: db as never })).status).toBe(503)
    expect((await handlePosWebhook({ provider: 'nope', rawBody: body, headers, url: SQ_URL, cfg: readPosConfig(env), supabase: db as never })).status).toBe(404)
  })
})

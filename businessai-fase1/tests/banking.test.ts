/**
 * Banking libraries (S6): configuration (closed by default, loopback doubles
 * only outside production), token encryption, server signatures, Plaid
 * adapter and webhook verification against the local TEST DOUBLE, sync
 * payloads, matching suggestions, OCR mapping and validation of the data a
 * person confirms. No real bank, provider or OCR service is contacted.
 */
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bankingStatus, parseTokenKeys, readBankingConfig, readOcrConfig } from '@/lib/banking/config'
import { decryptToken, encryptToken } from '@/lib/banking/crypto'
import { BankSigner } from '@/lib/banking/signer'
import { PlaidClient, PlaidError, toBankRow } from '@/lib/banking/plaid'
import { clearWebhookKeyCache, verifyPlaidWebhook } from '@/lib/banking/webhook-verify'
import { pageToPayload, syncConnection } from '@/lib/banking/sync'
import { handlePlaidWebhook } from '@/lib/banking/webhook'
import { mentionsClient, mentionsNumber, subsetSum, suggestMatches, type OpenInvoice } from '@/lib/banking/matching'
import { AzureReceiptOcr, mapAzureReceipt, NoOcr, parseConfirmed } from '@/lib/banking/ocr'
import { startPlaidDouble } from '../e2e/local-stack/plaid-double.mjs'
import { startOcrDouble } from '../e2e/local-stack/ocr-double.mjs'

const K32 = Buffer.alloc(32, 7).toString('base64')
const ENV = { APP_ENV: 'development', PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', BANK_SERVER_KEYS: `kb:${K32}`, BANK_TOKEN_KEYS: `t1:${K32}` }

describe('configuration', () => {
  it('closed by default and when any key is missing', () => {
    expect(readBankingConfig({ APP_ENV: 'development' })).toEqual({ configured: false, reason: 'missing_credentials' })
    expect(readBankingConfig({ ...ENV, BANK_SERVER_KEYS: '' })).toMatchObject({ configured: false, reason: 'missing_server_key' })
    expect(readBankingConfig({ ...ENV, BANK_TOKEN_KEYS: 'x:abc' })).toMatchObject({ configured: false, reason: 'missing_token_key' })
    expect(readBankingConfig({ ...ENV, BANKING_DISABLED: '1' })).toMatchObject({ configured: false, reason: 'disabled' })
  })
  it('sandbox by default; a loopback double only outside production, labelled test_double', () => {
    expect(readBankingConfig(ENV)).toMatchObject({ configured: true, environment: 'sandbox', baseURL: 'https://sandbox.plaid.com' })
    expect(readBankingConfig({ ...ENV, PLAID_ENV: 'production' })).toMatchObject({ environment: 'production', baseURL: 'https://production.plaid.com' })
    expect(readBankingConfig({ ...ENV, PLAID_BASE_URL: 'http://127.0.0.1:9' })).toMatchObject({ configured: true, environment: 'test_double' })
    expect(readBankingConfig({ ...ENV, APP_ENV: 'production', PLAID_BASE_URL: 'http://127.0.0.1:9' })).toMatchObject({ configured: false, reason: 'invalid_base_url' })
    expect(readBankingConfig({ ...ENV, PLAID_BASE_URL: 'http://evil.example' })).toMatchObject({ configured: false, reason: 'invalid_base_url' })
  })
  it('the UI learns only whether it works', () => {
    const s = JSON.stringify(bankingStatus(readBankingConfig(ENV)))
    expect(s).not.toContain('sec'); expect(s).not.toContain(K32)
    expect(readOcrConfig({})).toEqual({ configured: false, reason: 'none' })
    expect(readOcrConfig({ OCR_PROVIDER: 'azure', AZURE_DOCINTEL_ENDPOINT: 'https://x.cognitiveservices.azure.com' })).toMatchObject({ configured: false, reason: 'missing_credentials' })
    expect(readOcrConfig({ APP_ENV: 'production', OCR_PROVIDER: 'azure', AZURE_DOCINTEL_ENDPOINT: 'http://127.0.0.1:1', AZURE_DOCINTEL_KEY: 'k' })).toMatchObject({ configured: false })
  })
})

describe('access token encryption', () => {
  const keys = parseTokenKeys(`t2:${Buffer.alloc(32, 9).toString('base64')},t1:${K32}`)
  it('AES-256-GCM round trip; the key id travels with the ciphertext; tampering fails', () => {
    const { ciphertext, keyVersion } = encryptToken('access-sandbox-secret', keys)
    expect(keyVersion).toBe('t2'); expect(ciphertext).not.toContain('access-sandbox-secret')
    expect(decryptToken(ciphertext, keys)).toBe('access-sandbox-secret')
    expect(encryptToken('same', keys).ciphertext).not.toBe(encryptToken('same', keys).ciphertext)
    const parts = ciphertext.split('.'); parts[2] = Buffer.from('x').toString('base64url')
    expect(() => decryptToken(parts.join('.'), keys)).toThrow('BANK_TOKEN_INVALID')
    expect(() => decryptToken(ciphertext, parseTokenKeys(`t1:${K32}`))).toThrow('BANK_TOKEN_KEY_UNKNOWN')
    expect(parseTokenKeys('t1:short')).toEqual([])
  })
})

describe('server signatures (same canonical messages as 0042)', () => {
  it('bank_apply|v1|key|connection|ts|nonce|sha(payload)', () => {
    const secret = Buffer.alloc(32, 7)
    const s = new BankSigner({ id: 'kb', secret }).apply('conn-1', '{"a":1}')
    const sha = createHash('sha256').update('{"a":1}').digest('hex')
    expect(s.mac).toBe(createHmac('sha256', secret).update(['bank_apply', 'v1', 'kb', 'conn-1', String(s.ts), s.nonce, sha].join('|')).digest('hex'))
    const c = new BankSigner({ id: 'kb', secret }).connect('ABC-User', 'co', 'p')
    expect(c.mac).toBe(createHmac('sha256', secret).update(['bank_connect', 'v1', 'kb', 'abc-user', 'co', String(c.ts), c.nonce, createHash('sha256').update('p').digest('hex')].join('|')).digest('hex'))
    expect(new BankSigner({ id: 'kb', secret }).context('x').nonce).not.toBe(new BankSigner({ id: 'kb', secret }).context('x').nonce)
  })
})

describe('Plaid adapter and webhooks against the local TEST DOUBLE', () => {
  let dbl: { url: string; close: () => Promise<void> }
  let plaid: PlaidClient
  beforeAll(async () => {
    dbl = await startPlaidDouble({ port: 46131, clientId: 'cid', secret: 'sec' })
    plaid = new PlaidClient({ clientId: 'cid', secret: 'sec', baseURL: dbl.url, countryCodes: ['US'], webhookURL: null, environment: 'test_double' })
  })
  afterAll(async () => { await dbl.close() })

  it('exchange, accounts (masked numbers only), sync pages with a cursor, removal', async () => {
    const { public_token } = await plaid.sandboxPublicToken()
    const { access_token, item_id } = await plaid.exchange(public_token)
    expect(item_id).toMatch(/^dbl-item-/)
    const a = await plaid.accounts(access_token)
    expect(a.accounts.map((x) => x.mask)).toEqual(['4821', '9999'])
    await fetch(`${dbl.url}/_double/add`, { method: 'POST', body: JSON.stringify({ transactions: [
      { transaction_id: 't1', account_id: 'dbl-acc-checking', amount: -150, date: '2026-11-02', name: 'DEPOSITO FAC-1001' },
      { transaction_id: 't2', account_id: 'dbl-acc-checking', amount: 25.5, date: '2026-11-03', name: 'CARGO', pending: true },
    ] }) })
    const page = await plaid.syncPage(access_token, null)
    expect(page.added.length).toBe(2); expect(page.has_more).toBe(false)
    expect((await plaid.syncPage(access_token, page.next_cursor)).added).toEqual([])
    await expect(plaid.exchange(public_token)).rejects.toMatchObject({ code: 'INVALID_PUBLIC_TOKEN' })
    await plaid.remove(access_token)
    await expect(plaid.accounts(access_token)).rejects.toBeInstanceOf(PlaidError)
  })
  it('wrong credentials surface as a Plaid error code, never the secret', async () => {
    const bad = new PlaidClient({ clientId: 'cid', secret: 'wrong', baseURL: dbl.url, countryCodes: ['US'], webhookURL: null, environment: 'test_double' })
    const e = await bad.linkToken({ userId: 'u', language: 'es' }).catch((x) => x)
    expect(e).toBeInstanceOf(PlaidError); expect(e.code).toBe('INVALID_API_KEYS'); expect(String(e.message)).not.toContain('wrong')
    const prod = new PlaidClient({ clientId: 'cid', secret: 'sec', baseURL: dbl.url, countryCodes: ['US'], webhookURL: null, environment: 'production' })
    expect(() => prod.sandboxPublicToken()).toThrow('NOT_ALLOWED_IN_PRODUCTION')
  })
  it('webhook signatures: valid, tampered body, wrong key, stale', async () => {
    clearWebhookKeyCache()
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', expired_at: null }
    const jwt = (body: string, iat = Math.floor(Date.now() / 1000), kid = 'k1') => {
      const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url')
      const p = Buffer.from(JSON.stringify({ iat, request_body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url')
      return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    }
    const get = async (kid: string) => (kid === 'k1' ? jwk : null)
    const body = '{"webhook_code":"SYNC_UPDATES_AVAILABLE"}'
    expect(await verifyPlaidWebhook(jwt(body), body, get)).toEqual({ ok: true })
    expect(await verifyPlaidWebhook(jwt(body), body + ' ', get)).toEqual({ ok: false, reason: 'body' })
    expect(await verifyPlaidWebhook(jwt(body, Math.floor(Date.now() / 1000) - 900), body, get)).toEqual({ ok: false, reason: 'stale' })
    expect(await verifyPlaidWebhook(jwt(body, undefined, 'other'), body, get)).toEqual({ ok: false, reason: 'key' })
    expect(await verifyPlaidWebhook(null, body, get)).toEqual({ ok: false, reason: 'missing' })
    const forged = jwt(body).split('.'); forged[2] = forged[2].slice(0, -4) + 'AAAA'
    expect((await verifyPlaidWebhook(forged.join('.'), body, get)).ok).toBe(false)
  })
  it('a webhook is verified before anything is written; then recorded once through the signed function', async () => {
    clearWebhookKeyCache()
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    const supabase = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { already: false, outcome: 'recorded', connection_id: null }, error: null } } }
    const cfg = readBankingConfig({ ...ENV, PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_BASE_URL: dbl.url })
    const r1 = await handlePlaidWebhook({ rawBody: '{"item_id":"x"}', verification: 'a.b.c', cfg, supabase: supabase as never })
    expect(r1.status).toBe(401); expect(calls).toEqual([])
    // the double signs a real delivery to a capture server
    const { createServer } = await import('node:http')
    const got: { body: string; sig: string }[] = []
    const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ body: b, sig: String(req.headers['plaid-verification']) }); res.end('{}') }) })
    await new Promise<void>((ok) => srv.listen(46133, '127.0.0.1', () => ok()))
    await fetch(`${dbl.url}/_double/webhook`, { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:46133/', payload: { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'dbl-item-x', error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'secret detail' }, account_ids: ['a'] } }) })
    srv.close()
    const r2 = await handlePlaidWebhook({ rawBody: got[0].body, verification: got[0].sig, cfg, supabase: supabase as never })
    expect(r2).toEqual({ status: 200, body: { ok: true } })
    expect(calls.length).toBe(1); expect(calls[0].fn).toBe('bank_webhook_record')
    expect(JSON.parse(calls[0].args.payload as string)).toEqual({ item_id: 'dbl-item-x', webhook_type: 'ITEM', webhook_code: 'ERROR', error_code: 'ITEM_LOGIN_REQUIRED' })
    expect(calls[0].args.event_key).toBe(createHash('sha256').update(got[0].body).digest('hex'))
  })
  it('sync: pages written one by one with their cursor; a provider error is recorded as a failed run', async () => {
    const cfg = readBankingConfig({ ...ENV, PLAID_BASE_URL: dbl.url })
    if (!cfg.configured) throw new Error('cfg')
    const { access_token } = await plaid.exchange((await plaid.sandboxPublicToken()).public_token)
    await fetch(`${dbl.url}/_double/add`, { method: 'POST', body: JSON.stringify({ transactions: Array.from({ length: 3 }, (_, i) => ({ transaction_id: `s${i}`, account_id: 'dbl-acc-checking', amount: -10 - i, date: '2026-11-0' + (i + 1), name: 'DEP' })) }) })
    const applied: Record<string, unknown>[] = []
    const ct = encryptToken(access_token, cfg.tokenKeys).ciphertext
    const supabase = { rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'bank_sync_context') return { data: { company_id: 'co', status: 'active', cursor: null, token_ciphertext: ct, accounts: [{ provider_account_id: 'dbl-acc-checking', bank_account_id: 'ba-1' }] }, error: null }
      applied.push(JSON.parse(args.payload as string)); return { data: { added: 3, duplicates: 0, removed: 0 }, error: null }
    } }
    const r = await syncConnection(supabase as never, cfg, 'conn', 'manual')
    expect(r).toMatchObject({ ok: true, added: 3, pages: 1 })
    expect(applied[0]).toMatchObject({ trigger: 'manual', status: 'succeeded', cursor: 'dbl-cursor-3' })
    expect((applied[0].accounts as { rows: unknown[] }[])[0].rows.length).toBe(3)
    await fetch(`${dbl.url}/_double/fail`, { method: 'POST', body: JSON.stringify({ code: 'ITEM_LOGIN_REQUIRED' }) })
    const f = await syncConnection(supabase as never, cfg, 'conn', 'manual')
    expect(f).toEqual({ ok: false, reason: 'provider_error', code: 'ITEM_LOGIN_REQUIRED' })
    expect(applied.at(-1)).toEqual({ trigger: 'manual', status: 'failed', error_code: 'ITEM_LOGIN_REQUIRED' })
  })
})

describe('sync payloads', () => {
  it('money in is positive cents; pending and unlinked accounts are skipped', () => {
    expect(toBankRow({ transaction_id: 'a', account_id: 'x', amount: -150.25, iso_currency_code: 'USD', date: '2026-11-01', name: 'DEP', pending: false, payment_meta: { reference_number: 'FAC-7' } }))
      .toMatchObject({ amount_cents: '15025', reference: 'FAC-7', bank_txn_id: 'a' })
    const p = pageToPayload('webhook', 'c2', [
      { transaction_id: 'a', account_id: 'linked', amount: 20, iso_currency_code: 'USD', date: '2026-11-01', name: 'FEE', pending: false },
      { transaction_id: 'b', account_id: 'linked', amount: 5, iso_currency_code: 'USD', date: '2026-11-01', name: 'P', pending: true },
      { transaction_id: 'c', account_id: 'other', amount: 5, iso_currency_code: 'USD', date: '2026-11-01', name: 'X', pending: false },
    ], ['z'], new Map([['linked', 'ba']]))
    expect(p).toMatchObject({ pending_skipped: 1, removed: ['z'], cursor: 'c2' })
    expect(p.accounts).toEqual([{ bank_account_id: 'ba', rows: [expect.objectContaining({ bank_txn_id: 'a', amount_cents: '-2000' })] }])
  })
})

describe('smart matching (suggestions only)', () => {
  const inv = (id: string, number: string, client: string, cents: number, issue = '2026-10-01'): OpenInvoice => ({ id, number, client_id: client, client_name: client === 'c1' ? 'Panadería La Esquina' : 'Taller Ríos', balance_cents: cents, issue_date: issue, due_date: '2026-10-31' })
  const invoices = [inv('i1', 'FAC-0001', 'c1', 10000), inv('i2', 'FAC-0002', 'c1', 5000), inv('i3', 'FAC-0003', 'c2', 15000), inv('i4', 'FAC-0004', 'c2', 7000)]
  it('helpers: invoice numbers and client names as written by banks', () => {
    expect(mentionsNumber('TRANSF REF FAC 0001 PANADERIA', 'FAC-0001')).toBe(true)
    expect(mentionsNumber('PAGO 1', 'FAC-0001')).toBe(false)
    expect(mentionsClient('ATH MOVIL PANADERIA ESQUINA', 'Panadería La Esquina')).toBe(true)
    expect(mentionsClient('DEPOSITO', 'Panadería La Esquina')).toBe(false)
    expect(subsetSum(invoices.filter((i) => i.client_id === 'c1'), 15000).map((c) => c.map((i) => i.id))).toEqual([['i1', 'i2']])
  })
  it('the invoice named in the reference with the exact amount is the strongest suggestion, with its reasons', () => {
    const s = suggestMatches({ id: 'd', amount_cents: 15000, txn_date: '2026-11-02', description: 'TRANSFERENCIA TALLER RIOS', reference: 'FAC-0003' }, invoices, [])
    expect(s[0]).toMatchObject({ kind: 'invoices', allocations: [{ document_id: 'i3', amount_cents: 15000 }], ambiguous: false })
    expect(s[0].reasons).toEqual(expect.arrayContaining(['amount_exact', 'reference_invoice', 'client_name']))
    expect(s[0].confidence).toBeGreaterThanOrEqual(90)
  })
  it('one deposit for several invoices of the same client; a partial payment when the amounts differ', () => {
    const grouped = suggestMatches({ id: 'd', amount_cents: 15000, txn_date: '2026-11-02', description: 'ATH MOVIL PANADERIA ESQUINA', reference: null }, invoices, [])
    const combo = grouped.find((x) => x.kind === 'invoices' && x.allocations.length === 2)
    expect(combo && combo.kind === 'invoices' && combo.allocations.map((a) => a.document_id).sort()).toEqual(['i1', 'i2'])
    const partial = suggestMatches({ id: 'd', amount_cents: 4000, txn_date: '2026-11-02', description: 'ABONO FAC-0003', reference: null }, invoices, [])
    expect(partial[0]).toMatchObject({ kind: 'invoices', allocations: [{ document_id: 'i3', amount_cents: 4000 }] })
    expect(partial[0].reasons).toContain('partial')
  })
  it('equally likely options are flagged and capped; a recorded payment can be suggested; nothing for debits or applied deposits', () => {
    const tie = suggestMatches({ id: 'd', amount_cents: 7000, txn_date: '2026-11-02', description: 'DEPOSITO', reference: null }, [...invoices, inv('i5', 'FAC-0005', 'c1', 7000)], [])
    expect(tie.length).toBeGreaterThanOrEqual(2); expect(tie.slice(0, 2).every((x) => x.ambiguous && x.confidence <= 60)).toBe(true)
    const pay = suggestMatches({ id: 'd', amount_cents: 4000, txn_date: '2026-11-03', description: 'DEPOSITO CHEQUE 77', reference: 'CHK-77' }, [],
      [{ id: 'p', amount_cents: 4000, paid_at: '2026-11-02T15:00:00Z', reference: 'CHK-77', document_id: 'i9', document_number: 'FAC-0009', client_name: null, method: 'check' }])
    expect(pay[0]).toMatchObject({ kind: 'payment', payment_id: 'p' }); expect(pay[0].reasons).toEqual(expect.arrayContaining(['amount_exact', 'reference_payment', 'date_close']))
    expect(suggestMatches({ id: 'd', amount_cents: -500, txn_date: '2026-11-02', description: 'X', reference: null }, invoices, [])).toEqual([])
    expect(suggestMatches({ id: 'd', amount_cents: 500, allocated_cents: 500, txn_date: '2026-11-02', description: 'X', reference: null }, invoices, [])).toEqual([])
  })
})

describe('receipt OCR', () => {
  it('maps recognized fields and leaves the rest null (nothing invented, not even the currency)', () => {
    const f = mapAzureReceipt({ MerchantName: { valueString: 'Ferretería', confidence: 0.9 }, Total: { valueCurrency: { amount: 48.15 }, confidence: 0.8 } })
    expect(f.merchant).toEqual({ value: 'Ferretería', confidence: 0.9 })
    expect(f.total_cents).toEqual({ value: 4815, confidence: 0.8 })
    expect(f.currency).toBeNull(); expect(f.date).toBeNull(); expect(f.receipt_number).toBeNull(); expect(f.payment_method).toBeNull()
    expect(mapAzureReceipt(undefined).total_cents).toBeNull()
  })
  it('the Azure adapter against the local TEST DOUBLE: analyze, poll, map; no fields when nothing is readable', async () => {
    const dbl = await startOcrDouble({ port: 46132, key: 'ocr-key' })
    try {
      const ocr = new AzureReceiptOcr(dbl.url, 'ocr-key', fetch, 5)
      const r = await ocr.analyze(new TextEncoder().encode('JPEG…'), 'image/jpeg')
      expect(r).toMatchObject({ status: 'succeeded', fields: { total_cents: { value: 4815 }, tax_cents: { value: 540 }, currency: { value: 'USD' }, date: { value: '2026-11-10' }, receipt_number: null } })
      const none = await ocr.analyze(new TextEncoder().encode('SIN-DATOS'), 'image/jpeg')
      expect(none.status === 'succeeded' && Object.values(none.fields).every((v) => v === null)).toBe(true)
      expect(await new AzureReceiptOcr(dbl.url, 'wrong', fetch, 5).analyze(new Uint8Array([1]), 'image/png')).toMatchObject({ status: 'failed', error: 'HTTP_401' })
      expect(await new NoOcr().analyze()).toEqual({ status: 'not_configured', provider: 'none' })
    } finally { await dbl.close() }
  })
  it('what the person confirms is validated', () => {
    expect(parseConfirmed({ date: '2026-11-10', total: '48.15', tax: '5.40', currency: 'usd', merchant: ' Ferretería ' })).toEqual({ ok: true, data: expect.objectContaining({ total_cents: 4815, tax_cents: 540, currency: 'USD', merchant: 'Ferretería' }) })
    expect(parseConfirmed({ date: '10/11/2026', total: '1', currency: 'USD' })).toEqual({ ok: false, error: 'date' })
    expect(parseConfirmed({ date: '2026-11-10', total: '0', currency: 'USD' })).toEqual({ ok: false, error: 'total' })
    expect(parseConfirmed({ date: '2026-11-10', total: '10', tax: '11', currency: 'USD' })).toEqual({ ok: false, error: 'tax' })
    expect(parseConfirmed({ date: '2026-11-10', total: '10', currency: '' })).toEqual({ ok: false, error: 'currency' })
  })
})

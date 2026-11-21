#!/usr/bin/env node
/**
 * S6 Banking, payments & receipt capture in the browser — LOCAL stack only,
 * with clearly labelled TEST DOUBLES (no real bank, transaction or OCR result):
 *   - e2e/local-stack/plaid-double.mjs: the Plaid REST API (sandbox token,
 *     exchange, accounts, /transactions/sync, item removal, ES256-signed webhooks);
 *   - e2e/local-stack/ocr-double.mjs: Azure Document Intelligence prebuilt-receipt.
 * It drives the real code path: server actions, encrypted tokens, server
 * signatures, idempotent syncs and webhooks, matching suggestions confirmed by a
 * person, payments through Receivables and the ledger, private storage, RLS,
 * branches, iPhone / iPad layouts and English.
 *
 * Receipt capture uploads from the browser itself: run it with
 * E2E_BROWSER_STORAGE=1 on a build whose NEXT_PUBLIC_SUPABASE_URL is the local
 * auth / storage stand-in (http://127.0.0.1:<PORT+2>), as the Finance tests do.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/banking.auth.e2e.mjs
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'
import { startPlaidDouble } from './local-stack/plaid-double.mjs'
import { startOcrDouble } from './local-stack/ocr-double.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3540)
const CO = 'e2000000-0000-4000-8000-000000000001', OTHER_CO = 'e2000000-0000-4000-8000-000000000002'
const INV1 = 'e4000000-0000-4000-8000-000000000001', INV2 = 'e4000000-0000-4000-8000-000000000002', INV3 = 'e4000000-0000-4000-8000-000000000003'
const SERVER_SECRET = randomBytes(32).toString('base64'), TOKEN_KEY = randomBytes(32).toString('base64')
const PLAID = { clientId: `dbl-client-${randomBytes(4).toString('hex')}`, secret: `dbl-secret-${randomBytes(8).toString('hex')}` }
const OCR_KEY = `dbl-ocr-${randomBytes(6).toString('hex')}`

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null, plaid = null, ocr = null

try {
  plaid = await startPlaidDouble({ port: PORT + 6, ...PLAID })
  ocr = await startOcrDouble({ port: PORT + 7, key: OCR_KEY })
  const BASE_GUESS = `http://127.0.0.1:${PORT}`
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin',
    nextEnv: { PLAID_CLIENT_ID: PLAID.clientId, PLAID_SECRET: PLAID.secret, PLAID_BASE_URL: plaid.url, PLAID_WEBHOOK_URL: `${BASE_GUESS}/api/banking/webhooks/plaid`,
      BANK_SERVER_KEYS: `kbe2e:${SERVER_SECRET}`, BANK_TOKEN_KEYS: `te2e:${TOKEN_KEY}`, OCR_PROVIDER: 'azure', AZURE_DOCINTEL_ENDPOINT: ocr.url, AZURE_DOCINTEL_KEY: OCR_KEY } })
  const { BASE, PASSWORD, api, admin, count } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rpc = (email, fn, args) => api(email, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }
  const dbl = (path, body) => fetch(`${plaid.url}/_double/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }).then((r) => r.json())

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts })
    if (locale) await ctx.addCookies([{ name: 'ba_locale', value: locale, url: BASE }])
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(401|404)/.test(m.text())) consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
    page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
    await page.goto(`${BASE}/login`)
    await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
    return { ctx, page }
  }
  async function open(page, path) { const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); last = page.url().replace(BASE, ''); return { status: r?.status() ?? 0, body: await page.locator('body').innerText() } }
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  const submitIn = async (page, locator) => {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && (u.searchParams.has('done') || u.searchParams.has('error')), { timeout: 30000 }).catch(() => {}), locator.click()])
    await page.waitForLoadState('networkidle'); last = page.url().replace(BASE, ''); return page.locator('body').innerText()
  }

  // ---------------------------------------------------------------- setup (the database owner's steps and the company's bank account)
  check((await admin('/rpc/bank_set_server_key', { method: 'POST', body: JSON.stringify({ key: 'kbe2e', secret_b64: SERVER_SECRET }) })).status < 300, 'setup: the bank server key is registered in the database')
  check((await rpc('admin@e2e.local', 'bank_init', { target: CO })).status < 300, 'setup: the admin activates banking')
  const ledger1010 = (await db(`ledger_accounts?company_id=eq.${CO}&code=eq.1010&select=id`))[0]?.id
  const acctRes = await rpc('admin@e2e.local', 'bank_save_account', { target: CO, account: null, account_name: 'Operativa', bank: 'Banco de prueba', digits: '4821', ledger_account: ledger1010 })
  const BANK_ACCOUNT = await json(acctRes)
  check(acctRes.status < 300 && typeof BANK_ACCOUNT === 'string', 'setup: a BusinessAI bank account on 1010')
  const branchRes = await admin('/branches', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ company_id: CO, name: 'San Juan', code: 'SJU' }) })
  const BRANCH = (await json(branchRes))?.[0]?.id
  check(!!BRANCH, 'setup: a branch')
  const docs = await db(`documents?id=in.(${INV1},${INV2},${INV3})&select=id,document_number`)
  const num = Object.fromEntries(docs.map((d) => [d.id, d.document_number]))

  // ---------------------------------------------------------------- access
  {
    const { ctx, page } = await session('member@e2e.local')
    const r = await open(page, '/bank/connections')
    check(/Solo el propietario y los administradores/.test(r.body), 'a member does not open bank connections')
    await ctx.close()
  }

  // ---------------------------------------------------------------- connect (test double), link, sync
  const { ctx: actx, page } = await session('admin@e2e.local')
  {
    const r = await open(page, '/bank/connections')
    check(await page.getByTestId('test-environment-banner').isVisible(), 'the TEST environment is announced on the page (never presented as a real bank)')
    check(/DOBLE DE PRUEBA local/.test(r.body), 'the provider environment is labelled as the local test double')
    const body = await submitIn(page, page.getByRole('button', { name: 'Crear conexión de prueba' }))
    check(/Banco conectado/.test(body), 'the admin creates a test connection (sandbox flow, no bank password anywhere)')
    const conns = await db(`bank_connections?company_id=eq.${CO}&select=*`)
    check(conns.length === 1 && conns[0].environment === 'test_double' && conns[0].status === 'active', 'one connection, stored as test_double', JSON.stringify(conns))
    check(!JSON.stringify(conns).includes('access-sandbox-double'), 'the access token is not in the connection row')
    check(await page.getByTestId('provider-account').count() === 2 && /••4821/.test(body) && /••9999/.test(body), 'the provider accounts show only masked numbers')
    const viaApi = await json(await api('admin@e2e.local', `/rest/v1/bank_connections?select=*`))
    check(Array.isArray(viaApi) && viaApi.length === 1 && !('token_ciphertext' in viaApi[0]), 'the API exposes no token (not even encrypted)')
    check((await json(await api('other@e2e.local', `/rest/v1/bank_connections?select=id`)))?.length === 0, 'isolation: another company sees no connection')
    // link the checking account
    const first = page.getByTestId('provider-account').filter({ hasText: 'Cuenta de cheques' })
    await first.locator('select').selectOption(BANK_ACCOUNT)
    const linked = await submitIn(page, first.getByRole('button', { name: 'Guardar' }))
    check(/Cuenta vinculada/.test(linked), 'the checking account is linked to the BusinessAI account')
  }
  await dbl('add', { transactions: [
    { transaction_id: 'e2e-t1', account_id: 'dbl-acc-checking', amount: -800, date: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), name: `TRANSFERENCIA ${num[INV2]} CLIENTE UNO` },
    { transaction_id: 'e2e-t2', account_id: 'dbl-acc-checking', amount: -1000, date: new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 10), name: 'ATH MOVIL CLIENTE UNO' },
    { transaction_id: 'e2e-t3', account_id: 'dbl-acc-checking', amount: 25, date: new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 10), name: 'CARGO MENSUAL' },
    { transaction_id: 'e2e-t4', account_id: 'dbl-acc-checking', amount: -50, date: new Date().toISOString().slice(0, 10), name: 'DEPOSITO PENDIENTE', pending: true },
    { transaction_id: 'e2e-s1', account_id: 'dbl-acc-savings', amount: -9999, date: new Date().toISOString().slice(0, 10), name: 'AHORRO NO VINCULADO' },
  ] })
  {
    await open(page, '/bank/connections')
    let body = await submitIn(page, page.getByRole('button', { name: 'Sincronizar ahora' }))
    check(/Sincronizado: 3 movimientos nuevos/.test(body), 'sync: three posted transactions of the linked account (pending and unlinked skipped)', body.match(/Sincronizado[^\n]*/)?.[0])
    body = await submitIn(page, page.getByRole('button', { name: 'Sincronizar ahora' }))
    check(/Sincronizado: 0 movimientos nuevos/.test(body), 'syncing again adds nothing')
    check(await count('bank_lines', `bank_account_id=eq.${BANK_ACCOUNT}`) === 3, 'three bank lines, no duplicates')
    check(await page.getByTestId('sync-history').locator('tbody tr').count() >= 2, 'the sync history is shown')
  }

  // ---------------------------------------------------------------- webhooks (signed by the double, verified by the app)
  {
    await dbl('add', { transactions: [{ transaction_id: 'e2e-t5', account_id: 'dbl-acc-checking', amount: -337.5, date: new Date().toISOString().slice(0, 10), name: 'DEPOSITO CHEQUE 4410' }] })
    const item = (await db(`bank_connections?company_id=eq.${CO}&select=item_id`))[0].item_id
    const hook = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: item, initial_update_complete: true, historical_update_complete: true }
    const bad = await dbl('webhook', { url: `${BASE}/api/banking/webhooks/plaid`, payload: { ...hook, x: 1 }, tamper: true })
    check(bad.status === 401, 'a webhook with a forged signature is refused', JSON.stringify(bad))
    const ok = await dbl('webhook', { url: `${BASE}/api/banking/webhooks/plaid`, payload: hook, repeat: true })
    check(ok.status === 200 && ok.repeat === 200, 'a signed webhook is accepted, and so is its retry', JSON.stringify(ok))
    check(await count('bank_webhook_events') === 1, 'the retried webhook is recorded once')
    check(await count('bank_lines', `bank_account_id=eq.${BANK_ACCOUNT}`) === 4, 'the webhook synced the new transaction once')
    const unsigned = await fetch(`${BASE}/api/banking/webhooks/plaid`, { method: 'POST', body: JSON.stringify(hook) })
    check(unsigned.status === 401, 'an unsigned webhook is refused')
  }

  // ---------------------------------------------------------------- deposits: suggestions with reasons, human confirmation
  const line = async (txn) => (await db(`bank_lines?bank_txn_id=eq.${txn}&select=id,status`))[0]
  {
    const r = await open(page, '/bank/deposits')
    check(await page.getByTestId('pending-deposit').count() === 3, 'three deposits wait for a decision (the bank charge is not a deposit)')
    check(/Pagos registrados/.test(r.body) && /Pagos de procesador/.test(r.body) && /Conciliados/.test(r.body), 'recorded payments, processor payments, deposits and reconciled lines are shown apart')
    const l1 = await line('e2e-t1')
    const d = await open(page, `/bank/deposits/${l1.id}`)
    const top = page.getByTestId('deposit-suggestion').first()
    check(/Confianza 9\d%/.test(await top.innerText()) && new RegExp(num[INV2]).test(await top.innerText()), 'the best suggestion is the invoice named in the bank text, with its confidence', (await top.innerText()).slice(0, 200))
    check(/La referencia bancaria menciona el número de factura/.test(d.body) && /El importe coincide exactamente/.test(d.body), 'the suggestion explains why')
    const paymentsBefore = await count('payments')
    const body = await submitIn(page, top.getByRole('button', { name: 'Confirmar y registrar pago' }))
    check(/Depósito aplicado/.test(body), 'the person confirms: the deposit is applied')
    check((await db(`documents?id=eq.${INV2}&select=status`))[0]?.status === 'paid' && await count('payments') === paymentsBefore + 1, 'the invoice is paid by Receivables, one payment recorded')
    check((await line('e2e-t1')).status === 'matched', 'the bank line is matched to the payment\'s ledger line')
    const pay = (await db(`payments?document_id=eq.${INV2}&select=deposit_account_id,branch_id,payment_method`))[0]
    check(pay?.deposit_account_id === ledger1010 && pay?.payment_method === 'bank_transfer', 'the payment was deposited into the bank\'s ledger account', JSON.stringify(pay))
    // the same decision again (double submission) and more than the deposit: refused by the database
    const again = await json(await rpc('admin@e2e.local', 'bank_apply_deposit', { line: l1.id, allocations: [{ document_id: INV2, amount_cents: 80000 }], idem: 'e2e-repeat-0001' }))
    check(/BANK_LINE_NOT_AVAILABLE/.test(JSON.stringify(again)), 'an applied deposit cannot be applied again')
  }
  {
    // one deposit split across two invoices (partial payments)
    const l2 = await line('e2e-t2')
    await open(page, `/bank/deposits/${l2.id}`)
    const form = page.getByTestId('manual-apply')
    await form.locator('#doc-0').selectOption(INV1); await form.locator('#amt-0').fill('600.00')
    await form.locator('#doc-1').selectOption(INV3); await form.locator('#amt-1').fill('400.00')
    await form.locator('select[name="method"]').selectOption('ath_movil')
    const body = await submitIn(page, form.getByRole('button', { name: 'Confirmar y registrar pagos' }))
    check(/Depósito aplicado/.test(body), 'one deposit split across two invoices', body.match(/(Depósito|No se|La suma|Revisa)[^\n]*/)?.[0])
    check(await page.getByTestId('deposit-allocation').count() === 2, 'two applications are listed with their author')
    const over = await json(await rpc('admin@e2e.local', 'bank_apply_deposit', { line: (await line('e2e-t5')).id, allocations: [{ document_id: INV1, amount_cents: 40000 }], idem: 'e2e-over-0001' }))
    check(/DEPOSIT_OVER_APPLIED/.test(JSON.stringify(over)), 'never more than the deposit')
    check(/BANK_ACCOUNT_NOT_FOUND|FORBIDDEN/.test(JSON.stringify(await json(await rpc('other@e2e.local', 'bank_apply_deposit', { line: l2.id, allocations: [{ document_id: INV1, amount_cents: 100 }], idem: 'e2e-other-0001' })))),
      'isolation: another company cannot apply this deposit')
    check(/BANK_ACCOUNT_NOT_FOUND|FORBIDDEN/.test(JSON.stringify(await json(await rpc('member@e2e.local', 'bank_apply_deposit', { line: l2.id, allocations: [{ document_id: INV1, amount_cents: 100 }], idem: 'e2e-member-0001' })))),
      'a member cannot apply deposits')
    // undo one (traceable); the payment stays
    const paymentsBefore = await count('payments')
    const item = page.getByTestId('deposit-allocation').first()
    await item.locator('summary').click(); await item.locator('input[name="reason"]').fill('Era de otra factura')
    const undone = await submitIn(page, item.getByRole('button', { name: 'Deshacer' }))
    check(/Aplicación deshecha/.test(undone) && (await line('e2e-t2')).status === 'unmatched' && await count('payments') === paymentsBefore, 'undoing an application reopens the deposit and keeps the payment (traceable)')
    check(await page.getByTestId('deposit-allocation').filter({ hasText: 'deshecha' }).count() === 1, 'the undone application stays in the history with its reason')
  }

  // ---------------------------------------------------------------- receipts (member): photo → OCR double → correction → confirmation
  const shot = await page.screenshot({ type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 200, height: 200 } })
  let RECEIPT = null
  if (process.env.E2E_BROWSER_STORAGE !== '1') {
    console.log('SKIP: receipt capture in the browser needs E2E_BROWSER_STORAGE=1 and a build whose NEXT_PUBLIC_SUPABASE_URL is the local stub (http://127.0.0.1:<PORT+2>)')
  } else {
    const { ctx, page: m } = await session('member@e2e.local')
    await open(m, '/bank/receipts')
    await Promise.all([m.waitForURL(/\/bank\/receipts\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {}), m.getByTestId('receipt-file').setInputFiles({ name: 'recibo-ferreteria.jpg', mimeType: 'image/jpeg', buffer: shot })])
    last = m.url().replace(BASE, '')
    RECEIPT = m.url().match(/receipts\/([0-9a-f-]{36})/)?.[1]
    check(!!RECEIPT, 'a member photographs / uploads a receipt and lands on its review', await m.getByTestId('receipt-capture').innerText().catch(() => ''))
    if (!RECEIPT) throw new Error('receipt upload failed')
    await m.waitForLoadState('networkidle')
    const fields = m.getByTestId('ocr-fields')
    check(/Ferretería Central/.test(await fields.innerText()) && /48\.15/.test(await fields.innerText()), 'the reading service proposes merchant and total (with confidence)')
    check(await fields.locator('[data-field="receipt_number"][data-recognized="no"]').count() === 1 && /No reconocido/.test(await fields.innerText()), 'what was not recognized is shown as such (never invented)')
    check(/DOBLE DE PRUEBA/.test(await m.getByTestId('ocr-note').innerText()), 'the suggestions are labelled as coming from the test double')
    check(await m.getByTestId('receipt-image').isVisible(), 'the original photo is shown from private storage')
    const form = m.getByTestId('receipt-confirm')
    await form.locator('input[name="total"]').fill('49.15'); await form.locator('input[name="receipt_number"]').fill('R-7781')
    const body = await submitIn(m, form.getByRole('button', { name: 'Confirmar datos' }))
    check(/Datos confirmados/.test(body), 'the member corrects and confirms')
    const rc = (await db(`receipt_captures?id=eq.${RECEIPT}&select=status,confirmed,extracted,ocr_provider`))[0]
    check(rc?.status === 'confirmed' && rc.confirmed.total_cents === '4915' && rc.confirmed.receipt_number === 'R-7781' && rc.extracted.total_cents.value === 4815 && rc.ocr_provider === 'test_double',
      'the confirmed data is stored apart from the suggestion', JSON.stringify(rc))
    // the same file again: the existing receipt
    await open(m, '/bank/receipts')
    await Promise.all([m.waitForURL(/done=duplicate/, { timeout: 30000 }).catch(() => {}), m.getByTestId('receipt-file').setInputFiles({ name: 'otra-vez.jpg', mimeType: 'image/jpeg', buffer: shot })])
    check(m.url().includes(RECEIPT) && /ya estaba registrado/.test(await m.locator('body').innerText()), 'the same file twice is the same receipt (no duplicate)')
    check(await count('receipt_captures', `company_id=eq.${CO}`) === 1, 'one receipt record')
    // nothing readable: every field "not recognized"
    await open(m, '/bank/receipts')
    const blank = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SIN-DATOS ' + randomBytes(16).toString('hex'))])
    await Promise.all([m.waitForURL(/\/bank\/receipts\/[0-9a-f-]{36}$/, { timeout: 30000 }).catch(() => {}), m.getByTestId('receipt-file').setInputFiles({ name: 'borrosa.jpg', mimeType: 'image/jpeg', buffer: blank })])
    await m.waitForLoadState('networkidle')
    check(await m.getByTestId('ocr-fields').locator('[data-recognized="no"]').count() === 8, 'an unreadable receipt: every field is shown as not recognized')
    check((await m.getByTestId('receipt-confirm').locator('input[name="total"]').inputValue()) === '', 'and nothing is pre-filled for it')
    // a manual payment with branch, notes and the receipt as evidence
    await open(m, `/payments/new?document=${INV3}`)
    await m.locator('input[name="amount"]').fill('100.00')
    await m.locator('select[name="method"]').selectOption('check')
    await m.locator('input[name="reference"]').fill('CHK-501')
    await m.locator('select[name="branch_id"]').selectOption(BRANCH)
    await m.getByTestId('payment-evidence').locator('select').selectOption(RECEIPT).catch(async () => { await m.locator('select[name="evidence_capture_id"]').selectOption(RECEIPT) })
    await m.locator('textarea[name="notes"]').fill('Entregado en tienda')
    await m.locator('input[name="create_receipt"]').uncheck()
    await Promise.all([m.waitForURL(/\/documents\/.*done=payment/, { timeout: 30000 }).catch(() => {}), m.getByRole('button', { name: 'Registrar pago' }).click()])
    const p = (await db(`payments?document_id=eq.${INV3}&reference=eq.CHK-501&select=branch_id,notes,evidence_capture_id,payment_method`))[0]
    check(p?.branch_id === BRANCH && p.notes === 'Entregado en tienda' && p.evidence_capture_id === RECEIPT && p.payment_method === 'check', 'a manual payment records branch, notes and photo evidence', JSON.stringify(p))
    // iPhone layout of the receipt review
    await ctx.close()
    const phone = await session('member@e2e.local', devices['iPhone 13'])
    await open(phone.page, `/bank/receipts/${RECEIPT}`)
    check(await noOverflow(phone.page), 'iPhone: the receipt review fits the screen')
    await open(phone.page, '/bank/receipts')
    check(await noOverflow(phone.page) && await phone.page.getByTestId('receipt-camera').count() === 1, 'iPhone: the capture screen fits and offers the camera')
    await phone.ctx.close()
  }
  if (RECEIPT) {
    // isolation of receipts and files
    check((await json(await api('other@e2e.local', `/rest/v1/receipt_captures?select=id`)))?.length === 0, 'isolation: another company sees no receipt')
    const path = (await db(`receipt_captures?id=eq.${RECEIPT}&select=storage_path`))[0].storage_path
    const r = await api('other@e2e.local', `/storage/v1/object/Banking-evidence/${path}`)
    check(r.status >= 400, 'isolation: another company cannot download the original', String(r.status))
    const up = await api('other@e2e.local', `/storage/v1/object/Banking-evidence/${CO}/receipts/${'0'.repeat(8)}-0000-4000-8000-000000000000.jpg`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: shot })
    check(up.status >= 400, 'isolation: another company cannot upload into this company\'s folder', String(up.status))
  }

  // ---------------------------------------------------------------- connection problems, reconnection notice, safe disconnection
  {
    const item = (await db(`bank_connections?company_id=eq.${CO}&select=item_id`))[0].item_id
    await dbl('webhook', { url: `${BASE}/api/banking/webhooks/plaid`, payload: { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: item, error: { error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' } } })
    let r = await open(page, '/bank/connections')
    check(/Requiere reconectar/.test(r.body) && await page.getByTestId('bank-connection').getAttribute('data-status') === 'login_required', 'a connection needing the customer to sign in again is shown as such')
    const card = page.getByTestId('bank-connection')
    await card.locator('summary', { hasText: 'Desconectar' }).click()
    let body = await submitIn(page, card.getByRole('button', { name: 'Desconectar' }).last())
    check(/Marca la casilla/.test(body), 'disconnecting needs an explicit confirmation')
    await open(page, '/bank/connections')
    await page.getByTestId('bank-connection').locator('summary', { hasText: 'Desconectar' }).click()
    await page.getByTestId('bank-connection').locator('input[name="confirm"]').check()
    body = await submitIn(page, page.getByTestId('bank-connection').getByRole('button', { name: 'Desconectar' }).last())
    check(/Conexión eliminada en el proveedor y aquí/.test(body), 'the admin disconnects')
    const items = await fetch(`${plaid.url}/_double/items`).then((x) => x.json())
    check(items.find((i) => i.item_id === item)?.removed === true, 'the item was removed at the provider first')
    check((await db(`bank_connections?company_id=eq.${CO}&select=status`))[0]?.status === 'disconnected' && await count('bank_lines', `bank_account_id=eq.${BANK_ACCOUNT}`) === 4, 'disconnected locally; the transactions stay')
  }

  // ---------------------------------------------------------------- branches, English, iPad / iPhone
  {
    await open(page, `/bank/accounts/${BANK_ACCOUNT}`)
    const f = page.getByTestId('account-branch-form')
    await f.locator('select').selectOption(BRANCH)
    const body = await submitIn(page, f.getByRole('button', { name: 'Guardar sucursal' }))
    check(/Sucursal asignada/.test(body) && (await db(`bank_accounts?id=eq.${BANK_ACCOUNT}&select=branch_id`))[0]?.branch_id === BRANCH, 'the bank account is assigned to a branch')
  }
  await actx.close()
  {
    const { ctx, page: en } = await session('admin@e2e.local', {}, 'en')
    const r = await open(en, '/bank/deposits')
    check(/Deposits and payments/.test(r.body) && /Recorded decisions/.test(r.body) && !/Depósitos pendientes/.test(r.body), 'English: the deposits page')
    const c = await open(en, '/bank/connections')
    check(/Bank connections/.test(c.body) && /Disconnected/.test(c.body), 'English: the connections page')
    await ctx.close()
    for (const [label, dev] of [['iPad Mini', devices['iPad Mini']], ['iPhone 13', devices['iPhone 13']]]) {
      const s = await session('admin@e2e.local', dev)
      const l2 = await line('e2e-t2')
      for (const p of ['/bank/connections', '/bank/deposits', `/bank/deposits/${l2.id}`, '/bank/receipts']) {
        await open(s.page, p)
        check(await noOverflow(s.page), `${label}: ${p.replace(/[0-9a-f-]{36}/, ':id')} fits the screen`)
      }
      await s.ctx.close()
    }
  }
  check(consoleErrors.length === 0, 'no console errors or server errors', consoleErrors.slice(0, 5).join(' | '))
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
  if (stack) console.log(stack.logs.next.slice(-3000))
} finally {
  await browser.close()
  await stack?.stop(); await plaid?.close(); await ocr?.close()
  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

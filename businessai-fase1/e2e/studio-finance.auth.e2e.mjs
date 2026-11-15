#!/usr/bin/env node
/**
 * Document Studio · collections and payments (migration 0038) in the browser,
 * LOCAL stack only. From the expense page: a payment → «Payment voucher
 * (Studio)» → the voucher reads the payment and the expense → issued (CP-…) →
 * its PDF saved on the expense in private storage → listed and downloadable
 * there. From the invoice collection page: «collection letter» → balance, days
 * and ageing read from Receivables → issued (CC-…) → listed on the invoice.
 * A purchase order linked to the expense; an account statement with ageing.
 * Studio never creates payments, entries or expenses (counted). Permissions,
 * English, iPhone. Fictitious data.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/studio-finance.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3480)
const COMPANY = 'e2000000-0000-4000-8000-000000000001'
const INV = 'e4000000-0000-4000-8000-000000000001', CLIENT = 'e3000000-0000-4000-8000-000000000001'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
  const { BASE, PASSWORD, api, admin } = stack
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }
  const rpc = async (who, fn, body) => { const r = await api(who, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric' }).format(new Date())

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true })
    if (locale) await ctx.addCookies([{ name: 'ba_locale', value: locale, url: BASE }])
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
    page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
    await page.goto(`${BASE}/login`)
    await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
    return { ctx, page }
  }
  async function open(page, path) {
    const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    last = page.url().replace(BASE, '')
    const body = await page.locator('body').innerText()
    return { status: r?.status() ?? 0, body, broken: /Algo salió mal|Something went wrong|Application error|Internal Server Error/.test(body) }
  }
  async function act(page, button) {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && /[?&](done|error)=/.test(u.search), { timeout: 20000 }).catch(() => {}), button.click()])
    await page.waitForLoadState('networkidle')
    last = page.url().replace(BASE, '')
    return { url: page.url(), done: new URL(page.url()).searchParams.get('done'), error: new URL(page.url()).searchParams.get('error'), body: await page.locator('body').innerText() }
  }
  const svgText = async (page) => {
    await page.locator('svg[role="img"] text').first().waitFor({ timeout: 10000 }).catch(() => {})
    return (await page.locator('svg[role="img"] text').allTextContents()).join(' ').replace(/\s+/g, ' ')
  }
  const counts = async () => (await Promise.all(['bill_payments', 'payments', 'journal_entries', 'bills'].map(async (t) => (await db(`${t}?select=id`)).length))).join('/')

  const BILL = (await db(`bills?company_id=eq.${COMPANY}&vendor_invoice_number=eq.P-100&select=id`))[0]?.id
  const owner = await session('owner@e2e.local')
  const o = owner.page

  // ============================================================ voucher from a real payment
  let r = await open(o, `/payables/${BILL}`)
  const payForm = o.locator('form').filter({ has: o.locator('input[name="paid_on"]') })
  await payForm.locator('input[name="amount"]').fill('100.00'); await payForm.locator('input[name="reference"]').fill('CHK-777')
  r = await act(o, payForm.getByRole('button', { name: 'Registrar pago' }))
  check(r.done === 'paid', 'setup: a payment of 100.00 is recorded on the expense (Payables)', `${r.done} ${r.error}`)
  const before = await counts()
  r = await act(o, o.getByRole('button', { name: 'Comprobante de pago (Studio)' }))
  const V = /\/studio\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  const vrow = (await db(`studio_documents?id=eq.${V}&select=kind,bill_id,bill_payment_id,vendor_id`))[0]
  check(r.done === 'created' && vrow?.kind === 'payment_voucher' && vrow?.bill_id === BILL && !!vrow?.bill_payment_id, 'from the payment, a voucher draft linked to the expense and the payment', `${r.done} ${r.error} ${JSON.stringify(vrow)}`)
  let pv = await svgText(o)
  check(/Proveedor E2E/.test(pv) && /100[.,]00/.test(pv) && /CHK-777/.test(pv) && /Material/.test(pv) && /450[.,]00/.test(pv), 'preview: vendor, amount paid, reference and the expense lines are read (not typed)', pv.slice(0, 220))
  await o.locator('input[name="confirm"]').check()
  r = await act(o, o.getByRole('button', { name: 'Emitir documento' }))
  const vnum = (await db(`studio_documents?id=eq.${V}&select=number,status`))[0]
  check(r.done === 'finalized' && vnum?.number === `CP-${year}-0001`, `voucher issued (${vnum?.number})`, `${r.done} ${r.error}`)
  r = await act(o, o.getByRole('button', { name: 'Guardar el PDF en el gasto' }))
  const att = (await db(`bill_attachments?bill_id=eq.${BILL}&select=id,file_name,content_type,storage_path`)).find((x) => x.file_name === `CP-${year}-0001.pdf`)
  check(r.done === 'attached' && att?.content_type === 'application/pdf' && att.storage_path.startsWith(`${COMPANY}/${BILL}/`), 'its PDF is saved on the expense, in private storage', `${r.done} ${r.error} ${JSON.stringify(att)}`)
  check((await db(`studio_events?document_id=eq.${V}&action=eq.attached_to_bill&select=id`)).length === 1, 'the Studio history records it')
  r = await open(o, `/payables/${BILL}`)
  const docs = o.getByTestId('bill-studio-docs')
  check(await docs.count() === 1 && new RegExp(`CP-${year}-0001`).test(await docs.innerText()) && await o.getByRole('link', { name: `CP-${year}-0001.pdf` }).count() === 1,
    'the expense lists its voucher (Studio) and the PDF attachment')
  const dl = await owner.ctx.request.get(`${BASE}/payables/attachments/${att?.id}`, { maxRedirects: 0 })
  const signed = dl.headers().location ?? ''
  const file = signed ? await fetch(signed.startsWith('http') ? signed : `${BASE}${signed}`).then(async (x) => [x.status, Buffer.from(await x.arrayBuffer())]) : [0, Buffer.alloc(0)]
  check(file[0] === 200 && file[1].subarray(0, 5).toString() === '%PDF-' && /\/FontFile2|\/Type\s*\/Font/.test(file[1].toString('latin1')), 'the attached PDF downloads through a signed link (real PDF, embedded fonts)', `${dl.status()} ${file[0]}`)
  check(await counts() === before, `Studio created no payment, entry or expense (${await counts()})`, before)

  // ============================================================ purchase order linked to the expense
  const po = await rpc('owner@e2e.local', 'studio_save_document', { target: COMPANY, doc: null, doc_kind: 'purchase_order', doc_title: 'Orden de compra P-100', doc_folder: null,
    doc_content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Orden de compra' }, { type: 'bill' }] }, doc_page: {}, client: null, source_document: null, employee: null, vendor: null,
    template: null, base: null, expected_version: null, doc_origin: 'user' })
  const PO = Array.isArray(po.body) ? po.body[0]?.id : po.body?.id
  await open(o, `/studio/${PO}`)
  await o.getByTestId('studio-finance').locator('select[name="link"]').selectOption(BILL)
  r = await act(o, o.getByTestId('studio-finance').getByRole('button', { name: 'Guardar vínculo' }))
  pv = await svgText(o)
  check(r.done === 'finance_link' && (await db(`studio_documents?id=eq.${PO}&select=bill_id`))[0]?.bill_id === BILL && /Material/.test(pv) && /450[.,]00/.test(pv),
    'a purchase order linked to the expense shows its lines and total', `${r.done} ${r.error}`)

  // ============================================================ collection letter from the invoice
  r = await open(o, `/receivables/invoices/${INV}`)
  r = await act(o, o.getByRole('button', { name: 'Preparar carta de cobro (Studio)' }))
  const C = /\/studio\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  check(r.done === 'created' && (await db(`studio_documents?id=eq.${C}&select=kind,source_document_id,client_id`))[0]?.source_document_id === INV, 'from the invoice, a collection letter draft about it', `${r.done} ${r.error}`)
  pv = await svgText(o)
  check(/1[.,]000[.,]00/.test(pv) && /Cliente Uno/.test(pv) && /Corriente|Current/.test(pv), 'preview: balance 1,000.00, the client and its ageing are read from Receivables', pv.slice(0, 220))
  await o.locator('input[name="confirm"]').check()
  r = await act(o, o.getByRole('button', { name: 'Emitir documento' }))
  check(r.done === 'finalized' && (await db(`studio_documents?id=eq.${C}&select=number`))[0]?.number === `CC-${year}-0001`, 'collection letter issued with its own number (CC-…)', `${r.done} ${r.error}`)
  const pdf = await owner.ctx.request.get(`${BASE}/studio/${C}/pdf`)
  check(pdf.status() === 200 && Buffer.from(await pdf.body()).subarray(0, 5).toString() === '%PDF-', 'its PDF')
  r = await open(o, `/receivables/invoices/${INV}`)
  check(new RegExp(`CC-${year}-0001`).test(await o.getByTestId('invoice-studio-docs').innerText()), 'the invoice lists its collection letter')

  // ============================================================ account statement with ageing
  const st = await rpc('owner@e2e.local', 'studio_save_document', { target: COMPANY, doc: null, doc_kind: 'account_statement', doc_title: 'Estado de cuenta', doc_folder: null,
    doc_content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Estado de cuenta' }, { type: 'statement' }, { type: 'aging' }] }, doc_page: {}, client: CLIENT, source_document: null,
    employee: null, vendor: null, template: null, base: null, expected_version: null, doc_origin: 'user' })
  const S = Array.isArray(st.body) ? st.body[0]?.id : st.body?.id
  await open(o, `/studio/${S}`)
  pv = await svgText(o)
  check(/61–90|61-90/.test(pv) && /1[.,]000[.,]00/.test(pv), 'an account statement shows the client ageing', pv.slice(0, 200))

  // ============================================================ permissions
  const memVoucher = await rpc('member@e2e.local', 'studio_data', { doc: V })
  check(memVoucher.status >= 400, 'a member (no payables.view) cannot read the voucher\'s expense data', String(memVoucher.status))
  const memLink = await rpc('member@e2e.local', 'studio_finance_links', { target: COMPANY, bill: BILL, document: null })
  check(Array.isArray(memLink.body) && memLink.body.length === 0, 'nor the expense\'s Studio documents')
  const otherLink = await rpc('other@e2e.local', 'studio_finance_links', { target: COMPANY, bill: BILL, document: null })
  check(Array.isArray(otherLink.body) && otherLink.body.length === 0, 'another company sees none')

  // ============================================================ English and iPhone
  const en = await session('owner@e2e.local', {}, 'en')
  r = await open(en.page, `/studio/${PO}`)
  check(/Linked expense/.test(await en.page.getByTestId('studio-finance').innerText()) && await en.page.getByRole('button', { name: 'Save link' }).count() === 1, 'English: the expense link block')
  r = await open(en.page, `/payables/${BILL}`)
  check(/Studio documents/.test(r.body) && await en.page.getByRole('button', { name: 'Payment voucher (Studio)' }).count() >= 1, 'English: the expense page')
  r = await open(en.page, `/receivables/invoices/${INV}`)
  check(/Letters and Studio documents/.test(r.body) && await en.page.getByRole('button', { name: 'Prepare a collection letter (Studio)' }).count() === 1, 'English: the invoice page')
  await en.ctx.close()
  const phone = await session('owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of [`/studio/${V}`, `/studio/${C}`, `/payables/${BILL}`, `/receivables/invoices/${INV}`]) {
    await open(phone.page, path)
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1, `iPhone 13: ${path.replace(/[0-9a-f-]{36}/g, '[id]')} has no horizontal page scroll`, `${overflow}px`)
  }
  await phone.ctx.close(); await owner.ctx.close()
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
} finally {
  await browser.close()
  if (stack) {
    const serverErrors = stack.logs.next.split('\n').filter((l) => /Error|⨯/.test(l) && !/NEXT_REDIRECT|NEXT_NOT_FOUND/.test(l))
    check(serverErrors.length === 0, 'no server errors in the Next.js log', serverErrors.slice(0, 5).join(' | '))
    check(!/unhandled/.test(stack.logs.stub), 'the app used only endpoints the local stub implements', stack.logs.stub.match(/unhandled[^\n]*/g)?.slice(0, 3).join(' | ') ?? '')
    await stack.stop()
  }
  check(consoleErrors.length === 0, 'no browser console errors or 5xx responses', consoleErrors.slice(0, 5).join(' | '))
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

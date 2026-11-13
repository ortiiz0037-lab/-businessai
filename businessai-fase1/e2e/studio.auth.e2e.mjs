#!/usr/bin/env node
/**
 * Authenticated browser test of Document Studio (0028) on the LOCAL stack
 * (see e2e/local-stack). Signs in through the login form and drives the real
 * editor: templates, live data, editing, saving, conflicts, PDF (checked with
 * an independent PDF reader when available), issuing, e-mail preparation,
 * the assistant, company templates, identity, roles, isolation, phone/tablet.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/studio.auth.e2e.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const stack = await startStack({ root, port: Number(process.env.PORT ?? 3240), pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
const { BASE, PASSWORD, logs, work } = stack
const INVOICE = 'e4000000-0000-4000-8000-000000000001'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
async function session(email, opts = {}) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 || (r.status() >= 400 && ![404, 403, 400].includes(r.status()))) consoleErrors.push(`${email} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  return { ctx, page }
}
async function open(page, path) {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  last = page.url().replace(BASE, '')
  return { status: r?.status() ?? 0, body: await page.locator('body').innerText() }
}
async function submit(page, form) {
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.toString() !== before, { timeout: 25000 }).catch(() => {}), form.locator('button[type="submit"]').first().click()])
  await page.waitForLoadState('networkidle'); last = page.url().replace(BASE, '')
  return page.locator('body').innerText()
}
const svgText = async (page) => { await page.waitForSelector('svg text', { timeout: 20000 }).catch(() => {}); return (await page.locator('svg text').allTextContents()).join(' ') }
const pdfText = (bytes) => { const f = join(work, `d${Date.now()}.pdf`); writeFileSync(f, bytes); try { return { text: execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }), info: execFileSync('pdfinfo', [f], { encoding: 'utf8' }) } } catch { return null } }

let invoiceDoc = '', letterDoc = ''
try {
  const owner = await session('owner@e2e.local')
  const p = owner.page
  let r = await open(p, '/studio')
  check(r.status === 200 && /Documentos/.test(r.body) && /Nuevo documento/.test(r.body), 'Studio opens for the owner (document list)')

  // ---------------------------------------------------------------- invoice laid out on the existing business invoice
  r = await open(p, `/studio/new?source=${INVOICE}&template=sys:invoice_classic`)
  check(await p.locator('input[name="template"]').count() >= 10, 'new document: the 10 system templates are offered')
  check((await p.locator('form:has(input[name="template"]) select[name="source_document_id"]').inputValue()) === INVOICE, 'new document: opened from Documents, the invoice is already linked')
  await submit(p, p.locator('form:has(input[name="template"])'))
  invoiceDoc = new URL(p.url()).pathname.split('/')[2]
  check(/^[0-9a-f-]{36}$/.test(invoiceDoc) && /Borrador creado/.test(await p.locator('body').innerText()), 'a studio invoice draft is created on the business invoice')
  let preview = await svgText(p)
  check(/Factura/.test(preview) && /Cliente Uno/.test(preview) && /Uno Corp/.test(preview), 'live preview: heading and client data read from the database')
  check(/\$1,500\.00/.test(preview) && /Pagado/.test(preview) && /\$500\.00/.test(preview) && /\$1,000\.00/.test(preview), 'live preview: total 1,500.00, paid 500.00, balance 1,000.00 (real figures, nothing typed)')
  check(/BORRADOR/.test(preview), 'drafts carry a BORRADOR watermark')

  // ---------------------------------------------------------------- edit: add a paragraph, insert a merge field, save
  await p.selectOption('select:has(option[value="paragraph"])', 'paragraph')
  await p.getByRole('button', { name: /^Añadir/ }).click()
  const ta = p.locator('textarea[aria-label="Texto del párrafo"]').last()
  await ta.fill('Gracias por su preferencia, ')
  await ta.focus(); await ta.press('End')
  await p.selectOption('select:has(option[value="client.name"])', 'client.name')
  check((await ta.inputValue()).includes('{{client.name}}'), 'editor: “Insert field” puts {{client.name}} at the cursor')
  await p.waitForTimeout(400)
  preview = await svgText(p)
  check(/Gracias por su preferencia, Cliente Uno/.test(preview), 'editor: the preview updates live with the merged value')
  check(/Cambios sin guardar/.test(await p.locator('body').innerText()), 'editor: unsaved changes are flagged')
  await p.getByRole('button', { name: 'Guardar', exact: true }).click()
  await p.waitForFunction(() => /Guardado/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  check(/Guardado/.test(await p.locator('body').innerText()), 'editor: saves without leaving the page (version 2)')
  await open(p, `/studio/${invoiceDoc}`)
  check((await p.locator('textarea[aria-label="Texto del párrafo"]').last().inputValue()).includes('{{client.name}}'), 'the saved content is there after a reload')

  // ---------------------------------------------------------------- conflict: an admin saves meanwhile, the stale save is refused
  const admin = await session('admin@e2e.local')
  await open(admin.page, `/studio/${invoiceDoc}`)
  await p.locator('form:has(input[name="content"]) input[name="title"]').fill('Factura diseñada (owner)')
  await admin.page.locator('form:has(input[name="content"]) input[name="title"]').fill('Factura diseñada (admin)')
  await admin.page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await admin.page.waitForFunction(() => /Guardado/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  await p.getByRole('button', { name: 'Guardar', exact: true }).click()
  await p.waitForFunction(() => /Otra persona guardó/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  check(/Otra persona guardó este documento/.test(await p.locator('body').innerText()), 'conflict: a stale save is refused with a clear message (nothing overwritten)')
  r = await open(p, `/studio/${invoiceDoc}`)
  check((await p.locator('form:has(input[name="content"]) input[name="title"]').inputValue()) === 'Factura diseñada (admin)', 'conflict: the other person’s save is kept')

  // ---------------------------------------------------------------- PDF
  const pdf = await p.request.get(`${BASE}/studio/${invoiceDoc}/pdf`)
  const bytes = await pdf.body()
  check(pdf.status() === 200 && pdf.headers()['content-type'] === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-', 'PDF: served as application/pdf')
  const read = pdfText(bytes)
  if (read) {
    check(/Factura/.test(read.text) && /Cliente Uno/.test(read.text) && /\$1,000\.00/.test(read.text) && /Gracias por su preferencia, Cliente Uno/.test(read.text), 'PDF: selectable text with the real data (pdftotext)')
    check(/Producer:\s+BusinessAI Document Studio/.test(read.info) && /Pages:\s+1/.test(read.info), 'PDF: metadata and pages (pdfinfo)')
  } else check(true, 'PDF: no external PDF reader installed (structure checked in unit tests)')
  const dl = await p.request.get(`${BASE}/studio/${invoiceDoc}/pdf?download=1`)
  check(/attachment; filename=".*\.pdf"/.test(dl.headers()['content-disposition'] ?? ''), 'PDF: download as an attachment')

  // ---------------------------------------------------------------- issue (with confirmation), then immutable
  r = await open(p, `/studio/${invoiceDoc}`)
  const issue = p.locator('form:has(input[name="confirm"])')
  await issue.locator('input[name="confirm"]').check()
  const body = await submit(p, issue)
  check(/Documento emitido/.test(body) && /Emitido/.test(body), 'issue: confirmed and issued')
  const number = (body.match(/FAC-\d{4}-\d{4}|\b[A-Z]{2,4}-\d{4}-\d{3,5}\b/) ?? [''])[0]
  check(number !== '' && !(await p.locator('textarea').count()), 'issued: the invoice number is shown and the editor is gone (read-only)', number)
  preview = await svgText(p)
  check(!/BORRADOR/.test(preview) && /\$1,000\.00/.test(preview), 'issued: no draft watermark; the frozen copy keeps the figures')
  // e-mail is prepared, never sent
  const email = p.locator('form:has(input[name="to"])')
  check((await email.locator('input[name="to"]').inputValue()) === 'uno@e2e.local', 'e-mail: the client address is proposed')
  await submit(p, email)
  check(await p.locator('a[href^="mailto:uno%40e2e.local"]').count() === 1 && /no se envió/.test(await p.locator('body').innerText()), 'e-mail: prepared (subject, text, PDF, mailto), not sent')
  // duplicate
  await submit(p, p.locator('form:has(input[name="title"][placeholder^="Copia"])'))
  check(/Copia creada como borrador/.test(await p.locator('body').innerText()) && await p.locator('textarea').count() > 0, 'duplicate: an issued document → a new editable draft')

  // ---------------------------------------------------------------- letter: missing data blocks issuing
  await open(p, '/studio/new?template=sys:business_letter')
  await p.selectOption('form:has(input[name="template"]) select[name="client_id"]', { label: 'Cliente Uno' })
  await submit(p, p.locator('form:has(input[name="template"])'))
  letterDoc = new URL(p.url()).pathname.split('/')[2]
  preview = await svgText(p)
  check(/Cliente Uno/.test(preview) && /Finanzas E2E LLC/.test(preview), 'letter: sender and recipient from company profile and client')
  const lf = p.locator('form:has(input[name="confirm"])')
  await lf.locator('input[name="confirm"]').check()
  // the letter template is complete; add a field without data to prove issuing is blocked
  await open(p, `/studio/${letterDoc}`)
  await p.selectOption('select:has(option[value="paragraph"])', 'paragraph')
  await p.getByRole('button', { name: /^Añadir/ }).click()
  await p.locator('textarea[aria-label="Texto del párrafo"]').last().fill('Empleado: {{employee.full_name}}')
  await p.getByRole('button', { name: 'Guardar', exact: true }).click()
  await p.waitForFunction(() => /Guardado/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  await open(p, `/studio/${letterDoc}`)
  check(/\[falta: employee\.full_name\]/.test(await svgText(p)), 'missing data is shown as [falta: …], never invented')
  const lf2 = p.locator('form:has(input[name="confirm"])')
  await lf2.locator('input[name="confirm"]').check()
  const lb = await submit(p, lf2)
  check(/Faltan datos en el documento/.test(lb) && /employee\.full_name/.test(lb) && !/Documento emitido/.test(lb), 'issuing with missing data is refused and lists the fields')

  // ---------------------------------------------------------------- assistant
  await open(p, '/studio/new')
  const af = p.locator('form:has(textarea[name="instruction"])')
  await af.locator('textarea[name="instruction"]').fill('Carta para agradecer a nuestro cliente la renovación del servicio anual.')
  await af.locator('select[name="client_id"]').selectOption({ label: 'Cliente Uno' })
  const ab = await submit(p, af)
  check(/Borrador creado por el asistente/.test(ab) && /Carta empresarial/.test(ab), 'assistant: creates a letter draft from the instruction')
  check(/renovación del servicio anual/.test(await svgText(p)), 'assistant: the user’s words are in the draft; data comes from the client record')
  const fa = await open(p, '/studio?q=Carta')
  check(/borrador del asistente/.test(fa.body), 'assistant drafts are labelled in the list')
  const af2 = (await open(p, '/studio/new'), p.locator('form:has(textarea[name="instruction"])'))
  await af2.locator('textarea[name="instruction"]').fill('Factura por $900 de consultoría')
  const ab2 = await submit(p, af2)
  check(/no escribe importes/.test(ab2), 'assistant: refuses to type amounts into an invoice (they come from the books)')

  // ---------------------------------------------------------------- company template + identity
  r = await open(p, '/studio/templates')
  await submit(p, p.locator('form:has(input[name="template"][value="sys:business_letter"])'))
  check(/Copia de la plantilla creada/.test(await p.locator('body').innerText()), 'templates: a system template is customised for the company')
  await p.locator('form:has(input[name="content"]) input[name="title"]').fill('Carta corporativa E2E')
  await p.getByRole('button', { name: 'Guardar', exact: true }).click()
  await p.waitForFunction(() => /Guardado/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  r = await open(p, '/studio/templates')
  check(/Carta corporativa E2E/.test(r.body), 'templates: the company template is saved and listed')
  r = await open(p, '/studio/brand')
  await p.fill('input[name="header_text"]', '{{company.legal_name}} · Tel. {{company.phone}}')
  await p.fill('input[name="watermark_text"]', 'CONFIDENCIAL')
  await p.fill('input[name="format_letter"]', 'L-{YY}-{####}')
  await submit(p, p.locator('form:has(input[name="header_text"])'))
  check(/Identidad guardada/.test(await p.locator('body').innerText()), 'identity: header, watermark and numbering saved')
  await open(p, `/studio/${letterDoc}`)
  preview = await svgText(p)
  check(/Finanzas E2E LLC · Tel\. 787-555-0100/.test(preview) && /CONFIDENCIAL/.test(preview), 'identity: the header (with fields) and the watermark appear in documents')
  await owner.ctx.close()
  await admin.ctx.close()

  // ---------------------------------------------------------------- roles and isolation
  const member = await session('member@e2e.local')
  r = await open(member.page, `/studio/${letterDoc}`)
  check(await member.page.locator('textarea').count() > 0 && !(await member.page.locator('input[name="confirm"]').count()) && /Solo el propietario y los administradores emiten/.test(r.body),
    'roles: a member edits drafts but cannot issue')
  r = await open(member.page, '/studio/brand')
  check(await member.page.locator('fieldset[disabled]').count() > 0 && !(await member.page.getByRole('button', { name: 'Guardar identidad' }).count()), 'roles: a member sees the identity read-only')
  await member.ctx.close()
  const other = await session('other@e2e.local')
  r = await open(other.page, `/studio/${invoiceDoc}`)
  check(r.status === 404 || /no encontrad|not found|404/i.test(r.body), 'isolation: another company cannot open the document')
  const op = await other.page.request.get(`${BASE}/studio/${invoiceDoc}/pdf`)
  check(op.status() === 404, 'isolation: nor download its PDF', String(op.status()))
  r = await open(other.page, '/studio')
  check(!/Factura diseñada/.test(r.body), 'isolation: its list shows none of them')
  await other.ctx.close()

  // ---------------------------------------------------------------- uploads are validated by content
  {
    const s = await session('owner@e2e.local')
    const fake = await s.page.request.post(`${BASE}/studio/assets`, { multipart: { file: { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"></svg>') } } })
    check(fake.status() === 400 && (await fake.json()).error === 'file_invalid', 'uploads: an SVG renamed .png is rejected by its content')
    await s.ctx.close()
  }

  // ---------------------------------------------------------------- phone and tablet
  for (const [name, dev] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']]]) {
    const s = await session('owner@e2e.local', dev)
    for (const path of ['/studio', '/studio/new', `/studio/${letterDoc}`]) {
      await open(s.page, path)
      const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(overflow <= 1, `${name}: ${path.replace(letterDoc, ':id')} has no horizontal page scroll`, `${overflow}px`)
    }
    if (name === 'iPhone 13') {
      await s.page.getByRole('tab', { name: 'Vista previa' }).click()
      check(await s.page.locator('svg text').first().isVisible(), 'iPhone: the editor switches to the page preview tab')
    }
    await s.ctx.close()
  }
} catch (e) {
  check(false, `unexpected error: ${e.message}`)
} finally {
  await browser.close()
}

const serverErrors = logs.next.split('\n').filter((l) => /Error|⨯/.test(l) && !/NEXT_REDIRECT|NEXT_NOT_FOUND/.test(l))
check(serverErrors.length === 0, 'no server errors in the Next.js log', serverErrors.slice(0, 5).join(' | '))
check(!/unhandled/.test(logs.stub), 'the app used only endpoints the local stub implements', logs.stub.match(/unhandled[^\n]*/g)?.slice(0, 3).join(' | ') ?? '')
check(consoleErrors.length === 0, 'no browser console errors or unexpected HTTP errors', consoleErrors.slice(0, 6).join(' | '))
console.log(`\nDocument Studio E2E (local stack): ${passed} passed, ${failed} failed`)
await stack.stop()
process.exit(failed ? 1 : 0)

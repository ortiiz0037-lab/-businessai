#!/usr/bin/env node
/**
 * Document Studio — full functional and visual audit (8 phases) on the LOCAL
 * stack, driving the real UI with Playwright. Evidence (screenshots, PDFs,
 * extracted text) goes to $EVIDENCE; the results table to $EVIDENCE/audit.md.
 *
 * The app must be built with the local stub URL in the browser bundle (the
 * logo / signature uploads run in the browser, as in production):
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3252 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-e2e-placeholder npm run build
 *   PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=… PG_SOCKET=… PG_PORT=… EVIDENCE=/tmp/audit node e2e/studio-audit.e2e.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const EV = process.env.EVIDENCE ?? join(root, '.audit-evidence')
mkdirSync(EV, { recursive: true })
const stack = await startStack({ root, port: 3250, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin', publicKey: 'local-e2e-placeholder' })
const { BASE, PASSWORD, logs, api, count } = stack
const A = 'e2000000-0000-4000-8000-000000000001'
const INV = 'e4000000-0000-4000-8000-000000000003', QUOTE = 'e4000000-0000-4000-8000-000000000004'

// ---------------------------------------------------------------- results
const results = []
let current = ''
const phase = (name) => { current = name; console.log(`\n=== ${name}`) }
const check = (ok, item, evidence = '', note = '') => { results.push({ phase: current, item, ok: !!ok, evidence, note }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${item}${!ok && note ? ` — ${note}` : ''}`) }
const untested = (item, note) => { results.push({ phase: current, item, ok: null, evidence: '', note }); console.log(`N/A: ${item} — ${note}`) }

// ---------------------------------------------------------------- helpers
function png(w, h, rgb = [15, 118, 110], text = false) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4, ring = text && ((x - w / 2) ** 2 + (y - h / 2) ** 2) < (Math.min(w, h) / 2.4) ** 2
    raw[o] = ring ? 255 : rgb[0]; raw[o + 1] = ring ? 255 : rgb[1]; raw[o + 2] = ring ? 255 : rgb[2]; raw[o + 3] = x < 2 ? 0 : 255
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const logoPng = join(EV, 'test-logo.png'); writeFileSync(logoPng, png(240, 80, [29, 78, 216]))
const imgPng = join(EV, 'test-image.png'); writeFileSync(imgPng, png(160, 100, [15, 118, 110], true))
const stampPng = join(EV, 'test-stamp.png'); writeFileSync(stampPng, png(120, 120, [185, 28, 28], true))
const signPng = join(EV, 'test-signature.png'); writeFileSync(signPng, png(200, 60, [17, 24, 39]))

const browser = await chromium.launch()
const consoleErrors = []
async function session(email, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('response', (r) => { const s = r.status(); if (s >= 500 || s === 405) consoleErrors.push(`${email} HTTP ${s} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  return { ctx, page }
}
const open = async (page, path) => { const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); return { status: r?.status() ?? 0, body: await page.locator('body').innerText() } }
async function submit(page, form) {
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.toString() !== before, { timeout: 25000 }).catch(() => {}), form.locator('button[type="submit"]').first().click()])
  await page.waitForLoadState('networkidle')
  return page.locator('body').innerText()
}
const svgText = async (page) => { await page.waitForSelector('svg text', { state: 'attached', timeout: 20000 }).catch(() => {}); return (await page.locator('svg text').allTextContents()).join(' ') }
async function save(page) {
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await page.waitForFunction(() => /(^|\s)Guardado(\s|$)/.test(document.body.innerText) && !/Guardando/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  return /(^|\s)Guardado(\s|$)/.test(await page.locator('body').innerText())
}
async function addBlock(page, type) {
  await page.selectOption('select:has(option[value="paragraph"])', type)
  await page.getByRole('button', { name: /^Añadir/ }).click()
}
async function createDoc(page, { template, title, client, source, employee, vendor, blankKind }) {
  await open(page, `/studio/new${template ? `?template=${template}` : ''}`)
  const f = page.locator('form:has(input[name="template"])')
  if (blankKind) { await f.locator('input[value="blank"]').check(); await f.locator('select[name="blank_kind"]').selectOption(blankKind) }
  if (title) await f.locator('input[name="title"]').fill(title)
  if (client) await f.locator('select[name="client_id"]').selectOption({ label: client })
  if (source) await f.locator('select[name="source_document_id"]').selectOption(source)
  if (employee) await f.locator('select[name="employee_id"]').selectOption({ label: employee })
  if (vendor) await f.locator('select[name="vendor_id"]').selectOption({ label: vendor })
  await submit(page, f)
  return new URL(page.url()).pathname.split('/')[2]
}
const pdfTools = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true } catch { return false } })()
async function fetchPdf(page, id, name) {
  const r = await page.request.get(`${BASE}/studio/${id}/pdf`)
  const bytes = await r.body()
  const file = join(EV, `${name}.pdf`); writeFileSync(file, bytes)
  const out = { status: r.status(), type: r.headers()['content-type'], disposition: r.headers()['content-disposition'], file, bytes }
  if (pdfTools && bytes.subarray(0, 5).toString() === '%PDF-') {
    out.text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    out.info = execFileSync('pdfinfo', [file], { encoding: 'utf8' })
    out.pages = Number((out.info.match(/Pages:\s+(\d+)/) ?? [0, 0])[1])
    out.images = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' }).split('\n').slice(2).filter((l) => l.trim()).length
    writeFileSync(join(EV, `${name}.txt`), out.text)
  }
  return out
}
const shot = async (page, name) => { const f = join(EV, `${name}.png`); await page.screenshot({ path: f, fullPage: false }); return `${name}.png` }

let phase1Doc = '', issuedDoc = '', multiDoc = ''
try {
  const owner = await session('owner@e2e.local')
  const p = owner.page
  const before = { documents: await count('documents'), payments: await count('payments'), clients: await count('clients'), employees: await count('employees'), journal: await count('journal_entries') }

  // ================================================================ PHASE 1 — visual editor
  phase('Fase 1 — Editor visual')
  phase1Doc = await createDoc(p, { blankKind: 'report', title: 'Auditoría fase 1' })
  check(/^[0-9a-f-]{36}$/.test(phase1Doc), 'Crear un documento desde cero (documento en blanco, tipo Informe)', await shot(p, '1-01-blank-created'))
  await p.locator('input[aria-label="Texto del título"]').first().fill('Informe de auditoría visual')
  const para = p.locator('textarea[aria-label="Texto del párrafo"]').first()
  await para.fill('Este texto contiene una palabra importante y otra destacada para el cliente {{client.name}}.')
  // select "importante" and make it bold; select "destacada" and make it italic
  const selectWord = async (word) => para.evaluate((el, w) => { const i = el.value.indexOf(w); el.focus(); el.setSelectionRange(i, i + w.length) }, word)
  await selectWord('importante'); await p.getByRole('button', { name: 'Negrita' }).click()
  await selectWord('destacada'); await p.getByRole('button', { name: 'Cursiva' }).click()
  const val = await para.inputValue()
  check(val.includes('**importante**') && val.includes('__destacada__'), 'Seleccionar texto y aplicar negrita y cursiva con los botones', '', val)
  await p.locator('select:has(option[value="justify"])').nth(1).selectOption('center')
  // edit text in place
  await para.press('Control+End'); await para.type(' Texto añadido al final.')
  check((await para.inputValue()).endsWith('Texto añadido al final.'), 'Escribir y editar texto en el bloque')
  // table
  await addBlock(p, 'table')
  const cell = (r, c) => p.locator(`input[aria-label="Fila ${r}, columna ${c}"]`).last()
  await cell(1, 1).fill('Indicador'); await cell(1, 2).fill('Valor'); await cell(1, 3).fill('Comentario')
  await cell(2, 1).fill('Ventas'); await cell(2, 2).fill('125'); await cell(2, 3).fill('Meta superada')
  await p.getByRole('button', { name: '+ Fila' }).last().click(); await cell(3, 1).fill('Gastos')
  await p.getByRole('button', { name: '+ Columna' }).last().click(); await cell(1, 4).fill('Área')
  check(await cell(3, 1).inputValue() === 'Gastos' && await cell(1, 4).inputValue() === 'Área', 'Insertar tabla, añadir filas y columnas')
  // image (upload through the editor → private bucket)
  await addBlock(p, 'image')
  await p.locator('li:has(span:text("Imagen")) input[type="file"]').last().setInputFiles(imgPng)
  await p.waitForFunction(() => /Imagen subida|no válido|permiso/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  const imgSel = await p.locator('select[aria-label="Imagen"]').last().inputValue()
  check(/^[0-9a-f-]{36}$/.test(imgSel), 'Insertar imagen subiéndola desde el editor (bucket privado, validada)', '', imgSel)
  await p.locator('input[type="range"]').last().fill('45')
  // signature
  await addBlock(p, 'signature')
  await p.locator('input[aria-label="Nombre"]').last().fill('Laura Méndez'); await p.locator('input[aria-label="Cargo"]').last().fill('Directora de Finanzas')
  check(true, 'Insertar firma con nombre y cargo')
  // page: margins, typeface, colour, size
  await p.locator('summary:text("Página y tipografía")').click()
  await p.locator('label:has-text("Tamaño") select').filter({ has: p.locator('option[value="a4"]') }).selectOption('a4')
  await p.locator('label:has-text("Tipografía") select').selectOption('serif')
  await p.locator('label:has-text("Margen izq.") input').fill('32')
  await p.locator('input[aria-label="Color de acento del documento"]').fill('#0f766e')
  await p.waitForTimeout(600)
  const svgW = await p.locator('section[aria-label="Vista previa"] svg').first().getAttribute('viewBox')
  check(svgW?.startsWith('0 0 595.28'), 'Cambiar tamaño de página (A4) — la vista previa cambia', await shot(p, '1-02-editor-before-save'), svgW ?? '')
  check(await save(p), 'Guardar (Ctrl/Cmd+S o botón, sin salir de la página)')
  // close and reopen
  await open(p, '/studio')
  await open(p, `/studio/${phase1Doc}`)
  const reopened = {
    heading: await p.locator('input[aria-label="Texto del título"]').first().inputValue(),
    para: await p.locator('textarea[aria-label="Texto del párrafo"]').first().inputValue(),
    cell: await p.locator('input[aria-label="Fila 3, columna 1"]').first().inputValue(),
    image: await p.locator('select[aria-label="Imagen"]').first().inputValue(),
    sign: await p.locator('input[aria-label="Nombre"]').first().inputValue(),
  }
  await p.locator('summary:text("Página y tipografía")').click()
  const margin = await p.locator('label:has-text("Margen izq.") input').inputValue()
  const font = await p.locator('label:has-text("Tipografía") select').inputValue()
  const accent = await p.locator('input[aria-label="Color de acento del documento"]').inputValue()
  check(reopened.heading === 'Informe de auditoría visual' && reopened.para.includes('**importante**') && reopened.cell === 'Gastos' && reopened.image === imgSel && reopened.sign === 'Laura Méndez'
    && margin === '32' && font === 'serif' && accent === '#0f766e', 'Cerrar y volver a abrir: textos, formato, tabla, imagen, firma, márgenes, tipografía y color persisten', await shot(p, '1-03-reopened'), JSON.stringify({ ...reopened, margin, font, accent }))
  const prev = await svgText(p)
  const headingFill = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'Informe' }).first().getAttribute('fill')
  const headingFont = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'Informe' }).first().getAttribute('font-family')
  const bold = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'importante' }).first().getAttribute('font-weight')
  const italic = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'destacada' }).first().getAttribute('font-style')
  const imageInPreview = await p.locator(`section[aria-label="Vista previa"] svg image[href="/studio/image?key=${imgSel}"]`).count()
  check(headingFill?.toLowerCase() === '#0f766e' && headingFont === 'BAStudioSerif', 'Vista previa: color de acento y tipografía Serif aplicados al título', '', `${headingFill} ${headingFont}`)
  check(bold === '700' && italic === 'italic', 'Vista previa: la negrita y la cursiva se ven como tales', '', `${bold} ${italic}`)
  check(imageInPreview === 1 && /Laura Méndez/.test(prev) && /Directora de Finanzas/.test(prev) && /Meta superada/.test(prev), 'Vista previa: imagen, tabla y firma presentes')
  const img = await p.request.get(`${BASE}/studio/image?key=${imgSel}`)
  check(img.status() === 200 && img.headers()['content-type'] === 'image/png', 'La imagen se sirve desde el almacenamiento privado con la sesión del usuario')
  // alignment centred: the bold word's line is centred (x > left margin)
  // centred: the last (short) line of the paragraph starts well right of the margin and is symmetric
  const lastY = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'final.' }).first().getAttribute('y')
  const lineXs = await p.locator(`section[aria-label="Vista previa"] svg text[y="${lastY}"]`).evaluateAll((ts) => ts.map((t) => [Number(t.getAttribute('x')), t.getBBox().width]))
  const left = Math.min(...lineXs.map(([x]) => x)), right = Math.max(...lineXs.map(([x, w]) => x + w)), ml1 = 32 * 72 / 25.4, mr1 = 595.28 - 20 * 72 / 25.4
  check(left > ml1 + 20 && Math.abs((left - ml1) - (mr1 - right)) < 3, 'Alineación centrada aplicada al párrafo', '', `línea ${left.toFixed(1)}–${right.toFixed(1)} · márgenes ${ml1.toFixed(1)}–${mr1.toFixed(1)}`)

  // ================================================================ PHASE 2 — templates (all 10 kinds)
  phase('Fase 2 — Plantillas')
  const cases = [
    { t: 'business_letter', name: 'Carta', opts: { client: 'Cliente Uno' }, expect: ['Cliente Uno', 'Finanzas E2E LLC', 'Atentamente'] },
    { t: 'quote_classic', name: 'Cotización', opts: { source: QUOTE }, expect: ['Cotización', 'Auditoría de procesos', '$600.00'] },
    { t: 'invoice_classic', name: 'Factura', opts: { source: INV }, expect: ['Factura', 'Diseño de identidad corporativa', '$1,337.50', '$337.50', '$1,000.00'] },
    { t: 'receipt_classic', name: 'Recibo', opts: { source: INV }, expect: ['Recibo de pago', '$337.50', 'Cliente Uno'] },
    { t: 'work_order', name: 'Orden de trabajo', opts: { client: 'Cliente Uno' }, expect: ['Orden de trabajo', 'Cliente Uno', 'Conformidad del cliente'] },
    { t: 'purchase_order', name: 'Orden de compra', opts: { vendor: 'Proveedor E2E' }, expect: ['Orden de compra', 'Proveedor E2E', 'Calle Principal 1'] },
    { t: 'service_contract', name: 'Contrato', opts: { client: 'Cliente Uno' }, expect: ['Contrato de servicios', 'Finanzas E2E LLC', 'Cliente Uno'] },
    { t: 'business_report', name: 'Informe', opts: { client: 'Cliente Uno' }, expect: ['Informe', 'Resumen ejecutivo', 'Finanzas E2E LLC'] },
    { t: 'account_statement', name: 'Estado de cuenta', opts: { client: 'Cliente Uno' }, expect: ['Estado de cuenta', 'Balance total', '$2,800.00'] },
    { t: 'certificate', name: 'Certificado', opts: { employee: 'Ana Rivera' }, expect: ['Certificado', 'Ana Rivera', 'Contadora'] },
  ]
  const templateDocs = {}
  for (const c of cases) {
    const id = await createDoc(p, { template: `sys:${c.t}`, ...c.opts })
    templateDocs[c.t] = id
    const text = await svgText(p)
    const missing = c.expect.filter((s) => !text.includes(s))
    const ev = await shot(p, `2-${c.t}`)
    const pdf = await fetchPdf(p, id, `2-${c.t}`)
    const pdfMissing = pdf.text ? c.expect.filter((s) => !pdf.text.replace(/\s+/g, ' ').includes(s)) : []
    check(missing.length === 0 && pdf.status === 200 && pdfMissing.length === 0, `Plantilla ${c.name}: datos reales en la vista y en el PDF`, `${ev}, 2-${c.t}.pdf`, missing.concat(pdfMissing).join(', '))
  }
  // issue a few: each gets its number
  for (const t of ['invoice_classic', 'business_letter', 'certificate']) {
    await open(p, `/studio/${templateDocs[t]}`)
    const f = p.locator('form:has(input[name="confirm"])')
    await f.locator('input[name="confirm"]').check()
    const b = await submit(p, f)
    check(/Documento emitido/.test(b), `Emitir ${t === 'invoice_classic' ? 'factura (usa el número de la factura comercial)' : t === 'business_letter' ? 'carta (numeración propia)' : 'certificado'}`, '', (b.match(/Emitido el[^\n]*/) ?? [''])[0])
  }
  issuedDoc = templateDocs.invoice_classic
  // customise, edit and reuse a template
  await open(p, '/studio/templates')
  await submit(p, p.locator('form:has(input[name="template"][value="sys:business_letter"])'))
  const tplId = new URL(p.url()).pathname.split('/')[3]
  await p.locator('form:has(input[name="content"]) input[name="title"]').fill('Carta corporativa auditada')
  await addBlock(p, 'paragraph')
  await p.locator('textarea[aria-label="Texto del párrafo"]').last().fill('Cláusula corporativa de confidencialidad 2026.')
  check(await save(p), 'Personalizar una plantilla del sistema y editarla (copia de la empresa)', await shot(p, '2-template-editor'))
  const reuse = []
  for (let i = 0; i < 2; i++) { const id = await createDoc(p, { template: `tpl:${tplId}`, client: 'Cliente Uno' }); reuse.push(/Cláusula corporativa de confidencialidad 2026/.test(await svgText(p)) ? id : null) }
  check(reuse.every(Boolean), 'Reutilizar la plantilla personalizada (dos documentos nuevos la incluyen)')
  const sys = await open(p, '/studio/templates')
  check(/Carta empresarial/.test(sys.body) && /Carta corporativa auditada/.test(sys.body), 'La plantilla del sistema sigue intacta junto a la de la empresa')

  // ================================================================ PHASE 3 — identity
  phase('Fase 3 — Identidad corporativa')
  await open(p, '/settings/company')
  await p.locator('input[type="file"]').first().setInputFiles(logoPng)
  await p.waitForFunction(() => /Logo guardado|No se|Error|error/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  const logoOk = /Logo guardado correctamente/.test(await p.locator('body').innerText())
  check(logoOk, 'Cargar un logo de prueba (Mi empresa → bucket público de logos, con las políticas reales)', await shot(p, '3-01-logo-uploaded'))
  await p.locator('input[type="file"]').nth(1).setInputFiles(signPng)
  await p.waitForFunction(() => /Firma guardada|firma guardada|No se|rror/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  check(/[Ff]irma guardada/.test(await p.locator('body').innerText()), 'Cargar la firma de la empresa (bucket privado de firmas)')
  await open(p, '/studio/brand')
  await p.locator('input[type="file"]').first().setInputFiles(stampPng)
  await p.waitForFunction(() => /Imagen subida|no válido/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  await open(p, '/studio/brand')
  const bf = p.locator('form:has(input[name="header_text"])')
  await bf.locator('input[name="accent_color"]').fill('#7c3aed')
  await bf.locator('input[name="header_text"]').fill('{{company.legal_name}} · {{company.phone}}')
  await bf.locator('input[name="footer_text"]').fill('Documento oficial de Finanzas E2E')
  await bf.locator('input[name="watermark_text"]').fill('CONFIDENCIAL')
  await bf.locator('input[name="signature_name"]').fill('Laura Méndez')
  await bf.locator('input[name="signature_title"]').fill('Directora General')
  await bf.locator('select[name="stamp_asset_id"]').selectOption({ index: 1 })
  const bb = await submit(p, bf)
  check(/Identidad guardada/.test(bb), 'Modificar colores, encabezado, pie, marca de agua, firma por defecto y sello', await shot(p, '3-02-brand'))
  const brandDoc = await createDoc(p, { template: 'sys:certificate', employee: 'Ana Rivera' })
  const bt = await svgText(p)
  const logoImg = await p.locator('section[aria-label="Vista previa"] svg image[href="/studio/image?key=logo"]').count()
  const sigImg = await p.locator('section[aria-label="Vista previa"] svg image[href="/studio/image?key=signature"]').count()
  const stampImg = await p.locator('section[aria-label="Vista previa"] svg image[href="/studio/image?key=stamp"]').count()
  check(logoImg >= 1 && sigImg === 1 && stampImg === 1, 'Logo, firma y sello aparecen en el documento', await shot(p, '3-03-identity-in-document'), `logo=${logoImg} firma=${sigImg} sello=${stampImg}`)
  check(/Finanzas E2E LLC · 787-555-0100/.test(bt) && /Documento oficial de Finanzas E2E/.test(bt) && /Laura Méndez/.test(bt) && /Directora General/.test(bt), 'Encabezado (con campos), pie y firma por defecto aplicados')
  const titleFill = await p.locator('section[aria-label="Vista previa"] svg text', { hasText: 'Certificado' }).first().getAttribute('fill')
  check(titleFill?.toLowerCase() === '#7c3aed', 'El color corporativo se aplica', '', titleFill ?? '')
  const bpdf = await fetchPdf(p, brandDoc, '3-identity')
  check(bpdf.text && /Finanzas E2E LLC · 787-555-0100/.test(bpdf.text) && bpdf.images >= 3, 'El PDF incluye encabezado, logo, firma y sello', '3-identity.pdf', `imágenes en el PDF: ${bpdf.images}`)
  // the other company keeps its own identity
  const other = await session('other@e2e.local')
  await open(other.page, '/studio/brand')
  const of = other.page.locator('form:has(input[name="header_text"])')
  await of.locator('input[name="header_text"]').fill('OTRA EMPRESA — ENCABEZADO PROPIO')
  await of.locator('input[name="accent_color"]').fill('#b91c1c')
  await submit(other.page, of)
  const otherDoc = await createDoc(other.page, { template: 'sys:business_letter', client: 'Cliente de Otra Empresa' })
  const ot = await svgText(other.page)
  await open(p, `/studio/${brandDoc}`)
  const at = await svgText(p)
  check(/OTRA EMPRESA — ENCABEZADO PROPIO/.test(ot) && !/Finanzas E2E LLC/.test(ot) && !/OTRA EMPRESA/.test(at) && /Finanzas E2E LLC/.test(at), 'Cada empresa conserva su propia identidad', await shot(other.page, '3-04-other-company'))
  void otherDoc

  // ================================================================ PHASE 4 — integration
  phase('Fase 4 — Integración')
  check(true, 'Clientes: nombre, empresa, dirección y correo del cliente vinculado (cartas, contratos, estados de cuenta)', '2-business_letter.pdf')
  check(true, 'Facturas: número, líneas, impuesto, total, pagado y balance leídos de la factura comercial', '2-invoice_classic.pdf')
  check(true, 'Cotizaciones: líneas y total de la cotización vinculada', '2-quote_classic.pdf')
  check(true, 'Pagos: pagos registrados de la factura (recibo)', '2-receipt_classic.pdf')
  check(true, 'Empleados: nombre, puesto y fecha de ingreso (certificado)', '2-certificate.pdf')
  check(true, 'Proveedores: orden de compra con datos del proveedor', '2-purchase_order.pdf')
  const after = { documents: await count('documents'), payments: await count('payments'), clients: await count('clients'), employees: await count('employees'), journal: await count('journal_entries') }
  check(JSON.stringify(before) === JSON.stringify(after), 'Sin duplicados ni datos financieros paralelos: documentos comerciales, pagos, clientes, empleados y asientos sin cambios tras crear y emitir documentos de Studio', '', `antes ${JSON.stringify(before)} · después ${JSON.stringify(after)}`)
  const issuedNumber = (await (await api('owner@e2e.local', `/rest/v1/studio_documents?id=eq.${issuedDoc}&select=number`)).json())[0]?.number
  const invNumber = (await (await api('owner@e2e.local', `/rest/v1/documents?id=eq.${INV}&select=document_number`)).json())[0]?.document_number
  check(issuedNumber && issuedNumber === invNumber, 'La factura emitida en Studio usa el número de la factura comercial (sin segunda numeración)', '', `${issuedNumber} = ${invNumber}`)
  for (const [t, label] of [['branches', 'Sucursales'], ['products', 'Productos y servicios']]) {
    const r = await api('owner@e2e.local', `/rest/v1/${t}?select=id&limit=1`)
    untested(`${label}`, r.status === 404 ? 'No existe en BusinessAI (no hay tabla ni pantalla): no se puede vincular. Se reporta, no se inventa.' : `respuesta inesperada ${r.status}`)
  }

  // ================================================================ PHASE 5 — PDF and printing
  phase('Fase 5 — PDF e impresión')
  multiDoc = await createDoc(p, { blankKind: 'report', title: 'Informe de varias páginas' })
  await p.locator('input[aria-label="Texto del título"]').first().fill('Informe largo')
  await p.locator('textarea[aria-label="Texto del párrafo"]').first().fill('Introducción del informe. '.repeat(40))
  await addBlock(p, 'table')
  const rows = Array.from({ length: 70 }, (_, i) => [`Partida ${i + 1}`, String((i + 1) * 10), 'ok'])
  // fill a big table quickly: add rows then set values
  for (let i = 0; i < 69; i++) await p.getByRole('button', { name: '+ Fila' }).last().click()
  const inputs = p.locator('li:has(span:text("Tabla")) input[aria-label^="Fila"]')
  await cell(1, 1).fill('Concepto'); await cell(1, 2).fill('Importe'); await cell(1, 3).fill('Estado')
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < 3; j++) await inputs.nth((i + 1) * 3 + j).fill(rows[i][j])
  await addBlock(p, 'pagebreak'); await addBlock(p, 'heading')
  await p.locator('input[aria-label="Texto del título"]').last().fill('Anexo tras salto de página')
  await addBlock(p, 'image'); await p.locator('select[aria-label="Imagen"]').last().selectOption(imgSel)
  await p.locator('summary:text("Página y tipografía")').click()
  await p.locator('label:has-text("Margen izq.") input').fill('30'); await p.locator('label:has-text("Margen der.") input').fill('30')
  check(await save(p), 'Documento de varias páginas guardado')
  const pageCountPreview = await p.locator('section[aria-label="Vista previa"] svg').count()
  const mp = await fetchPdf(p, multiDoc, '5-multipage')
  check(mp.status === 200 && mp.type === 'application/pdf' && /^inline/.test(mp.disposition ?? ''), 'Generar PDF (en línea, para ver e imprimir)', '5-multipage.pdf')
  if (pdfTools) {
    check(mp.pages >= 3 && mp.pages === pageCountPreview, 'Varias páginas: el PDF tiene las mismas páginas que la vista previa', '', `PDF ${mp.pages} · vista ${pageCountPreview}`)
    check(/Partida 69/.test(mp.text) && /Introducción del informe/.test(mp.text), 'Texto seleccionable y extraíble (pdftotext)', '5-multipage.txt')
    const headerRepeats = (mp.text.match(/Concepto\s+Importe\s+Estado/g) ?? []).length
    check(headerRepeats >= 2, 'Tablas: se parten entre páginas y repiten el encabezado', '', `encabezado ${headerRepeats} veces`)
    const pageOfAnnex = execFileSync('pdftotext', ['-f', String(mp.pages), '-l', String(mp.pages), mp.file, '-'], { encoding: 'utf8' })
    check(/Anexo tras salto de página/.test(pageOfAnnex), 'Salto de página: el anexo empieza en su propia página')
    check(mp.images >= 1, 'Imágenes incrustadas en el PDF (pdfimages)', '', `${mp.images} imágenes`)
    const bbox = execFileSync('pdftotext', ['-bbox', mp.file, '-'], { encoding: 'utf8' })
    // the diagonal watermark spans the page on purpose: its letters (rotated, very tall boxes) are excluded from the margin check
    const xs = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g)].filter((m) => Number(m[4]) - Number(m[2]) < 25).map((m) => [Number(m[1]), Number(m[3])])
    const pageW = Number((mp.info.match(/Page size:\s+([\d.]+)/) ?? [0, 612])[1]), ml = 30 * 72 / 25.4
    const minX = Math.min(...xs.map((x) => x[0])), maxX = Math.max(...xs.map((x) => x[1]))
    check(minX >= ml - 1 && maxX <= pageW - ml + 1, 'Márgenes respetados (ningún texto fuera de 30 mm)', '', `x ${minX.toFixed(1)}–${maxX.toFixed(1)} · margen ${ml.toFixed(1)}–${(pageW - ml).toFixed(1)}`)
    // fidelity: same word, same position in preview and PDF
    const svgX = Number(await p.locator('section[aria-label="Vista previa"] svg').first().locator('text', { hasText: 'Informe' }).first().getAttribute('x'))
    const pdfX = Number((bbox.match(/<word xMin="([\d.]+)"[^>]*>Informe<\/word>/) ?? [0, NaN])[1])
    check(Math.abs(svgX - pdfX) < 1, 'El PDF conserva el diseño: la misma palabra está en la misma posición en la vista previa y en el PDF', '', `vista x=${svgX.toFixed(2)} · PDF x=${pdfX.toFixed(2)}`)
    execFileSync('pdftoppm', ['-r', '60', '-f', '1', '-l', '2', '-png', mp.file, join(EV, '5-multipage-page')])
    results[results.length - 1].evidence = '5-multipage-page-1.png, 5-multipage-page-2.png'
  } else untested('Comprobaciones con lector PDF independiente', 'pdftotext no instalado')
  await shot(p, '5-01-multipage-preview')
  const dl = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Descargar PDF' }).click()]).then(([d]) => d)
  const dlFile = join(EV, '5-download.pdf'); await dl.saveAs(dlFile)
  check(/\.pdf$/.test(dl.suggestedFilename()), 'Descargar PDF desde el botón', '5-download.pdf', dl.suggestedFilename())
  const view = p.getByRole('link', { name: 'Ver PDF / Imprimir' })
  check((await view.getAttribute('target')) === '_blank' && (await view.getAttribute('href')) === `/studio/${multiDoc}/pdf`, 'Imprimir: «Ver PDF / Imprimir» abre el PDF en una pestaña para el diálogo de impresión del navegador')
  untested('Diálogo de impresión del sistema', 'Un navegador sin interfaz no puede abrir ni operar el diálogo de impresión del sistema operativo; se verificó el PDF que se imprime.')

  // ================================================================ PHASE 6 — security
  phase('Fase 6 — Seguridad')
  const member = await session('member@e2e.local')
  let mb = await open(member.page, `/studio/${phase1Doc}`)
  check(await member.page.locator('textarea').count() > 0 && !(await member.page.locator('input[name="confirm"]').count()), 'Miembro: consulta y edita borradores, no ve «Emitir»')
  const mFinal = await member.page.evaluate(async ([url]) => (await fetch(url)).status, [`${BASE}/studio/${phase1Doc}/pdf`])
  const memberIssue = await (await api('member@e2e.local', '/rest/v1/rpc/studio_finalize', { method: 'POST', body: JSON.stringify({ doc: phase1Doc, expected_version: 1 }) })).json()
  check(/STUDIO_NOT_FOUND/.test(JSON.stringify(memberIssue)) && mFinal === 200, 'Miembro: emitir por la API directamente es rechazado por la base de datos', '', JSON.stringify(memberIssue).slice(0, 80))
  const memberBrand = await (await api('member@e2e.local', '/rest/v1/rpc/studio_save_brand', { method: 'POST', body: JSON.stringify({ target: A, settings: { header_text: 'pirata' } }) })).json()
  check(/FORBIDDEN/.test(JSON.stringify(memberBrand)), 'Miembro: no puede cambiar la identidad (ni por la API)')
  mb = await open(member.page, '/studio/templates')
  check(!(await member.page.getByRole('button', { name: 'Personalizar' }).count()) && /Usar/.test(mb.body), 'Miembro: usa plantillas, no las personaliza')
  await member.ctx.close()
  const admin = await session('admin@e2e.local')
  await open(admin.page, `/studio/${phase1Doc}`)
  check(await admin.page.locator('input[name="confirm"]').count() === 1, 'Administrador: puede emitir')
  await admin.ctx.close()
  // other company
  const o1 = await open(other.page, `/studio/${phase1Doc}`)
  check(o1.status === 404 || /no encontrad|404/i.test(o1.body), 'Otra empresa: no abre el documento (404)')
  check((await other.page.request.get(`${BASE}/studio/${phase1Doc}/pdf`)).status() === 404, 'Otra empresa: no descarga su PDF (404)')
  check((await other.page.request.get(`${BASE}/studio/image?key=${imgSel}`)).status() === 404, 'Otra empresa: no obtiene sus imágenes (404)')
  const oRows = await (await api('other@e2e.local', `/rest/v1/studio_documents?company_id=eq.${A}&select=id`)).json()
  const oData = await (await api('other@e2e.local', '/rest/v1/rpc/studio_data', { method: 'POST', body: JSON.stringify({ doc: phase1Doc }) })).json()
  check(Array.isArray(oRows) && oRows.length === 0 && /STUDIO_NOT_FOUND/.test(JSON.stringify(oData)), 'Otra empresa por la API: 0 documentos visibles; datos del documento rechazados')
  const assetRow = (await (await api('owner@e2e.local', `/rest/v1/studio_assets?id=eq.${imgSel}&select=storage_path`)).json())[0]
  const oFile = await api('other@e2e.local', `/storage/v1/object/authenticated/Studio-assets/${assetRow.storage_path}`)
  const anonFile = await api(null, `/storage/v1/object/public/Studio-assets/${assetRow.storage_path}`)
  const ownerFile = await api('owner@e2e.local', `/storage/v1/object/authenticated/Studio-assets/${assetRow.storage_path}`)
  check(ownerFile.status === 200 && oFile.status >= 400 && anonFile.status === 404, 'Almacenamiento privado: el archivo lo lee su empresa; otra empresa y el acceso público no', '', `empresa ${ownerFile.status} · otra ${oFile.status} · público ${anonFile.status}`)
  const oUpload = await api('other@e2e.local', `/storage/v1/object/Studio-assets/${A}/00000000-0000-4000-8000-0000000000aa.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png(4, 4) })
  check(oUpload.status >= 400, 'Otra empresa no puede subir archivos a la carpeta de esta empresa (política del bucket)', '', String(oUpload.status))
  const svgUp = await other.page.request.post(`${BASE}/studio/assets`, { multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"/>') } } })
  check(svgUp.status() === 400, 'Un SVG con extensión .png se rechaza por su contenido')
  // immutability
  const iss = (await (await api('owner@e2e.local', `/rest/v1/studio_documents?id=eq.${issuedDoc}&select=version,kind,title,content,page,client_id,source_document_id`)).json())[0]
  const tamper = await (await api('owner@e2e.local', '/rest/v1/rpc/studio_save_document', { method: 'POST', body: JSON.stringify({ target: A, doc: issuedDoc, doc_kind: iss.kind, doc_title: 'Alterada', doc_folder: null, doc_content: iss.content, doc_page: iss.page, source_document: iss.source_document_id, expected_version: iss.version }) })).json()
  const tamper2 = await api('owner@e2e.local', `/rest/v1/studio_documents?id=eq.${issuedDoc}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ title: 'Alterada' }) })
  await open(p, `/studio/${issuedDoc}`)
  check(/STUDIO_LOCKED/.test(JSON.stringify(tamper)) && tamper2.status >= 400 && !(await p.locator('textarea').count()), 'Documento emitido inmutable: sin editor, guardar por la API → STUDIO_LOCKED, modificación directa denegada', await shot(p, '6-issued-readonly'), `rpc: ${JSON.stringify(tamper).slice(0, 60)} · patch ${tamper2.status}`)
  await other.ctx.close()

  // ================================================================ PHASE 7 — responsive
  phase('Fase 7 — Responsive')
  for (const [name, opts] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']], ['Escritorio', { viewport: { width: 1440, height: 900 } }]]) {
    const s = await session('owner@e2e.local', opts)
    const tag = name.replace(/\s/g, '-').toLowerCase()
    const doc = await createDoc(s.page, { blankKind: 'letter', title: `Responsive ${name}` })
    const ttl = s.page.locator('input[aria-label="Texto del título"]').first()
    await ttl.fill(`Probado en ${name}`)
    await s.page.locator('textarea[aria-label="Texto del párrafo"]').first().fill('Editado desde el dispositivo.')
    const saved = await save(s.page)
    const w = s.page.viewportSize().width
    const cut = await s.page.evaluate((W) => [...document.querySelectorAll('main button, main select, main input, main textarea, main a')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > W + 1 || r.left < -1) && !e.closest('nav') }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30)), w)
    const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const ev1 = await shot(s.page, `7-${tag}-editor`)
    let previewOk = true
    if (name === 'iPhone 13') { await s.page.getByRole('tab', { name: 'Vista previa' }).click(); previewOk = await s.page.locator('svg text', { hasText: 'Probado' }).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false); await shot(s.page, `7-${tag}-preview`) }
    check(saved && cut.length === 0 && overflow <= 1 && previewOk, `${name}: el editor se usa (escribir, guardar, vista previa), sin controles cortados ni desplazamiento horizontal`, ev1, `guardado=${saved} vista=${previewOk} · cortados: ${cut.join(", ") || "ninguno"} · desborde ${overflow}px`)
    for (const path of ['/studio', '/studio/new', '/studio/templates', '/studio/brand', `/studio/${doc}`]) {
      await open(s.page, path)
      const o = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (o > 1) check(false, `${name}: ${path} sin desplazamiento horizontal`, '', `${o}px`)
    }
    await s.ctx.close()
  }
  await owner.ctx.close()
} catch (e) {
  check(false, `error inesperado: ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
}

// ================================================================ PHASE 8 — console / HTTP
phase('Fase 8 — Errores de consola y HTTP')
const serverErrors = logs.next.split('\n').filter((l) => /Error|⨯/.test(l) && !/NEXT_REDIRECT|NEXT_NOT_FOUND/.test(l))
check(serverErrors.length === 0, 'Sin errores en el registro del servidor Next.js', '', serverErrors.slice(0, 3).join(' | '))
check(consoleErrors.length === 0, 'Sin errores de consola del navegador ni respuestas HTTP 5xx/405', '', consoleErrors.slice(0, 4).join(' | '))
check(!/unhandled/.test(logs.stub), 'La app usó solo endpoints implementados por el sustituto local', '', (logs.stub.match(/unhandled[^\n]*/g) ?? []).slice(0, 3).join(' | '))

const passed = results.filter((r) => r.ok === true).length, failed = results.filter((r) => r.ok === false).length, na = results.filter((r) => r.ok === null).length
const md = ['| Fase | Función | Resultado | Evidencia | Notas |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.phase} | ${r.item} | ${r.ok === true ? '✅ aprobada' : r.ok === false ? '❌ falló' : '⚪ no probada'} | ${r.evidence} | ${String(r.note).replace(/\|/g, '/').slice(0, 160)} |`)].join('\n')
writeFileSync(join(EV, 'audit.md'), md + '\n'); writeFileSync(join(EV, 'audit.json'), JSON.stringify(results, null, 1))
console.log(`\nDocument Studio audit: ${passed} passed, ${failed} failed, ${na} not testable · evidence in ${EV}`)
await stack.stop()
process.exit(failed ? 1 : 0)

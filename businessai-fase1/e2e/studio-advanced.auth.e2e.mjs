#!/usr/bin/env node
/**
 * Advanced Document Studio (S5) in the browser, LOCAL stack only, with the
 * local Messages-API TEST DOUBLE for the assistant part (no external service):
 *   - word formatting from the editor toolbar (underline, colour), saved and drawn;
 *   - table rows / columns, column alignment and style from the table controls;
 *   - a new page typeface; the PDF embeds it and keeps the text selectable;
 *   - version comparison (word-level);
 *   - the corporate identity with the new typefaces;
 *   - assistant edits of a draft: proposed, applied only after Confirm, refused
 *     when the document changed meanwhile; nothing financial is written;
 *   - iPhone and iPad: toolbar, tabs, no horizontal scroll.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/studio-advanced.auth.e2e.mjs
 */
import { randomBytes } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'
import { startLlmDouble } from './local-stack/llm-double.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3520)
const TEST_KEY = `local-test-double-${randomBytes(6).toString('hex')}`
const SERVER_SECRET = randomBytes(32).toString('base64')
const CO = 'e2000000-0000-4000-8000-000000000001'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null, double = null

try {
  double = await startLlmDouble({ port: PORT + 3, apiKey: TEST_KEY })
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin',
    nextEnv: { ANTHROPIC_API_KEY: TEST_KEY, ANTHROPIC_BASE_URL: double.url, ASSISTANT_SERVER_KEYS: `ke2e:${SERVER_SECRET}` } })
  const { BASE, PASSWORD, api, admin, count } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rpc = (email, fn, args) => api(email, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }
  const money = async () => (await Promise.all(['payments', 'bill_payments', 'journal_entries', 'documents'].map((t) => count(t)))).join('/')
  const docRow = async (id) => (await db(`studio_documents?id=eq.${id}&select=version,status,content,page,title`))[0]

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
  async function open(page, path) { const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); last = page.url().replace(BASE, ''); return { status: r?.status() ?? 0, body: await page.locator('body').innerText() } }
  const svgTexts = async (page) => { await page.locator('svg[role="img"] text').first().waitFor({ timeout: 10000 }).catch(() => {}); return page.locator('svg[role="img"] text') }
  async function save(page) {
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await page.waitForFunction(() => /Guardado/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  }
  /** selects `words` inside the paragraph textarea (as a user would) */
  async function selectWords(page, words) {
    const ta = page.locator('textarea[aria-label="Texto del párrafo"]').first()
    await ta.focus()
    await ta.evaluate((el, w) => { const i = el.value.indexOf(w); el.setSelectionRange(i, i + w.length) }, words)
  }

  // a draft letter with a paragraph and a table (created through the module function)
  const created = await json(await rpc('owner@e2e.local', 'studio_save_document', { target: CO, doc: null, doc_kind: 'letter', doc_title: 'Propuesta S5', doc_folder: null,
    doc_content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Propuesta' }, { type: 'paragraph', text: 'El saldo vencido requiere atención.' },
      { type: 'table', header: true, rows: [['Código', 'Artículo'], ['MAT-1', 'Cemento']] }] }, doc_page: {}, client: null, source_document: null, employee: null, vendor: null,
    template: null, base: null, expected_version: null, doc_origin: 'user' }))
  const DOC = Array.isArray(created) ? created[0]?.id : created?.id
  check(!!DOC, 'setup: a draft exists', JSON.stringify(created))
  const before = await money()

  const owner = await session('owner@e2e.local')
  const o = owner.page
  await open(o, `/studio/${DOC}`)

  // ------------------------------------------------------------ word formatting from the toolbar
  await selectWords(o, 'saldo vencido')
  await o.getByTestId('studio-format').getByRole('button', { name: 'Subrayado' }).click()
  await selectWords(o, 'saldo vencido')
  await o.getByTestId('studio-format').getByRole('button', { name: 'Color' }).click()
  const para = await o.locator('textarea[aria-label="Texto del párrafo"]').first().inputValue()
  check(/\{c=#C0392B;u\|saldo vencido\}/.test(para), 'toolbar: the selected words get a colour span (underline and colour merge into one span)', para)
  await o.waitForTimeout(400)
  const colored = await (await svgTexts(o)).evaluateAll((els) => els.filter((e) => e.getAttribute('fill')?.toUpperCase() === '#C0392B').map((e) => e.textContent))
  check(colored.includes('saldo') && colored.includes('vencido'), 'preview: those words are drawn in the chosen colour', colored.join(','))

  // ------------------------------------------------------------ table rows and columns
  const te = o.getByTestId('studio-table-editor')
  await te.getByRole('button', { name: 'Insertar columna a la derecha de 2' }).click()
  await te.getByRole('button', { name: 'Insertar fila debajo de 2' }).click()
  await te.getByLabel('Alineación de la columna 3').selectOption('right')
  await te.getByLabel('Fila 1, columna 3').fill('Precio')
  await te.getByLabel('Fila 3, columna 2').fill('Arena')
  await te.locator('select').filter({ has: o.locator('option[value="grid"]') }).selectOption('grid')
  await te.getByLabel('Última fila como total').check()

  // ------------------------------------------------------------ page typeface
  await o.locator('summary', { hasText: 'Página y tipografía' }).click()
  await o.getByTestId('studio-page-font').selectOption('lora')
  await save(o)
  let row = await docRow(DOC)
  const tbl = row?.content?.blocks?.[2]
  check(row?.version === 2 && row.page.font === 'lora' && /\{c=#C0392B;u\|saldo vencido\}/.test(row.content.blocks[1].text), 'saved: version 2 with the formatting and the Lora typeface', JSON.stringify(row?.page))
  check(JSON.stringify(tbl?.rows) === JSON.stringify([['Código', 'Artículo', 'Precio'], ['MAT-1', 'Cemento', ''], ['', 'Arena', '']]) && tbl.align?.[2] === 'right' && tbl.style === 'grid' && tbl.total === true,
    'table: a column and a row inserted, right-aligned price column, grid style, total row', JSON.stringify(tbl))

  // ------------------------------------------------------------ the PDF: typeface embedded, text selectable
  const pdf = await owner.ctx.request.get(`${BASE}/studio/${DOC}/pdf`)
  const bytes = Buffer.from(await pdf.body())
  const raw = bytes.toString('latin1')
  const streams = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => { try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { return '' } })
  check(pdf.status() === 200 && raw.startsWith('%PDF-') && /\/BaseFont \/[A-Z]+\+Lora/.test(raw) && /\/FontFile2/.test(raw), 'PDF: real, with the Lora subset embedded')
  check(streams.some((s) => s.includes('beginbfchar')) && streams.some((s) => /Tf 0\.75 0\.22 0\.17 rg/.test(s)), 'PDF: text is selectable (ToUnicode maps) and the coloured words keep their colour')

  // ------------------------------------------------------------ comparison of versions
  let r = await open(o, `/studio/${DOC}/compare?from=1&to=2`)
  const blocks = o.getByTestId('compare-blocks')
  check(/1 modificados|2 modificados/.test(await o.getByTestId('compare-summary').innerText()) && /Tipografía/.test(r.body) && /lora/.test(r.body), 'compare: changed blocks and the typeface change are listed')
  check(await blocks.locator('[data-op="changed"]').count() >= 1 && /solo formato/i.test(await blocks.innerText()) && await blocks.locator('ins').filter({ hasText: 'Arena' }).count() === 1,
    'compare: the paragraph is a formatting-only change; the new table words are marked as added', (await blocks.innerText()).slice(0, 400))
  r = await open(o, `/studio/${DOC}`)
  check(await o.getByTestId('studio-versions').getByRole('link', { name: 'Comparar versiones' }).count() === 1, 'the document links to the comparison')

  // ------------------------------------------------------------ corporate identity typefaces
  await open(o, '/studio/brand')
  await o.locator('select[name="heading_font"]').selectOption('playfair')
  await o.locator('select[name="body_font"]').selectOption('plex-sans')
  await Promise.all([o.waitForURL(/done=/, { timeout: 20000 }).catch(() => {}), o.locator('form').filter({ has: o.locator('select[name="heading_font"]') }).locator('button[type="submit"]').first().click()])
  const brand = (await db(`studio_brand?company_id=eq.${CO}&select=heading_font,body_font`))[0]
  check(brand?.heading_font === 'playfair' && brand?.body_font === 'plex-sans', 'identity: the new typefaces are saved', JSON.stringify(brand))

  // ------------------------------------------------------------ assistant: edits of the draft, only after Confirm
  check((await admin('/rpc/assistant_set_server_key', { method: 'POST', body: JSON.stringify({ key: 'ke2e', secret_b64: SERVER_SECRET }) })).status < 300, 'setup: the assistant server key is registered')
  await admin('/assistant_limits?plan=eq.pro', { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ per_minute: 60 }) })
  await open(o, `/studio/${DOC}`)
  await o.getByTestId('assistant-fab').click(); await o.getByTestId('assistant-chat').waitFor({ timeout: 15000 })
  async function ask(q) {
    const n = await o.getByTestId('assistant-answer').count()
    const input = o.locator('textarea[id^="assistant-input"]').first()
    await input.fill(q); await input.press('Enter')
    await o.waitForFunction((k) => document.querySelectorAll('[data-testid="assistant-answer"]').length > k && !document.querySelector('[data-testid="assistant-live"]'), n, { timeout: 40000 }).catch(() => {})
    return (await o.getByTestId('assistant-answer').allInnerTexts()).at(-1) ?? ''
  }
  let answer = await ask(`Edita el borrador ${DOC}`)
  const v2 = (await docRow(DOC)).version
  const card = o.getByTestId('assistant-action').last()
  check(/pendiente de su confirmación/.test(answer) && await card.getAttribute('data-status') === 'proposed' && v2 === 2, 'assistant: the edit is PROPOSED; the document is unchanged until Confirm')
  check(/dar formato a «El saldo»|añadir un párrafo al final/.test(await card.innerText()), 'the confirmation card says what will change', (await card.innerText()).slice(0, 200))
  await card.getByRole('button', { name: 'Confirmar' }).click()
  await o.waitForFunction(() => ['executed', 'failed'].includes([...document.querySelectorAll('[data-testid="assistant-action"]')].at(-1)?.getAttribute('data-status') ?? ''), null, { timeout: 25000 }).catch(() => {})
  row = await docRow(DOC)
  check(await card.getAttribute('data-status') === 'executed' && row.version === 3 && row.page.font === 'playfair' && row.content.blocks.some((b) => b.text === 'Quedamos atentos a su respuesta.'),
    'after Confirm: version 3 with the edits applied (paragraph added, typeface changed)', JSON.stringify(row?.page))
  check(/compare\?from=2&to=3/.test(await card.locator('a').first().getAttribute('href').catch(() => '') ?? ''), 'the card links to the comparison of the edit')
  // a second proposal goes stale when the user saves meanwhile
  answer = await ask(`Edita el borrador ${DOC}`)
  check(/pendiente de su confirmación/.test(answer), 'a second edit is proposed', answer.slice(0, 300))
  const stale = o.getByTestId('assistant-action').last()
  const cur = await docRow(DOC)
  await rpc('owner@e2e.local', 'studio_save_document', { target: CO, doc: DOC, doc_kind: 'letter', doc_title: 'Propuesta S5 (manual)', doc_folder: null, doc_content: cur.content, doc_page: cur.page,
    client: null, source_document: null, employee: null, vendor: null, template: null, base: null, expected_version: cur.version, doc_origin: 'user' })
  await stale.getByRole('button', { name: 'Confirmar' }).click()
  await o.waitForFunction(() => ['executed', 'failed'].includes([...document.querySelectorAll('[data-testid="assistant-action"]')].at(-1)?.getAttribute('data-status') ?? ''), null, { timeout: 25000 }).catch(() => {})
  row = await docRow(DOC)
  check(await stale.getAttribute('data-status') === 'failed' && row.version === 4 && row.title === 'Propuesta S5 (manual)', 'a stale edit is refused (the user\'s newer version wins; nothing overwritten)')
  check(await money() === before, 'no payment, ledger entry or business document was created', `${before} → ${await money()}`)
  await owner.ctx.close()

  // ------------------------------------------------------------ iPhone and iPad
  for (const [name, dev] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']]]) {
    const m = await session('owner@e2e.local', { ...dev })
    await open(m.page, `/studio/${DOC}`)
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1 && await m.page.getByTestId('studio-format').isVisible(), `${name}: editor with the formatting bar, no horizontal page scroll`, `${overflow}px`)
    if (name === 'iPhone 13') {
      await m.page.getByRole('tab', { name: 'Vista previa' }).click()
      check(await m.page.locator('svg[role="img"]').first().isVisible(), `${name}: the preview tab shows the pages`)
    }
    await open(m.page, `/studio/${DOC}/compare`)
    check(await m.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}: comparison fits the screen`)
    await m.ctx.close()
  }
  const en = await session('owner@e2e.local', {}, 'en')
  r = await open(en.page, `/studio/${DOC}/compare`)
  check(/Compare versions/.test(r.body) && /changed/.test(r.body), 'English: comparison')
  await en.ctx.close()
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
  if (double) await double.close()
  check(consoleErrors.length === 0, 'no browser console errors or 5xx responses', consoleErrors.slice(0, 5).join(' | '))
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

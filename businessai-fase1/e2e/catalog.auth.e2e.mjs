#!/usr/bin/env node
/**
 * Catalog of products and services (migration 0039) in the browser, LOCAL stack
 * only. Create, validate, edit (with a stale-version conflict), archive and
 * restore items; an invoice line chosen from the catalog copies the values and
 * records the item (code, unit) and later catalog changes do not alter it; the
 * item lists where it was used; an archived item cannot be used; a Studio table
 * takes a row from the catalog. Permissions (member reads only, other company
 * nothing), English, iPhone. Fictitious data.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/catalog.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3490)
const COMPANY = 'e2000000-0000-4000-8000-000000000001'
const CLIENT = 'e3000000-0000-4000-8000-000000000001'

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

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts })
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
  async function act(page, button, until = (u) => /[?&](done|error)=/.test(u.search)) {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && until(u), { timeout: 20000 }).catch(() => {}), button.click()])
    await page.waitForLoadState('networkidle')
    last = page.url().replace(BASE, '')
    return { url: page.url(), done: new URL(page.url()).searchParams.get('done'), error: new URL(page.url()).searchParams.get('error'), body: await page.locator('body').innerText() }
  }
  const items = async () => db(`catalog_items?company_id=eq.${COMPANY}&select=id,code,name,price_cents,tax_rate,unit,status,version,track_inventory&order=code`)

  const owner = await session('owner@e2e.local')
  const o = owner.page

  // ============================================================ create
  let r = await open(o, '/catalog')
  check(r.status === 200 && !r.broken && /El catálogo está vacío/.test(r.body) && await o.getByTestId('catalog-new').isVisible(), 'the catalog opens empty, with the new-item form open')
  const nf = o.getByTestId('catalog-new')
  async function create(code, name, kind, unit, price, tax = '', track = false) {
    await open(o, '/catalog')
    if (!(await nf.isVisible())) await o.locator('summary', { hasText: 'Nuevo artículo' }).click()
    await nf.locator('input[name="code"]').fill(code); await nf.locator('input[name="name"]').fill(name)
    await nf.locator('select[name="kind"]').selectOption(kind); await nf.locator('input[name="unit"]').fill(unit)
    await nf.locator('input[name="price"]').fill(price); await nf.locator('input[name="tax_rate"]').fill(tax)
    if (track) await nf.locator('input[name="track_inventory"]').check()
    return act(o, nf.getByRole('button', { name: 'Crear artículo' }))
  }
  r = await create('MAT-001', 'Cemento gris', 'product', 'saco', '12.50', '11.5', true)
  let all = await items()
  const MAT = all.find((x) => x.code === 'MAT-001')
  check(r.done === 'created' && MAT?.price_cents === 1250 && Number(MAT.tax_rate) === 11.5 && MAT.unit === 'saco' && MAT.track_inventory === true && r.url.includes(`/catalog/${MAT.id}`),
    'a product is created: price 12.50 stored as 1250 cents, own tax 11.5%, unit, stock flag', `${r.done} ${r.error} ${JSON.stringify(MAT)}`)
  r = await create('SRV-001', 'Instalación', 'service', 'hora', '45')
  check(r.done === 'created', 'a service is created')
  r = await create('mat-001', 'Duplicado', 'product', 'u', '1')
  check(r.error === 'catalog_code_taken' && /Ese código ya existe/.test(r.body), 'a duplicate code (any case) is refused with a clear message')
  r = await create('BAD-1', 'Precio malo', 'product', 'u', '1.005')
  check(r.error === 'price' && (await items()).length === 2, 'an invalid price is refused (nothing created)')
  r = await open(o, '/catalog')
  check(await o.getByTestId('catalog-list').locator('li').count() === 2 && /MAT-001/.test(r.body) && /\$12\.50/.test(r.body), 'the list shows both items with their price')
  r = await open(o, '/catalog?q=insta')
  check(await o.getByTestId('catalog-list').locator('li').count() === 1 && /Instalación/.test(r.body), 'search by name')
  r = await open(o, '/catalog?kind=product')
  check(await o.getByTestId('catalog-list').locator('li').count() === 1 && /Cemento/.test(r.body), 'filter by kind')

  // ============================================================ edit + stale version
  const other = await owner.ctx.newPage()
  await open(o, `/catalog/${MAT.id}`); await other.goto(`${BASE}/catalog/${MAT.id}`, { waitUntil: 'networkidle' })
  const ed = o.getByTestId('catalog-edit')
  await ed.locator('input[name="price"]').fill('13.00')
  r = await act(o, ed.getByRole('button', { name: 'Guardar cambios' }))
  check(r.done === 'saved' && (await items()).find((x) => x.code === 'MAT-001').price_cents === 1300, 'price edited to 13.00 (version 2)')
  check(/Editado/.test(await o.getByTestId('catalog-history').innerText()), 'the history shows the edit')
  await other.getByTestId('catalog-edit').locator('input[name="name"]').fill('Cemento viejo')
  r = await act(other, other.getByTestId('catalog-edit').getByRole('button', { name: 'Guardar cambios' }))
  check(r.error === 'catalog_conflict' && (await items()).find((x) => x.code === 'MAT-001').name === 'Cemento gris', 'a stale form is refused (no lost update)', `${r.error}`)
  await other.close()

  // ============================================================ invoice line from the catalog
  r = await open(o, '/documents/new?type=invoice')
  const pick = o.getByTestId('catalog-pick-1')
  check(await pick.count() === 1 && (await pick.locator('option').allTextContents()).some((t) => t.includes('MAT-001')), 'the invoice form offers the catalog on each line')
  await o.locator('select[name="client_id"]').first().selectOption(CLIENT)
  await pick.selectOption(MAT.id)
  const desc = await o.locator('input[name="item_description_1"]').inputValue(), price = await o.locator('input[name="item_price_1"]').inputValue()
  check(desc === 'Cemento gris' && price === '13.00' && await o.locator('input[name="tax_rate"]').inputValue() === '11.5', 'choosing it fills the description, price and suggests its tax', `${desc} ${price}`)
  await o.locator('input[name="item_quantity_1"]').fill('4')
  r = await act(o, o.getByRole('button', { name: /Guardar factura/ }), (u) => /^\/documents\/[0-9a-f-]{36}$/.test(u.pathname))
  const DOC = /\/documents\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  const doc = (await db(`documents?id=eq.${DOC}&select=items,subtotal,tax,total`))[0]
  const line = doc?.items?.[0]
  check(!!DOC && line?.catalog_item_id === MAT.id && line.code === 'MAT-001' && line.unit === 'saco' && line.unit_price === 13 && line.amount === 52 && Number(doc.subtotal) === 52 && Number(doc.total) === 57.98,
    'the invoice line is a copy: 4 × 13.00 = 52.00 (+11.5% = 57.98) with the item, code and unit recorded', JSON.stringify(doc))
  r = await open(o, `/catalog/${MAT.id}`)
  check((await o.getByTestId('catalog-used').locator('li').count()) === 1, 'the item lists the invoice where it was used')
  await o.getByTestId('catalog-edit').locator('input[name="price"]').fill('15.00')
  await act(o, o.getByTestId('catalog-edit').getByRole('button', { name: 'Guardar cambios' }))
  check((await db(`documents?id=eq.${DOC}&select=items`))[0]?.items?.[0]?.unit_price === 13, 'changing the catalog price later does not alter the invoice')

  // ============================================================ archive: not offered; a stale choice is refused
  await open(o, '/documents/new?type=invoice')
  await o.locator('select[name="client_id"]').first().selectOption(CLIENT)
  await o.getByTestId('catalog-pick-1').selectOption(MAT.id)
  const stale = await owner.ctx.newPage()
  await stale.goto(`${BASE}/catalog/${MAT.id}`, { waitUntil: 'networkidle' })
  r = await act(stale, stale.getByRole('button', { name: 'Archivar' }))
  check(r.done === 'archived' && (await items()).find((x) => x.code === 'MAT-001').status === 'archived', 'the item is archived (not deleted)')
  await stale.close()
  r = await act(o, o.getByRole('button', { name: /Guardar factura/ }))
  check(r.error === 'catalog' && /ya no está disponible/.test(r.body), 'an invoice saved with a just-archived item is refused, with a clear message')
  await open(o, '/documents/new?type=invoice')
  check(!(await o.getByTestId('catalog-pick-1').locator('option').allTextContents()).some((t) => t.includes('MAT-001')), 'an archived item is no longer offered')
  r = await open(o, '/catalog?status=archived')
  check(/MAT-001/.test(r.body), 'archived items are listed under «Archivados»')
  await open(o, `/catalog/${MAT.id}`)
  r = await act(o, o.getByRole('button', { name: 'Restaurar' }))
  check(r.done === 'restored' && (await items()).find((x) => x.code === 'MAT-001').status === 'active', 'and restored')

  // ============================================================ Studio: a table row from the catalog
  const sd = await rpc('owner@e2e.local', 'studio_save_document', { target: COMPANY, doc: null, doc_kind: 'purchase_order', doc_title: 'Pedido con catálogo', doc_folder: null,
    doc_content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Pedido' }, { type: 'table', header: true, rows: [['Código', 'Artículo', 'Unidad', 'Precio']] }] }, doc_page: {},
    client: null, source_document: null, employee: null, vendor: null, template: null, base: null, expected_version: null, doc_origin: 'user' })
  const SD = Array.isArray(sd.body) ? sd.body[0]?.id : sd.body?.id
  await open(o, `/studio/${SD}`)
  await o.getByTestId('studio-table-catalog').selectOption(MAT.id)
  await o.waitForTimeout(400)
  const pv = (await o.locator('svg[role="img"] text').allTextContents()).join(' ')
  const cells = await o.locator('table input').evaluateAll((els) => els.map((e) => e.value))
  check(cells.includes('MAT-001') && cells.includes('Cemento gris') && cells.includes('saco') && cells.includes('$15.00') && /Cemento gris/.test(pv), 'a Studio table takes a row from the catalog (code, name, unit, price) and the preview shows it', cells.join('|'))

  // ============================================================ permissions
  const mem = await session('member@e2e.local')
  r = await open(mem.page, '/catalog')
  check(r.status === 200 && /MAT-001/.test(r.body) && await mem.page.getByTestId('catalog-new').count() === 0, 'a member reads the catalog but cannot create items')
  r = await open(mem.page, `/catalog/${MAT.id}`)
  check(await mem.page.getByTestId('catalog-edit').count() === 0 && await mem.page.getByTestId('catalog-history').count() === 0 && !(await mem.page.getByRole('button', { name: 'Archivar' }).count()),
    'nor edit, archive or see its history')
  const memSave = await rpc('member@e2e.local', 'catalog_save', { target: COMPANY, item: null, p_code: 'M-1', p_name: 'x', p_description: null, p_kind: 'product', p_unit: 'u', p_price_cents: 1, p_tax_rate: null, p_track_inventory: false, expected_version: null })
  check(memSave.status >= 400, 'the database refuses a member write', String(memSave.status))
  const oth = await api('other@e2e.local', `/rest/v1/catalog_items?company_id=eq.${COMPANY}&select=id`)
  check(oth.ok && (await oth.json()).length === 0, 'another company reads nothing')
  await mem.ctx.close()

  // ============================================================ English and iPhone
  const en = await session('owner@e2e.local', {}, 'en')
  r = await open(en.page, '/catalog')
  check(/Products and services/.test(r.body) && /New item/.test(r.body), 'English: the catalog')
  r = await open(en.page, `/catalog/${MAT.id}`)
  check(/Where it was used/.test(r.body) && /History/.test(r.body), 'English: an item')
  r = await open(en.page, '/documents/new?type=invoice')
  check(/from the catalog \(optional\)/.test(r.body), 'English: the invoice form')
  await en.ctx.close()
  const phone = await session('owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of ['/catalog', `/catalog/${MAT.id}`, '/documents/new?type=invoice']) {
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

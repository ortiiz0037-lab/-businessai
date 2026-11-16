#!/usr/bin/env node
/**
 * S7 Inventory in the browser — LOCAL stack only (no external service). Drives the real code path:
 * server actions, 0043 functions, RLS, branch scope, the scanner field (a USB / Bluetooth scanner in
 * keyboard mode types the code and presses Enter, exactly what the test does), approvals, purchase
 * orders with partial receipts by scanning, transfers in transit, counts by scanning, replenishment,
 * reports, the catalog panel, English, iPhone and iPad layouts.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/inventory.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3560)
const CO = 'e2000000-0000-4000-8000-000000000001'
const VENDOR = 'e5000000-0000-4000-8000-000000000001'
const EAN = '4006381333931'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
  const { BASE, PASSWORD, api, admin, count } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rpc = (email, fn, args) => api(email, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }

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
  async function open(page, path) { const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); last = page.url().replace(BASE, ''); return { status: r?.status() ?? 0, body: await page.locator('body').innerText() } }
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  const submitIn = async (page, locator) => {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && (u.searchParams.has('done') || u.searchParams.has('error')), { timeout: 30000 }).catch(() => {}), locator.click()])
    await page.waitForLoadState('networkidle'); last = page.url().replace(BASE, ''); return page.locator('body').innerText()
  }
  /** what a keyboard-mode scanner does: type the code into the focused field and press Enter */
  async function scan(page, code, scope = page) { const f = scope.getByTestId('scan-field').first(); await f.fill(code); await f.press('Enter'); await page.waitForTimeout(700) }
  const onHand = async (branch, item, variant = null) => Number((await db(`inventory_stock?branch_id=eq.${branch}&item_id=eq.${item}&variant_key=eq.${variant ?? '00000000-0000-0000-0000-000000000000'}&select=on_hand`))[0]?.on_hand ?? 0)

  // ---------------------------------------------------------------- setup through the same functions the app uses
  const SJ = (await json(await admin('/branches', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ company_id: CO, name: 'San Juan', code: 'SJU' }) })))?.[0]?.id
  const PC = (await json(await admin('/branches', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ company_id: CO, name: 'Ponce', code: 'PCE' }) })))?.[0]?.id
  check(!!SJ && !!PC, 'setup: two branches')
  const TOR = (await json(await rpc('admin@e2e.local', 'catalog_save', { target: CO, item: null, p_code: 'TOR-14', p_name: 'Tornillo 1/4', p_description: null, p_kind: 'product', p_unit: 'unidad', p_price_cents: 25, p_tax_rate: null, p_track_inventory: true, expected_version: null })))?.[0]?.id
  const CAM = (await json(await rpc('admin@e2e.local', 'catalog_save', { target: CO, item: null, p_code: 'CAM-01', p_name: 'Camiseta', p_description: null, p_kind: 'product', p_unit: 'unidad', p_price_cents: 1500, p_tax_rate: null, p_track_inventory: true, expected_version: null })))?.[0]?.id
  check(!!TOR && !!CAM, 'setup: two tracked products in the catalog')
  check((await rpc('admin@e2e.local', 'catalog_barcode_add', { item: TOR, variant: null, p_code: EAN, p_symbology: 'ean13', p_primary: true })).status < 300, 'setup: an EAN-13 barcode for the screw')

  // ---------------------------------------------------------------- catalog panel: variants, codes, cost (admin)
  const { ctx: actx, page: a } = await session('admin@e2e.local')
  {
    await open(a, `/catalog/${CAM}`)
    const vf = a.getByTestId('variant-form')
    await vf.locator('input[name="sku"]').fill('CAM-01-R-M'); await vf.locator('input[name="size"]').fill('M'); await vf.locator('input[name="color"]').fill('Rojo')
    let body = await submitIn(a, vf.getByRole('button', { name: 'Añadir variante' }))
    check(/Variantes actualizadas/.test(body) && /Rojo \/ M|M \/ Rojo/.test(await a.getByTestId('variants').innerText()), 'catalog: a variant (size / color) with its own SKU')
    const bf = a.getByTestId('barcode-form')
    await bf.locator('input[name="code"]').fill(EAN); body = await submitIn(a, bf.getByRole('button', { name: 'Añadir código' }))
    check(/ya identifica otro producto/.test(body), 'catalog: a code already used by another product is refused')
    await bf.locator('input[name="code"]').fill('4006381333932'); body = await submitIn(a, bf.getByRole('button', { name: 'Añadir código' }))
    check(/dígito de control/.test(body), 'catalog: a wrong check digit is refused')
    await bf.locator('input[name="code"]').fill('96385074'); await bf.locator('select[name="symbology"]').selectOption('ean8')
    await bf.locator('select[name="variant_id"]').selectOption({ label: /Rojo|M/ }).catch(async () => { const opts = await bf.locator('select[name="variant_id"] option').all(); await bf.locator('select[name="variant_id"]').selectOption(await opts[1].getAttribute('value')) })
    body = await submitIn(a, bf.getByRole('button', { name: 'Añadir código' }))
    check(/Código añadido/.test(body) && /96385074/.test(await a.getByTestId('barcodes').innerText()), 'catalog: an EAN-8 for the variant')
    await open(a, `/catalog/${TOR}`)
    await a.locator('input[name="cost"]').first().fill('5.00'); body = await submitIn(a, a.getByRole('button', { name: 'Guardar costo' }))
    check(/Costo guardado/.test(body), 'catalog: acquisition cost with history')
  }
  const VAR = (await db(`catalog_variants?item_id=eq.${CAM}&select=id`))[0]?.id

  // ---------------------------------------------------------------- scanner (member)
  const { ctx: mctx, page: m } = await session('member@e2e.local')
  {
    const r = await open(m, '/inventory/scan')
    check(r.status === 200 && await m.getByTestId('scan-field').isVisible(), 'a member opens the scanner')
    await scan(m, EAN)
    check(await m.getByTestId('scan-result').getAttribute('data-found') === 'yes' && /Tornillo/.test(await m.getByTestId('scan-result').innerText()), 'a scanned barcode finds the product at once')
    await scan(m, '96385074')
    check(/Camiseta/.test(await m.getByTestId('scan-result').innerText()), 'a variant barcode finds the variant')
    await scan(m, '0000000000017')
    check(await m.getByTestId('scan-result').getAttribute('data-found') === 'no' && /Código desconocido/.test(await m.getByTestId('scan-result').innerText()), 'an unknown code is reported as unknown')
  }

  // ---------------------------------------------------------------- opening stock (admin, by scanning into the lines)
  {
    await open(a, '/inventory/movements/new?kind=opening')
    await a.getByTestId('movement-form').locator('select[name="branch_id"]').selectOption(SJ)
    await scan(a, EAN, a.getByTestId('movement-form'))
    check(await a.locator('select[name="line"]').first().inputValue() === `${TOR}|`, 'scanning fills the line with the product')
    await a.locator('input[name="qty"]').first().fill('20'); await a.locator('input[name="cost"]').first().fill('5.00')
    await a.locator('input[name="reason"]').fill('Inventario inicial')
    const body = await submitIn(a, a.getByTestId('movement-form').getByRole('button', { name: 'Registrar' }))
    check(/Movimiento registrado/.test(body) && await onHand(SJ, TOR) === 20, 'an approver records opening stock (20 at San Juan)')
    await open(a, '/inventory/movements/new?kind=opening')
    await a.getByTestId('movement-form').locator('select[name="branch_id"]').selectOption(SJ)
    await a.locator('select[name="line"]').first().selectOption(`${CAM}|${VAR}`)
    await a.locator('input[name="qty"]').first().fill('6'); await a.locator('input[name="reason"]').fill('Inventario inicial')
    await submitIn(a, a.getByTestId('movement-form').getByRole('button', { name: 'Registrar' }))
    check(await onHand(SJ, CAM, VAR) === 6, 'stock per variant')
  }

  // ---------------------------------------------------------------- sales, protection against negative stock, damaged goods with approval
  {
    await open(m, '/inventory/movements/new?kind=sale')
    await m.getByTestId('movement-form').locator('select[name="branch_id"]').selectOption(SJ)
    await scan(m, EAN, m.getByTestId('movement-form')); await scan(m, EAN, m.getByTestId('movement-form')); await scan(m, EAN, m.getByTestId('movement-form'))
    check(await m.locator('input[name="qty"]').first().inputValue() === '3', 'each scan adds one to the line (3 scans → 3)')
    let body = await submitIn(m, m.getByTestId('movement-form').getByRole('button', { name: 'Registrar' }))
    check(/Movimiento registrado/.test(body) && await onHand(SJ, TOR) === 17, 'a member records a sale (20 → 17)')
    await open(m, '/inventory/movements/new?kind=sale')
    await m.getByTestId('movement-form').locator('select[name="branch_id"]').selectOption(SJ)
    await m.locator('select[name="line"]').first().selectOption(`${TOR}|`); await m.locator('input[name="qty"]').first().fill('100')
    body = await submitIn(m, m.getByTestId('movement-form').getByRole('button', { name: 'Registrar' }))
    check(/No hay existencias suficientes/.test(body) && await onHand(SJ, TOR) === 17, 'a sale beyond stock is refused (never negative)')
    await open(m, '/inventory/movements/new?kind=damaged')
    await m.getByTestId('movement-form').locator('select[name="branch_id"]').selectOption(SJ)
    await m.locator('select[name="line"]').first().selectOption(`${TOR}|`); await m.locator('input[name="qty"]').first().fill('1'); await m.locator('input[name="reason"]').fill('Caja mojada')
    body = await submitIn(m, m.getByTestId('movement-form').getByRole('button', { name: 'Enviar para aprobación' }))
    check(/Solicitud enviada/.test(body) && await onHand(SJ, TOR) === 17, 'a member reports damaged goods: pending, stock unchanged')
    await open(m, '/inventory/adjustments')
    check(await m.getByRole('button', { name: 'Aprobar' }).count() === 0, 'members see no approve button')
    await open(a, '/inventory/adjustments')
    body = await submitIn(a, a.getByTestId('adjustment').filter({ hasText: 'Caja mojada' }).getByRole('button', { name: 'Aprobar' }))
    check(/Aprobado/.test(body) && await onHand(SJ, TOR) === 16, 'the admin approves: stock 16, with who decided')
    check(/Decidido por admin@e2e.local/.test(await a.getByTestId('adjustment').filter({ hasText: 'Caja mojada' }).innerText()), 'the decision keeps its author')
  }

  // ---------------------------------------------------------------- purchase order: approval, partial receipt by scanning, vendor bill
  let PO = null
  {
    await open(m, '/inventory/purchase-orders/new')
    await m.locator('select[name="vendor_id"]').selectOption(VENDOR); await m.locator('select[name="branch_id"]').selectOption(SJ)
    await m.locator('select[name="line"]').first().selectOption(`${TOR}|`); await m.locator('input[name="qty"]').first().fill('10'); await m.locator('input[name="cost"]').first().fill('5.50')
    let body = await submitIn(m, m.getByRole('button', { name: 'Guardar y enviar a aprobación' }))
    PO = m.url().match(/purchase-orders\/([0-9a-f-]{36})/)?.[1]
    check(!!PO && /Por aprobar/.test(await m.getByTestId('po-status').innerText()), 'a member drafts a purchase order and sends it for approval')
    check(await m.getByRole('button', { name: 'Aprobar y emitir' }).count() === 0, 'members cannot approve it')
    await open(a, `/inventory/purchase-orders/${PO}`)
    body = await submitIn(a, a.getByRole('button', { name: 'Aprobar y emitir' }))
    check(/Aprobada/.test(await a.getByTestId('po-status').innerText()), 'the admin approves and issues it')
    await open(m, `/inventory/purchase-orders/${PO}`)
    for (let i = 0; i < 4; i++) await scan(m, EAN)
    check((await m.locator('input[data-scan-key]').first().inputValue()) === '4', 'receiving by scanning: 4 scans → 4 arriving')
    await m.locator('input[name^="dmg_"]').first().fill('1')
    body = await submitIn(m, m.getByRole('button', { name: 'Confirmar recepción' }))
    check(/Recepción parcial registrada/.test(body) && await onHand(SJ, TOR) === 20, 'partial receipt: 4 good enter stock (16 → 20), 1 damaged recorded')
    await m.locator('input[data-scan-key]').first().fill('9')
    body = await submitIn(m, m.getByRole('button', { name: 'Confirmar recepción' }))
    check(/No se puede recibir más de lo pedido/.test(body) && await onHand(SJ, TOR) === 20, 'never more than ordered')
    await m.locator('input[data-scan-key]').first().fill('5')
    body = await submitIn(m, m.getByRole('button', { name: 'Confirmar recepción' }))
    check(/la orden está completa/.test(body) && await onHand(SJ, TOR) === 25 && /Recibida/.test(await m.getByTestId('po-status').innerText()), 'second delivery completes the order (25)')
    check(await m.getByTestId('po-receipts').locator(':scope > li').count() === 2, 'both deliveries are listed with who received them')
    const bill = await json(await rpc('admin@e2e.local', 'bill_save_draft', { target: CO, bill: null, vendor: VENDOR, invoice_number: 'F-OC1', bill_date: new Date().toISOString().slice(0, 10), due_date: null,
      description: 'Mercancía OC', notes: null, lines: [{ category_id: (await db(`expense_categories?company_id=eq.${CO}&select=id&limit=1`))[0]?.id, amount_cents: '5500', description: 'Tornillos' }], idempotency_key: 'e2e-bill-po-0001' }))
    await open(a, `/inventory/purchase-orders/${PO}`)
    if (typeof bill === 'string') await a.locator('select[name="bill_id"]').selectOption(bill)
    body = await submitIn(a, a.getByRole('button', { name: 'Vincular' }))
    check(/Factura del proveedor vinculada/.test(body) && (await db(`purchase_order_bills?po_id=eq.${PO}&select=bill_id`)).length === 1, 'the vendor bill is linked (no new expense or payment)', typeof bill === 'string' ? '' : JSON.stringify(bill))
  }

  // ---------------------------------------------------------------- transfer: in transit until received, differences with a note
  {
    await open(m, '/inventory/transfers/new')
    await m.locator('select[name="from_branch"]').selectOption(SJ); await m.locator('select[name="to_branch"]').selectOption(PC)
    await m.locator('select[name="line"]').first().selectOption(`${TOR}|`); await m.locator('input[name="qty"]').first().fill('5')
    await submitIn(m, m.getByRole('button', { name: 'Solicitar transferencia' }))
    const T = m.url().match(/transfers\/([0-9a-f-]{36})/)?.[1]
    check(!!T && /Solicitada/.test(await m.getByTestId('transfer-status').innerText()), 'a member requests a transfer San Juan → Ponce')
    await open(a, `/inventory/transfers/${T}`); await submitIn(a, a.getByRole('button', { name: 'Aprobar' }))
    await open(m, `/inventory/transfers/${T}`)
    await submitIn(m, m.getByRole('button', { name: 'Despachar' }))
    check(/En tránsito/.test(await m.getByTestId('transfer-status').innerText()) && await onHand(SJ, TOR) === 20 && await onHand(PC, TOR) === 0, 'dispatched: out of San Juan, NOT in Ponce yet')
    await open(a, `/inventory/transfers/${T}`)
    await a.locator('input[data-scan-key]').first().fill('4')
    let body = await submitIn(a, a.getByRole('button', { name: 'Confirmar recepción' }))
    check(/Hay diferencias: explica/.test(body) && await onHand(PC, TOR) === 0, 'a difference without a note is refused')
    await a.locator('input[data-scan-key]').first().fill('4'); await a.locator('input[name="note"]').fill('Faltó una unidad')
    body = await submitIn(a, a.getByRole('button', { name: 'Confirmar recepción' }))
    check(/Recepción confirmada/.test(body) && await onHand(PC, TOR) === 4 && /Faltó una unidad/.test(await a.getByTestId('transfer-difference').innerText()), 'received with the difference recorded: Ponce 4')
  }

  // ---------------------------------------------------------------- physical count by scanning; approval adjusts stock
  {
    await open(m, '/inventory/counts')
    await m.getByTestId('count-start').locator('select[name="branch_id"]').selectOption(SJ)
    await submitIn(m, m.getByTestId('count-start').getByRole('button', { name: 'Empezar conteo' }))
    const C = m.url().match(/counts\/([0-9a-f-]{36})/)?.[1]
    for (let i = 0; i < 3; i++) await scan(m, EAN)
    await m.waitForTimeout(800); await m.reload({ waitUntil: 'networkidle' })
    check(/3/.test(await m.getByTestId('count-line').filter({ hasText: 'Tornillo' }).getByTestId('counted').innerText()), 'counting by scanning: 3 scans → 3 counted')
    await submitIn(m, m.getByRole('button', { name: 'Enviar conteo' }))
    check(/−17|-17/.test(await m.getByTestId('count-line').filter({ hasText: 'Tornillo' }).getByTestId('difference').innerText()), 'submitted: difference against the records (3 − 20)')
    check(await onHand(SJ, TOR) === 20, 'nothing changes before approval')
    await open(a, `/inventory/counts/${C}`)
    const body = await submitIn(a, a.getByRole('button', { name: 'Aprobar y ajustar existencias' }))
    check(/Conteo aprobado/.test(body) && await onHand(SJ, TOR) === 3, 'approved: stock equals what was counted (3)')
  }

  // ---------------------------------------------------------------- replenishment rules → suggestion → draft purchase order
  {
    await open(a, `/inventory/items/${TOR}`)
    const f = a.getByTestId('item-rules').first()
    await f.locator('input[name="reorder_point"]').fill('10'); await f.locator('input[name="reorder_qty"]').fill('20'); await f.locator('select[name="vendor_id"]').selectOption(VENDOR); await f.locator('input[name="lead_time_days"]').fill('5')
    await submitIn(a, f.getByRole('button', { name: 'Guardar reglas' }))
    const r = await open(a, '/inventory/replenishment')
    const s = a.getByTestId('suggestion').filter({ hasText: 'Tornillo' }).first()
    check(await s.getAttribute('data-needed') === 'yes' && /Disponible \+ en tránsito/.test(await s.innerText()), 'a product below its reorder point is suggested, with the reason')
    check(/Ventas registradas|Sin ventas registradas/.test(r.body), 'the basis is explained (recorded sales or basic rules)')
    const before = (await db(`purchase_orders?company_id=eq.${CO}&source=eq.replenishment&select=id`)).length
    const body = await submitIn(a, a.getByRole('button', { name: /Crear borradores/ }))
    check(/borradores de orden de compra creados/.test(body) && (await db(`purchase_orders?company_id=eq.${CO}&source=eq.replenishment&status=eq.draft&select=id`)).length === before + 1, 'a draft purchase order per vendor (approval still required)')
  }

  // ---------------------------------------------------------------- reports, consistency, export
  {
    const r = await open(a, '/inventory/reports')
    check(/Consistencia con el registro/.test(r.body) && /OK/.test(r.body) && /Valor \(FIFO\)/.test(r.body) && /no se contabiliza/.test(r.body), 'reports: valuation (average and FIFO, not posted) and consistency OK')
    const csv = await a.request.get(`${BASE}/inventory/export`)
    const text = await csv.text()
    check(csv.status() === 200 && /Tornillo 1\/4/.test(text) && /receipt/.test(text), 'movements export as CSV')
    const mr = await open(m, '/inventory/reports')
    check(!/Valor \(FIFO\)/.test(mr.body), 'members see quantities, not costs')
  }

  // ---------------------------------------------------------------- branch scope and isolation
  {
    await admin('/branch_members', { method: 'POST', body: JSON.stringify({ company_id: CO, branch_id: SJ, user_id: 'e1000000-0000-4000-8000-000000000003' }) })
    const r = await open(m, '/inventory/stock')
    check(!/Ponce/.test(await m.getByTestId('stock-table').innerText()), 'a member assigned to San Juan does not see Ponce stock')
    const deny = await json(await rpc('member@e2e.local', 'inventory_move', { target: CO, branch: PC, location: null, p_kind: 'sale', lines: [{ item: TOR, qty: '1' }], reason: null, doc: null, idem: 'e2e-scope-0001' }))
    check(/BRANCH_FORBIDDEN/.test(JSON.stringify(deny)), 'nor move it')
    check((await json(await api('other@e2e.local', `/rest/v1/inventory_movements?company_id=eq.${CO}&select=id`)))?.length === 0, 'isolation: another company sees no movements')
    check(/FORBIDDEN/.test(JSON.stringify(await json(await rpc('other@e2e.local', 'inventory_move', { target: CO, branch: SJ, location: null, p_kind: 'sale', lines: [{ item: TOR, qty: '1' }], reason: null, doc: null, idem: 'e2e-other-0001' })))),
      'nor moves its stock')
    check((await json(await rpc('admin@e2e.local', 'inventory_verify', { target: CO })))?.length === 0, 'stock equals the ledger after everything')
    void r
  }
  await mctx.close(); await actx.close()

  // ---------------------------------------------------------------- English, iPhone, iPad
  {
    const { ctx, page: en } = await session('admin@e2e.local', {}, 'en')
    const r = await open(en, '/inventory')
    check(/Low stock alerts/.test(r.body) && /Latest movements/.test(r.body) && !/Últimos movimientos/.test(r.body), 'English: the inventory overview')
    await ctx.close()
    for (const [label, dev] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']]]) {
      const s = await session('admin@e2e.local', dev)
      for (const p of ['/inventory', '/inventory/scan', '/inventory/stock', '/inventory/movements/new?kind=sale', `/inventory/purchase-orders/${PO}`, '/inventory/transfers', '/inventory/counts', '/inventory/replenishment', `/inventory/items/${TOR}`]) {
        await open(s.page, p)
        check(await noOverflow(s.page), `${label}: ${p.replace(/[0-9a-f-]{36}/, ':id')} fits the screen`)
      }
      await open(s.page, '/inventory/scan')
      check(await s.page.getByTestId('scan-camera').isVisible(), `${label}: the camera button is offered`)
      await s.ctx.close()
    }
  }
  check(consoleErrors.length === 0, 'no console errors or server errors', consoleErrors.slice(0, 5).join(' | '))
  void count
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
  if (stack) console.log(stack.logs.next.slice(-3000))
} finally {
  await browser.close()
  await stack?.stop()
  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

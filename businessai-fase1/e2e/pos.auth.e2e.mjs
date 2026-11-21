#!/usr/bin/env node
/**
 * S8 / S9 POS in the browser — WRITTEN IN S9.2, NOT YET EXECUTED (this sandbox cannot install PostgREST;
 * it runs in the e2e-auth GitHub workflow). Kept in the same shape as the inventory test, which ran.
 * Former header of the template: S7 Inventory in the browser — LOCAL stack only (no external service). Drives the real code path:
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
const PORT = Number(process.env.PORT ?? 3580)
const CO = 'e2000000-0000-4000-8000-000000000001'
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
  check(!!SJ, 'setup: a branch')
  const TAL = (await json(await rpc('admin@e2e.local', 'catalog_save', { target: CO, item: null, p_code: 'TAL-1', p_name: 'Taladro', p_description: null, p_kind: 'product', p_unit: 'unidad', p_price_cents: 8000, p_tax_rate: null, p_track_inventory: true, expected_version: null })))?.[0]?.id
  check(!!TAL && (await rpc('admin@e2e.local', 'catalog_barcode_add', { item: TAL, variant: null, p_code: EAN, p_symbology: 'ean13', p_primary: true })).status < 300, 'setup: a product with its barcode')
  check((await rpc('admin@e2e.local', 'inventory_adjust', { target: CO, branch: SJ, location: null, p_kind: 'opening', lines: [{ item: TAL, qty: '5', unit_cost: '5000' }], reason: 'Inicial', vendor: null, doc: null, idem: 'e2e-pos-open-1' })).status < 300, 'setup: opening stock 5')

  // ---------------------------------------------------------------- settings by the admin: tax, register
  const { ctx: actx, page: a } = await session('admin@e2e.local')
  {
    let r = await open(a, '/pos/settings')
    check(r.status === 200 && await a.getByTestId('pos-taxes').isVisible(), 'admin opens POS settings')
    const ok = (await rpc('admin@e2e.local', 'pos_tax_rate_save', { target: CO, rate_id: null, p_code: 'IVU', p_name: 'IVU 11.5%', p_rate: 11.5, p_default: true, archived: false })).status < 300
    check(ok, 'the IVU rate is the default tax')
    const rf = a.getByTestId('pos-registers').locator('form').last()
    await rf.locator('input[name="code"]').fill('CAJA1'); await rf.locator('input[name="name"]').fill('Caja 1'); await rf.locator('select[name="branch_id"]').selectOption(SJ)
    const body = await submitIn(a, rf.getByRole('button', { name: 'Crear caja' }))
    check(/Guardado/.test(body) && (await db(`pos_registers?company_id=eq.${CO}&code=eq.CAJA1&select=id`)).length === 1, 'admin creates a register from the screen')
    r = await open(a, '/pos/integrations')
    check(r.status === 200 && /Proveedores investigados/.test(r.body) && /no está configurada en el servidor|not configured/i.test(r.body), 'integrations page: researched providers, nothing presented as connected')
  }

  // ---------------------------------------------------------------- the member opens a shift and sells by scanning
  const { ctx: mctx, page: m } = await session('member@e2e.local')
  {
    let r = await open(m, '/pos/register')
    check(r.status === 200 && await m.getByTestId('open-shift').isVisible(), 'the register asks to open a shift first')
    await m.getByTestId('shift-float').fill('100.00')
    await submitIn(m, m.getByTestId('open-shift').getByRole('button', { name: 'Abrir turno' }))
    await open(m, '/pos/register')
    check(await m.getByTestId('pos-register').isVisible(), 'with the shift open the register is shown')
    await scan(m, EAN); await m.waitForTimeout(500)
    check(/Taladro/.test(await m.getByTestId('pos-cart').innerText()), 'a scanned barcode adds the product to the cart')
    check((await m.getByTestId('pos-total').innerText()).includes('89.20'), 'the total includes IVU (80.00 + 11.5 % = 89.20)')
    await m.getByTestId('pos-pay-rest').click(); await m.getByTestId('pos-tendered').fill('100')
    check((await m.getByTestId('pos-change').innerText()).includes('10.80'), 'change for 100.00 is 10.80')
    await m.getByTestId('pos-charge').click()
    await m.getByTestId('pos-sold').waitFor({ timeout: 20000 })
    check(/POS-000001/.test(await m.getByTestId('pos-sold').innerText()) && await onHand(SJ, TAL) === 4, 'the sale is recorded once and stock leaves the branch (5 → 4)')
    const sale = (await db(`pos_sales?company_id=eq.${CO}&select=id,total_cents`))[0]
    check(sale?.total_cents === 8920 && (await db(`journal_entries?source=eq.pos_sale&source_id=eq.${sale.id}&select=id`)).length === 1, 'the sale is in the ledger')
    r = await open(m, `/pos/sales/${sale.id}`)
    check(r.status === 200 && (await m.getByTestId('receipt-total').innerText()).includes('89.20'), 'the receipt shows the amounts as sold')
    // refund needs a supervisor code for a member
    const rf = m.getByTestId('refund-form')
    await rf.locator('input[name^="qty_"]').first().fill('1'); await rf.locator('input[name="reason"]').fill('Defecto')
    let body = await submitIn(m, rf.getByRole('button', { name: 'Registrar devolución' }))
    check(/autorización/.test(body) && await onHand(SJ, TAL) === 4, 'a member refund without a code is refused (nothing changes)')
    const code = (await json(await rpc('admin@e2e.local', 'pos_approval_issue', { target: CO, branch: SJ, p_scope: 'refund', p_max_cents: 10000, p_max_pct: null, minutes: 10 })))?.code
    await open(m, `/pos/sales/${sale.id}`)
    const rf2 = m.getByTestId('refund-form')
    await rf2.locator('input[name^="qty_"]').first().fill('1'); await rf2.locator('input[name="reason"]').fill('Defecto'); await rf2.locator('input[name="approval_code"]').fill(code)
    body = await submitIn(m, rf2.getByRole('button', { name: 'Registrar devolución' }))
    check(/Devolución registrada/.test(body) && await onHand(SJ, TAL) === 5, 'with the supervisor code: refunded and restocked (4 → 5)')
    // close the shift with the counted cash
    r = await open(m, '/pos/shifts')
    await m.getByTestId('counted').fill('99.00'); await m.getByTestId('close-shift').locator('input[name="note"]').fill('Falta un dólar')
    body = await submitIn(m, m.getByTestId('close-shift').getByRole('button', { name: 'Cerrar turno' }))
    check(/Turno cerrado/.test(body) && (await db(`pos_shifts?company_id=eq.${CO}&select=status,difference_cents`))[0]?.status === 'pending_review', 'counted 99.00 against 100.00 expected (float + sale − refund): the difference waits for review, never corrected')
  }

  // ---------------------------------------------------------------- reports, isolation, English, devices
  {
    let r = await open(a, '/pos/reports')
    check(r.status === 200 && (await a.getByTestId('report-net').innerText()).includes('0.00') && (await a.getByTestId('report-methods').innerText()).includes('Efectivo'), 'reports: net 0.00 after the full refund, cash shown by method')
    const { ctx: octx, page: o } = await session('other@e2e.local')
    r = await open(o, `/pos/sales/${(await db(`pos_sales?company_id=eq.${CO}&select=id`))[0].id}`)
    check(r.status === 404 || !/Taladro/.test(r.body), 'another company cannot open the sale')
    await octx.close()
    const { ctx, page: e } = await session('admin@e2e.local', {}, 'en')
    r = await open(e, '/pos')
    check(/Point of sale/.test(r.body) && /Latest sales/.test(r.body), 'English: POS overview')
    await ctx.close()
    for (const [label, dev] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']]]) {
      const s = await session('admin@e2e.local', dev)
      for (const p of ['/pos', '/pos/register', '/pos/sales', '/pos/shifts', '/pos/reports', '/pos/integrations', '/pos/settings', '/settings/account']) {
        await open(s.page, p)
        check(await noOverflow(s.page), `${label}: ${p} fits the screen`)
      }
      await s.ctx.close()
    }
  }
  await actx.close(); await mctx.close()
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

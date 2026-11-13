#!/usr/bin/env node
/**
 * Authenticated browser test of Payroll (0034) on the LOCAL stack, with
 * fictitious data only: compensation, deductions, a weekly run from the time
 * clock hours (verified by the database), preview with exact cents, stale
 * preview after an adjustment, approval, ledger entries, payment record,
 * pay stubs (Document Studio engine), reports / CSV, reversal, roles and
 * isolation, English, phone and tablet. No bank, no money, no taxes.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/payroll.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3340)
const CO = 'e2000000-0000-4000-8000-000000000001'
const WORKER_ID = 'e1000000-0000-4000-8000-000000000009'
const ANA = 'e6000000-0000-4000-8000-000000000001'          // seeded employee (salary)
const PABLO = 'e6000000-0000-4000-8000-0000000000aa'        // hourly, linked to worker@e2e.local

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

async function session(BASE, PASSWORD, email, opts = {}) {
  const ctx = await browser.newContext({ ...opts })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  return { ctx, page }
}
async function open(BASE, page, path) {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  last = page.url().replace(BASE, '')
  return { status: r?.status() ?? 0, body: await page.locator('body').innerText() }
}
async function submit(page, button) {
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.href !== before && /[?&](done|error)=/.test(u.search), { timeout: 30000 }), button.click()])
  await page.waitForLoadState('networkidle')
  last = page.url()
  return { url: page.url(), body: await page.locator('body').innerText() }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const pr = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00-04:00`).toISOString()   // Puerto Rico is UTC−4 all year

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin',
    extraUsers: { 'worker@e2e.local': WORKER_ID } })
  const { BASE, PASSWORD, api, admin } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rows = async (email, path) => (await json(await api(email, path))) ?? []

  // fixtures (database owner): an hourly employee linked to the worker account, and its punches in the last closed week
  const today = pr(0)
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7
  const P0 = addDays(addDays(today, -dow), -7)                       // Monday of last week
  let r0 = await admin('/employees', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ id: PABLO, company_id: CO, first_name: 'Pablo', last_name: 'Pagado', employee_number: '77', user_id: WORKER_ID }) })
  check(r0.status < 300, 'setup: an hourly employee (fictitious) linked to an employee account', String(r0.status))
  r0 = await admin('/time_punches', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify([
    { company_id: CO, employee_id: PABLO, kind: 'in', at: at(P0, '08:00'), source: 'self' }, { company_id: CO, employee_id: PABLO, kind: 'break_start', at: at(P0, '12:00'), source: 'self' },
    { company_id: CO, employee_id: PABLO, kind: 'break_end', at: at(P0, '13:00'), source: 'self' }, { company_id: CO, employee_id: PABLO, kind: 'out', at: at(P0, '17:00'), source: 'self' },
    { company_id: CO, employee_id: PABLO, kind: 'in', at: at(addDays(P0, 1), '08:00'), source: 'self' }, { company_id: CO, employee_id: PABLO, kind: 'out', at: at(addDays(P0, 1), '18:30'), source: 'self' }]) })
  check(r0.status < 300, 'setup: last week\'s punches (8 h and 10.5 h)', String(r0.status))

  // ------------------------------------------------------------ roles: only owner / admin see payroll
  const member = await session(BASE, PASSWORD, 'member@e2e.local')
  let r = await open(BASE, member.page, '/payroll')
  check(await member.page.getByTestId('payroll-denied').count() === 1 && !/\$/.test(r.body.replace(/Plan/g, '')), 'a member cannot open payroll')

  // ------------------------------------------------------------ owner: compensation (history with dates)
  const owner = await session(BASE, PASSWORD, 'owner@e2e.local')
  const p = owner.page
  r = await open(BASE, p, '/payroll')
  check(r.status === 200 && await p.getByTestId('tax-notice').count() === 1 && /NO calculados/.test(r.body), 'owner: payroll opens with the clear "taxes not calculated" notice')
  for (const [emp, type, amount, freq] of [[PABLO, 'hourly', '15.25', 'weekly'], [ANA, 'salary', '52000', 'weekly']]) {
    await open(BASE, p, `/payroll/employees?employee=${emp}`)
    const form = p.getByTestId('comp-form')
    await form.locator('select[name="pay_type"]').selectOption(type); await form.locator('select[name="pay_frequency"]').selectOption(freq)
    await form.locator('input[name="amount"]').fill(amount); await form.locator('input[name="effective_from"]').fill(addDays(P0, -30))
    await form.locator('input[name="reason"]').fill('Contratación (ficticia)')
    r = await submit(p, form.getByRole('button', { name: 'Registrar compensación' }))
    check(/done=compensation_saved/.test(r.url) && (type === 'hourly' ? /\$15\.25\/h/ : /\$52,000\.00\/año/).test(await p.getByTestId('comp-history').innerText()), `owner: records ${type} pay with an effective date`)
  }

  // ------------------------------------------------------------ owner: a weekly run from the time clock
  r = await open(BASE, p, '/payroll?f=weekly')
  const nr = p.getByTestId('new-run')
  check(await nr.locator('input[name="period_start"]').inputValue() === P0 && await nr.locator('input[name="period_end"]').inputValue() === addDays(P0, 6), 'the last closed week is suggested')
  await Promise.all([p.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}\?done=created/, { timeout: 20000 }), nr.getByRole('button', { name: 'Crear borrador' }).click()])
  const RUN = /runs\/([0-9a-f-]{36})/.exec(p.url())[1]
  last = p.url()
  // a deduction item and its assignment (settings exist once the first run is created)
  await open(BASE, p, '/payroll/settings')
  const itemForm = p.getByTestId('payroll-items').locator('form')
  await itemForm.locator('input[name="code"]').fill('RETIRO'); await itemForm.locator('input[name="name"]').fill('Plan de retiro (ficticio)')
  await itemForm.locator('select[name="kind"]').selectOption('deduction'); await itemForm.locator('select[name="calc"]').selectOption('percent'); await itemForm.locator('input[name="percent"]').fill('2.5')
  r = await submit(p, itemForm.getByRole('button', { name: 'Crear concepto' }))
  await open(BASE, p, '/payroll/settings')
  await itemForm.locator('input[name="code"]').fill('BONO'); await itemForm.locator('input[name="name"]').fill('Bonificación'); await itemForm.locator('select[name="kind"]').selectOption('earning')
  await itemForm.locator('select[name="calc"]').selectOption('fixed')
  r = await submit(p, itemForm.getByRole('button', { name: 'Crear concepto' }))
  check(/Plan de retiro/.test(await p.getByTestId('payroll-items').innerText()) && /Bonificación/.test(await p.getByTestId('payroll-items').innerText()), 'owner: creates a % deduction and a bonus item')
  check(/Desactivada/.test(await p.getByTestId('tax-rules').innerText()), 'tax rules are shown as disabled placeholders')
  await open(BASE, p, `/payroll/employees?employee=${PABLO}`)
  const assign = p.getByTestId('comp-detail').locator('form').last()
  await assign.locator('select[name="item_id"]').selectOption({ label: 'Plan de retiro (ficticio) · Deducción · Porcentaje del bruto' })
  await assign.locator('input[name="percent"]').fill('2.5'); await assign.locator('input[name="starts_on"]').fill(addDays(P0, -30))
  r = await submit(p, assign.getByRole('button', { name: 'Asignar' }))
  check(/done=item_assigned/.test(r.url), 'owner: assigns the deduction to the hourly employee')

  await open(BASE, p, `/payroll/runs/${RUN}`)
  r = await submit(p, p.getByRole('button', { name: 'Preparar nómina' }))
  const lines = await p.getByTestId('run-lines').innerText()
  // Pablo: regular 16:00 × $15.25 = $244.00; overtime 2:30 × 1.5 = $57.19; gross $301.19; 2.5 % = $7.53; net $293.66. Ana: $52,000 / 52 = $1,000.00
  check(/done=prepared/.test(r.url) && /Pablo Pagado/.test(lines) && /\$244\.00/.test(lines) && /\$57\.19/.test(lines) && /\$301\.19/.test(lines) && /\$7\.53/.test(lines) && /\$293\.66/.test(lines),
    'preview: hours from the clock, overtime ×1.5, % deduction — exact cents', lines.slice(0, 400))
  check(/\$1,000\.00/.test(lines) && /Clock|Reloj: 18:30 h ✓/.test(lines), 'preview: weekly salary and the verified clock hours')
  check(/\$1,293\.66/.test(await p.getByTestId('run-totals').innerText()), 'totals: net $1,293.66')
  // an adjustment makes the preview stale: approve is hidden until prepared again
  const adj = p.getByTestId('adjustments').locator('form').last()
  await adj.locator('select[name="employee_id"]').selectOption(PABLO); await adj.locator('select[name="item_id"]').selectOption({ label: 'Bonificación · Ingreso' })
  await adj.locator('input[name="amount"]').fill('50')
  r = await submit(p, adj.getByRole('button', { name: 'Añadir ajuste' }))
  check(await p.getByTestId('stale-preview').count() === 1 && await p.getByRole('button', { name: 'Aprobar nómina' }).count() === 0, 'after an adjustment the preview is stale (no approval until prepared again)')
  r = await submit(p, p.getByRole('button', { name: /Volver a preparar/ }))
  // with $50.00 bonus: gross $351.19, 2.5 % = $8.77975 → $8.78, net $342.41
  check(/\$351\.19/.test(await p.getByTestId('run-lines').innerText()) && /\$342\.41/.test(await p.getByTestId('run-lines').innerText()), 'the bonus is included and the % deduction recomputed once')
  // the admin prepares but cannot approve
  const adminS = await session(BASE, PASSWORD, 'admin@e2e.local')
  await open(BASE, adminS.page, `/payroll/runs/${RUN}`)
  check(await adminS.page.getByRole('button', { name: 'Aprobar nómina' }).count() === 0, 'an admin (no payroll.approve) sees no approval')
  await adminS.ctx.close()
  await p.getByTestId('run-actions').locator('input[name="confirm"]').first().check()
  r = await submit(p, p.getByRole('button', { name: 'Aprobar nómina' }))
  check(/done=approved/.test(r.url) && /Aprobada/.test(r.body), 'the owner approves the reviewed version')
  check(await p.getByRole('button', { name: /Preparar|Añadir ajuste/ }).count() === 0, 'an approved run cannot be recomputed or adjusted')
  const entries = await rows('owner@e2e.local', '/rest/v1/journal_entries?select=source,total_cents&source=eq.payroll')
  check(entries.length === 1 && Number(entries[0].total_cents) === 135119, 'ledger: one balanced accrual of $1,351.19 (expense / wages payable / deductions payable)', JSON.stringify(entries))

  // ------------------------------------------------------------ payment record, pay stubs, reports
  r = await submit(p, p.getByTestId('run-actions').getByRole('button', { name: 'Registrar pago' }))
  check(/done=paid/.test(r.url), 'record the payment (no money moved)')
  check((await rows('owner@e2e.local', '/rest/v1/journal_entries?select=id&source=eq.payroll_payment')).length === 1, 'ledger: one payment entry (wages payable → bank)')
  const stubHref = await p.getByTestId('run-lines').getByRole('link', { name: 'Recibo (PDF)' }).first().getAttribute('href')
  const pdf = await owner.ctx.request.get(`${BASE}${stubHref}`)
  check(pdf.status() === 200 && pdf.headers()['content-type'] === 'application/pdf' && (await pdf.body()).subarray(0, 5).toString() === '%PDF-', 'pay stub: a real PDF drawn by the Document Studio engine')
  const worker = await session(BASE, PASSWORD, 'worker@e2e.local')
  r = await open(BASE, worker.page, '/clock')
  check(await worker.page.getByTestId('my-payslips').count() === 1, 'the employee sees its own pay stub on its clock')
  const myLine = (await rows('worker@e2e.local', '/rest/v1/payroll_lines?select=id,net_cents,employee_id'))
  check(myLine.length === 1 && myLine[0].employee_id === PABLO && Number(myLine[0].net_cents) === 34241, 'the employee reads only its own line (net $342.41)', JSON.stringify(myLine))
  const myPdf = await worker.ctx.request.get(`${BASE}/api/payroll/payslips/${myLine[0]?.id}`)
  check(myPdf.status() === 200, 'the employee downloads its own pay stub')
  const anaLine = (await rows('owner@e2e.local', `/rest/v1/payroll_lines?select=id&employee_id=eq.${ANA}`))[0]
  const notMine = await worker.ctx.request.get(`${BASE}/api/payroll/payslips/${anaLine?.id}`)
  const memberPdf = await member.ctx.request.get(`${BASE}/api/payroll/payslips/${anaLine?.id}`)
  check(notMine.status() === 404 && memberPdf.status() === 404, 'nobody else\'s pay stub (employee, member): 404')
  check((await rows('worker@e2e.local', '/rest/v1/employee_compensation?select=employee_id')).every((x) => x.employee_id === PABLO), 'the employee sees only its own pay history')
  check((await rows('member@e2e.local', '/rest/v1/employee_compensation?select=id')).length === 0 && (await rows('other@e2e.local', '/rest/v1/payroll_runs?select=id')).length === 0,
    'privacy and isolation: members and other companies see no pay data')
  const forged = await api('member@e2e.local', '/rest/v1/rpc/payroll_approve', { method: 'POST', body: JSON.stringify({ run: RUN, expected_version: 1 }) })
  const direct = await api('owner@e2e.local', `/rest/v1/payroll_lines?run_id=eq.${RUN}`, { method: 'PATCH', body: JSON.stringify({ net_cents: 1 }) })
  check(forged.status >= 400 && direct.status >= 400, 'no approval without the permission; no direct write of pay lines', `${forged.status} ${direct.status}`)
  r = await open(BASE, p, `/payroll/reports?from=${P0}&to=${addDays(P0, 6)}`)
  check(/\$1,342\.41/.test(await p.getByTestId('report-totals').innerText()) && /Pablo Pagado/.test(await p.getByTestId('report-employees').innerText()), 'reports: totals and per-employee summary')
  const csv = await owner.ctx.request.get(`${BASE}/api/payroll/export?run=${RUN}`)
  const csvText = await csv.text()
  check(csv.status() === 200 && /Pablo Pagado/.test(csvText) && /342\.41/.test(csvText) && /Impuestos no calculados/.test(csvText), 'CSV export of the run (exact amounts, taxes not calculated)')

  // ------------------------------------------------------------ reversal (mirror entries, history kept)
  await open(BASE, p, `/payroll/runs/${RUN}`)
  const rev = p.getByTestId('run-actions')
  await rev.locator('input[name="reason"]').fill('Prueba de reversión (ficticia)'); await rev.locator('form:has(input[name="reason"]) input[name="confirm"]').check()
  r = await submit(p, rev.getByRole('button', { name: 'Revertir nómina' }))
  check(/done=reversed/.test(r.url) && /Revertida/.test(r.body), 'reverse a paid run')
  check((await rows('owner@e2e.local', '/rest/v1/journal_entries?select=id&source=in.(payroll_void,payroll_payment_void)')).length === 2, 'ledger: two mirror entries; the originals stay')

  // ------------------------------------------------------------ English, phone, tablet
  await owner.ctx.addCookies([{ name: 'ba_locale', value: 'en', url: BASE }])
  r = await open(BASE, p, `/payroll/runs/${RUN}`)
  check(/Taxes and withholdings: NOT calculated/.test(r.body) && /Reversed/.test(r.body), 'English: the run page')
  const phone = await session(BASE, PASSWORD, 'owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of ['/payroll', `/payroll/runs/${RUN}`, '/payroll/employees', '/payroll/reports']) { await open(BASE, phone.page, path); check(await noOverflow(phone.page), `iPhone: ${path.replace(RUN, ':id')} fits the screen`) }
  const tablet = await session(BASE, PASSWORD, 'owner@e2e.local', { ...devices['iPad (gen 7)'] })
  for (const path of ['/payroll/settings', `/payroll/employees?employee=${PABLO}`]) { await open(BASE, tablet.page, path); check(await noOverflow(tablet.page), `iPad: ${path.replace(PABLO, ':id')} fits the screen`) }
  await phone.ctx.close(); await tablet.ctx.close(); await owner.ctx.close(); await member.ctx.close(); await worker.ctx.close()

  const relevant = consoleErrors.filter((e) => !/favicon|Failed to load resource: the server responded with a status of (400|403|404)/.test(e))
  check(relevant.length === 0, 'no console errors or 5xx responses', relevant.slice(0, 20).join('\n  '))
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
  if (stack) console.log(JSON.stringify(stack.logs, null, 1).slice(-3000))
} finally {
  await browser.close()
  if (stack) await stack.stop()
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

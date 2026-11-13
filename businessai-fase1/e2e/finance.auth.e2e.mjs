#!/usr/bin/env node
/**
 * Authenticated browser test of Finance deliveries 2–6 against a LOCAL stack:
 * local PostgreSQL (built by e2e/local-stack/db.sh) → PostgREST on 127.0.0.1
 * → e2e/local-stack/auth-stub.mjs → `next start`. Nothing remote is reachable:
 * the app gets only 127.0.0.1 URLs and a JWT secret generated for this run.
 *
 *   npm run build
 *   PSQL="psql -h /sock -p 5432 -U postgres" bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/finance.auth.e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('..', import.meta.url))
// the pre-installed Playwright (same as e2e/public.e2e.mjs)
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const { PGRST_BIN, PG_SOCKET, PG_PORT = '5432', DB = 'ba_e2e_fin' } = process.env
if (!PGRST_BIN || !PG_SOCKET?.startsWith('/')) { console.error('Set PGRST_BIN and PG_SOCKET (a local unix-socket directory).'); process.exit(2) }
const APP = Number(process.env.PORT ?? 3220), PGRST = APP + 1, STUB = APP + 2
const BASE = `http://127.0.0.1:${APP}`
const PASSWORD = `local-${randomBytes(9).toString('hex')}`
const SECRET = randomBytes(36).toString('base64url')
const USERS = { 'owner@e2e.local': 'e1000000-0000-4000-8000-000000000001', 'admin@e2e.local': 'e1000000-0000-4000-8000-000000000002',
  'member@e2e.local': 'e1000000-0000-4000-8000-000000000003', 'other@e2e.local': 'e1000000-0000-4000-8000-000000000004' }
const b64 = (s) => Buffer.from(s).toString('base64url')
const jwt = (p) => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64(JSON.stringify(p)); return `${h}.${b}.${createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}` }
const ANON = jwt({ role: 'anon', iss: 'e2e-local', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 })

// ------------------------------------------------------------- stack
const work = mkdtempSync(join(tmpdir(), 'ba-e2e-'))
writeFileSync(join(work, 'postgrest.conf'), [`db-uri = "postgres://authenticator@/${DB}?host=${PG_SOCKET}&port=${PG_PORT}"`, 'db-schemas = "public"', 'db-anon-role = "anon"',
  'db-pool = 10', `jwt-secret = "${SECRET}"`, 'server-host = "127.0.0.1"', `server-port = ${PGRST}`, 'log-level = "warn"'].join('\n'), { mode: 0o600 })
const logs = { pgrst: '', stub: '', next: '' }
const procs = []
function start(name, cmd, args, env) {
  // own process group, so stop() also ends the children (npx → next-server)
  const p = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', (d) => { logs[name] += d }); p.stderr.on('data', (d) => { logs[name] += d })
  procs.push(p); return p
}
start('pgrst', PGRST_BIN, [join(work, 'postgrest.conf')], {})
start('stub', process.execPath, ['e2e/local-stack/auth-stub.mjs'], { STUB_PORT: String(STUB), PGRST_URL: `http://127.0.0.1:${PGRST}`, JWT_SECRET: SECRET, TEST_PASSWORD: PASSWORD, USERS: JSON.stringify(USERS) })
start('next', 'npx', ['next', 'start', '-p', String(APP), '-H', '127.0.0.1'], { NODE_ENV: 'production', APP_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${STUB}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON, NEXT_PUBLIC_APP_URL: BASE, STRIPE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' })
const signal = (sig) => { for (const p of procs) try { process.kill(-p.pid, sig) } catch { /* gone */ } }
const alive = () => procs.some((p) => { try { process.kill(-p.pid, 0); return true } catch { return false } })
// SIGTERM, wait up to 4 s for a graceful exit, then SIGKILL (next-server can linger on open connections)
const stop = async () => { signal('SIGTERM'); for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 200)); signal('SIGKILL'); for (let i = 0; i < 20 && alive(); i++) { await new Promise((r) => setTimeout(r, 100)); signal('SIGKILL') } rmSync(work, { recursive: true, force: true }) }
process.on('exit', () => { signal('SIGKILL'); rmSync(work, { recursive: true, force: true }) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stop(); process.exit(130) })
async function ready(url, ms = 60000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 400)) }
  throw new Error(`not ready: ${url}\n${JSON.stringify(logs, null, 1).slice(0, 3000)}`)
}
await ready(`http://127.0.0.1:${PGRST}/`); await ready(`http://127.0.0.1:${STUB}/auth/v1/logout`); await ready(`${BASE}/login`)
if (process.env.SERVE_ONLY) {   // debugging: keep the local stack up and print how to sign in
  writeFileSync(process.env.SERVE_ONLY, JSON.stringify({ base: BASE, password: PASSWORD }), { mode: 0o600 })
  console.log(`serving ${BASE}`); await new Promise(() => {})
}

// ------------------------------------------------------------- helpers
let passed = 0, failed = 0
const results = []
let last = { url: '', flash: '' }   // where the last step landed, printed with a failure
const check = (cond, label, extra = '') => { results.push([cond, label]); if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last.url} ${last.flash}]`) } }
async function remember(page) {
  last = { url: page.url().replace(BASE, ''), flash: (await page.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => [])).filter((t) => !/límite de tu plan|plan limit/.test(t)).join(' / ').slice(0, 200) }
}
const browser = await chromium.launch()
const consoleErrors = []
async function session(email, opts = {}) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url()}: ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url()}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) consoleErrors.push(`${email} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')} (page ${page.url().replace(BASE, '')})`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  return { ctx, page }
}
async function open(page, path) {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })   // pages stream (Suspense)
  const body = await page.locator('body').innerText()
  await remember(page)
  return { status: r?.status() ?? 0, body, url: page.url(), broken: /Algo salió mal|Something went wrong|Application error|Internal Server Error/.test(body) }
}
const ok = (r) => r.status < 400 && !r.broken
const here = async (page) => ({ body: await page.locator('body').innerText(), url: page.url() })   // the page an action redirected to
async function selectByPrefix(page, sel, prefix) {
  const value = await page.locator(sel).evaluate((el, p) => [...el.options].find((o) => o.text.trim().startsWith(p))?.value ?? '', prefix)
  if (!value) throw new Error(`no option starting with ${prefix} in ${sel}`)
  await page.selectOption(sel, value)
}
async function submit(page, formSel) {
  // every action redirects (…?done= / ?error=): wait until the URL actually changes
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.toString() !== before && /done=|error=|\/finance\/budgets\/[0-9a-f-]{36}/.test(u.toString()), { timeout: 20000 }).catch(() => {}),
    page.locator(formSel).locator('button[type="submit"]').first().click()])
  await page.waitForLoadState('networkidle')
  await remember(page)
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date())
const year = today.slice(0, 4)

try {
  // ----------------------------------------------------------- login
  {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await page.goto(`${BASE}/login`)
    await page.fill('input[name="email"]', 'owner@e2e.local'); await page.fill('input[name="password"]', 'wrong-password-123')
    await page.click('form button[type="submit"]'); await page.waitForTimeout(1500)
    check(new URL(page.url()).pathname === '/login', 'login: a wrong password keeps the user on /login')
    const r = await open(page, '/finance'); check(new URL(r.url).pathname === '/login', 'login: /finance without a session → /login')
    await ctx.close()
  }
  const owner = await session('owner@e2e.local')
  const p = owner.page
  check(!new URL(p.url()).pathname.startsWith('/login'), 'login: the owner signs in with the login form (local auth)')

  // ----------------------------------------------------------- every finance screen renders with data
  const screens = ['/accounting', '/accounting/accounts', '/accounting/journal', '/accounting/journal/new', '/accounting/ledger', '/accounting/trial-balance', '/accounting/periods',
    '/payables', '/payables/new', '/payables/vendors', '/payables/recurring', '/payables/reports', '/payables/settings',
    '/receivables', '/receivables/aging',
    '/bank', '/bank/accounts', '/bank/import', '/bank/reconciliations', '/bank/reports',
    '/finance', '/finance/income-statement', '/finance/balance-sheet', '/finance/cash-flow', '/finance/budgets', '/finance/projections',
    `/finance/income-statement?period=year&ref=${today}&compare=last_year`, `/finance/income-statement?period=quarter&ref=${today}`,
    `/finance/income-statement?period=custom&from=${year}-01-01&to=${today}&compare=previous`, `/finance/cash-flow?period=year&ref=${today}`]
  for (const s of screens) { const r = await open(p, s); check(ok(r), `renders ${s}`, `status ${r.status}${r.broken ? ' error boundary' : ''}`) }

  // ----------------------------------------------------------- D2 ledger: a manual entry through the form, an unbalanced one refused
  {
    await open(p, '/accounting/journal/new')
    await p.fill('input[name="entry_date"]', today); await p.fill('input[name="description"]', 'Aporte E2E navegador')
    await selectByPrefix(p, 'select[name="account_0"]', '1000'); await p.fill('input[name="debit_0"]', '125.50')
    await selectByPrefix(p, 'select[name="account_1"]', '3000'); await p.fill('input[name="credit_1"]', '125.50')
    await submit(p, 'form:has(input[name="entry_date"])')
    const j = await open(p, '/accounting/journal')
    check(j.body.includes('Aporte E2E navegador'), 'D2: a balanced manual entry is posted from the form and listed in the journal')
    await open(p, '/accounting/journal/new')
    await p.fill('input[name="entry_date"]', today); await p.fill('input[name="description"]', 'Descuadrado E2E')
    await selectByPrefix(p, 'select[name="account_0"]', '1000'); await p.fill('input[name="debit_0"]', '100')
    await selectByPrefix(p, 'select[name="account_1"]', '3000'); await p.fill('input[name="credit_1"]', '90')
    await submit(p, 'form:has(input[name="entry_date"])')
    const j2 = await open(p, '/accounting/journal')
    check(!j2.body.includes('Descuadrado E2E'), 'D2: an unbalanced entry is refused (not in the journal)')
    const tb = await open(p, `/accounting/trial-balance?as_of=${today}`)
    check(ok(tb) && /125[.,]50|1000/.test(tb.body), 'D2: the trial balance renders with the new entry')
  }

  // ----------------------------------------------------------- D3 payables: pay the approved bill
  {
    const list = await open(p, '/payables')
    const href = await p.locator('a[href^="/payables/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).find((h) => /^\/payables\/[0-9a-f-]{36}$/.test(h ?? '')) ?? null)
    check(ok(list) && !!href, 'D3: the approved bill is listed', href ?? 'no bill link')
    if (href) {
      await open(p, href)
      await selectByPrefix(p, 'select[name="account_id"]', '1010')
      await submit(p, 'form:has(input[name="paid_on"])')
      const d = await open(p, href)
      check(/\bPagado\b|\bPaid\b/.test(d.body), 'D3: paying the bill from its page marks it paid')
      check(/\/accounting\/journal\?from=/.test(await p.content()), 'D3: the bill links to its ledger entries')
    }
  }

  // ----------------------------------------------------------- D4 receivables
  {
    const r = await open(p, '/receivables')
    check(r.body.includes('Cliente Uno') && /1[,.]000[.,]00/.test(r.body), 'D4: the overdue invoice of Cliente Uno shows its 1,000.00 balance (1,500.00 − 500.00 paid)')
    const inv = await p.locator('a[href^="/receivables/invoices/"]').first().getAttribute('href').catch(() => null)
    if (inv) { const d = await open(p, inv); check(ok(d) && d.body.includes('Cliente Uno'), 'D4: the invoice collection page opens') } else check(false, 'D4: invoice link present')
    const a = await open(p, '/receivables/aging'); check(ok(a) && a.body.includes('Cliente Uno'), 'D4: aging report lists the client')
  }

  // ----------------------------------------------------------- D5 bank: account, CSV import, exact matching
  {
    let b = await open(p, '/bank')
    if (await p.locator('form:has(button) >> text=/Activar banca|Activate banking/').count()) { await p.getByRole('button', { name: /Activar banca|Activate banking/ }).click(); await p.waitForLoadState('domcontentloaded') }
    await open(p, '/bank/accounts')
    await p.fill('form:has(select[name="ledger_account_id"]) input[name="name"]', 'Banco E2E')
    await selectByPrefix(p, 'form:has(select[name="ledger_account_id"]) select[name="ledger_account_id"]', '1010')
    await submit(p, 'form:has(select[name="ledger_account_id"])')
    b = await open(p, '/bank')
    check(b.body.includes('Banco E2E'), 'D5: a bank account linked to 1010 is created')
    await open(p, '/bank/import')
    const csv = join(work, 'estado.csv')
    writeFileSync(csv, `Fecha,Descripcion,Importe\n${today.slice(5, 7)}/${today.slice(8, 10)}/${year},Pago Proveedor E2E,-450.00\n${today.slice(5, 7)}/${today.slice(8, 10)}/${year},Comision bancaria,-12.50\n`)
    await p.setInputFiles('input[type="file"][name="file"]', csv)
    await p.waitForTimeout(800)
    await p.selectOption('select:has(option[value="YMD"])', 'MDY')   // the file uses MM/DD/YYYY (Spanish default is DD/MM)
    await p.waitForTimeout(400)
    const confirm = p.locator('button[type="submit"]:not([disabled])', { hasText: /2/ })
    check(await confirm.count() > 0, 'D5: the wizard previews 2 valid rows')
    if (await confirm.count()) { await confirm.first().click(); await p.waitForURL(/done=|error=/, { timeout: 20000 }).catch(() => {}); await p.waitForLoadState('domcontentloaded') }
    await open(p, '/bank/accounts')
    const acc = await p.locator('a[href^="/bank/accounts/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).find((h) => /[0-9a-f-]{36}$/.test(h ?? '')))
    if (acc) {
      const d = await open(p, acc)
      check(/Pago Proveedor E2E/.test(d.body) && /Comision bancaria/.test(d.body), 'D5: imported lines appear on the account')
      await submit(p, 'form:has(input[name="bank_account_id"]):has(button:text-matches("Emparejar exactos|Match exact ones"))')
      const d2 = await open(p, acc)
      check(/Emparejad|Matched/.test(d2.body), 'D5: exact matching pairs the vendor payment with its ledger line')
    } else check(false, 'D5: bank account page link')
    const again = await open(p, '/bank/import')
    check(ok(again), 'D5: import page still renders after an import')
  }

  // ----------------------------------------------------------- D6 statements
  {
    const is = await open(p, `/finance/income-statement?period=year&ref=${today}&compare=last_year`)
    check(/Utilidad bruta/.test(is.body) && /Resultado neto/.test(is.body), 'D6: income statement shows gross profit and net result')
    check(/4000/.test(is.body) && /\/accounting\/ledger\?account=/.test(await p.content()), 'D6: income statement accounts link to their ledger')
    const bs = await open(p, '/finance/balance-sheet')
    check(/Cuadra: activos/.test(bs.body), 'D6: the balance sheet balances (assets = liabilities + equity) with real data', bs.body.match(/No cuadra[^\n]*/)?.[0] ?? '')
    const cf = await open(p, `/finance/cash-flow?period=year&ref=${today}`)
    check(/Cuadra con el efectivo/.test(cf.body), 'D6: the cash flow matches the change in cash', cf.body.match(/No cuadra[^\n]*/)?.[0] ?? '')
    check(/Provisional|Definitivo/.test(is.body), 'D6: statements state whether they are final or provisional')
    const dash = await open(p, '/finance')
    check(/Ingresos del mes/.test(dash.body) && /Alertas y oportunidades/.test(dash.body), 'D6: the dashboard shows KPIs and alerts')
    check(/Proveedor|vencen|vencidas/.test(dash.body), 'D6: the dashboard flags overdue receivables / payables')
  }

  // ----------------------------------------------------------- D6 budgets: create → line → approve → publish → version
  let budgetUrl = null
  {
    await open(p, '/finance/budgets')
    await p.fill('form:has(input[name="fiscal_year"]) input[name="name"]', 'Presupuesto E2E')
    await p.fill('input[name="fiscal_year"]', year)
    await submit(p, 'form:has(input[name="fiscal_year"])')
    budgetUrl = new URL(p.url()).pathname
    check(/^\/finance\/budgets\/[0-9a-f-]{36}$/.test(budgetUrl), 'D6: a monthly budget draft is created', p.url())
    await selectByPrefix(p, '#editor select[name="target"]', '4000')
    const amounts = p.locator('#editor input[name="amount"]')
    const n = await amounts.count()
    for (let i = 0; i < n; i++) await amounts.nth(i).fill('3000')
    await p.fill('#editor input[name="note"]', 'Meta de ventas')
    await submit(p, '#editor')
    let b = await here(p)
    check(n === 12 && /Línea guardada/.test(b.body) && /36[,.]000[.,]00/.test(b.body), 'D6: the 12 months of a line are saved in one go (36,000.00 a year)')
    await submit(p, 'form:has(input[name="note"]):has(button:text-matches("^Aprobar$"))')
    b = await here(p)
    check(/Presupuesto aprobado/.test(b.body), 'D6: the owner approves the budget')
    check(!(await p.locator('#editor').count()), 'D6: an approved budget shows no line editor (locked)')
    await submit(p, 'form:has(button:text-matches("^Publicar$"))')
    b = await here(p)
    check(/Presupuesto publicado/.test(b.body), 'D6: the owner publishes it')
    b = await open(p, budgetUrl)
    check(/Presupuesto vs real/.test(b.body) && /favorable|desfavorable/.test(b.body), 'D6: budget vs actual shows variances with their meaning')
    const dl = await Promise.all([p.waitForEvent('download'), p.click('a:text("Excel")')]).then(([d]) => d)
    const xlsxPath = join(work, 'b.xlsx'); await dl.saveAs(xlsxPath)
    const bytes = readFileSync(xlsxPath)
    check(bytes.subarray(0, 2).toString() === 'PK' && /\.xlsx$/.test(dl.suggestedFilename()), 'D6: budget vs actual downloads as .xlsx', dl.suggestedFilename())
    await submit(p, 'form:has(button:text-matches("^Nueva versión$"))')
    b = await open(p, new URL(p.url()).pathname)
    check(/v2/.test(b.body) && /Borrador/.test(b.body), 'D6: a new version is created as a draft (v2)')
  }

  // ----------------------------------------------------------- D6 exports and projections
  {
    const r = await p.request.get(`${BASE}/finance/export?report=income&period=year&ref=${today}&compare=last_year&format=csv`)
    const text = await r.text()
    check(r.status() === 200 && /Finanzas E2E/.test(text) && /Moneda,USD/.test(text) && /Utilidad bruta/.test(text), 'D6: income statement CSV has company, currency and lines')
    const x = await p.request.get(`${BASE}/finance/export?report=balance&format=xlsx`)
    check(x.status() === 200 && (await x.body()).subarray(0, 2).toString() === 'PK', 'D6: balance sheet exports as xlsx')
    const pr = await open(p, '/finance/projections')
    check(/Estimación, no un resultado garantizado/.test(pr.body) && /Conservador/.test(pr.body) && /Optimista/.test(pr.body), 'D6: projections are labelled as estimates with three scenarios')
    await p.fill('input[name="growth"]', '12'); await p.fill('input[name="horizon"]', '9')
    await submit(p, 'form:has(input[name="growth"])')
    const pr2 = await open(p, '/finance/projections')
    check(/Supuestos guardados/.test(pr2.body) || /Guardado/.test(pr2.body), 'D6: editable assumptions are saved')
    check((await p.locator('table tbody tr').first().locator('..').locator('tr').count()) >= 9, 'D6: the projection covers the saved horizon (9 months)')
  }
  await owner.ctx.close()

  // ----------------------------------------------------------- roles and isolation
  {
    const admin = await session('admin@e2e.local')
    const r = await open(admin.page, '/finance/budgets')
    const draft = await admin.page.locator('a[href^="/finance/budgets/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter((h) => /[0-9a-f-]{36}$/.test(h ?? '')))
    check(ok(r) && draft.length >= 2, 'roles: the admin sees the budgets')
    let sawApprove = false
    for (const h of draft) { await open(admin.page, h); if (await admin.page.locator('button:text-matches("^Aprobar$")').count()) sawApprove = true }
    check(!sawApprove, 'roles: the admin is never offered “Approve” (owner only)')
    await admin.ctx.close()
    const member = await session('member@e2e.local')
    for (const s of ['/finance', '/finance/budgets', '/accounting', '/bank']) {
      const m = await open(member.page, s)
      check(/Solo el propietario|Only the owner|no está activad|not enabled/.test(m.body) && !/Ingresos del mes|Cuadra/.test(m.body), `roles: a member cannot open ${s}`)
    }
    const ex = await member.page.request.get(`${BASE}/finance/export?report=income&format=csv`)
    check(ex.status() === 403, 'roles: a member cannot export statements', String(ex.status()))
    await member.ctx.close()
    const other = await session('other@e2e.local')
    const o = await open(other.page, budgetUrl ?? '/finance/budgets/00000000-0000-4000-8000-000000000000')
    check(o.status === 404 || /404|no encontrad|not found/i.test(o.body), 'isolation: another company cannot open this company’s budget')
    const oi = await open(other.page, `/finance/income-statement?period=year&ref=${today}`)
    check(!/4000/.test(oi.body), 'isolation: another company sees none of these accounts')
    await other.ctx.close()
  }

  // ----------------------------------------------------------- phone and tablet layouts
  for (const [name, dev] of [['iPhone 13', devices['iPhone 13']], ['iPad Mini', devices['iPad Mini']]]) {
    const s = await session('owner@e2e.local', dev)
    for (const path of ['/finance', '/finance/income-statement', '/finance/budgets']) {
      await open(s.page, path)
      const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(overflow <= 1, `${name}: ${path} has no horizontal page scroll`, `${overflow}px`)
    }
    await s.ctx.close()
  }
} catch (e) {
  check(false, `unexpected error: ${e.message}`)
} finally {
  await browser.close()
}

const serverErrors = logs.next.split('\n').filter((l) => /Error|⨯/.test(l) && !/NEXT_REDIRECT/.test(l))
check(serverErrors.length === 0, 'no server errors in the Next.js log', serverErrors.slice(0, 5).join(' | '))
check(!/unhandled/.test(logs.stub), 'the app used only the auth endpoints the local stub implements', logs.stub.match(/unhandled[^\n]*/g)?.slice(0, 3).join(' | ') ?? '')
const ce = consoleErrors.filter((c) => !/favicon/.test(c))
check(ce.length === 0, 'no browser console errors', ce.slice(0, 5).join(' | '))
console.log(`\nAuthenticated E2E (local stack): ${passed} passed, ${failed} failed`)
await stop()
process.exit(failed ? 1 : 0)

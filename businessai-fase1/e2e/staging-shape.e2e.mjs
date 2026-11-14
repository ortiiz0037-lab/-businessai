#!/usr/bin/env node
/**
 * What the Preview shows TODAY: the app against a LOCAL database with exactly
 * the schema of the real businessai-staging project (migrations 0001–0011 +
 * 0014a; the module drafts 0015–0035 are not applied there). Fictitious data.
 *
 * For every main route, signed in as the owner of a demo company: no 5xx, no
 * error page, no console error, no horizontal overflow on iPhone, and each
 * module either works or says clearly that it is not enabled yet. Also checks
 * that the other company's client and invoice are not visible.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3382 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-e2e-placeholder npm run build
 *   UNTIL=0014a_permissions SEED=seed-base.sql DB=ba_e2e_stg PSQL=… bash e2e/local-stack/db.sh
 *   DB=ba_e2e_stg PGRST_BIN=… PG_SOCKET=… PG_PORT=… node e2e/staging-shape.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3380)
const NOT_ENABLED = /no est[áa]n? activad[aos]+ en esta base de datos|todavía no est[áa]n? activad|not enabled in this database|no está configurado en este servidor|not configured on this server/i
const ERROR_PAGE = /Algo salió mal|Something went wrong|Application error|Internal Server Error/

// route → what the owner should see on the staging-shaped database
const ROUTES = [
  ['/dashboard', 'works'], ['/clients', 'works'], ['/clients/e3000000-0000-4000-8000-000000000001', 'works'], ['/documents', 'works'],
  ['/documents/e4000000-0000-4000-8000-000000000001', 'works'], ['/payments', 'works'], ['/settings/company', 'works'], ['/billing', 'works'],
  ['/finance', 'pending'], ['/accounting', 'pending'], ['/receivables', 'pending'], ['/payables', 'pending'], ['/bank', 'pending'],
  ['/studio', 'pending'], ['/workforce', 'pending'], ['/payroll', 'pending'], ['/crm', 'pending'], ['/assistant', 'pending'],
]

let passed = 0, failed = 0
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`) } }
const browser = await chromium.launch()
let stack = null
const table = []

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_stg', publicKey: 'local-e2e-placeholder' })
  const { BASE, PASSWORD, api } = stack
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|403|404)/.test(m.text())) errors.push(`${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })

  for (const path of ['/', '/login']) {
    const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    const body = await page.locator('body').innerText()
    check((r?.status() ?? 0) < 400 && !ERROR_PAGE.test(body) && /BusinessAI/.test(body), `public ${path}: loads`)
  }
  await page.fill('input[name="email"]', 'owner@e2e.local'); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  check(!page.url().includes('/login'), 'sign-in with a fictitious owner')

  for (const [path, expect] of ROUTES) {
    const before = errors.length
    const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    const body = await page.locator('body').innerText()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    const state = ERROR_PAGE.test(body) ? 'ERROR' : NOT_ENABLED.test(body) ? 'not enabled (clear message)' : /could not be found|404/.test(body) && !/BusinessAI/.test(body) ? 'not found' : 'works'
    table.push([path, state])
    check((r?.status() ?? 0) < 500 && state !== 'ERROR' && errors.length === before, `${path}: no server error, no error page, no console error`, errors.slice(before).join(' | '))
    check(!overflow, `${path}: fits an iPhone screen`)
    if (expect === 'works') check(state === 'works', `${path}: works on the staging schema`, state)
    else check(state === 'not enabled (clear message)', `${path}: says clearly that the module is not enabled yet`, `${state}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  // isolation on the staging schema (RLS of 0014a): the other company's rows never show
  await page.goto(`${BASE}/clients`, { waitUntil: 'networkidle' })
  check(!/Cliente de Otra Empresa/.test(await page.locator('body').innerText()), 'the other company\'s client is not listed')
  await page.goto(`${BASE}/documents/e4000000-0000-4000-8000-000000000002`, { waitUntil: 'networkidle' })
  check(!/OTRA-0001/.test(await page.locator('body').innerText()), 'the other company\'s invoice does not open')
  const rows = await (await api('owner@e2e.local', '/rest/v1/clients?select=name')).json()
  check(Array.isArray(rows) && rows.length === 1 && rows[0].name === 'Demo · Cliente Uno', 'API: the owner reads only its company\'s clients', JSON.stringify(rows))
  const forged = await api('owner@e2e.local', '/rest/v1/clients', { method: 'POST', body: JSON.stringify({ company_id: 'e2000000-0000-4000-8000-000000000002', name: 'x' }) })
  check(forged.status >= 400, 'API: no insert into another company', String(forged.status))
  const member = await api('member@e2e.local', '/rest/v1/clients?id=eq.e3000000-0000-4000-8000-000000000001', { method: 'DELETE', headers: { prefer: 'return=representation' } })
  const left = await (await api('owner@e2e.local', '/rest/v1/clients?select=id&id=eq.e3000000-0000-4000-8000-000000000001')).json()
  check(left.length === 1, 'permissions: a member cannot delete clients (0014a matrix)', String(member.status))
  await ctx.close()
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e}`)
  if (stack) console.log(JSON.stringify(stack.logs, null, 1).slice(-3000))
} finally {
  await browser.close()
  if (stack) await stack.stop()
}
console.log('\nRoute | state on the staging schema'); for (const [p, s] of table) console.log(`${p} | ${s}`)
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

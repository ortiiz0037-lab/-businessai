#!/usr/bin/env node
/**
 * Browser E2E (Playwright) of the REAL production build, without any
 * backend: Supabase points at an unreachable local port, so nothing here
 * can read or write a remote environment. Covers what needs no data:
 * public pages in Spanish and English, the language switch, the
 * password-reset error page, redirects of protected pages to /login, and
 * the layout (no horizontal overflow) on iPhone, iPad and desktop.
 * Signed-in flows (documents, payments, roles) are covered by the local
 * PostgreSQL suites and need a disposable Supabase stack to run in a browser.
 *
 * Usage: npm run build && npm run test:e2e   (PORT=3210 to change the port)
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PORT ?? 3210)
const BASE = `http://127.0.0.1:${PORT}`

const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'production',
  APP_ENV: 'development',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',          // unreachable on purpose
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'e2e-placeholder',
  NEXT_PUBLIC_APP_URL: BASE,
  STRIPE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
}

let passed = 0
let failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}`) }
}

async function waitForServer(ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/login`, { redirect: 'manual' })).status < 500) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('server did not start')
}

// own process group: stopping it also stops the next-server child (npx alone would leave it serving an old build)
const server = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

const VIEWPORTS = [
  ['iPhone', devices['iPhone 13']],
  ['iPad', devices['iPad (gen 7)']],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
]
const PUBLIC_PAGES = ['/', '/precios', '/login', '/signup', '/forgot-password', '/terminos', '/privacidad', '/invite?token=' + 'f'.repeat(64), '/clock/link?token=' + 'e'.repeat(64), '/kiosk', '/kiosk/setup?token=' + 'd'.repeat(64)]
const PROTECTED = ['/dashboard', '/documents', '/documents/new', '/payments', '/payments/new', '/clients', '/billing', '/settings/company',
  '/settings/team', '/clients/00000000-0000-4000-8000-000000000000', '/clients/00000000-0000-4000-8000-000000000000/edit',
  '/clock', '/workforce', '/workforce/employees', '/workforce/schedule', '/workforce/requests', '/workforce/reports', '/workforce/settings',
  '/accounting', '/accounting/journal', '/accounting/journal/new', '/accounting/ledger', '/accounting/trial-balance', '/accounting/accounts', '/accounting/periods',
  '/payables', '/payables/new', '/payables/vendors', '/payables/recurring', '/payables/reports', '/payables/settings',
  '/receivables', '/receivables/aging', '/receivables/reports', '/receivables/settings',
  '/bank', '/bank/accounts', '/bank/import', '/bank/reconciliations', '/bank/reports', '/bank/export?kind=lines',
  '/finance', '/finance/income-statement', '/finance/balance-sheet', '/finance/cash-flow', '/finance/budgets', '/finance/projections', '/finance/export?report=income&format=csv',
  '/studio', '/studio/new', '/studio/templates', '/studio/brand', '/studio/00000000-0000-4000-8000-000000000000/pdf', '/studio/image?key=logo', '/assistant', '/assistant?c=00000000-0000-4000-8000-000000000000', '/assistant/insights',
  '/pos', '/pos/register', '/pos/sales', '/pos/shifts', '/pos/reports', '/pos/integrations', '/pos/settings', '/settings/account']

try {
  await waitForServer()
  const browser = await chromium.launch()
  for (const [name, device] of VIEWPORTS) {
    const context = await browser.newContext({ ...device })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    for (const path of PUBLIC_PAGES) {
      const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      check(res && res.status() === 200, `${name} ${path}: 200`)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(overflow <= 1, `${name} ${path}: no horizontal overflow (${overflow}px)`)
    }
    check(errors.length === 0, `${name}: no JavaScript errors on public pages${errors.length ? ` (${errors[0]})` : ''}`)
    await context.close()
  }

  // Security headers on public and protected responses (next.config.ts)
  for (const path of ['/', '/login', '/dashboard']) {
    const r = await fetch(`${BASE}${path}`, { redirect: 'manual' })
    const h = (k) => r.headers.get(k) ?? ''
    check(/frame-ancestors 'none'/.test(h('content-security-policy')) && h('x-frame-options') === 'DENY', `${path}: cannot be framed by another site`)
    check(h('x-content-type-options') === 'nosniff' && h('referrer-policy') === 'strict-origin-when-cross-origin', `${path}: nosniff and referrer policy`)
    check(/camera=\(self\)/.test(h('permissions-policy')) && /geolocation=\(\)/.test(h('permissions-policy')), `${path}: camera only for the app, no location`)
  }
  // Language of the sign-in pages: ?lang= first, then the remembered choice (ba_locale), then the
  // browser's language, else Spanish — the rule of the app and of the sign-in server actions.
  {
    const es = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-PR' })
    const p = await es.newPage()
    await p.goto(`${BASE}/login`)
    check(await p.getByRole('button', { name: /iniciar sesión|entrar/i }).count() > 0, 'login in Spanish for a Spanish browser')
    check(await p.evaluate(() => document.documentElement.lang) === 'es', 'login: <html lang="es">')
    await es.close()
    const en = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    const q = await en.newPage()
    await q.goto(`${BASE}/login`)
    check(await q.getByRole('button', { name: /sign in|log in/i }).count() > 0, 'login in English for an English browser')
    await en.close()
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-PR' })
  const page = await context.newPage()
  await page.goto(`${BASE}/login?lang=en`)
  check(await page.getByRole('button', { name: /sign in|log in/i }).count() > 0, 'login in English with ?lang=en')
  check(await page.evaluate(() => document.documentElement.lang) === 'en', 'login: <html lang="en">')
  await page.goto(`${BASE}/login`)
  check(await page.getByRole('button', { name: /sign in|log in/i }).count() > 0, 'English is remembered: /login without ?lang stays English')
  await page.goto(`${BASE}/forgot-password`)
  check(await page.getByRole('button', { name: /send|link/i }).count() > 0, 'English is remembered on password recovery too')
  await page.goto(`${BASE}/forgot-password?lang=en&error=link`)
  check(await page.getByText('opened in another browser').count() > 0, 'reset link error explained in English (I10)')
  await page.goto(`${BASE}/forgot-password?lang=es&error=link`)
  check(await page.getByText('otro navegador').count() > 0, 'reset link error explained in Spanish (I10)')
  await page.goto(`${BASE}/login`)
  check(await page.getByRole('button', { name: /iniciar sesión|entrar/i }).count() > 0, 'switching back to Spanish is remembered')
  // Invitation link: public, explains an unknown link, sends no referrer.
  await page.goto(`${BASE}/invite?token=${'0'.repeat(64)}&lang=es`)
  check(await page.getByText('Enlace no válido').count() > 0, 'an unknown invitation link is explained (Spanish)')
  await page.goto(`${BASE}/invite?token=${'0'.repeat(64)}&lang=en`)
  check(await page.getByText('Invalid link').count() > 0, 'an unknown invitation link is explained (English)')
  check(await page.locator('meta[name="referrer"][content="no-referrer"]').count() === 1, 'the invitation page sends no referrer (token never leaks)')
  // Employee access link: public page, no referrer, sign-in options.
  await page.goto(`${BASE}/clock/link?token=${'e'.repeat(64)}&lang=es`)
  check(await page.getByText('Acceso al reloj ponchador').count() > 0, 'employee access link page in Spanish')
  check(await page.locator('meta[name="referrer"][content="no-referrer"]').count() === 1, 'the employee link page sends no referrer')
  const csv = await fetch(`${BASE}/api/workforce/report?from=2026-01-01&to=2026-01-07`, { redirect: 'manual' })
  check(csv.status === 401 || csv.status === 307 || csv.status === 302, `the CSV export refuses anonymous requests (${csv.status})`)
  // POS machine routes (S8): without the provider's signature / the bridge token / the cron secret nothing is accepted
  for (const prov of ['square', 'clover', 'shopify', 'lightspeed_x']) {
    const r = await fetch(`${BASE}/api/pos/webhooks/${prov}`, { method: 'POST', body: '{"type":"order.updated"}', headers: { 'content-type': 'application/json' } })
    check(r.status === 503 || r.status === 401, `the ${prov} webhook refuses an unsigned delivery (${r.status})`)
  }
  const unknownProv = await fetch(`${BASE}/api/pos/webhooks/acme`, { method: 'POST', body: '{}', redirect: 'manual' })
  check([307, 404].includes(unknownProv.status), `an unknown POS provider is not a machine route: sent to sign-in (${unknownProv.status})`)
  const bridge = await fetch(`${BASE}/api/pos/bridge`, { method: 'POST', body: '{"sales":[]}', headers: { authorization: 'Bearer bapos_' + '0'.repeat(64) } })
  check(bridge.status === 503 || bridge.status === 401, `the POS bridge refuses an unknown token (${bridge.status})`)
  const recover = await fetch(`${BASE}/api/pos/recover`, { method: 'POST' })
  check(recover.status === 401, `the POS recovery job needs its secret (${recover.status})`)
  const sq = await fetch(`${BASE}/api/pos/oauth/square/start`, { redirect: 'manual' })
  check([302, 303, 307].includes(sq.status) && !String(sq.headers.get('location')).includes('squareup'), `Square OAuth is not offered while it is not configured (${sq.status} → ${sq.headers.get('location')})`)
  // Shared tablet: public, but without an activation it shows no form and no data.
  await page.goto(`${BASE}/kiosk?lang=es`)
  check(await page.getByText('Tableta no activada').count() > 0 && await page.locator('input[name="pin"]').count() === 0,
    'a tablet that was not activated shows no punch form')
  check(await page.locator('meta[name="referrer"][content="no-referrer"]').count() === 1, 'the kiosk page sends no referrer')
  await page.goto(`${BASE}/kiosk/setup?token=${'d'.repeat(64)}&lang=en`)
  check(await page.getByText('The link is not valid').count() > 0, 'an unknown tablet activation link is refused')
  // Protected pages: never rendered without a session.
  for (const path of PROTECTED) {
    await page.goto(`${BASE}${path}`)
    check(new URL(page.url()).pathname === '/login', `${path} without a session → /login`)
  }
  // Security headers / no secrets in the page.
  const html = await (await fetch(`${BASE}/`)).text()
  check(!/sk_(test|live)_|service_role/i.test(html), 'no secret keys in the public HTML')
  await browser.close()
} catch (error) {
  failed++
  console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  console.log(serverLog.slice(-2000))
} finally {
  try { process.kill(-server.pid, 'SIGTERM') } catch { server.kill('SIGTERM') }
}
console.log(`\nE2E result: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

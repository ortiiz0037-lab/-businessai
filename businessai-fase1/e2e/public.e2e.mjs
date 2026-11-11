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

const server = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

const VIEWPORTS = [
  ['iPhone', devices['iPhone 13']],
  ['iPad', devices['iPad (gen 7)']],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
]
const PUBLIC_PAGES = ['/', '/precios', '/login', '/signup', '/forgot-password', '/terminos', '/privacidad']
const PROTECTED = ['/dashboard', '/documents', '/documents/new', '/payments', '/payments/new', '/clients', '/billing', '/settings/company']

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

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  // Language: Spanish by default, English with ?lang=en.
  await page.goto(`${BASE}/login`)
  check(await page.getByRole('button', { name: /iniciar sesión|entrar/i }).count() > 0, 'login in Spanish by default')
  await page.goto(`${BASE}/login?lang=en`)
  check(await page.getByRole('button', { name: /sign in|log in/i }).count() > 0, 'login in English with ?lang=en')
  await page.goto(`${BASE}/forgot-password?lang=en&error=link`)
  check(await page.getByText('opened in another browser').count() > 0, 'reset link error explained in English (I10)')
  await page.goto(`${BASE}/forgot-password?error=link`)
  check(await page.getByText('otro navegador').count() > 0, 'reset link error explained in Spanish (I10)')
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
  server.kill('SIGTERM')
}
console.log(`\nE2E result: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

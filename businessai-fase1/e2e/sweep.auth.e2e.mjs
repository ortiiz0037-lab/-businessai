#!/usr/bin/env node
/**
 * Launch-readiness sweep — every signed-in page of the app, in the browser, on the LOCAL stack only.
 *
 * The route list is read from src/app/(app)/** /page.tsx, so a new page is swept without editing this
 * file. Dynamic segments are filled with records of the local seed (client, invoice, vendor, employee);
 * a dynamic route without a seed record is reported as skipped (its module suite covers it).
 *
 * For each page it checks, as the OWNER:
 *   · desktop 1440×900 in Spanish and English, iPhone 13 in Spanish, iPad Mini in English
 *   · HTTP status < 500, the error screen ("Algo salió mal" / "Something went wrong") not shown,
 *     no horizontal page scroll, no console / page errors, no failed (≥ 500) request,
 *     <html lang> matching the language
 * and as a MEMBER (fewest permissions) on desktop: same checks — a page the member may not use must
 * answer with a redirect or a message, never a crash.
 * Public and sign-in pages (login, sign-up, password recovery, invitation, clock, kiosk) are checked on
 * iPhone 13 and desktop.
 * In English, distinctive Spanish interface words are listed as WARN (data from the seed is Spanish
 * on purpose, so these are leads to review, not failures).
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/sweep.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3600)
const CO = 'e2000000-0000-4000-8000-000000000001'

let passed = 0, failed = 0
const failures = [], warnings = [], skipped = []
const check = (cond, label, extra = '') => {
  if (cond) { passed++; return }
  failed++; failures.push(`${label}${extra ? ` — ${extra}` : ''}`); console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`)
}

// ---------------------------------------------------------------- routes from the file system
function pages(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...pages(p))
    else if (name === 'page.tsx') out.push(p)
  }
  return out
}
const appDir = join(root, 'src', 'app', '(app)')
const appRoutes = pages(appDir).map((f) => '/' + relative(appDir, f).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join('/'))
  .map((r) => (r === '/' ? '/dashboard' : r)).sort()

// distinctive interface words (not names used by the seed)
const SPANISH_UI = ['Guardar', 'Cancelar', 'Buscar', 'Eliminar', 'Agregar', 'Configuración', 'Sucursal', 'Acciones', 'Ninguno', 'Ninguna',
  'Todavía', 'Aún no', 'Cerrar sesión', 'Descargar', 'Siguiente', 'Anterior', 'Fecha de', 'Importe', 'Proveedor', 'Factura']

const browser = await chromium.launch()
let stack = null
try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
  const { BASE, PASSWORD, admin } = stack
  const first = async (path) => { const r = await admin(`/${path}`); const j = r.ok ? await r.json() : []; return j?.[0]?.id ?? null }

  // ---------------------------------------------------------------- ids for the dynamic segments
  const ids = {
    client: await first(`clients?company_id=eq.${CO}&select=id&order=id&limit=1`),
    invoice: await first(`documents?company_id=eq.${CO}&document_type=eq.invoice&select=id&order=id&limit=1`),
    document: await first(`documents?company_id=eq.${CO}&select=id&order=id&limit=1`),
    vendor: await first(`vendors?company_id=eq.${CO}&select=id&order=id&limit=1`),
    employee: await first(`employees?company_id=eq.${CO}&select=id&order=id&limit=1`),
  }
  const fill = (r) => {
    const map = [
      [/^\/clients\/\[id\]/, 'client'], [/^\/documents\/\[id\]/, 'document'], [/^\/receivables\/clients\/\[id\]/, 'client'],
      [/^\/receivables\/invoices\/\[id\]/, 'invoice'], [/^\/payables\/vendors\/\[vendorId\]/, 'vendor'], [/^\/workforce\/employees\/\[id\]/, 'employee'],
    ]
    if (!r.includes('[')) return r
    for (const [re, key] of map) if (re.test(r) && ids[key]) return r.replace(/\[[^\]]+\]/, ids[key])
    return null
  }
  const routes = []
  for (const r of appRoutes) { const f = fill(r); if (f) routes.push(f); else skipped.push(r) }
  console.log(`routes: ${appRoutes.length} pages in src/app/(app) · swept ${routes.length} · dynamic without a seed record ${skipped.length}`)

  // ---------------------------------------------------------------- sessions
  async function session(email, opts, locale) {
    const ctx = await browser.newContext({ ...opts })
    await ctx.addCookies([{ name: 'ba_locale', value: locale, url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
    page.on('response', (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
    if (email) {
      await page.goto(`${BASE}/login`)
      await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
      await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
    }
    return { ctx, page, errs }
  }

  async function sweep(name, s, list, locale) {
    let ok = 0
    for (const path of list) {
      s.errs.length = 0
      let status = 0
      try { const r = await s.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45000 }); status = r?.status() ?? 0 } catch (e) { status = -1; s.errs.push(String(e.message).slice(0, 160)) }
      const where = `${name} ${path}`
      const before = failed
      check(status > 0 && status < 500, `${where}: loads`, `status ${status}`)
      const body = await s.page.locator('body').innerText().catch(() => '')
      check(!/Algo salió mal|Something went wrong/.test(body), `${where}: no error screen`)
      const over = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0)
      check(over <= 1, `${where}: no horizontal page scroll`, `${over}px wider`)
      check(s.errs.length === 0, `${where}: no console / request errors`, s.errs.slice(0, 3).join(' | '))
      const lang = await s.page.evaluate(() => document.documentElement.lang).catch(() => '')
      check(lang.startsWith(locale), `${where}: <html lang> is ${locale}`, `lang="${lang}"`)
      if (locale === 'en') {
        const found = SPANISH_UI.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(body))
        if (found.length) warnings.push(`${where}: Spanish interface words in English: ${found.join(', ')}`)
      }
      if (failed === before) ok++
    }
    console.log(`${failed ? '…' : 'PASS'}: ${name}: ${ok} / ${list.length} pages clean`)
  }

  const desktop = { viewport: { width: 1440, height: 900 } }
  const runs = [
    ['owner · desktop · es', 'owner@e2e.local', desktop, 'es'],
    ['owner · desktop · en', 'owner@e2e.local', desktop, 'en'],
    ['owner · iPhone 13 · es', 'owner@e2e.local', devices['iPhone 13'], 'es'],
    ['owner · iPad Mini · en', 'owner@e2e.local', devices['iPad Mini'], 'en'],
    ['member · desktop · es', 'member@e2e.local', desktop, 'es'],
  ]
  for (const [name, email, opts, locale] of runs) {
    const s = await session(email, opts, locale)
    await sweep(name, s, routes, locale)
    await s.ctx.close()
  }

  // ---------------------------------------------------------------- public and sign-in pages
  const publicRoutes = ['/', '/precios', '/privacidad', '/terminos', '/login', '/signup', '/register', '/forgot-password', '/reset-password', '/clock', '/kiosk']
  for (const [name, opts, locale] of [['public · iPhone 13 · es', devices['iPhone 13'], 'es'], ['public · desktop · en', desktop, 'en']]) {
    const s = await session(null, opts, locale)
    await sweep(name, s, publicRoutes, locale)
    await s.ctx.close()
  }
} catch (e) {
  failed++; failures.push(`run aborted: ${e.message}`); console.log(`FAIL: run aborted — ${e.message}`)
  if (stack?.logs) console.log(String(stack.logs.next ?? '').slice(-2000))
} finally {
  await browser.close()
  await stack?.stop?.()
}

if (skipped.length) console.log(`SKIPPED (dynamic, no seed record; covered by their module suite): ${skipped.join(' ')}`)
for (const w of warnings) console.log(`WARN: ${w}`)
console.log(`\nResult: ${passed} passed, ${failed} failed · ${warnings.length} warnings`)
process.exit(failed ? 1 : 0)

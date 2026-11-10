#!/usr/bin/env node
/**
 * Real screenshots of the STAGING Preview (label `staging:test`), every
 * screen on iPhone, iPad and desktop, signed in through the real login form.
 *
 * A temporary user (e3-shots-<stamp>@example.test) is created with the
 * service role, added as admin of the demo company "BusinessAI Demo (QA)"
 * only, and deleted at the end (also on failure). Nothing else is written.
 * If the demo company does not exist, only the public pages are captured.
 *
 * Required: STAGING_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *           STAGING_PROJECT_REF, PINNED_STAGING_REF, PRODUCTION_PROJECT_REF,
 *           VERCEL_AUTOMATION_BYPASS_SECRET, SCREENSHOT_DIR.
 * Output:   SCREENSHOT_DIR/<page>-<device>.png and report.json (HTTP status,
 *           horizontal overflow, console errors per page).
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { checkTarget, DEMO_OWNER_EMAIL } from './demo-company.mjs'
import { DEMO_COMPANY_NAME } from './demo-data.mjs'

const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1) }

export const PUBLIC_PAGES = ['/', '/login', '/signup', '/precios', '/terminos', '/privacidad']
export const APP_PAGES = ['/dashboard', '/clients', '/documents', '/documents/new?type=invoice', '/documents/new?type=quote',
  '/payments', '/settings/company', '/billing']

const slug = (p) => p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'

async function main() {
  const env = process.env
  const problem = checkTarget(env)
  if (problem) fail(problem)
  if (!env.STAGING_URL || !env.SCREENSHOT_DIR) fail('STAGING_URL and SCREENSHOT_DIR are required')
  if (env.STAGING_URL.includes(env.PRODUCTION_PROJECT_REF)) fail('the URL mentions the production project')
  const base = env.STAGING_URL.replace(/\/$/, '')
  const out = env.SCREENSHOT_DIR
  mkdirSync(out, { recursive: true })

  // require(): resolves a project install (CI: npm install --no-save) or a global one.
  const { chromium, devices } = createRequire(import.meta.url)('playwright')
  const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  // Demo company (owned by the dedicated demo account).
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const owner = list?.users.find((u) => u.email === DEMO_OWNER_EMAIL)
  const { data: companies } = owner
    ? await admin.from('companies').select('id').eq('name', DEMO_COMPANY_NAME).eq('created_by', owner.id)
    : { data: [] }
  const companyId = companies?.[0]?.id ?? null

  let userId = null
  const email = `e3-shots-${Date.now()}@example.test`
  const password = randomBytes(18).toString('base64url')
  const report = []
  const browser = await chromium.launch()
  // The Vercel toolbar keeps a connection open (the page never goes "network idle"): skip it while capturing.
  const headers = { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '', 'x-vercel-set-bypass-cookie': 'true', 'x-vercel-skip-toolbar': '1' }
  const targets = { iphone: devices['iPhone 15 Pro'], ipad: devices['iPad Pro 11'], desktop: { viewport: { width: 1440, height: 900 } } }

  try {
    if (companyId) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'QA Capturas' } })
      if (error) throw error
      userId = data.user.id
      const m = await admin.from('memberships').insert({ company_id: companyId, user_id: userId, role: 'admin' })
      if (m.error) throw m.error
    } else {
      console.log('Demo company not found: only public pages are captured.')
    }
    // First invoice of the demo company, for the document detail screen.
    const { data: inv } = companyId
      ? await admin.from('documents').select('id').eq('company_id', companyId).eq('document_type', 'invoice').neq('status', 'draft').limit(1)
      : { data: [] }
    const appPages = companyId ? [...APP_PAGES, ...(inv?.[0] ? [`/documents/${inv[0].id}`] : [])] : []

    for (const [device, dev] of Object.entries(targets)) {
      for (const locale of ['es', 'en']) {
        const ctx = await browser.newContext({ ...dev, deviceScaleFactor: device === 'desktop' ? 1 : 2, extraHTTPHeaders: headers, locale: locale === 'en' ? 'en-US' : 'es-PR' })
        await ctx.addCookies([{ name: 'ba_locale', value: locale, url: base }])
        const page = await ctx.newPage()
        const errors = []
        page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)) })
        const settle = async () => {
          await page.waitForLoadState('load', { timeout: 60000 })
          await page.evaluate(() => document.fonts?.ready).catch(() => {})
          await page.waitForTimeout(800)
        }
        // One page failing is recorded and does not stop the others.
        const shoot = async (path) => {
          errors.length = 0
          const file = `${slug(path).replace(/_[0-9a-f]{8}(_[0-9a-f]{4}){3}_[0-9a-f]{12}$/i, '_detail')}-${device}-${locale}.png`
          const entry = { path: path.replace(/[0-9a-f-]{36}/i, ':id'), device, locale, status: 0, overflowPx: 0, consoleErrors: [], file, error: null }
          try {
            const res = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 60000 })
            await settle()
            // Compare with the device width, not innerWidth: mobile emulation (like Safari) zooms out
            // and widens the layout viewport when content is too wide, which would hide the overflow.
            const inner = page.viewportSize()?.width ?? 0
            const scroll = await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))
            await page.screenshot({ path: `${out}/${file}`, fullPage: true })
            Object.assign(entry, { status: res?.status() ?? 0, overflowPx: scroll - inner })
          } catch (e) {
            entry.error = String(e?.message ?? e).split('\n')[0].slice(0, 200)
          }
          entry.consoleErrors = [...errors]
          report.push(entry)
        }
        // Public pages only in Spanish on every device, plus the home page in English.
        if (locale === 'es' || device === 'desktop') for (const p of PUBLIC_PAGES) await shoot(locale === 'en' ? `${p}?lang=en` : p)
        if (companyId) {
          await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
          await settle()
          await page.fill('input[name="email"]', email)
          await page.fill('input[name="password"]', password)
          await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('form button[type="submit"]').first().click()])
          await ctx.addCookies([{ name: 'ba_company', value: companyId, url: base }])
          for (const p of appPages) await shoot(p)
        }
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
    if (userId) {
      await admin.from('memberships').delete().eq('user_id', userId).eq('company_id', companyId)
      const { error } = await admin.auth.admin.deleteUser(userId)
      console.log(error ? `WARN: temporary user not deleted: ${error.message}` : 'Temporary capture user removed.')
    }
    writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1))
  }

  const bad = report.filter((r) => r.error || r.status === 0 || r.status >= 400 || r.overflowPx > 0)
  console.log(`Screenshots: ${report.length} captures (${new Set(report.map((r) => r.path)).size} pages × devices × languages).`)
  for (const r of bad) console.log(`PROBLEM ${r.path} ${r.device} ${r.locale}: status ${r.status}, overflow ${r.overflowPx}px${r.error ? `, ${r.error}` : ''}`)
  const withErrors = report.filter((r) => r.consoleErrors.length)
  for (const r of withErrors) console.log(`CONSOLE ${r.path} ${r.device} ${r.locale}: ${r.consoleErrors[0]}`)
  if (bad.length) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => fail(e?.message ?? String(e)))

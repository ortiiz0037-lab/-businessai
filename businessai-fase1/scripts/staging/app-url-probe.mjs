#!/usr/bin/env node
/**
 * Proves which NEXT_PUBLIC_APP_URL the running Preview build was compiled with — by behaviour, no value is read.
 *
 * The assistant stream route (src/app/api/assistant/stream/route.ts) accepts a request whose Origin is either the
 * request's own origin or NEXT_PUBLIC_APP_URL, and refuses a non-JSON body with 415 BEFORE doing any work.
 * Signed in on the branch ALIAS (STAGING_URL), we POST a plain-text body with:
 *   Origin = APP_URL (the staging domain) → 415 means the build carries APP_URL; 403 means it does not;
 *   Origin = a foreign host              → must stay 403 (the origin check still refuses others).
 * No assistant turn, no provider call, nothing written by the app. A temporary confirmed user
 * (e3-appurl-<stamp>@example.test, created with the service role, NO email sent) signs in through the real
 * /login form and is deleted at the end (also on failure).
 * Env: STAGING_URL, APP_URL, STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY, STAGING_PROJECT_REF,
 *      PINNED_STAGING_REF, PRODUCTION_PROJECT_REF, VERCEL_AUTOMATION_BYPASS_SECRET.
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { checkTarget } from './demo-company.mjs'
import { checkAppUrl } from './preview-app-url.mjs'

/** Meaning of the two answers (pure, tested). */
export function judgeProbe(withAppUrl, withForeign) {
  const lines = [
    { ok: withAppUrl === 415, text: `Origin = APP_URL accepted by the build (HTTP ${withAppUrl}; 403 = the build does not carry APP_URL)` },
    { ok: withForeign === 403, text: `a foreign Origin is still refused (HTTP ${withForeign})` },
  ]
  return { ok: lines.every((l) => l.ok), lines }
}

async function main() {
  const env = process.env
  const problem = checkTarget(env); if (problem) throw new Error(problem)
  if (!env.STAGING_URL || !env.APP_URL || !env.VERCEL_AUTOMATION_BYPASS_SECRET) throw new Error('STAGING_URL, APP_URL and VERCEL_AUTOMATION_BYPASS_SECRET are required')
  const appUrl = env.APP_URL.replace(/\/+$/, '')
  const bad = checkAppUrl(appUrl); if (bad) throw new Error(bad)
  if ((env.STAGING_URL + appUrl).includes(env.PRODUCTION_PROJECT_REF)) throw new Error('a URL mentions the production project')
  const base = env.STAGING_URL.replace(/\/+$/, '')

  const { chromium } = createRequire(import.meta.url)('playwright')
  const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = `e3-appurl-${Date.now()}@example.test`
  const password = randomBytes(18).toString('base64url')
  let userId = null
  const browser = await chromium.launch()
  try {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    userId = data.user.id
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true', 'x-vercel-skip-toolbar': '1' } })
    const page = await context.newPage()
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="password"]', password)
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('form button[type="submit"]').first().click()])
    console.log('Signed in on the branch alias with a temporary user (no email sent).')
    const probe = async (origin) => (await context.request.post(`${base}/api/assistant/stream`, {
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, data: 'x', maxRedirects: 0, failOnStatusCode: false,
    })).status()
    const verdict = judgeProbe(await probe(appUrl), await probe('https://not-the-app.invalid'))
    for (const l of verdict.lines) console.log(`${l.ok ? 'PASS' : 'FAIL'}: ${l.text}`)
    console.log(verdict.ok ? `RESULT: the Preview build carries NEXT_PUBLIC_APP_URL=${appUrl}` : 'RESULT: see the FAIL lines')
    if (!verdict.ok) process.exitCode = 1
  } finally {
    await browser.close()
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      console.log(error ? `WARNING: temporary user not deleted: ${error.message}` : 'Temporary user deleted.')
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

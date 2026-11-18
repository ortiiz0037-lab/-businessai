#!/usr/bin/env node
/**
 * Sign-up, email confirmation and password recovery against STAGING — the real Supabase Auth of the
 * staging project and the deployed staging Preview, through the app's own forms in a real browser.
 * One throw-away user (…@example.com, a reserved domain: nothing is delivered anywhere), removed at the end.
 *
 *   A. Auth settings: sign-ups on, email confirmation required.
 *   B. Sign-up form on the Preview → Supabase accepts it and records that the confirmation email was sent
 *      (confirmation_sent_at). If Supabase cannot send email (no SMTP for outside addresses) it is reported.
 *   C. Before confirming: sign-in is refused, no session.
 *   D. The confirmation link (/auth/confirm?token_hash=…&type=signup, the form the app's email template
 *      uses) confirms the address and signs the person in (→ /onboarding).
 *   E. The redirect target of Supabase's own link (action_link → redirect_to) is the Preview, i.e. the
 *      Preview URL is in the staging Auth redirect allow-list (otherwise links land on another site).
 *   F. "Forgot password" form → Supabase records that the recovery email was sent (recovery_sent_at);
 *      the answer is the same generic message (no account enumeration).
 *   G. The recovery link opened in ANOTHER browser → /reset-password → new password saved → signed in;
 *      the old password no longer works, the new one does.
 *   H. A forged / expired link → back to "forgot password" with an explanation, no session.
 * Email DELIVERY to an inbox is not observable here (no mailbox): B and F prove Supabase dispatched it;
 * the links are generated with the admin API (same token Supabase puts in the email).
 *
 * Env: STAGING_URL, STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF, STAGING_SUPABASE_URL,
 *      STAGING_SUPABASE_PUBLISHABLE_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY, VERCEL_AUTOMATION_BYPASS_SECRET.
 * Prints no keys, tokens, links or emails.
 */
import { createRequire } from 'node:module'
import { createClient } from '@supabase/supabase-js'

const env = process.env
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`) }
const info = (t) => console.log(`INFO: ${t}`)
const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1) }

for (const k of ['STAGING_URL', 'STAGING_PROJECT_REF', 'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_PUBLISHABLE_KEY', 'STAGING_SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) fail(`${k} is required`)
const host = new URL(env.STAGING_SUPABASE_URL).hostname
if (!host.startsWith(`${env.STAGING_PROJECT_REF}.`)) fail('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF')
if (env.PRODUCTION_PROJECT_REF && (host.startsWith(`${env.PRODUCTION_PROJECT_REF}.`) || env.STAGING_URL.includes(env.PRODUCTION_PROJECT_REF))) fail('refusing to run against PRODUCTION')

const base = env.STAGING_URL.replace(/\/$/, '')
const stamp = Date.now()
const email = `businessai-e2e-auth-${stamp}@example.com`
const password = `E2e-${stamp}-Aa1!`
const newPassword = `E2e-new-${stamp}-Bb2!`
const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const anon = () => createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const headers = { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '', 'x-vercel-set-bypass-cookie': 'true', 'x-vercel-skip-toolbar': '1' }
const { chromium } = createRequire(import.meta.url)('playwright')

async function findUser() {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const u = data.users.find((x) => x.email === email)
    if (u) return u
    if (data.users.length < 200) return null
  }
  return null
}
const canSignIn = async (pw) => !(await anon().auth.signInWithPassword({ email, password: pw })).error
const tokenHash = async (type, extra = {}) => {
  const { data, error } = await admin.auth.admin.generateLink({ type, email, ...extra })
  if (error) throw new Error(`generateLink ${type}: ${error.status ?? ''} ${error.code ?? error.message}`)
  return data.properties
}

let userId = null
const browser = await chromium.launch()
try {
  // ----------------------------------------------------------------- A. settings
  const s = await (await fetch(`${env.STAGING_SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.STAGING_SUPABASE_PUBLISHABLE_KEY } })).json()
  check('A. staging Auth: email sign-up enabled', s.external?.email === true && s.disable_signup === false)
  check('A. staging Auth: email confirmation required', s.mailer_autoconfirm === false)

  // ----------------------------------------------------------------- B. sign-up form
  const ctx = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const page = await ctx.newPage()
  await page.goto(`${base}/signup?lang=es`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.fill('input[name="fullName"]', 'QA Correo')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.locator('form button[type="submit"]').first().click()
  const answer = page.locator('p.alert-success, p.alert-danger').first()
  await answer.waitFor({ timeout: 30000 }).catch(() => {})
  const said = (await answer.innerText().catch(() => '')).trim()
  const signupOk = /Te enviamos un correo/.test(said)
  check('B. sign-up form: "we sent you an email to confirm"', signupOk, signupOk ? '' : `the form answered: "${said.slice(0, 120)}"`)
  // the form's own answer (not Next.js's empty route announcer, which also has role="alert")
  let u = null
  for (let i = 0; i < 10 && !u; i++) { u = await findUser(); if (!u) await new Promise((r) => setTimeout(r, 1000)) }
  if (!u) {
    info('the sign-up did not create the user; creating it with the admin API to test the remaining steps')
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: false })
    if (error) throw error
    u = data.user
  }
  userId = u.id
  check('B. Supabase recorded the confirmation email as sent', signupOk && Boolean(u.confirmation_sent_at), u.confirmation_sent_at ? 'confirmation_sent_at set' : 'not sent')
  check('B. the new account is not confirmed yet', !u.email_confirmed_at)

  // ----------------------------------------------------------------- C. before confirming
  check('C. before confirming: sign-in is refused', !(await canSignIn(password)))
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' })
  check('C. before confirming: protected pages send to /login', new URL(page.url()).pathname === '/login')

  // ----------------------------------------------------------------- D. confirmation link
  {
    const props = await tokenHash('signup', { password })
    await page.goto(`${base}/auth/confirm?token_hash=${encodeURIComponent(props.hashed_token)}&type=signup&next=/onboarding`, { waitUntil: 'networkidle' })
    check('D. confirmation link: signed in and sent to onboarding', new URL(page.url()).pathname === '/onboarding', new URL(page.url()).pathname)
    u = await findUser()
    check('D. the address is now confirmed', Boolean(u?.email_confirmed_at))
    check('D. after confirming: sign-in works', await canSignIn(password))
  }
  await ctx.close()

  // ----------------------------------------------------------------- E. redirect allow-list (after D: opening
  // Supabase's own link also confirms an address)
  {
    const props = await tokenHash('magiclink', { options: { redirectTo: `${base}/auth/confirm?next=/onboarding` } })
    const r = await fetch(props.action_link, { redirect: 'manual' })
    const loc = r.headers.get('location') ?? ''
    const target = loc ? new URL(loc, env.STAGING_SUPABASE_URL) : null
    check('E. Supabase sends its links back to the Preview (redirect URL allowed in staging Auth)',
      r.status >= 300 && r.status < 400 && target?.origin === new URL(base).origin,
      target ? `redirects to ${target.origin === new URL(base).origin ? 'the Preview' : `${target.host} (the Site URL), not the Preview: add the Preview URL to Auth → URL configuration → Redirect URLs`}` : `HTTP ${r.status}`)
  }

  // ----------------------------------------------------------------- F. forgot-password form
  {
    const before = (await findUser())?.recovery_sent_at ?? null
    const c = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
    const p = await c.newPage()
    await p.goto(`${base}/forgot-password?lang=es`, { waitUntil: 'networkidle' })
    await p.fill('input[name="email"]', email)
    await p.locator('form button[type="submit"]').first().click()
    const a = p.locator('p.alert-success, p.alert-danger').first()
    await a.waitFor({ timeout: 30000 }).catch(() => {})
    const msg = (await a.innerText().catch(() => '')).trim()
    check('F. forgot-password form: generic answer (no account enumeration)', /Si existe una cuenta/.test(msg), msg.slice(0, 120))
    const after = (await findUser())?.recovery_sent_at ?? null
    check('F. Supabase recorded the recovery email as sent', Boolean(after) && after !== before, after ? 'recovery_sent_at updated' : 'not sent')
    // the same answer for an address without an account
    await p.goto(`${base}/forgot-password?lang=es`, { waitUntil: 'networkidle' })
    await p.fill('input[name="email"]', `nobody-${stamp}@example.com`)
    await p.locator('form button[type="submit"]').first().click()
    await a.waitFor({ timeout: 30000 }).catch(() => {})
    check('F. an unknown address gets the same answer', /Si existe una cuenta|Demasiados intentos/.test((await a.innerText().catch(() => '')).trim()))
    await c.close()
  }

  // ----------------------------------------------------------------- G. reset in another browser
  {
    const props = await tokenHash('recovery')
    const c = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
    const p = await c.newPage()
    await p.goto(`${base}/auth/confirm?token_hash=${encodeURIComponent(props.hashed_token)}&type=recovery&next=/reset-password`, { waitUntil: 'networkidle' })
    check('G. recovery link (another browser) opens the new-password form', new URL(p.url()).pathname === '/reset-password' && await p.locator('input[name="confirm"]').count() > 0, new URL(p.url()).pathname)
    await p.fill('input[name="password"]', newPassword)
    await p.fill('input[name="confirm"]', newPassword)
    await Promise.all([p.waitForURL((x) => x.pathname !== '/reset-password', { timeout: 30000 }).catch(() => {}), p.locator('form button[type="submit"]').first().click()])
    check('G. new password saved: signed in and out of the reset page', ['/dashboard', '/onboarding'].includes(new URL(p.url()).pathname), new URL(p.url()).pathname)
    check('G. the old password no longer works', !(await canSignIn(password)))
    check('G. the new password works', await canSignIn(newPassword))
    await c.close()
  }

  // ----------------------------------------------------------------- H. forged link
  {
    const c = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
    const p = await c.newPage()
    await p.goto(`${base}/auth/confirm?token_hash=${'0'.repeat(56)}&type=recovery&next=/reset-password`, { waitUntil: 'networkidle' })
    const url = new URL(p.url())
    check('H. a forged / expired recovery link → "forgot password" with an explanation', url.pathname === '/forgot-password' && url.searchParams.get('error') === 'link')
    await p.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' })
    check('H. … and no session', new URL(p.url()).pathname === '/login')
    await c.close()
  }
} catch (e) {
  check('unexpected error', false, String(e?.message ?? e).replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 200))
} finally {
  await browser.close()
  if (!userId) { try { userId = (await findUser())?.id ?? null } catch { /* ignore */ } }
  if (userId) {
    // companies the test user may own (none expected: onboarding is not completed)
    const { error } = await admin.auth.admin.deleteUser(userId)
    console.log(error ? `WARN: the test user could not be removed (${error.message}) — remove it in Auth` : 'test user removed')
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed.`)
  process.exit(failed ? 1 : 0)
}

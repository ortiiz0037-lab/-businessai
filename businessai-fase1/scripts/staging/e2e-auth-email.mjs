#!/usr/bin/env node
/**
 * Sign-up, email confirmation and password recovery against STAGING — the real Supabase Auth of the staging
 * project and the deployed staging Preview, through the app's own forms in a real browser.
 *
 * Staging sends Auth email through Supabase's DEFAULT email service (no custom SMTP yet): it delivers only to
 * addresses of the Supabase organisation's members and only a couple of messages per hour. So:
 *
 *   --mode=links  (default; run by every `staging:test`)  — sends NO email at all.
 *       A. Auth settings: sign-ups on, email confirmation required.
 *       E. Supabase sends its links back to the Preview (Site URL / Redirect URLs).
 *       C. An unconfirmed account cannot sign in; protected pages send to /login.
 *       D. The confirmation link (token_hash, as Supabase puts in the email) confirms and signs in → /onboarding.
 *       G. The recovery link opened in ANOTHER browser → new password → signed in; old password refused.
 *       H. A forged / expired link → "forgot password" with an explanation, no session.
 *       The links are generated with the admin API (no email sent). The throw-away user's address is a
 *       "+e2e" variant of the authorised mailbox; nothing is ever sent to it.
 *
 *   --mode=inbox  (label `staging:auth-email`) — sends EXACTLY TWO real emails to the authorised mailbox
 *       (STAGING_AUTH_TEST_EMAIL) and needs a person to open them:
 *       0. Refuses before sending anything if A or E fail, if any Auth email was sent in the last 60 minutes
 *          (default service: ~2 per hour), or if a non-test account already uses that address.
 *       1. Sign-up through the Preview form → "we sent you an email"; confirmation_sent_at recorded.
 *          The person taps the link in the email → the address becomes confirmed (polled, up to 15 min).
 *       2. "Forgot password" form → generic answer; recovery_sent_at recorded. The person taps the link,
 *          chooses a new password and saves → signed in after the recovery email (polled, up to 15 min).
 *       3. The test account is removed.
 *
 * Env: STAGING_URL, STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF, STAGING_SUPABASE_URL,
 *      STAGING_SUPABASE_PUBLISHABLE_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY, VERCEL_AUTOMATION_BYPASS_SECRET,
 *      STAGING_AUTH_TEST_EMAIL (a mailbox of a member of the Supabase organisation; a repository secret),
 *      AUTH_INBOX_WAIT_MS (inbox mode, per email; default 15 minutes).
 * Prints no keys, tokens, links or email addresses (this repository's logs are public).
 */
import { createRequire } from 'node:module'
import { createClient } from '@supabase/supabase-js'
import { mailboxProblem, parseMailbox } from './auth-mailbox.mjs'

const env = process.env
const mode = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=links').slice(7)
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`) }
const info = (t) => console.log(`INFO: ${t}`)
const fail = (m) => { console.error(`ERROR: ${m}`); process.exit(1) }
const redact = (t) => String(t ?? '').replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 200)

if (!['links', 'inbox'].includes(mode)) fail(`unknown mode ${mode}`)
for (const k of ['STAGING_URL', 'STAGING_PROJECT_REF', 'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_PUBLISHABLE_KEY', 'STAGING_SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) fail(`${k} is required`)
const host = new URL(env.STAGING_SUPABASE_URL).hostname
if (!host.startsWith(`${env.STAGING_PROJECT_REF}.`)) fail('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF')
if (env.PRODUCTION_PROJECT_REF && (host.startsWith(`${env.PRODUCTION_PROJECT_REF}.`) || env.STAGING_URL.includes(env.PRODUCTION_PROJECT_REF))) fail('refusing to run against PRODUCTION')

const mailbox = parseMailbox(env.STAGING_AUTH_TEST_EMAIL)
if (!mailbox) fail(`STAGING_AUTH_TEST_EMAIL ${mailboxProblem(env.STAGING_AUTH_TEST_EMAIL)}`)

const base = env.STAGING_URL.replace(/\/$/, '')
const stamp = Date.now()
// links mode: a sub-address of the authorised mailbox, never emailed; inbox mode: the mailbox itself
const email = mode === 'inbox' ? mailbox.address : `${mailbox.local}+e2e-${stamp}@${mailbox.domain}`
const password = `E2e-${stamp}-Aa1!`
const newPassword = `E2e-new-${stamp}-Bb2!`
const WAIT = Number(env.AUTH_INBOX_WAIT_MS ?? 15 * 60_000)
const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const anon = () => createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const headers = { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '', 'x-vercel-set-bypass-cookie': 'true', 'x-vercel-skip-toolbar': '1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function allUsers() {
  const out = []
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    out.push(...data.users)
    if (data.users.length < 200) break
  }
  return out
}
const findUser = async (address = email) => (await allUsers()).find((x) => x.email?.toLowerCase() === address.toLowerCase()) ?? null
const canSignIn = async (pw) => !(await anon().auth.signInWithPassword({ email, password: pw })).error
const tokenHash = async (type, address, extra = {}) => {
  const { data, error } = await admin.auth.admin.generateLink({ type, email: address, ...extra })
  if (error) throw new Error(`generateLink ${type}: ${error.status ?? ''} ${error.code ?? redact(error.message)}`)
  return data.properties
}
const isTestUser = (u) => u?.user_metadata?.businessai_e2e === true || u?.app_metadata?.businessai_e2e === true
async function tag(u) { await admin.auth.admin.updateUserById(u.id, { user_metadata: { ...(u.user_metadata ?? {}), businessai_e2e: true } }) }
async function waitFor(label, pred, every = 15_000) {
  const end = Date.now() + WAIT
  while (Date.now() < end) { const u = await findUser(); if (u && await pred(u)) return u; await sleep(every) }
  info(`gave up waiting for: ${label} (${Math.round(WAIT / 60000)} min)`)
  return null
}

/** A: settings. E: Supabase's links come back to the Preview (uses a throw-away user, sends nothing). */
async function settingsAndRedirects() {
  const s = await (await fetch(`${env.STAGING_SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.STAGING_SUPABASE_PUBLISHABLE_KEY } })).json()
  check('A. staging Auth: email sign-up enabled', s.external?.email === true && s.disable_signup === false)
  check('A. staging Auth: email confirmation required (not disabled)', s.mailer_autoconfirm === false)
  const probe = `${mailbox.local}+e2e-redirect-${stamp}@${mailbox.domain}`
  const { data, error } = await admin.auth.admin.createUser({ email: probe, password, email_confirm: true, user_metadata: { businessai_e2e: true } })
  if (error) throw error
  try {
    const props = await tokenHash('magiclink', probe, { options: { redirectTo: `${base}/auth/confirm?next=/onboarding` } })
    const r = await fetch(props.action_link, { redirect: 'manual' })
    const loc = r.headers.get('location') ?? ''
    const target = loc ? new URL(loc, env.STAGING_SUPABASE_URL) : null
    const ok = r.status >= 300 && r.status < 400 && target?.origin === new URL(base).origin
    check('E. Supabase sends its links back to the Preview (Site URL / Redirect URLs)', ok,
      target ? (ok ? 'the Preview' : `${target.host}, not the Preview: Authentication → URL Configuration`) : `HTTP ${r.status}`)
    return ok
  } finally { await admin.auth.admin.deleteUser(data.user.id) }
}

async function linksMode(browser) {
  await settingsAndRedirects()
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: false, user_metadata: { businessai_e2e: true } })
  if (error) throw error
  cleanup.push(data.user.id)
  // C
  check('C. before confirming: sign-in is refused', !(await canSignIn(password)))
  const ctx = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const page = await ctx.newPage()
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' })
  check('C. before confirming: protected pages send to /login', new URL(page.url()).pathname === '/login')
  // D
  const conf = await tokenHash('signup', email, { password })
  await page.goto(`${base}/auth/confirm?token_hash=${encodeURIComponent(conf.hashed_token)}&type=signup&next=/onboarding`, { waitUntil: 'networkidle' })
  check('D. confirmation link: signed in and sent to onboarding', new URL(page.url()).pathname === '/onboarding', new URL(page.url()).pathname)
  check('D. the address is now confirmed', Boolean((await findUser())?.email_confirmed_at))
  check('D. after confirming: sign-in works', await canSignIn(password))
  await ctx.close()
  // G
  const rec = await tokenHash('recovery', email)
  const c2 = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const p2 = await c2.newPage()
  await p2.goto(`${base}/auth/confirm?token_hash=${encodeURIComponent(rec.hashed_token)}&type=recovery&next=/reset-password`, { waitUntil: 'networkidle' })
  check('G. recovery link (another browser) opens the new-password form', new URL(p2.url()).pathname === '/reset-password' && await p2.locator('input[name="confirm"]').count() > 0, new URL(p2.url()).pathname)
  await p2.fill('input[name="password"]', newPassword)
  await p2.fill('input[name="confirm"]', newPassword)
  await Promise.all([p2.waitForURL((x) => x.pathname !== '/reset-password', { timeout: 30000 }).catch(() => {}), p2.locator('form button[type="submit"]').first().click()])
  check('G. new password saved: signed in and out of the reset page', ['/dashboard', '/onboarding'].includes(new URL(p2.url()).pathname), new URL(p2.url()).pathname)
  check('G. the old password no longer works', !(await canSignIn(password)))
  check('G. the new password works', await canSignIn(newPassword))
  await c2.close()
  // H
  const c3 = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const p3 = await c3.newPage()
  await p3.goto(`${base}/auth/confirm?token_hash=${'0'.repeat(56)}&type=recovery&next=/reset-password`, { waitUntil: 'networkidle' })
  const url = new URL(p3.url())
  check('H. a forged / expired recovery link → "forgot password" with an explanation', url.pathname === '/forgot-password' && url.searchParams.get('error') === 'link')
  await p3.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' })
  check('H. … and no session', new URL(p3.url()).pathname === '/login')
  await c3.close()
  info('links mode: no email was sent')
}

async function inboxMode(browser) {
  // 0. preconditions — nothing is sent unless all hold
  const redirectsOk = await settingsAndRedirects()
  const users = await allUsers()
  const hourAgo = Date.now() - 60 * 60_000
  const recent = users.filter((u) => [u.confirmation_sent_at, u.recovery_sent_at, u.email_change_sent_at].some((t) => t && Date.parse(t) > hourAgo))
  const last = Math.max(0, ...users.flatMap((u) => [u.confirmation_sent_at, u.recovery_sent_at, u.email_change_sent_at]).filter(Boolean).map((t) => Date.parse(t)))
  check('0. no Auth email sent in the last 60 minutes (default service limit)', recent.length === 0,
    recent.length ? `last one at ${new Date(last).toISOString()}; run again after ${new Date(last + 60 * 60_000).toISOString()}` : '')
  const existing = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (existing && isTestUser(existing)) { await admin.auth.admin.deleteUser(existing.id); info('removed a previous test account for the mailbox') }
  const blocked = existing && !isTestUser(existing)
  check('0. the mailbox has no real account in staging (a test must not touch it)', !blocked, blocked ? 'an account that is not a test account uses it: use another member mailbox' : '')
  if (!redirectsOk || recent.length || blocked) { info('STOPPED before sending any email'); return }

  // 1. sign-up → confirmation email
  const ctx = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const page = await ctx.newPage()
  await page.goto(`${base}/signup?lang=es`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.fill('input[name="fullName"]', 'QA Correo real')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await page.locator('form button[type="submit"]').first().click()
  const answer = page.locator('p.alert-success, p.alert-danger').first()
  await answer.waitFor({ timeout: 30000 }).catch(() => {})
  const said = (await answer.innerText().catch(() => '')).trim()
  check('1. sign-up form: "we sent you an email to confirm"', /Te enviamos un correo/.test(said), /Te enviamos/.test(said) ? '' : `the form answered: "${said.slice(0, 120)}"`)
  let u = await findUser()
  if (u) { cleanup.push(u.id); await tag(u) }
  check('1. Supabase recorded the confirmation email as sent', Boolean(u?.confirmation_sent_at))
  await ctx.close()
  if (!u?.confirmation_sent_at) return
  console.log(`ACTION: open the confirmation email ("Confirm your signup") in the authorised mailbox and tap the link — waiting up to ${Math.round(WAIT / 60000)} minutes`)
  u = await waitFor('the confirmation link to be opened', (x) => Boolean(x.email_confirmed_at))
  check('1. the REAL confirmation email arrived and its link confirmed the address', Boolean(u?.email_confirmed_at))
  if (!u?.email_confirmed_at) return

  // 2. forgot password → recovery email
  const c2 = await browser.newContext({ extraHTTPHeaders: headers, locale: 'es-PR' })
  const p2 = await c2.newPage()
  await p2.goto(`${base}/forgot-password?lang=es`, { waitUntil: 'networkidle' })
  await p2.fill('input[name="email"]', email)
  await p2.locator('form button[type="submit"]').first().click()
  const a2 = p2.locator('p.alert-success, p.alert-danger').first()
  await a2.waitFor({ timeout: 30000 }).catch(() => {})
  const msg = (await a2.innerText().catch(() => '')).trim()
  check('2. forgot-password form: generic answer (no account enumeration)', /Si existe una cuenta/.test(msg), msg.slice(0, 120))
  await c2.close()
  const sent = await findUser()
  check('2. Supabase recorded the recovery email as sent', Boolean(sent?.recovery_sent_at))
  if (!sent?.recovery_sent_at) return
  const sentAt = Date.parse(sent.recovery_sent_at)
  console.log(`ACTION: open the reset email ("Reset Your Password"), tap the link, choose any new password and save — waiting up to ${Math.round(WAIT / 60000)} minutes`)
  // proof, without knowing the new password: the link signed the person in after the email was sent, and the
  // old password stops working once the new one is saved (polled every 30 s: sign-in attempts are rate limited)
  const opened = await waitFor('the recovery link to be opened', (x) => x.last_sign_in_at && Date.parse(x.last_sign_in_at) > sentAt)
  check('2. the REAL recovery email arrived and its link signed the person in', Boolean(opened))
  const saved = opened ? await waitFor('the new password to be saved', async () => !(await canSignIn(password)), 30_000) : null
  check('2. the new password was saved: the old one no longer works', Boolean(saved))
}

const cleanup = []
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch()
try {
  info(`mode: ${mode}`)
  if (mode === 'links') await linksMode(browser)
  else await inboxMode(browser)
} catch (e) {
  check('unexpected error', false, redact(e?.message ?? e))
} finally {
  await browser.close()
  for (const id of cleanup) {
    const { error } = await admin.auth.admin.deleteUser(id)
    console.log(error ? `WARN: a test account could not be removed (${redact(error.message)}) — remove it in Auth` : 'test account removed')
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed (${mode} mode).`)
  process.exit(failed ? 1 : 0)
}

#!/usr/bin/env node
/**
 * READ-ONLY check of sign-in on the staging Preview. Writes nothing.
 *
 * 1. Which Supabase project the Preview uses: the plain value of
 *    NEXT_PUBLIC_SUPABASE_URL for Preview in Vercel (read-only; a URL, not a
 *    secret), that the keys are not shared with Production, and that the
 *    latest preview of the branch was built after the variables were set.
 *    Also scans the public /login JavaScript for any production ref.
 * 2. Staging Auth public settings (GET /auth/v1/settings with the
 *    publishable key): sign-ups enabled, email confirmation required.
 * 3. Number of users in staging Auth (service role, GET admin users; the
 *    count only — no emails or ids are printed).
 * 4. Whether the database tables the app needs exist (REST probe on
 *    `memberships` and the `create_company` function), i.e. migrations.
 *
 * Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, [VERCEL_TEAM_ID], STAGING_BRANCH,
 *      STAGING_URL, VERCEL_AUTOMATION_BYPASS_SECRET, STAGING_PROJECT_REF,
 *      PRODUCTION_PROJECT_REF, STAGING_SUPABASE_URL,
 *      STAGING_SUPABASE_PUBLISHABLE_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY.
 */

/** Project refs (subdomains of supabase.co) mentioned in a text. */
export function supabaseRefs(text) {
  return [...new Set([...text.matchAll(/https?:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))].sort()
}

/** Script URLs referenced by an HTML page (same origin, /_next/static only). */
export function nextScripts(html) {
  return [...new Set([...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))]
}

function out(level, text) { console.log(`${level.padEnd(5)} ${text}`) }

async function main() {
  const env = process.env
  const base = (env.STAGING_URL ?? '').replace(/\/$/, '')
  const stagingRef = env.STAGING_PROJECT_REF
  const prodRef = env.PRODUCTION_PROJECT_REF
  const supa = env.STAGING_SUPABASE_URL
  let fails = 0
  const fail = (t) => { fails++; out('FAIL', t) }

  // 1a. Supabase URL configured for Preview in Vercel (plain value, read-only) and build order.
  const team = env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : ''
  const vercel = async (path) => {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`https://api.vercel.com${path}${team ? sep + team : ''}`, { headers: { Authorization: `Bearer ${env.VERCEL_TOKEN ?? ''}` } })
    if (!r.ok) throw new Error(`Vercel ${path.split('?')[0]}: HTTP ${r.status}`)
    return r.json()
  }
  const envs = (await vercel(`/v10/projects/${env.VERCEL_PROJECT_ID}/env`)).envs ?? []
  const urlVars = envs.filter((e) => e.key === 'NEXT_PUBLIC_SUPABASE_URL' && (e.target ?? []).includes('preview') && !e.gitBranch)
  let previewVarUpdated = 0
  if (urlVars.length !== 1) fail(`Preview has ${urlVars.length} NEXT_PUBLIC_SUPABASE_URL entries (expected 1)`)
  else {
    const v = urlVars[0]
    const full = await vercel(`/v1/projects/${env.VERCEL_PROJECT_ID}/env/${v.id}`)
    const ref = supabaseRefs(String(full.value ?? ''))[0] ?? 'unknown'
    previewVarUpdated = v.updatedAt ?? v.createdAt ?? 0
    out('INFO', `Preview NEXT_PUBLIC_SUPABASE_URL → project ${ref} (targets: ${v.target.join(', ')})`)
    if (ref === stagingRef && !(v.target ?? []).includes('production')) out('PASS', 'Preview points to the STAGING project only (variable not shared with Production)')
    else fail('Preview Supabase URL is not the staging project, or is shared with Production')
    if (prodRef && ref === prodRef) fail('Preview points to the PRODUCTION project')
  }
  for (const key of ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const shared = envs.filter((e) => e.key === key && (e.target ?? []).includes('preview') && (e.target ?? []).includes('production'))
    if (shared.length) fail(`${key} is shared between Preview and Production`)
    else out('PASS', `${key}: Preview has its own entry (not shared with Production)`)
  }
  const deployments = (await vercel(`/v6/deployments?projectId=${encodeURIComponent(env.VERCEL_PROJECT_ID ?? '')}&limit=50`)).deployments ?? []
  const latest = deployments
    .filter((d) => d.target !== 'production' && (d.state ?? d.readyState) === 'READY' && d.meta?.githubCommitRef === env.STAGING_BRANCH)
    .sort((a, b) => (b.createdAt ?? b.created ?? 0) - (a.createdAt ?? a.created ?? 0))[0]
  if (!latest) fail(`no READY preview deployment for ${env.STAGING_BRANCH}`)
  else {
    const built = latest.createdAt ?? latest.created ?? 0
    out('INFO', `latest READY preview of the branch: ${latest.url} (${new Date(built).toISOString()})`)
    out(built >= previewVarUpdated ? 'PASS' : 'FAIL', 'that deployment was built after the Preview Supabase variables were set (NEXT_PUBLIC_* are build-time)')
    if (built < previewVarUpdated) fails++
  }

  // 1b. Supabase projects visible in the Preview's public JavaScript (informative: the browser
  //     client is only loaded on signed-in pages, so "none" is normal here).
  const headers = { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '' }
  const page = await fetch(`${base}/login`, { headers, redirect: 'manual' })
  out(page.status === 200 ? 'PASS' : 'FAIL', `Preview /login answers HTTP ${page.status}`)
  if (page.status !== 200) fails++
  const html = await page.text()
  let bundle = html
  for (const src of nextScripts(html)) {
    const r = await fetch(`${base}${src}`, { headers })
    if (r.ok) bundle += await r.text()
  }
  const refs = supabaseRefs(bundle)
  out('INFO', `Supabase projects in the public /login JavaScript: ${refs.join(', ') || 'none (expected: the browser client loads only on signed-in pages)'}`)
  if (prodRef && refs.includes(prodRef)) fail('the PRODUCTION project appears in the Preview JavaScript')

  // 2. Auth settings (public endpoint).
  const s = await fetch(`${supa}/auth/v1/settings`, { headers: { apikey: env.STAGING_SUPABASE_PUBLISHABLE_KEY ?? '' } })
  if (!s.ok) fail(`staging Auth settings: HTTP ${s.status}`)
  else {
    const j = await s.json()
    out(j.disable_signup ? 'WARN' : 'PASS', `staging sign-ups ${j.disable_signup ? 'DISABLED' : 'enabled'}`)
    out(j.external?.email ? 'PASS' : 'FAIL', `email/password provider ${j.external?.email ? 'enabled' : 'DISABLED'}`)
    out('INFO', `email confirmation ${j.mailer_autoconfirm ? 'NOT required (auto-confirm on)' : 'required (a confirmation email must be opened before signing in)'}`)
  }

  // 3. Users in staging Auth (count only).
  const u = await fetch(`${supa}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: { apikey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? '', Authorization: `Bearer ${env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? ''}` },
  })
  if (!u.ok) fail(`staging Auth users: HTTP ${u.status}`)
  else {
    const j = await u.json()
    const users = j.users ?? []
    const confirmed = users.filter((x) => x.email_confirmed_at).length
    out('INFO', `users in staging Auth: ${users.length} (${confirmed} with confirmed email)`)
  }

  // 4. Database objects the app needs (migrations applied?).
  const probe = await fetch(`${supa}/rest/v1/memberships?select=id&limit=1`, {
    headers: { apikey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? '', Authorization: `Bearer ${env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? ''}` },
  })
  const fn = await fetch(`${supa}/rest/v1/rpc/company_billing_state`, {
    method: 'POST',
    headers: { apikey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? '', Authorization: `Bearer ${env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: '00000000-0000-0000-0000-000000000000' }),
  })
  out('INFO', `table memberships: ${probe.ok ? 'exists' : `missing (HTTP ${probe.status})`}`)
  out('INFO', `function company_billing_state: ${fn.status === 404 ? 'missing' : `present (HTTP ${fn.status})`}`)

  console.log(fails ? `RESULT: ${fails} check(s) failed` : 'RESULT: Preview isolated on staging (see INFO lines for what sign-in still needs)')
  process.exit(fails ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

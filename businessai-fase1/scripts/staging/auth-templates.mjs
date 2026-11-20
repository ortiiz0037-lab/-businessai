#!/usr/bin/env node
/**
 * Staging Supabase Auth email templates — link format only (Management API, STAGING project only).
 *
 *   --plan   (default) READ-ONLY: Site URL check + what would change in "Confirm signup" and "Reset password".
 *   --apply  writes ONLY mailer_templates_confirmation_content and mailer_templates_recovery_content, then reads
 *            the configuration back to verify. Nothing else (subjects, other templates, SMTP, Site URL) is sent.
 *
 * Only the link is changed: every `{{ .ConfirmationURL }}` becomes the token_hash link that the app verifies itself
 * (works in any browser; the PKCE `code` link only works in the browser that asked for it). The rest of the
 * template (text, HTML, branding) is kept byte for byte. A template that has neither link is NOT touched (stops).
 * Refuses unless the project is the pinned staging ref and its Site URL is EXPECTED_SITE_URL. Sends no email.
 * Env: SUPABASE_ACCESS_TOKEN, STAGING_PROJECT_REF, PINNED_STAGING_REF, PRODUCTION_PROJECT_REF, EXPECTED_SITE_URL.
 */
export const LINKS = {
  confirmation: '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding',
  recovery: '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password',
}
export const FIELDS = { confirmation: 'mailer_templates_confirmation_content', recovery: 'mailer_templates_recovery_content' }
const CONFIRMATION_URL = /\{\{\s*\.ConfirmationURL\s*\}\}/g

/** New content for one template (pure). */
export function planTemplate(kind, content) {
  const link = LINKS[kind]
  const text = content ?? ''
  const uses = (text.match(CONFIRMATION_URL) ?? []).length
  if (uses > 0) return { op: 'update', uses, content: text.replace(CONFIRMATION_URL, link) }
  if (text.includes(link)) return { op: 'none' }
  return { op: 'blocked', reason: `the ${kind} template has neither {{ .ConfirmationURL }} nor the token_hash link: review it by hand` }
}

/** Guards (pure): staging ref only, and the Site URL must be the staging domain. */
export function checkTarget(env, siteUrl) {
  const ref = env.STAGING_PROJECT_REF ?? ''
  if (!ref || ref !== env.PINNED_STAGING_REF) return 'STAGING_PROJECT_REF is not the pinned staging project'
  if (!env.PRODUCTION_PROJECT_REF || ref === env.PRODUCTION_PROJECT_REF) return 'refusing the production project'
  if (siteUrl !== undefined && (siteUrl ?? '').replace(/\/+$/, '') !== (env.EXPECTED_SITE_URL ?? '').replace(/\/+$/, ''))
    return `Site URL is ${siteUrl || '(empty)'}, expected ${env.EXPECTED_SITE_URL}: nothing changed`
  return null
}

async function main() {
  const env = process.env
  const apply = process.argv.includes('--apply')
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('secret SUPABASE_ACCESS_TOKEN is not set')
  const bad = checkTarget(env); if (bad) throw new Error(bad)
  const url = `https://api.supabase.com/v1/projects/${env.STAGING_PROJECT_REF}/config/auth`
  const call = async (method, body) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Management API ${method} config/auth: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (token missing access to the staging project)' : ''}`)
    return json
  }
  const cfg = await call('GET')
  console.log(`Project: ${env.STAGING_PROJECT_REF} (staging). Site URL: ${cfg.site_url}`)
  const site = checkTarget(env, cfg.site_url)
  console.log(site ? `FAIL: ${site}` : `PASS: Site URL is ${env.EXPECTED_SITE_URL}`)
  if (site) process.exit(1)
  const plans = Object.fromEntries(Object.keys(LINKS).map((k) => [k, planTemplate(k, cfg[FIELDS[k]])]))
  for (const [k, p] of Object.entries(plans)) {
    console.log(`${k}: ${p.op === 'update' ? `replace ${p.uses} × {{ .ConfirmationURL }} with the token_hash link (rest of the template unchanged)` : p.op === 'none' ? 'already uses the token_hash link' : `STOP — ${p.reason}`}`)
  }
  if (Object.values(plans).some((p) => p.op === 'blocked')) process.exit(1)
  const patch = Object.fromEntries(Object.entries(plans).filter(([, p]) => p.op === 'update').map(([k, p]) => [FIELDS[k], p.content]))
  if (!apply) { console.log('PLAN ONLY — nothing was written.'); return }
  if (Object.keys(patch).length) { await call('PATCH', patch); console.log(`Written: ${Object.keys(patch).join(', ')}`) }
  else console.log('Nothing to write.')
  const after = await call('GET')
  let ok = true
  for (const k of Object.keys(LINKS)) {
    const c = after[FIELDS[k]] ?? ''
    const good = c.includes(LINKS[k]) && !CONFIRMATION_URL.test(c); CONFIRMATION_URL.lastIndex = 0
    const kept = plans[k].op !== 'update' || c === plans[k].content
    console.log(`${good && kept ? 'PASS' : 'FAIL'}: ${k} template uses the token_hash link${kept ? ', rest unchanged' : ' (content differs from the plan)'}`)
    ok &&= good && kept
  }
  const siteAfter = checkTarget(env, after.site_url)
  console.log(siteAfter ? `FAIL: ${siteAfter}` : 'PASS: Site URL unchanged')
  if (!ok || siteAfter) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

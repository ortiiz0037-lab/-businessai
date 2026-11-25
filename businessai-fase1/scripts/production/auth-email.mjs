#!/usr/bin/env node
/**
 * PRODUCTION Supabase Auth email: custom SMTP (Resend) + token_hash links in "Confirm signup" / "Reset password".
 * Same changes that passed on Staging (scripts/staging/auth-smtp.mjs, auth-templates.mjs; real-device test 12/12),
 * for the pinned Production project only. Management API; no database connection, no migration.
 *
 *   --plan   (default) READ-ONLY: DNS of the sender domain, Production Site URL check, current SMTP sender
 *            (never the password) and exactly what --apply would change. Writes nothing.
 *   --apply  writes ONLY smtp_* and the two template bodies, then reads back to verify. Sends no email.
 *            Requires CONFIRM_PRODUCTION=<pinned ref> as well as the flag.
 *
 * Refuses unless: the ref is the pinned Production project (never Staging), EXPECTED_SITE_URL is the https
 * Production origin (not staging.*, not *.vercel.app, not localhost) and equals the project's Site URL, and the
 * Resend DNS records are published. A template with neither link is never touched.
 * Env: SUPABASE_ACCESS_TOKEN, RESEND_SMTP_KEY (apply only), EXPECTED_SITE_URL, SENDER_DOMAIN, [SENDER_NAME],
 *      [CONFIRM_PRODUCTION].
 */
import { resolveMx, resolveTxt } from 'node:dns/promises'
import { FIELDS, LINKS, planTemplate } from '../staging/auth-templates.mjs'
import { SMTP, checkDomain, judgeDns, smtpPatch } from '../staging/auth-smtp.mjs'

export const PRODUCTION_REF = 'rugqcumiuqrjbfwpuslm'
export const STAGING_REF = 'wbfpvxptoujgvflljasc'

/** The Production origin the app is served from (pure). */
export function checkProductionSiteUrl(value) {
  let u
  try { u = new URL(value ?? '') } catch { return 'EXPECTED_SITE_URL is not a URL' }
  if (u.protocol !== 'https:') return 'EXPECTED_SITE_URL must be https'
  if (/^staging\./.test(u.hostname) || /\.vercel\.app$/.test(u.hostname) || /^(localhost|127\.)/.test(u.hostname))
    return 'EXPECTED_SITE_URL must be the Production domain (not staging, a Vercel alias or localhost)'
  if (u.pathname !== '/' || u.search || u.hash) return 'EXPECTED_SITE_URL must be an origin (no path, query or fragment)'
  return null
}

/** Guards (pure): pinned Production ref only; Site URL, when given, must equal EXPECTED_SITE_URL. */
export function checkProductionTarget(env, siteUrl) {
  if ((env.PROJECT_REF ?? PRODUCTION_REF) !== PRODUCTION_REF || PRODUCTION_REF === STAGING_REF) return 'not the pinned Production project'
  const bad = checkProductionSiteUrl(env.EXPECTED_SITE_URL); if (bad) return bad
  if (siteUrl !== undefined && (siteUrl ?? '').replace(/\/+$/, '') !== env.EXPECTED_SITE_URL.replace(/\/+$/, ''))
    return `Production Site URL is ${siteUrl || '(empty)'}, expected ${env.EXPECTED_SITE_URL}: set it in Supabase → Authentication → URL Configuration first; nothing changed`
  return null
}

/** Apply needs the flag AND the typed ref (pure). */
export function applyAllowed(argv, env) {
  return argv.includes('--apply') && env.CONFIRM_PRODUCTION === PRODUCTION_REF
}

async function main() {
  const env = process.env
  const apply = process.argv.includes('--apply')
  if (apply && !applyAllowed(process.argv, env)) throw new Error(`--apply also needs CONFIRM_PRODUCTION=${PRODUCTION_REF}`)
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN is not set')
  const domain = env.SENDER_DOMAIN
  const name = env.SENDER_NAME || 'BusinessAI'
  const bad = checkProductionTarget(env) ?? checkDomain(domain); if (bad) throw new Error(bad)

  const txt = async (h) => (await resolveTxt(h).catch(() => [])).map((r) => r.join(''))
  const dns = judgeDns({ dkim: await txt(`resend._domainkey.${domain}`), mx: await resolveMx(`send.${domain}`).catch(() => []), spf: await txt(`send.${domain}`) })
  for (const d of dns) console.log(`${d.ok ? 'PASS' : 'FAIL'}: ${d.text.replaceAll('<domain>', domain)}`)

  const url = `https://api.supabase.com/v1/projects/${PRODUCTION_REF}/config/auth`
  const call = async (method, body) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    const why = String(json?.message ?? json?.msg ?? json?.error ?? '').replace(/(sbp|re)_[A-Za-z0-9_]+/g, '[key]').slice(0, 300)
    if (!res.ok) throw new Error(`Management API ${method} config/auth: HTTP ${res.status}${why ? ` — ${why}` : ''}`)
    return json
  }
  const cfg = await call('GET')
  const site = checkProductionTarget(env, cfg.site_url)
  console.log(site ? `FAIL: ${site}` : `PASS: Production Site URL is ${env.EXPECTED_SITE_URL}`)
  console.log(`Current SMTP: ${cfg.smtp_host ? `${cfg.smtp_host}:${cfg.smtp_port}, from ${cfg.smtp_sender_name ?? ''} <${cfg.smtp_admin_email ?? ''}>` : 'Supabase default email service'}`)
  console.log(`Would set SMTP: ${SMTP.host}:${SMTP.port}, user ${SMTP.user}, password = the Resend key (secret), from ${name} <no-reply@${domain}>`)
  const plans = Object.fromEntries(Object.keys(LINKS).map((k) => [k, planTemplate(k, cfg[FIELDS[k]])]))
  for (const [k, p] of Object.entries(plans))
    console.log(`${k} template: ${p.op === 'update' ? `replace ${p.uses} × {{ .ConfirmationURL }} with the token_hash link (rest unchanged)` : p.op === 'none' ? 'already uses the token_hash link' : `STOP — ${p.reason}`}`)
  if (site || dns.some((d) => !d.ok) || Object.values(plans).some((p) => p.op === 'blocked')) { console.log('STOP — nothing written (see FAIL / STOP lines).'); process.exit(1) }
  if (!apply) { console.log('PLAN ONLY — nothing was written.'); return }

  if (!env.RESEND_SMTP_KEY?.startsWith('re_')) throw new Error('RESEND_SMTP_KEY is not set or is not a Resend API key')
  const patch = { ...smtpPatch({ domain, name, key: env.RESEND_SMTP_KEY }) }
  for (const [k, p] of Object.entries(plans)) if (p.op === 'update') patch[FIELDS[k]] = p.content
  await call('PATCH', patch)
  const after = await call('GET')
  let ok = after.smtp_host === SMTP.host && String(after.smtp_port) === SMTP.port && after.smtp_user === SMTP.user &&
    after.smtp_admin_email === `no-reply@${domain}` && after.smtp_sender_name === name
  console.log(`${ok ? 'PASS' : 'FAIL'}: Production sends Auth email through ${SMTP.host} from ${name} <no-reply@${domain}>`)
  for (const k of Object.keys(LINKS)) {
    const c = after[FIELDS[k]] ?? ''
    const good = c.includes(LINKS[k]) && !/\{\{\s*\.ConfirmationURL\s*\}\}/.test(c) && (plans[k].op !== 'update' || c === plans[k].content)
    console.log(`${good ? 'PASS' : 'FAIL'}: ${k} template uses the token_hash link, rest unchanged`)
    ok &&= good
  }
  const siteAfter = checkProductionTarget(env, after.site_url)
  console.log(siteAfter ? `FAIL: ${siteAfter}` : 'PASS: Site URL unchanged')
  if (!ok || siteAfter) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

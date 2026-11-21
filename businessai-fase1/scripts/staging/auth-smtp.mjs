#!/usr/bin/env node
/**
 * Custom SMTP (Resend) for the STAGING Supabase project only — Management API.
 *
 *   --plan   (default) READ-ONLY: checks the sending domain's DNS records (public DNS, no key needed) and shows
 *            the staging project's current SMTP state (never the password) and exactly what --apply would set.
 *   --apply  writes ONLY the smtp_* fields of the staging project, then reads back to verify. Sends no email.
 *
 * Refuses unless: pinned staging ref, not production, Site URL is EXPECTED_SITE_URL, and the DNS records Resend
 * needs (DKIM, bounce MX, SPF) are published — sending from an unverified domain would break staging Auth email.
 * Env: SUPABASE_ACCESS_TOKEN, RESEND_SMTP_KEY (apply only), STAGING_PROJECT_REF, PINNED_STAGING_REF,
 *      PRODUCTION_PROJECT_REF, EXPECTED_SITE_URL, SENDER_DOMAIN, SENDER_NAME.
 */
import { resolveMx, resolveTxt } from 'node:dns/promises'
import { checkTarget } from './auth-templates.mjs'

export const SMTP = { host: 'smtp.resend.com', port: '465', user: 'resend' }

/** The smtp_* fields to send (pure). The password is the Resend API key; it is never printed. */
export function smtpPatch({ domain, name, key }) {
  return {
    smtp_host: SMTP.host, smtp_port: SMTP.port, smtp_user: SMTP.user, smtp_pass: key,
    smtp_admin_email: `no-reply@${domain}`, smtp_sender_name: name,
  }
}

/** Sender domain sanity (pure): a subdomain of mybusinessai.site, never the bare domain. */
export function checkDomain(domain) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.mybusinessai\.site$/.test(domain ?? '')) return 'SENDER_DOMAIN must be a subdomain of mybusinessai.site'
  return null
}

/** What Resend needs to be published (pure check of DNS answers). */
export function judgeDns({ dkim, mx, spf }) {
  return [
    { ok: dkim.some((t) => /p=[A-Za-z0-9+/=]{100,}/.test(t)), text: 'DKIM TXT resend._domainkey.<domain> published' },
    { ok: mx.some((m) => /amazonses\.com\.?$/.test(m.exchange)), text: 'bounce MX send.<domain> → feedback-smtp.<region>.amazonses.com' },
    { ok: spf.some((t) => /^v=spf1 .*include:amazonses\.com/.test(t)), text: 'SPF TXT send.<domain> includes amazonses.com' },
  ]
}

async function main() {
  const env = process.env
  const apply = process.argv.includes('--apply')
  const domain = env.SENDER_DOMAIN
  const name = env.SENDER_NAME || 'BusinessAI (Staging)'
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('secret SUPABASE_ACCESS_TOKEN is not set')
  const bad = checkTarget(env) ?? checkDomain(domain); if (bad) throw new Error(bad)

  const txt = async (h) => (await resolveTxt(h).catch(() => [])).map((r) => r.join(''))
  const mx = await resolveMx(`send.${domain}`).catch(() => [])
  const dns = judgeDns({ dkim: await txt(`resend._domainkey.${domain}`), mx, spf: await txt(`send.${domain}`) })
  for (const d of dns) console.log(`${d.ok ? 'PASS' : 'FAIL'}: ${d.text.replaceAll('<domain>', domain)}`)
  if (dns.some((d) => !d.ok)) {
    // where the bounce/SPF records were actually published (public records only, read-only)
    const root = domain.split('.').slice(-2).join('.')
    for (const h of [...new Set([`send.${domain}`, `send.${root}`, domain, `send.mail.${domain}`])]) {
      const m = (await resolveMx(h).catch(() => [])).map((r) => `MX ${r.priority} ${r.exchange}`)
      const t = (await txt(h)).filter((v) => v.startsWith('v=spf1')).map((v) => `TXT ${v}`)
      console.log(`  ${h}: ${[...m, ...t].join(' · ') || 'no MX / SPF'}`)
    }
  }

  const url = `https://api.supabase.com/v1/projects/${env.STAGING_PROJECT_REF}/config/auth`
  const call = async (method, body) => {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    const why = String(json?.message ?? json?.msg ?? json?.error ?? '').replace(/(sbp|re)_[A-Za-z0-9_]+/g, '[key]').slice(0, 300)
    if (!res.ok) throw new Error(`Management API ${method} config/auth: HTTP ${res.status}${why ? ` — ${why}` : ''}`)
    return json
  }
  const cfg = await call('GET')
  const site = checkTarget(env, cfg.site_url)
  console.log(`Project: ${env.STAGING_PROJECT_REF} (staging). ${site ? `FAIL: ${site}` : `PASS: Site URL is ${env.EXPECTED_SITE_URL}`}`)
  console.log(`Current SMTP: ${cfg.smtp_host ? `${cfg.smtp_host}:${cfg.smtp_port} as ${cfg.smtp_user}, from ${cfg.smtp_sender_name ?? ''} <${cfg.smtp_admin_email ?? ''}>` : 'Supabase default email service'}`)
  const target = smtpPatch({ domain, name, key: '[secret]' })
  console.log(`Would set: ${target.smtp_host}:${target.smtp_port}, user ${target.smtp_user}, password = the Resend key (secret), from ${name} <${target.smtp_admin_email}>`)
  if (site || dns.some((d) => !d.ok)) { console.log('STOP — nothing written (see FAIL lines).'); process.exit(1) }
  if (!apply) { console.log('PLAN ONLY — nothing was written.'); return }
  if (!env.RESEND_SMTP_KEY?.startsWith('re_')) throw new Error('secret STAGING_RESEND_SMTP_KEY is not set or is not a Resend API key')
  await call('PATCH', smtpPatch({ domain, name, key: env.RESEND_SMTP_KEY }))
  const after = await call('GET')
  const ok = after.smtp_host === SMTP.host && String(after.smtp_port) === SMTP.port && after.smtp_user === SMTP.user &&
    after.smtp_admin_email === target.smtp_admin_email && after.smtp_sender_name === name && !checkTarget(env, after.site_url)
  console.log(`${ok ? 'PASS' : 'FAIL'}: staging now sends Auth email through ${SMTP.host} from ${name} <${target.smtp_admin_email}>; Site URL unchanged`)
  if (!ok) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

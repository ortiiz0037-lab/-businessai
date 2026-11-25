#!/usr/bin/env node
/**
 * Vercel PRODUCTION environment readiness + NEXT_PUBLIC_APP_URL (Production target only).
 *
 *   --plan   (default) READ-ONLY: for every variable the app needs in Production, says present / missing for the
 *            Production target (names, targets and types only — never a value, except NEXT_PUBLIC_APP_URL, which is
 *            a public URL), and what --apply would change for NEXT_PUBLIC_APP_URL.
 *   --apply  writes ONLY the Production entry of NEXT_PUBLIC_APP_URL (creates it if missing). Starts NO deployment:
 *            NEXT_PUBLIC_* are compiled at build time, so the value takes effect on the next Production deploy, which
 *            is a separate, owner-authorised step. Requires CONFIRM_PRODUCTION=vercel-production too.
 * Never touches an entry that also targets Preview/Development (Staging keeps its own value).
 * Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, [VERCEL_TEAM_ID], APP_URL (https://<production domain>), [CONFIRM_PRODUCTION].
 */
import { checkProductionSiteUrl } from './auth-email.mjs'

export const KEY = 'NEXT_PUBLIC_APP_URL'

/** Variables the app reads in Production (src/lib/env.ts, billing, email, Supabase). */
export const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_APP_URL', 'APP_ENV', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM',
]

/** Presence per required key for the Production target (pure). */
export function readiness(entries) {
  return REQUIRED.map((key) => {
    const prod = entries.filter((e) => e.key === key && e.target.includes('production'))
    return { key, present: prod.length > 0, shared: prod.some((e) => e.target.length > 1) }
  })
}

/** What to do with NEXT_PUBLIC_APP_URL for Production (pure). */
export function planProductionAppUrl(entries, appUrl) {
  const mine = entries.filter((e) => e.key === KEY && e.target.includes('production'))
  const only = mine.filter((e) => e.target.length === 1 && !e.gitBranch)
  const shared = mine.filter((e) => e.target.length > 1)
  if (shared.length && !only.length) return { op: 'blocked', reason: `${KEY} is shared by ${shared[0].target.join(' + ')}: give Production its own entry first` }
  if (only.length > 1) return { op: 'blocked', reason: `${only.length} Production-only entries of ${KEY}: keep one` }
  const target = only[0]
  if (!target) return { op: 'create', value: appUrl }
  if (target.value === appUrl) return { op: 'none', id: target.id, value: appUrl }
  return { op: 'update', id: target.id, from: target.value ?? '(not readable)', value: appUrl }
}

async function main() {
  const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: projectId, APP_URL: raw } = process.env
  if (!token || !projectId || !raw) throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID and APP_URL are required')
  const appUrl = raw.replace(/\/+$/, '')
  const bad = checkProductionSiteUrl(appUrl); if (bad) throw new Error(bad.replace('EXPECTED_SITE_URL', 'APP_URL'))
  const apply = process.argv.includes('--apply')
  if (apply && process.env.CONFIRM_PRODUCTION !== 'vercel-production') throw new Error('--apply also needs CONFIRM_PRODUCTION=vercel-production')
  const team = process.env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : ''
  const api = async (method, path, body) => {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`https://api.vercel.com${path}${team ? sep + team : ''}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Vercel ${method} ${path.split('?')[0]}: ${res.status} ${json?.error?.code ?? ''}`)
    return json
  }
  const list = await api('GET', `/v10/projects/${projectId}/env`)
  const entries = (list.envs ?? []).map((e) => ({ id: e.id, key: e.key, target: e.target ?? [], gitBranch: e.gitBranch ?? null, value: e.key === KEY && e.type === 'plain' ? e.value : undefined }))
  console.log('Production variables (presence only):')
  for (const r of readiness(entries)) console.log(`  ${r.present ? 'PASS' : 'MISSING'}: ${r.key}${r.shared ? ' (entry shared with another target)' : ''}`)
  const plan = planProductionAppUrl(entries, appUrl)
  console.log(`PLAN ${KEY}: ${plan.op === 'update' ? `update the Production entry: ${plan.from} → ${plan.value}` : plan.op === 'create' ? `create a Production-only entry = ${plan.value}` : plan.op === 'none' ? `nothing to change (${plan.value})` : `STOP — ${plan.reason}`}`)
  console.log('No deployment is started by this script.')
  if (!apply) { console.log('PLAN ONLY — nothing was written.'); return }
  if (plan.op === 'blocked') throw new Error(plan.reason)
  if (plan.op === 'update') await api('PATCH', `/v9/projects/${projectId}/env/${plan.id}`, { value: appUrl, type: 'plain', target: ['production'] })
  if (plan.op === 'create') await api('POST', `/v10/projects/${projectId}/env`, { key: KEY, value: appUrl, type: 'plain', target: ['production'] })
  console.log(plan.op === 'none' ? 'Nothing written.' : `${KEY} (production) = ${appUrl}; takes effect on the next Production deploy.`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

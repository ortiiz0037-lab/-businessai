#!/usr/bin/env node
/**
 * NEXT_PUBLIC_APP_URL for Vercel PREVIEW only (the origin the app puts in Auth / invitation email links).
 *
 *   --plan   (default) READ-ONLY: lists every NEXT_PUBLIC_APP_URL entry of the project (targets, branch, current
 *            value — a public URL, not a secret) and prints exactly what --apply would change.
 *   --apply  writes ONLY the Preview entry (creates it if missing), then rebuilds the latest READY preview of
 *            STAGING_BRANCH so the new value is compiled in (NEXT_PUBLIC_* are build-time).
 * Never touches an entry that targets Production: if the only entry is shared Production+Preview, it stops.
 * Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, [VERCEL_TEAM_ID], STAGING_BRANCH, APP_URL (https://staging.…).
 */
import { pickLatestPreview, redeployBody } from './vercel-env.mjs'

export const KEY = 'NEXT_PUBLIC_APP_URL'

/** Validates the desired value: https origin of a staging.* host, no path. */
export function checkAppUrl(value) {
  let u
  try { u = new URL(value) } catch { return 'APP_URL is not a URL' }
  if (u.protocol !== 'https:') return 'APP_URL must be https'
  if (!/^staging\./.test(u.hostname)) return 'APP_URL must be a staging.* host'
  if (u.pathname !== '/' || u.search || u.hash) return 'APP_URL must be an origin (no path, query or fragment)'
  return null
}

/** What to do with the existing entries of KEY (pure). */
export function planAppUrl(entries, appUrl) {
  const mine = entries.filter((e) => e.key === KEY)
  const previewOnly = mine.filter((e) => e.target.length === 1 && e.target[0] === 'preview' && !e.gitBranch)
  const shared = mine.filter((e) => e.target.includes('preview') && e.target.length > 1)
  if (shared.length && !previewOnly.length) return { op: 'blocked', reason: `${KEY} is shared by ${shared[0].target.join(' + ')}: give Preview its own entry first` }
  if (previewOnly.length > 1) return { op: 'blocked', reason: `${previewOnly.length} Preview-only entries of ${KEY}: keep one` }
  const target = previewOnly[0]
  if (!target) return { op: 'create', value: appUrl }
  if (target.value === appUrl) return { op: 'none', id: target.id, value: appUrl }
  return { op: 'update', id: target.id, from: target.value ?? '(not readable)', value: appUrl }
}

async function main() {
  const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: projectId, STAGING_BRANCH: branch, APP_URL: appUrlRaw } = process.env
  if (!token || !projectId || !branch || !appUrlRaw) throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID, STAGING_BRANCH and APP_URL are required')
  const appUrl = appUrlRaw.replace(/\/+$/, '')
  const bad = checkAppUrl(appUrl); if (bad) throw new Error(bad)
  const team = process.env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : ''
  const api = async (method, path, body) => {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`https://api.vercel.com${path}${team ? sep + team : ''}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Vercel ${method} ${path.split('?')[0]}: ${res.status} ${json?.error?.code ?? ''}`)
    return json
  }
  const apply = process.argv.includes('--apply')
  const list = await api('GET', `/v10/projects/${projectId}/env`)
  const entries = (list.envs ?? []).map((e) => ({ id: e.id, key: e.key, target: e.target ?? [], gitBranch: e.gitBranch ?? null, type: e.type, value: e.type === 'plain' ? e.value : undefined }))
  console.log(`${KEY} entries in the project:`)
  for (const e of entries.filter((x) => x.key === KEY)) console.log(`  - targets: ${e.target.join(', ')}${e.gitBranch ? ` · branch ${e.gitBranch}` : ''} · ${e.type} · value: ${e.value ?? '(not readable)'}`)
  if (!entries.some((x) => x.key === KEY)) console.log('  (none)')
  const plan = planAppUrl(entries, appUrl)
  console.log(`PLAN: ${plan.op === 'update' ? `update the Preview entry: ${plan.from} → ${plan.value}` : plan.op === 'create' ? `create a Preview-only entry = ${plan.value}` : plan.op === 'none' ? `nothing to change (Preview already ${plan.value})` : `STOP — ${plan.reason}`}`)
  console.log('Production entries are never changed by this script.')
  if (!apply) { console.log('PLAN ONLY — nothing was written.'); return }
  if (plan.op === 'blocked') throw new Error(plan.reason)
  if (plan.op === 'update') { await api('PATCH', `/v9/projects/${projectId}/env/${plan.id}`, { value: plan.value, type: 'plain', target: ['preview'] }); console.log(`= ${KEY} (preview) updated`) }
  if (plan.op === 'create') { await api('POST', `/v10/projects/${projectId}/env`, { key: KEY, value: plan.value, type: 'plain', target: ['preview'] }); console.log(`+ ${KEY} (preview) created`) }
  const deployments = await api('GET', `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=50`)
  const source = pickLatestPreview(deployments.deployments, branch)
  if (!source) throw new Error(`no READY preview deployment of ${branch}; push to the branch or Redeploy in Vercel`)
  const created = await api('POST', '/v13/deployments?forceNew=1', redeployBody(source))
  if (created.target === 'production') throw new Error('Vercel reported a production target; stop and review in the dashboard')
  console.log(`Preview rebuild requested from ${source.uid} (branch ${branch}); the new build carries ${KEY}=${appUrl}.`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })

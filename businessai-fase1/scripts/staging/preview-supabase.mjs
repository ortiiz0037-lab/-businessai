#!/usr/bin/env node
/**
 * Supabase variables for the STAGING Preview — names come from the code.
 *
 *   node scripts/staging/preview-supabase.mjs inspect   # read-only
 *   node scripts/staging/preview-supabase.mjs apply     # Preview only
 *
 * inspect (read-only):
 *   1. Scans src/ for the process.env names the app reads; the middleware
 *      (src/lib/supabase/proxy.ts) needs NEXT_PUBLIC_SUPABASE_URL and
 *      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
 *   2. Lists the variable NAMES the Vercel project has for Preview (never
 *      values) and reports missing ones and near-miss names (e.g. *_ANON_KEY).
 *   3. Checks the staging values against Supabase staging with read-only
 *      requests (publishable key → /auth/v1/settings, service role →
 *      /rest/v1/), so a key from another project is detected.
 * apply:
 *   inspect, then writes the 3 Supabase variables for the PREVIEW target
 *   only, re-reads them to confirm (plain values compared by SHA-256, never
 *   printed), rebuilds the latest READY preview of STAGING_BRANCH (never a
 *   production deployment), waits until it is READY, and checks that /login
 *   answers 200 through the protection bypass without a middleware error.
 *
 * Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, [VERCEL_TEAM_ID], STAGING_PROJECT_REF,
 *      PRODUCTION_PROJECT_REF, STAGING_SUPABASE_URL,
 *      STAGING_SUPABASE_PUBLISHABLE_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *      STAGING_URL, STAGING_BRANCH, VERCEL_AUTOMATION_BYPASS_SECRET.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pickLatestPreview, planChanges, redeployBody } from './vercel-env.mjs'

export const MIDDLEWARE_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']
export const SUPABASE_NAMES = [...MIDDLEWARE_NAMES, 'SUPABASE_SERVICE_ROLE_KEY']
const NEAR_MISS = /SUPABASE/i

/** process.env names read under a directory (source files only). */
export function scanEnvNames(dir) {
  const names = new Set()
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry) || /\.backup|\.before-|pre-audit/.test(entry)) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1])
      // src/lib/env.ts reads through a `source` object: source.NAME
      if (p.endsWith(join('lib', 'env.ts'))) {
        for (const m of readFileSync(p, 'utf8').matchAll(/source\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1])
      }
    }
  }
  walk(dir)
  return [...names].sort()
}

/** Names present for the Preview target, plus near-miss Supabase names. */
export function compareWithPreview(existing, required) {
  const preview = existing.filter((e) => e.target.includes('preview') && !e.gitBranch)
  const have = new Set(preview.map((e) => e.key))
  return {
    missing: required.filter((k) => !have.has(k)),
    present: required.filter((k) => have.has(k)),
    nearMiss: [...have].filter((k) => NEAR_MISS.test(k) && !required.includes(k)).sort(),
    sharedWithProduction: preview.filter((e) => required.includes(e.key) && e.target.includes('production')).map((e) => e.key),
  }
}

/** Validates the staging values' shape (never prints them). */
export function desiredSupabase(env) {
  const need = (k) => {
    const v = env[k]?.trim()
    if (!v) throw new Error(`${k} is required`)
    return v
  }
  const ref = need('STAGING_PROJECT_REF')
  const url = new URL(need('STAGING_SUPABASE_URL'))
  if (url.hostname !== `${ref}.supabase.co`) throw new Error('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF')
  const prod = env.PRODUCTION_PROJECT_REF?.trim()
  if (prod && (prod === ref || url.hostname.startsWith(`${prod}.`))) throw new Error('refusing the PRODUCTION project')
  const publishable = need('STAGING_SUPABASE_PUBLISHABLE_KEY')
  if (!/^sb_publishable_|^eyJ/.test(publishable)) throw new Error('STAGING_SUPABASE_PUBLISHABLE_KEY has an unexpected format')
  const service = need('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  if (!/^sb_secret_|^eyJ/.test(service)) throw new Error('STAGING_SUPABASE_SERVICE_ROLE_KEY has an unexpected format')
  if (service === publishable) throw new Error('service role key equals the publishable key')
  // Legacy JWT keys carry the project ref: it must be staging.
  for (const [k, v] of [['publishable', publishable], ['service role', service]]) {
    if (v.startsWith('eyJ')) {
      const payload = JSON.parse(Buffer.from(v.split('.')[1] ?? '', 'base64url').toString() || '{}')
      if (payload.ref && payload.ref !== ref) throw new Error(`the ${k} key belongs to another project`)
    }
  }
  return [
    { key: 'NEXT_PUBLIC_SUPABASE_URL', value: url.origin, type: 'plain' },
    { key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', value: publishable, type: 'plain' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', value: service, type: 'sensitive' },
  ]
}

export const sha = (v) => createHash('sha256').update(v).digest('hex')

/** true when a /login response shows the middleware failing. */
export function middlewareFailed(status, vercelError, body) {
  return status >= 500 || vercelError === 'MIDDLEWARE_INVOCATION_FAILED' || /URL and Key are required/.test(body ?? '')
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

async function main() {
  const command = process.argv[2]
  if (!['inspect', 'apply'].includes(command)) fail('usage: preview-supabase.mjs inspect|apply')
  const env = process.env
  const token = env.VERCEL_TOKEN
  const projectId = env.VERCEL_PROJECT_ID
  if (!token || !projectId) fail('VERCEL_TOKEN and VERCEL_PROJECT_ID are required')
  const team = env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : ''
  // Test-only redirection to a local simulator (localhost only).
  const testBase = (v) => (env.BA_TEST_MODE === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v ?? '') ? v : null)
  const vercelBase = testBase(env.TEST_VERCEL_API) ?? 'https://api.vercel.com'
  const api = async (method, path, body) => {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${vercelBase}${path}${team ? sep + team : ''}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Vercel ${method} ${path.split('?')[0]}: ${res.status} ${json?.error?.code ?? ''}`)
    return json
  }
  const listEnv = async () => ((await api('GET', `/v10/projects/${projectId}/env`)).envs ?? [])
    .map((e) => ({ id: e.id, key: e.key, target: e.target ?? [], type: e.type, gitBranch: e.gitBranch ?? null }))

  // 1. Names the code reads.
  const codeNames = scanEnvNames(new URL('../../src', import.meta.url).pathname)
  const missingInCode = SUPABASE_NAMES.filter((n) => !codeNames.includes(n))
  if (missingInCode.length) fail(`the code no longer reads ${missingInCode.join(', ')}; update this script`)
  console.log(`Code reads: ${codeNames.join(', ')}`)
  console.log(`Middleware (src/lib/supabase/proxy.ts) needs: ${MIDDLEWARE_NAMES.join(', ')}`)

  // 2. Names Vercel has for Preview (no values).
  const before = await listEnv()
  const cmp = compareWithPreview(before, SUPABASE_NAMES)
  console.log(`Vercel Preview — present: ${cmp.present.join(', ') || 'none'}`)
  console.log(`Vercel Preview — missing: ${cmp.missing.join(', ') || 'none'}`)
  if (cmp.nearMiss.length) console.log(`Vercel Preview — other Supabase-like names the code does NOT read: ${cmp.nearMiss.join(', ')}`)
  if (cmp.sharedWithProduction.length) console.log(`Shared with Production today: ${cmp.sharedWithProduction.join(', ')}`)

  // 3. Values: shape and read-only checks against Supabase staging.
  let desired
  try {
    desired = desiredSupabase(env)
  } catch (e) {
    fail(e.message)
  }
  const base = testBase(env.TEST_SUPABASE_API) ?? desired[0].value
  const pub = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: desired[1].value } })
  // apikey header only: new-format keys (sb_…) are not JWTs.
  const svc = await fetch(`${base}/rest/v1/`, { headers: { apikey: desired[2].value } })
  console.log(`Supabase staging accepts the publishable key: ${pub.ok ? 'yes' : `NO (HTTP ${pub.status})`}`)
  console.log(`Supabase staging accepts the service role key: ${svc.ok ? 'yes' : `NO (HTTP ${svc.status})`}`)
  if (!pub.ok || !svc.ok) fail('a staging key is not valid for the staging project; nothing was written')

  if (command === 'inspect') {
    const plan = planChanges(before, desired, { splitShared: env.SPLIT_SHARED === 'true' })
    console.log('PLAN (nothing written):')
    for (const o of plan.ops) console.log(`  ${o.op.padEnd(6)} ${o.key}${o.op === 'split' ? ` (stays ${o.target.join(', ')})` : ' → preview'}`)
    if (plan.blocked) console.log('  blocked: variables shared with Production need STAGING_SPLIT_SHARED=true (Production stays as is)')
    return
  }

  // 4. Write (Preview only).
  const plan = planChanges(before, desired, { splitShared: env.SPLIT_SHARED === 'true' })
  if (plan.blocked) fail(`shared with Production: ${plan.shared.map((s) => s.key).join(', ')}. Set STAGING_SPLIT_SHARED=true (Production stays as is).`)
  for (const o of plan.ops) {
    if (o.op === 'split') await api('PATCH', `/v9/projects/${projectId}/env/${o.id}`, { target: o.target })
    else if (o.op === 'update') await api('PATCH', `/v9/projects/${projectId}/env/${o.id}`, { value: o.value, type: o.type, target: o.target })
    else await api('POST', `/v10/projects/${projectId}/env`, { key: o.key, value: o.value, type: o.type, target: o.target })
    console.log(`${o.op === 'create' ? '+' : '~'} ${o.key} (${o.op === 'split' ? o.target.join(', ') : 'preview'})`)
  }

  // 5. Confirm names and values are available for Preview before rebuilding.
  const after = await listEnv()
  for (const want of desired) {
    const entries = after.filter((e) => e.key === want.key && e.target.length === 1 && e.target[0] === 'preview' && !e.gitBranch)
    if (entries.length !== 1) fail(`${want.key}: expected exactly one Preview entry, found ${entries.length}`)
    if (want.type === 'plain') {
      const read = await api('GET', `/v1/projects/${projectId}/env/${entries[0].id}`)
      if (typeof read.value !== 'string' || sha(read.value) !== sha(want.value)) fail(`${want.key}: stored value differs from the staging value`)
      console.log(`✓ ${want.key}: present for Preview, value verified (SHA-256 match)`)
    } else {
      console.log(`✓ ${want.key}: present for Preview (sensitive: cannot be read back, by design)`)
    }
  }
  const touchedProduction = after.some((e) => desired.some((d) => d.key === e.key) && e.target.includes('production')
    && !before.some((b) => b.id === e.id && b.target.includes('production')))
  if (touchedProduction) fail('unexpected Production change detected; stop and review in Vercel')

  // 6. Rebuild the branch preview and wait until READY.
  const branch = env.STAGING_BRANCH
  if (!branch) fail('STAGING_BRANCH is required to rebuild the preview')
  const list = await api('GET', `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=50`)
  const source = pickLatestPreview(list.deployments, branch)
  if (!source) fail(`no READY preview deployment for ${branch}`)
  const created = await api('POST', '/v13/deployments?forceNew=1', redeployBody(source))
  if (created.target === 'production') fail('Vercel reported a production target; stop and review')
  const id = created.id ?? created.uid
  console.log(`Rebuilding preview ${id} from ${source.uid}…`)
  let state = created.readyState
  for (let i = 0; i < 60 && !['READY', 'ERROR', 'CANCELED'].includes(state); i++) {
    await new Promise((r) => setTimeout(r, vercelBase.startsWith('http://') ? 200 : 15000))
    state = (await api('GET', `/v13/deployments/${id}`)).readyState
  }
  if (state !== 'READY') fail(`preview build ended in state ${state}`)
  console.log('Preview rebuilt: READY')

  // 7. /login through the bypass: 200 and no middleware error.
  const previewBase = testBase(env.TEST_PREVIEW_BASE)
  const targets = previewBase ? [previewBase] : [`https://${created.url}`, env.STAGING_URL?.replace(/\/$/, '')].filter(Boolean)
  for (const t of targets) {
    let ok = false
    for (let i = 0; i < 10 && !ok; i++) {
      const res = await fetch(`${t}/login`, { headers: { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '' }, redirect: 'manual' })
      const body = await res.text().catch(() => '')
      const failed = middlewareFailed(res.status, res.headers.get('x-vercel-error'), body)
      ok = res.status === 200 && !failed
      console.log(`${new URL(t).host}/login → HTTP ${res.status}${res.headers.get('x-vercel-error') ? ` (${res.headers.get('x-vercel-error')})` : ''}`)
      if (!ok) await new Promise((r) => setTimeout(r, previewBase ? 200 : 15000))
    }
    if (!ok) fail(`${new URL(t).host}/login does not answer 200 without middleware errors`)
  }
  console.log('OK: Preview has the Supabase staging variables and /login works (middleware healthy).')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message))
}

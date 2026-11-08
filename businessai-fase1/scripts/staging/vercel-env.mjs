#!/usr/bin/env node
/**
 * Writes the STAGING variables into the Vercel project, for the PREVIEW
 * target only. Production variables are never created, changed or read.
 *
 *   VERCEL_TOKEN=… VERCEL_PROJECT_ID=prj_… [VERCEL_TEAM_ID=team_…] \
 *   STAGING_URL=… STAGING_SUPABASE_URL=… STAGING_SUPABASE_PUBLISHABLE_KEY=… \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=… STRIPE_SECRET_KEY=sk_test_… \
 *   STRIPE_WEBHOOK_SECRET=whsec_… [VERCEL_DEPLOY_HOOK_URL=…] \
 *   node scripts/staging/vercel-env.mjs [--split-shared] [--plan-only]
 *
 * --plan-only: reads the project's variable list (names and targets only)
 * and prints what would change. Writes nothing.
 *
 * A variable that today is shared by Production AND Preview (one entry for
 * both) cannot get a Preview-only value without touching that entry. By
 * default the script STOPS and lists them. With --split-shared it removes
 * "preview" from those entries' targets (their value and their Production
 * target are left exactly as they are) and then creates the Preview value.
 */

export const PREVIEW = 'preview'

/** Desired Preview variables, validated. Secrets are typed "sensitive". */
export function desiredVariables(env) {
  const need = (k) => {
    const v = env[k]?.trim()
    if (!v) throw new Error(`${k} is required`)
    return v
  }
  const stripeKey = need('STRIPE_SECRET_KEY')
  if (!/^(sk|rk)_test_/.test(stripeKey)) throw new Error('STRIPE_SECRET_KEY must be a TEST key (live keys are refused)')
  const webhookSecret = need('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret.startsWith('whsec_')) throw new Error('STRIPE_WEBHOOK_SECRET must start with whsec_')
  const appUrl = new URL(need('STAGING_URL'))
  if (appUrl.protocol !== 'https:') throw new Error('STAGING_URL must be https')
  const supabaseUrl = new URL(need('STAGING_SUPABASE_URL'))
  if (!supabaseUrl.hostname.endsWith('.supabase.co')) throw new Error('STAGING_SUPABASE_URL must be a supabase.co URL')
  const ref = env.STAGING_PROJECT_REF?.trim()
  if (ref && !supabaseUrl.hostname.startsWith(`${ref}.`)) throw new Error('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF')
  const prodRef = env.PRODUCTION_PROJECT_REF?.trim()
  if (prodRef && supabaseUrl.hostname.startsWith(`${prodRef}.`)) throw new Error('STAGING_SUPABASE_URL points at PRODUCTION')

  return [
    { key: 'APP_ENV', value: 'staging', type: 'plain' },
    { key: 'NEXT_PUBLIC_APP_URL', value: appUrl.origin, type: 'plain' },
    { key: 'NEXT_PUBLIC_SUPABASE_URL', value: supabaseUrl.origin, type: 'plain' },
    { key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', value: need('STAGING_SUPABASE_PUBLISHABLE_KEY'), type: 'plain' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', value: need('STAGING_SUPABASE_SERVICE_ROLE_KEY'), type: 'sensitive' },
    { key: 'STRIPE_SECRET_KEY', value: stripeKey, type: 'sensitive' },
    { key: 'STRIPE_WEBHOOK_SECRET', value: webhookSecret, type: 'sensitive' },
  ]
}

/**
 * Decides the API operations from the project's current variables.
 * Every write it plans targets ONLY "preview"; "split" only removes
 * "preview" from a shared entry.
 */
export function planChanges(existing, desired, { splitShared = false } = {}) {
  const ops = []
  const shared = []
  for (const want of desired) {
    const same = existing.filter((e) => e.key === want.key && !e.gitBranch)
    const previewOnly = same.find((e) => e.target.length === 1 && e.target[0] === PREVIEW)
    const sharedEntries = same.filter((e) => e.target.includes(PREVIEW) && e.target.length > 1)
    if (sharedEntries.length) {
      shared.push(...sharedEntries.map((e) => ({ key: e.key, target: e.target })))
      if (splitShared) {
        for (const e of sharedEntries) {
          ops.push({ op: 'split', id: e.id, key: e.key, target: e.target.filter((t) => t !== PREVIEW) })
        }
      }
    }
    if (previewOnly) ops.push({ op: 'update', id: previewOnly.id, ...want, target: [PREVIEW] })
    else ops.push({ op: 'create', ...want, target: [PREVIEW] })
  }
  for (const o of ops) {
    if (o.op !== 'split' && (o.target.length !== 1 || o.target[0] !== PREVIEW)) {
      throw new Error(`refusing to write ${o.key} outside Preview`)
    }
    if (o.op === 'split' && o.target.includes(PREVIEW)) throw new Error('split must remove preview')
  }
  return { ops, shared, blocked: shared.length > 0 && !splitShared }
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

async function main() {
  const token = process.env.VERCEL_TOKEN
  const projectId = process.env.VERCEL_PROJECT_ID
  if (!token || !projectId) fail('VERCEL_TOKEN and VERCEL_PROJECT_ID are required')
  const team = process.env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : ''
  const api = async (method, path, body) => {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`https://api.vercel.com${path}${team ? sep + team : ''}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Vercel ${method} ${path.split('?')[0]}: ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`)
    return json
  }

  const planOnly = process.argv.includes('--plan-only')
  let desired
  try {
    // In plan mode the webhook secret does not exist yet (created in run mode).
    const source = planOnly && !process.env.STRIPE_WEBHOOK_SECRET
      ? { ...process.env, STRIPE_WEBHOOK_SECRET: 'whsec_created_in_run_mode' }
      : process.env
    desired = desiredVariables(source)
  } catch (e) {
    fail(e.message)
  }

  const current = await api('GET', `/v10/projects/${projectId}/env`)
  const existing = (current.envs ?? []).map((e) => ({ id: e.id, key: e.key, target: e.target ?? [], gitBranch: e.gitBranch ?? null }))
  const { ops, shared, blocked } = planChanges(existing, desired, { splitShared: process.argv.includes('--split-shared') })

  if (planOnly) {
    console.log('PLAN ONLY — nothing is written (values are never printed):')
    for (const o of ops) {
      console.log(o.op === 'split'
        ? `  split  ${o.key}: would remove "preview" (stays ${o.target.join(', ')})`
        : `  ${o.op.padEnd(6)} ${o.key} → preview (${o.type})`)
    }
    if (shared.length) {
      console.log('Shared Production+Preview today (need STAGING_SPLIT_SHARED=true to proceed):')
      for (const v of shared) console.log(`  - ${v.key} (${v.target.join(', ')})`)
    }
    return
  }

  if (blocked) {
    console.error('These variables are shared by Production and Preview today:')
    for (const s of shared) console.error(`  - ${s.key} (${s.target.join(', ')})`)
    fail('Nothing was changed. Re-run with split_shared=true to give Preview its own value (Production stays as is).')
  }

  for (const o of ops) {
    if (o.op === 'split') {
      await api('PATCH', `/v9/projects/${projectId}/env/${o.id}`, { target: o.target })
      console.log(`~ ${o.key}: no longer shared with Preview (still ${o.target.join(', ')})`)
    } else if (o.op === 'update') {
      await api('PATCH', `/v9/projects/${projectId}/env/${o.id}`, { value: o.value, type: o.type, target: o.target })
      console.log(`= ${o.key} (preview) updated`)
    } else {
      await api('POST', `/v10/projects/${projectId}/env`, { key: o.key, value: o.value, type: o.type, target: o.target })
      console.log(`+ ${o.key} (preview) created`)
    }
  }

  if (process.env.VERCEL_DEPLOY_HOOK_URL) {
    const res = await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' })
    console.log(res.ok ? 'Redeploy of the staging branch requested (deploy hook).' : `Deploy hook failed: ${res.status}`)
  } else {
    console.log('Variables saved. They apply to the NEXT Preview deployment (push to the staging branch or Redeploy in Vercel).')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message))
}

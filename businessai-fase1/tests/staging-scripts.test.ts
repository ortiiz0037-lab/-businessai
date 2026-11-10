import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { desiredVariables, pickLatestPreview, planChanges, redeployBody } from '../scripts/staging/vercel-env.mjs'
import { WEBHOOK_EVENTS, webhookUrl } from '../scripts/staging/stripe-webhook.mjs'

// Placeholders only — not credentials.
const ENV = {
  STAGING_URL: 'https://businessai-git-staging-team.vercel.app/',
  STAGING_PROJECT_REF: 'stagingref',
  STAGING_SUPABASE_URL: 'https://stagingref.supabase.co',
  STAGING_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_placeholder',
  STAGING_SUPABASE_SERVICE_ROLE_KEY: 'service_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
}

type Op = { op: string; key: string; target: string[]; type?: string; value?: string }

describe('vercel-env: Preview variables only', () => {
  it('builds the 7 staging variables, secrets as sensitive', () => {
    const vars = desiredVariables(ENV) as { key: string; value: string; type: string }[]
    expect(vars.map((v) => v.key)).toEqual([
      'APP_ENV', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    ])
    expect(vars.find((v) => v.key === 'APP_ENV')?.value).toBe('staging')
    expect(vars.find((v) => v.key === 'NEXT_PUBLIC_APP_URL')?.value).toBe('https://businessai-git-staging-team.vercel.app')
    for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      expect(vars.find((v) => v.key === k)?.type).toBe('sensitive')
    }
  })

  it('refuses live keys, http URLs, non-Supabase URLs and the production project', () => {
    expect(() => desiredVariables({ ...ENV, STRIPE_SECRET_KEY: 'sk_live_x' })).toThrow(/TEST/)
    expect(() => desiredVariables({ ...ENV, STRIPE_WEBHOOK_SECRET: 'x' })).toThrow(/whsec_/)
    expect(() => desiredVariables({ ...ENV, STAGING_URL: 'http://x.vercel.app' })).toThrow(/https/)
    expect(() => desiredVariables({ ...ENV, STAGING_SUPABASE_URL: 'https://evil.example.com' })).toThrow(/supabase/)
    expect(() => desiredVariables({ ...ENV, STAGING_PROJECT_REF: 'otherref' })).toThrow(/does not match/)
    expect(() => desiredVariables({ ...ENV, PRODUCTION_PROJECT_REF: 'stagingref' })).toThrow(/PRODUCTION/)
    expect(() => desiredVariables({ ...ENV, STAGING_SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(/required/)
  })

  const desired = desiredVariables(ENV)

  it('creates missing variables for Preview only', () => {
    const { ops, blocked } = planChanges([], desired)
    expect(blocked).toBe(false)
    expect((ops as Op[]).every((o) => o.op === 'create' && o.target.join() === 'preview')).toBe(true)
  })

  it('updates existing Preview-only entries and ignores Production-only ones', () => {
    const existing = [
      { id: 'e1', key: 'APP_ENV', target: ['preview'], gitBranch: null },
      { id: 'e2', key: 'STRIPE_SECRET_KEY', target: ['production'], gitBranch: null },
    ]
    const { ops } = planChanges(existing, desired) as { ops: Op[] }
    expect(ops.find((o) => o.key === 'APP_ENV')).toMatchObject({ op: 'update', id: 'e1', target: ['preview'] })
    expect(ops.find((o) => o.key === 'STRIPE_SECRET_KEY')).toMatchObject({ op: 'create', target: ['preview'] })
    expect(ops.some((o) => (o as { id?: string }).id === 'e2')).toBe(false)
  })

  it('STOPS when a variable is shared by Production and Preview', () => {
    const existing = [{ id: 's1', key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production', 'preview'], gitBranch: null }]
    const plan = planChanges(existing, desired)
    expect(plan.blocked).toBe(true)
    expect(plan.shared).toEqual([{ key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production', 'preview'] }])
  })

  it('with --split-shared only removes "preview" from the shared entry', () => {
    const existing = [{ id: 's1', key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production', 'preview', 'development'], gitBranch: null }]
    const { ops, blocked } = planChanges(existing, desired, { splitShared: true }) as { ops: Op[]; blocked: boolean }
    expect(blocked).toBe(false)
    const split = ops.find((o) => o.op === 'split')
    expect(split).toEqual({ op: 'split', id: 's1', key: 'NEXT_PUBLIC_SUPABASE_URL', target: ['production', 'development'] })
    expect(split).not.toHaveProperty('value')
    expect(ops.find((o) => o.op === 'create' && o.key === 'NEXT_PUBLIC_SUPABASE_URL')?.target).toEqual(['preview'])
  })

  it('leaves branch-specific entries alone', () => {
    const existing = [{ id: 'b1', key: 'APP_ENV', target: ['preview'], gitBranch: 'feature-x' }]
    const { ops } = planChanges(existing, desired) as { ops: Op[] }
    expect(ops.find((o) => o.key === 'APP_ENV')).toMatchObject({ op: 'create' })
  })
})

describe('stripe-webhook', () => {
  it('points at the staging webhook route, https only, with optional Vercel bypass', () => {
    expect(webhookUrl('https://s.vercel.app/some/path')).toBe('https://s.vercel.app/api/stripe/webhook')
    expect(webhookUrl('https://s.vercel.app', 'byp')).toBe('https://s.vercel.app/api/stripe/webhook?x-vercel-protection-bypass=byp')
    expect(() => webhookUrl('http://s.vercel.app')).toThrow(/https/)
  })

  it('subscribes exactly the events the app handles', () => {
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining([
      'checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted',
      'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required',
    ]))
    expect(WEBHOOK_EVENTS).toHaveLength(10)
  })
})

describe('vercel-env: rebuilding the staging preview', () => {
  const branch = 'claude/businessai-platform-audit-vjjcoc'
  const d = (uid: string, over: Record<string, unknown> = {}) =>
    ({ uid, name: 'businessai', state: 'READY', target: null, createdAt: 1, meta: { githubCommitRef: branch }, ...over })

  it('picks the newest READY preview of the branch', () => {
    const picked = pickLatestPreview([
      d('old', { createdAt: 1 }), d('new', { createdAt: 3 }), d('building', { createdAt: 4, state: 'BUILDING' }),
      d('other-branch', { createdAt: 5, meta: { githubCommitRef: 'feature' } }),
    ], branch)
    expect(picked.uid).toBe('new')
  })

  it('never picks or redeploys a production deployment', () => {
    expect(pickLatestPreview([d('prod', { target: 'production', createdAt: 9 })], branch)).toBeNull()
    expect(() => redeployBody(d('prod', { target: 'production' }))).toThrow(/production/)
    expect(() => redeployBody(null)).toThrow()
    const body = redeployBody(d('p1'))
    expect(body).toEqual({ name: 'businessai', deploymentId: 'p1' })
    expect(body).not.toHaveProperty('target')
  })
})

describe('auth-check (read-only Preview sign-in check)', () => {
  it('finds Supabase project refs and Next.js scripts', async () => {
    const { supabaseRefs, nextScripts } = await import('../scripts/staging/auth-check.mjs')
    const js = 'a="https://wbfpvxptoujgvflljasc.supabase.co";b="https://wbfpvxptoujgvflljasc.supabase.co/auth";c="https://example.com"'
    expect(supabaseRefs(js)).toEqual(['wbfpvxptoujgvflljasc'])
    expect(supabaseRefs(js + ' https://rugqcumiuqrjbfwpuslm.supabase.co')).toEqual(['rugqcumiuqrjbfwpuslm', 'wbfpvxptoujgvflljasc'])
    const html = '<script src="/_next/static/chunks/app.js" async></script><script src="https://cdn.example/x.js"></script>'
    expect(nextScripts(html)).toEqual(['/_next/static/chunks/app.js'])
  })
})

describe('staging.yml: what each label runs', () => {
  const yml = readFileSync(new URL('../../.github/workflows/staging.yml', import.meta.url), 'utf8')
  const expr = (key: string) => {
    const m = new RegExp(`\\n      ${key}: \\$\\{\\{ (.+) \\}\\}`).exec(yml)
    if (!m) throw new Error(`no ${key}`)
    return m[1]
  }
  /** Evaluates a GitHub expression for a label event (inputs are undefined on label events). */
  const evalFor = (key: string, label: string) => {
    const js = expr(key)
      .replace(/github\.event\.label\.name/g, JSON.stringify(label))
      .replace(/github\.event_name/g, '"pull_request"')
      .replace(/inputs\.\w+/g, 'undefined')
      .replace(/vars\.\w+/g, '"x"')
    return new Function(`return (${js})`)()
  }
  const flags = (label: string) => Object.fromEntries(
    ['MODE', 'DO_MIGRATIONS', 'DO_STRIPE', 'DO_VERCEL', 'DO_TESTS', 'DO_PREVIEW_SUPABASE'].map((k) => [k, evalFor(k, label)]))

  it('staging:migrate runs ONLY the migrations', () => {
    expect(flags('staging:migrate')).toEqual({
      MODE: 'migrate', DO_MIGRATIONS: true, DO_STRIPE: false, DO_VERCEL: false, DO_TESTS: false, DO_PREVIEW_SUPABASE: false,
    })
  })

  it('the other labels keep their behaviour', () => {
    expect(flags('staging:check')).toEqual({ MODE: 'check', DO_MIGRATIONS: true, DO_STRIPE: true, DO_VERCEL: true, DO_TESTS: false, DO_PREVIEW_SUPABASE: true })
    expect(flags('staging:preview')).toEqual({ MODE: 'preview', DO_MIGRATIONS: false, DO_STRIPE: false, DO_VERCEL: false, DO_TESTS: false, DO_PREVIEW_SUPABASE: true })
    expect(flags('staging:run')).toEqual({ MODE: 'run', DO_MIGRATIONS: true, DO_STRIPE: true, DO_VERCEL: true, DO_TESTS: true, DO_PREVIEW_SUPABASE: false })
  })

  it('the job only starts for the four exact labels', () => {
    for (const l of ['staging:check', 'staging:preview', 'staging:migrate', 'staging:run']) expect(yml).toContain(`github.event.label.name == '${l}'`)
    expect(yml).toMatch(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  })

  it('migrate mode pins the staging project and refuses production', () => {
    expect(yml).toMatch(/PINNED_STAGING_REF: wbfpvxptoujgvflljasc/)
    expect(yml).toMatch(/PINNED_PRODUCTION_REF: rugqcumiuqrjbfwpuslm/)
    expect(yml).toMatch(/EXPECT_STAGING_REF: \$\{\{ env\.MODE == 'migrate' && env\.PINNED_STAGING_REF/)
    expect(yml).toMatch(/DRY_RUN=1 EXPECT_NONE=1 STATUS=1 (VERIFY_0014A=1 )?bash scripts\/staging\/apply-migrations\.sh/)
    // Every step that writes to Stripe or Vercel is gated by a flag that is false in migrate mode.
    for (const step of ['2a. Stripe TEST', '2b. Stripe TEST', '3. Vercel', '4a. Smoke', '4b. Billing', '4c. RLS']) {
      const start = yml.indexOf(`      - name: ${step}`)
      expect(start, step).toBeGreaterThan(0)
      const block = yml.slice(start).split('\n      - name')[0]
      expect(block, step).toMatch(/if: env\.DO_(STRIPE|VERCEL|TESTS) == 'true'/)
    }
  })
})

describe('staging-test.yml (label staging:test): tests only, no configuration', () => {
  const yml = readFileSync(new URL('../../.github/workflows/staging-test.yml', import.meta.url), 'utf8')
  const step = (name: string) => {
    const start = yml.indexOf(`      - name: ${name}`)
    expect(start, name).toBeGreaterThan(0)
    return yml.slice(start).split('\n      - name')[0]
  }
  it('runs only on the exact label, never from forks', () => {
    expect(yml).toMatch(/github\.event\.label\.name == 'staging:test' &&/)
    expect(yml).toMatch(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
    expect(yml).toMatch(/types: \[labeled\]/)
    expect(yml).not.toMatch(/workflow_dispatch|push:/)
  })
  it('writes no Stripe, Vercel or database configuration', () => {
    for (const writer of ['stripe-setup-test', 'stripe-webhook', 'vercel-env', 'preview-supabase', 'apply-migrations', 'VERCEL_TOKEN', 'STAGING_DB_URL']) {
      expect(yml, writer).not.toContain(writer)
    }
  })
  it('staging only and Stripe TEST only, pinned in the file', () => {
    expect(yml).toMatch(/PINNED_STAGING_REF: wbfpvxptoujgvflljasc/)
    expect(yml).toMatch(/PINNED_PRODUCTION_REF: rugqcumiuqrjbfwpuslm/)
    const guard = step('Guard')
    expect(guard).toContain('[ "$STAGING_PROJECT_REF" = "$PINNED_STAGING_REF" ]')
    expect(guard).toMatch(/\^\(sk\|rk\)_test_/)
    expect(guard).toContain('"$PINNED_PRODUCTION_REF"')
  })
  it('billing and RLS run even if an earlier test fails, but never without the guard', () => {
    for (const s of ['2. Billing', '3. RLS']) {
      expect(step(s), s).toContain("if: ${{ !cancelled() && steps.guard.outcome == 'success' }}")
    }
    expect(step('2. Billing')).toContain('node scripts/staging/e2e-billing.mjs')
  })
  it('skipped RLS suites count as a failure', () => {
    const rls = step('3. RLS')
    expect(rls).toContain('tests/rls.test.ts tests/rls-business.test.ts')
    expect(rls).toContain('numPendingTests')
    expect(rls).toContain('RLS_TEST_PROJECT_REF: ${{ env.STAGING_PROJECT_REF }}')
  })
})

describe('staging.yml ignores the staging:test label', () => {
  const yml = readFileSync(new URL('../../.github/workflows/staging.yml', import.meta.url), 'utf8')
  it('its job condition lists only its own four labels', () => {
    const cond = yml.slice(yml.indexOf('    if: >-'), yml.indexOf('    runs-on:'))
    expect(cond).not.toContain('staging:test')
  })
})

describe('migrations: order, identifiers and transactions (apply-migrations.sh)', () => {
  const script = readFileSync(new URL('../scripts/staging/apply-migrations.sh', import.meta.url), 'utf8')
  const order = /\nORDER=\(\n([\s\S]*?)\n\)/.exec(script)![1].split('\n').map((l) => l.trim()).filter(Boolean)
  const dir = new URL('../supabase/migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort()
  const sql = (name: string) => readFileSync(new URL(`${name}.sql`, dir), 'utf8')
  // Statement-level lines only (comments and dollar-quoted bodies keep
  // `begin` inside DO blocks and functions, which is not a transaction).
  const topLevel = (text: string) => text.replace(/\$([a-z]*)\$[\s\S]*?\$\1\$/g, '').split('\n')
    .map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean)

  it('ORDER lists every migration file exactly once, and nothing else', () => {
    expect([...order].sort()).toEqual(files)
    expect(new Set(order).size).toBe(order.length)
  })
  it('0014a_permissions is recognised and runs right after 0011, last', () => {
    expect(order).toContain('0014a_permissions')
    expect(order.indexOf('0014a_permissions')).toBe(order.indexOf('0011_usage_limits') + 1)
    expect(order.at(-1)).toBe('0014a_permissions')
  })
  it('identifiers are safe to store in ba_meta.applied_migrations', () => {
    for (const name of order) expect(name, name).toMatch(/^\d{4}[a-z]?_[a-z0-9_]+$/)
    expect(script).toMatch(/name text primary key, sha256 text not null/)
    expect(script).toMatch(/on conflict \(name\) do update/)
  })
  it('the record is written only after the file succeeded (set -e + ON_ERROR_STOP)', () => {
    expect(script).toMatch(/set -euo pipefail/)
    expect(script).toMatch(/-v ON_ERROR_STOP=1/)
    const apply = script.slice(script.indexOf('for name in "${pending[@]}"'))
    expect(apply.indexOf('psqlx -f "$file"')).toBeLessThan(apply.indexOf('insert into ba_meta.applied_migrations'))
  })
  it('from 0014a on, each migration is one explicit transaction', () => {
    const recent = order.slice(order.indexOf('0014a_permissions'))
    expect(recent.length).toBeGreaterThan(0)
    for (const name of recent) {
      const lines = topLevel(sql(name))
      expect(lines[0], `${name}: first statement`).toMatch(/^begin;$/i)
      expect(lines.at(-1), `${name}: last statement`).toMatch(/^commit;$/i)
      expect(lines.filter((l) => /^(begin|start transaction|commit|end|rollback)\s*;/i.test(l)), name).toHaveLength(2)
      expect(sql(name), `${name}: statements that cannot run in a transaction`).not.toMatch(/\bconcurrently\b|^\s*vacuum\b|alter\s+system/im)
      expect(sql(name), `${name}: lock_timeout`).toMatch(/set local lock_timeout/)
    }
  })
  it('0014a: fixed search_path on every SECURITY DEFINER function, and a rollback script', () => {
    const text = sql('0014a_permissions')
    const fns = [...text.matchAll(/create or replace function[\s\S]*?\$\$;/g)].map((m) => m[0])
    expect(fns.length).toBe(3)
    for (const f of fns) expect(f).toMatch(/security definer set search_path = ''/)
    expect(existsSync(new URL('../supabase/rollback/0014a_rollback.sql', import.meta.url))).toBe(true)
  })
})

describe('staging suites: guarded and listed in staging:test', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/staging-test.yml', import.meta.url), 'utf8')
  const run = workflow.slice(workflow.indexOf('npx vitest run'), workflow.indexOf('--reporter=verbose'))
  const suites = readdirSync(new URL('./', import.meta.url))
    .filter((f) => f.endsWith('.test.ts') && f !== 'staging-helpers.test.ts')
    .filter((f) => /from '\.\/staging-helpers'/.test(readFileSync(new URL(f, import.meta.url), 'utf8')))
  it('every suite using the staging helpers runs in staging:test (and is never silently left out)', () => {
    expect(suites.length).toBeGreaterThan(0)
    for (const f of suites) expect(run, f).toContain(`tests/${f}`)
  })
  it('every staging suite gates on stagingEnv (ref = URL, never production)', () => {
    for (const f of suites) expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).toMatch(/stagingEnv\.enabled/)
  })
})

describe('verify_0014a.sql: strictly read-only 0014a verification', () => {
  const file = readFileSync(new URL('../supabase/inspect/verify_0014a.sql', import.meta.url), 'utf8')
  const code = file.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")
  const script = readFileSync(new URL('../scripts/staging/apply-migrations.sh', import.meta.url), 'utf8')
  const staging = readFileSync(new URL('../../.github/workflows/staging.yml', import.meta.url), 'utf8')
  it('is a single SELECT with no writes, DDL or transaction control', () => {
    expect(code.trim()).toMatch(/^with\b[\s\S]*\bselect\b[\s\S]*;$/i)
    expect(code.match(/;/g)).toHaveLength(1)
    expect(code).not.toMatch(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|copy|vacuum|analyze|call|do|begin|commit|rollback|set|reset|lock|refresh|nextval|setval|pg_terminate_backend|pg_cancel_backend|lo_\w+|dblink\w*)\b/i)
  })
  it('apply-migrations.sh runs it only in DRY_RUN, read-only, and only when 0014a is recorded', () => {
    const dry = script.slice(script.indexOf('if [[ "${DRY_RUN:-0}" == "1" ]]; then\n  if [[ "${STATUS'), script.indexOf('DRY_RUN=1: nothing applied.'))
    expect(dry).toContain('-f "$VERIFY_E3"')
    expect(dry).toMatch(/PGOPTIONS="-c default_transaction_read_only=on" psqlx -tA \\\n\s+-c "begin transaction read only" -f "\$VERIFY_E3" -c "rollback"/)
    expect(dry).toMatch(/where name = '0014a_permissions'/)
    expect(dry).toMatch(/\[\[ "\$e3" == "OK" \]\] \|\| die/)
    expect(script.match(/VERIFY_E3"/g)).toHaveLength(1)
  })
  it('staging:check and the migrate confirmation run it; nothing else does', () => {
    expect(staging).toContain('if [ "$MODE" = check ]; then DRY_RUN=1 VERIFY_0014A=1 bash scripts/staging/apply-migrations.sh; exit; fi')
    expect(staging).toContain('run: DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1 bash scripts/staging/apply-migrations.sh')
    expect(staging.match(/VERIFY_0014A=1/g)).toHaveLength(2)
  })
})

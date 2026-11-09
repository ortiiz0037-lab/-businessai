import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
    expect(yml).toMatch(/DRY_RUN=1 EXPECT_NONE=1 STATUS=1 bash scripts\/staging\/apply-migrations\.sh/)
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

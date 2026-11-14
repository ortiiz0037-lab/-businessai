import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
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

  it('staging:migrate-modules: same migrate mode and guards, ONLY the migrations, pinned module list', () => {
    expect(flags('staging:migrate-modules')).toEqual({
      MODE: 'migrate', DO_MIGRATIONS: true, DO_STRIPE: false, DO_VERCEL: false, DO_TESTS: false, DO_PREVIEW_SUPABASE: false,
    })
    // the approved list is pinned in the file: ORDER from 0015 to 0035 (applied to staging with the owner's approval).
    // Later drafts (0036 …) are NOT in it: each needs its own approval, and until then the label stops at
    // "MODULE_DRAFTS does not match ORDER" before touching anything (fail-closed).
    const pinned = /\n      MODULE_DRAFTS: ([0-9a-z_,]+)\n/.exec(yml)?.[1] ?? ''
    const order = /ORDER=\(([\s\S]*?)\)/.exec(readFileSync(new URL('../scripts/staging/apply-migrations.sh', import.meta.url), 'utf8'))![1].match(/\d{4}[a-z]?_[a-z0-9_]+/g)!
    const after14a = order.slice(order.indexOf('0014a_permissions') + 1)
    expect(pinned.split(',')).toEqual(after14a.slice(0, after14a.indexOf('0035_crm') + 1))
    for (const m of after14a.slice(after14a.indexOf('0035_crm') + 1)) {
      expect(pinned.split(',')).not.toContain(m)
      expect(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8')).toMatch(/^-- STAGING-GATE: approval required/m)
    }
    expect(pinned.split(',')[0]).toBe('0015_documents_lifecycle')
    expect(pinned.split(',').at(-1)).toBe('0035_crm')
    // APPROVED_DRAFTS comes from the pinned list only for that exact label; never from label text
    const ad = yml.match(/APPROVED_DRAFTS: \$\{\{ (.+) \}\}/g)!
    expect(ad).toHaveLength(2)
    for (const e of ad) expect(e).toContain("github.event.label.name == 'staging:migrate-modules' && env.MODULE_DRAFTS")
    expect(yml).not.toMatch(/APPROVED_DRAFTS:.*github\.event\.label\.name[^=]*\}\}/)
    // the apply only runs when the dry run lists exactly the approved list; then each migration is checked read-only
    expect(yml).toContain('STOP: the dry run does not list exactly 0015…0035; nothing applied')
    expect(yml).toContain("PGOPTIONS='-c default_transaction_read_only=on'")
    expect(yml).toContain('supabase/inspect/inspect_migration_state.sql')
    // the migrate guard (pinned staging ref, production refused) applies to it too: it runs for MODE == migrate
    expect(yml).toMatch(/name: "M\. Migrate guard[^\n]*\n\s+if: env\.MODE == 'migrate'/)
    expect(yml).toContain('MODULE_DRAFTS does not match ORDER after 0014a_permissions')
  })

  it('the other labels keep their behaviour', () => {
    expect(flags('staging:check')).toEqual({ MODE: 'check', DO_MIGRATIONS: true, DO_STRIPE: true, DO_VERCEL: true, DO_TESTS: false, DO_PREVIEW_SUPABASE: true })
    expect(flags('staging:preview')).toEqual({ MODE: 'preview', DO_MIGRATIONS: false, DO_STRIPE: false, DO_VERCEL: false, DO_TESTS: false, DO_PREVIEW_SUPABASE: true })
    expect(flags('staging:run')).toEqual({ MODE: 'run', DO_MIGRATIONS: true, DO_STRIPE: true, DO_VERCEL: true, DO_TESTS: true, DO_PREVIEW_SUPABASE: false })
  })

  it('the job only starts for the five exact labels', () => {
    for (const l of ['staging:check', 'staging:preview', 'staging:migrate', 'staging:migrate-modules', 'staging:run']) expect(yml).toContain(`github.event.label.name == '${l}'`)
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
  it('0014a_permissions is recognised and runs right after 0011', () => {
    expect(order).toContain('0014a_permissions')
    expect(order.indexOf('0014a_permissions')).toBe(order.indexOf('0011_usage_limits') + 1)
  })
  it('numbering (docs/MIGRATIONS.md): from 0010 on, ORDER is the file-name order, strictly increasing, appended at the end', () => {
    const recent = order.slice(order.indexOf('0010_billing'))
    expect(recent).toEqual([...recent].sort())
    const nums = recent.map((n) => n.slice(0, 5))
    expect(new Set(nums).size).toBe(nums.length)
    // Retired reservations: never reuse a suffix letter after 0014a.
    for (const name of order.slice(order.indexOf('0014a_permissions') + 1)) expect(name, name).toMatch(/^\d{4}_[a-z0-9_]+$/)
    expect(order.some((n) => /^(0012|0013|0014b)_/.test(n))).toBe(false)
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
  it('from 0014a on: every SECURITY DEFINER function has a fixed search_path, and each migration has a rollback', () => {
    for (const name of order.slice(order.indexOf('0014a_permissions'))) {
      const text = sql(name)
      for (const m of text.matchAll(/create or replace function[\s\S]*?\$\$;/g)) {
        if (/security definer/.test(m[0])) expect(m[0], name).toMatch(/security definer set search_path = ''/)
      }
      const rb = new URL(`../supabase/rollback/${name.slice(0, name.indexOf('_'))}_rollback.sql`, import.meta.url)
      expect(existsSync(rb), `${name}: rollback`).toBe(true)
    }
  })
})

describe('draft gate (review finding I12): a draft in ORDER is never applied without explicit approval', () => {
  const gate = fileURLToPath(new URL('../scripts/staging/draft-gate.sh', import.meta.url))
  const mig = fileURLToPath(new URL('../supabase/migrations', import.meta.url))
  const runKnown = (approved: string, known: string, ...names: string[]) =>
    spawnSync('bash', ['-c', `source "$0"; draft_gate "$1" "$2" "$3" "\${@:4}"`, gate, mig, approved, known, ...names], { encoding: 'utf8' })
      .stdout.trim().split('\n')
  const run = (approved: string, ...names: string[]) => runKnown(approved, '', ...names)
  const script = readFileSync(new URL('../scripts/staging/apply-migrations.sh', import.meta.url), 'utf8')
  const yml = readFileSync(new URL('../../.github/workflows/staging.yml', import.meta.url), 'utf8')

  it('0015 and 0016 carry the gate marker; already-applied migrations do not', () => {
    for (const n of ['0015_documents_lifecycle', '0016_billing_hardening'])
      expect(readFileSync(`${mig}/${n}.sql`, 'utf8')).toMatch(/^-- STAGING-GATE: approval required/m)
    for (const n of ['0011_usage_limits', '0014a_permissions'])
      expect(readFileSync(`${mig}/${n}.sql`, 'utf8')).not.toMatch(/^-- STAGING-GATE/m)
  })
  it('without approval a draft and everything after it are held', () => {
    expect(run('', '0011_usage_limits', '0015_documents_lifecycle', '0016_billing_hardening'))
      .toEqual(['RUN 0011_usage_limits', 'HOLD 0015_documents_lifecycle', 'HOLD 0016_billing_hardening'])
  })
  it('approving one draft runs it and still holds the next draft', () => {
    expect(run('0015_documents_lifecycle', '0015_documents_lifecycle', '0016_billing_hardening'))
      .toEqual(['RUN 0015_documents_lifecycle', 'HOLD 0016_billing_hardening'])
    expect(run('0015_documents_lifecycle,0016_billing_hardening', '0015_documents_lifecycle', '0016_billing_hardening'))
      .toEqual(['RUN 0015_documents_lifecycle', 'RUN 0016_billing_hardening'])
  })
  it('a gated migration already applied with exactly this content re-runs in a cascade (lost record) without new approval', () => {
    expect(runKnown('', '0015_documents_lifecycle,0016_billing_hardening,', '0014a_permissions', '0015_documents_lifecycle', '0016_billing_hardening'))
      .toEqual(['RUN 0014a_permissions', 'RUN 0015_documents_lifecycle', 'RUN 0016_billing_hardening'])
    // 0015 known, 0016 never applied: 0016 still waits.
    expect(runKnown('', '0015_documents_lifecycle,', '0015_documents_lifecycle', '0016_billing_hardening'))
      .toEqual(['RUN 0015_documents_lifecycle', 'HOLD 0016_billing_hardening'])
  })
  it('a partial name or a missing file is never approved', () => {
    expect(run('0015', '0015_documents_lifecycle')).toEqual(['HOLD 0015_documents_lifecycle'])
    expect(run('9999_missing', '9999_missing')).toEqual(['HOLD 9999_missing'])
  })
  it('apply-migrations.sh applies only what the gate lets run; drafts come only from a manual run or the pinned list of staging:migrate-modules', () => {
    expect(script).toMatch(/source "\$HERE\/draft-gate.sh"/)
    expect(script).toMatch(/\[\[ -n "\$recorded" && "\$recorded" == "\$sum" \]\] && known\+="\$name,"/)
    expect(script.indexOf('draft_gate "$MIG"')).toBeLessThan(script.indexOf('for name in "${pending[@]}"; do\n  file='))
    expect(yml).toMatch(/APPROVED_DRAFTS: \$\{\{ github\.event\.label\.name == 'staging:migrate-modules' && env\.MODULE_DRAFTS \|\| github\.event_name == 'workflow_dispatch' && inputs\.approved_drafts \|\| '' \}\}/)
    // every other label passes nothing: the list exists only behind that exact label
    expect(yml).toMatch(/MODULES_RUN: \$\{\{ github\.event\.label\.name == 'staging:migrate-modules' \}\}/)
    expect(yml.match(/APPROVED_DRAFTS:/g)).toHaveLength(2)
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
    expect(staging).toContain('\n          DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1 bash scripts/staging/apply-migrations.sh\n')
    expect(staging.match(/VERIFY_0014A=1/g)).toHaveLength(2)
  })
})

describe('R3: storage.objects policies that could reach the company buckets', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  const mig = read('../supabase/migrations/0014a_permissions.sql')
  const verify = read('../supabase/inspect/verify_0014a.sql')
  const inspect = read('../supabase/inspect/inspect_storage_policies.sql')
  const script = read('../scripts/staging/apply-migrations.sh')
  const classifier = (src: string) => [...src.matchAll(/-- BEGIN storage\.objects policy classifier \(R3\)[\s\S]*?-- END storage\.objects policy classifier \(R3\)/g)]
    .map((m) => m[0].split('\n').map((l) => l.trim()).join('\n'))
  it('the same classifier is used by 0014a (guard, warning, final check), verify_0014a and the inspection', () => {
    const all = [...classifier(mig), ...classifier(verify), ...classifier(inspect)]
    expect(classifier(mig)).toHaveLength(3)
    expect(all).toHaveLength(5)
    expect(new Set(all).size).toBe(1)
  })
  it('0014a stops (exception) on blocked policies, before any change and again before commit', () => {
    const guards = mig.slice(0, mig.indexOf('-- ------------------------------------------- 1. catalog'))
    expect(guards).toMatch(/where c\.verdict like 'block:%';\n\s+if unknown is not null then\n\s+raise exception E'BA0014a: storage\.objects policies that could reach the company buckets were found; nothing was changed/)
    expect(mig.slice(mig.indexOf('6. verification before commit'))).toMatch(/where c\.verdict like 'block:%';\n\s+if bad is not null then raise exception/)
  })
  it('0014a never drops or alters a storage policy other than its own 5 ba_ policies', () => {
    const stmts = [...mig.matchAll(/\b(drop|alter) policy (?:if exists )?(\w+) on storage\.objects/gi)].map((m) => m[2])
    expect(stmts.length).toBeGreaterThan(0)
    for (const n of stmts) expect(n).toMatch(/^ba_company_(assets_(select|insert)|signatures_(select|insert|delete))$/)
  })
  it('the inspection is a single read-only SELECT', () => {
    const code = inspect.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''")
    expect(code.trim()).toMatch(/^select\b[\s\S]*;$/i)
    expect(code.match(/;/g)).toHaveLength(1)
    expect(code).not.toMatch(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|copy|vacuum|analyze|call|do|begin|commit|rollback|set|reset|lock|refresh|nextval|setval|pg_terminate_backend|pg_cancel_backend|lo_\w+|dblink\w*)\b/i)
  })
  it('staging:check lists the verdicts in a read-only transaction', () => {
    expect(script).toContain('STORAGE_POLICIES="$ROOT/supabase/inspect/inspect_storage_policies.sql"')
    expect(script).toMatch(/PGOPTIONS="-c default_transaction_read_only=on" psqlx -tA -F' \| ' \\\n\s+-c "begin transaction read only" \\\n\s+-c "select 'storage_policy: ' \|\| policyname[^\n]*"\$STORAGE_POLICIES"[^\n]*\\\n\s+-c "rollback"/)
  })
})

describe('read-only Production inspections (0007 preview, migration state, 0010 impact)', () => {
  const files = ['inspect_0007_preview.sql', 'inspect_migration_state.sql', 'inspect_0010_impact.sql', 'inspect_storage_policies.sql']
  for (const f of files) {
    it(`${f} is a single read-only SELECT (no writes, DDL or transaction control)`, () => {
      const code = readFileSync(new URL(`../supabase/inspect/${f}`, import.meta.url), 'utf8')
        .replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''")
      expect(code.trim()).toMatch(/^(with|select)\b[\s\S]*;$/i)
      expect(code.match(/;/g)).toHaveLength(1)
      expect(code).not.toMatch(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|copy|vacuum|analyze|call|do|begin|commit|rollback|set|reset|lock|refresh|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_sleep|lo_\w+|dblink\w*)\b/i)
    })
  }
  it('the 0007 preview uses 0007\'s own drop and guard conditions', () => {
    const mig = readFileSync(new URL('../supabase/migrations/0007_storage_company_assets.sql', import.meta.url), 'utf8')
    const prev = readFileSync(new URL('../supabase/inspect/inspect_0007_preview.sql', import.meta.url), 'utf8')
    expect(mig).toContain("ilike '%company-assets%'")
    expect(mig).toContain("not ilike '%bucket_id%'")
    expect(prev).toContain("not pol.is_ba and pol.cond ilike '%company-assets%' as dropped_by_0007")
    expect(prev).toContain("pol.is_ba or pol.cond ilike '%bucket_id%' as passes_0007_guard")
  })
  it('the impact query returns counts only (no names, emails or amounts)', () => {
    const imp = readFileSync(new URL('../supabase/inspect/inspect_0010_impact.sql', import.meta.url), 'utf8')
    const out = imp.slice(imp.lastIndexOf('\nselect\n'))
    expect(out).not.toMatch(/\b(name|email|total|amount|stripe_customer_id|stripe_subscription_id)\b(?!_)/)
  })
})

describe('demo company (staging:demo / staging:demo-remove)', () => {
  const yml = readFileSync(new URL('../../.github/workflows/staging-demo.yml', import.meta.url), 'utf8')
  const ok = {
    STAGING_PROJECT_REF: 'wbfpvxptoujgvflljasc', PINNED_STAGING_REF: 'wbfpvxptoujgvflljasc',
    PRODUCTION_PROJECT_REF: 'rugqcumiuqrjbfwpuslm', STAGING_SUPABASE_URL: 'https://wbfpvxptoujgvflljasc.supabase.co',
    STAGING_SUPABASE_SERVICE_ROLE_KEY: 'service_placeholder',
  }
  it('runs only for its two labels, from this repository, staging refs pinned, no Stripe', () => {
    expect(yml).toContain("github.event.label.name == 'staging:demo' || github.event.label.name == 'staging:demo-remove'")
    expect(yml).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(yml).toContain('PINNED_STAGING_REF: wbfpvxptoujgvflljasc')
    expect(yml).toContain('PINNED_PRODUCTION_REF: rugqcumiuqrjbfwpuslm')
    expect(yml).not.toMatch(/STRIPE|VERCEL|STAGING_DB_URL|apply-migrations/)
  })
  it('the script refuses anything but the pinned staging project', async () => {
    const { checkTarget, maskEmail } = await import('../scripts/staging/demo-company.mjs')
    expect(checkTarget(ok)).toBeNull()
    expect(checkTarget({ ...ok, STAGING_PROJECT_REF: 'otherref' })).toMatch(/pinned/)
    expect(checkTarget({ ...ok, STAGING_PROJECT_REF: 'rugqcumiuqrjbfwpuslm', PINNED_STAGING_REF: 'rugqcumiuqrjbfwpuslm' })).toMatch(/production/)
    expect(checkTarget({ ...ok, STAGING_SUPABASE_URL: 'https://rugqcumiuqrjbfwpuslm.supabase.co' })).toMatch(/not the staging project/)
    expect(checkTarget({ ...ok, STAGING_SUPABASE_SERVICE_ROLE_KEY: '' })).toMatch(/missing/)
    expect(maskEmail('jane.doe@gmail.com')).toBe('j***@g***.com')
  })
  it('only ever deletes the demo company by exact name AND demo owner', () => {
    const src = readFileSync(new URL('../scripts/staging/demo-company.mjs', import.meta.url), 'utf8')
    expect(src).toMatch(/\.eq\('name', DEMO_COMPANY_NAME\)\.eq\('created_by', owner\.id\)/)
    expect(src).toMatch(/\.delete\(\)\.eq\('id', id\)\.eq\('name', DEMO_COMPANY_NAME\)/)
    expect(src).not.toMatch(/console\.log\([^)]*(SERVICE_ROLE|password)/i)
  })
})

describe('real Preview screenshots (staging:test step 4)', () => {
  const yml = readFileSync(new URL('../../.github/workflows/staging-test.yml', import.meta.url), 'utf8')
  const src = readFileSync(new URL('../scripts/staging/screenshots.mjs', import.meta.url), 'utf8')
  it('runs inside staging:test with a pinned Playwright and uploads the captures', () => {
    expect(yml).toContain('npm install --no-save --no-audit --no-fund playwright@1.63.0')
    expect(yml).toContain('node scripts/staging/screenshots.mjs')
    expect(yml).toMatch(/uses: actions\/upload-artifact@v4[\s\S]*name: preview-screenshots/)
  })
  it('guards the staging target and always removes its temporary user', () => {
    expect(src).toMatch(/const problem = checkTarget\(env\)/)
    expect(src).toMatch(/finally \{[\s\S]*deleteUser\(userId\)/)
    expect(src).toMatch(/e3-shots-\$\{Date\.now\(\)\}@example\.test/)
    // Only the demo company (by exact name AND demo owner), only as admin.
    expect(src).toMatch(/\.eq\('name', DEMO_COMPANY_NAME\)\.eq\('created_by', owner\.id\)/)
    expect(src).toMatch(/role: 'admin'/)
    expect(src).not.toMatch(/console\.log\([^)]*password/)
  })
})

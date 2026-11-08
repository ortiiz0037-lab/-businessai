import { describe, expect, it } from 'vitest'
import { desiredVariables, planChanges } from '../scripts/staging/vercel-env.mjs'
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

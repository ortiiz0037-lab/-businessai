/**
 * S9: onboarding steps derived from real data (never a box the user ticks), the plan catalog as
 * approved (prices and limits match the database: supabase/tests/local/126_platform_flows.test.sql),
 * and the patched Next.js version.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { onboardingProgress, onboardingSteps, type OnboardingInput } from '@/lib/onboarding'
import { PLAN_CATALOG as PLANS } from '@/lib/billing/catalog'

const fresh: OnboardingInput = { emailConfirmed: false, profile: null, branches: 0, members: 1, employees: 0, invitations: 0, subscriptionStatus: null, localeChosen: false }

describe('onboarding', () => {
  it('a new company: account, company, currency / time zone and dashboard are done; the rest is pending', () => {
    const s = onboardingSteps(fresh)
    expect(s.map((x) => x.key)).toEqual(['account', 'email', 'company', 'profile', 'locale', 'branches', 'team', 'plan', 'preferences', 'dashboard'])
    expect(s.filter((x) => x.done).map((x) => x.key)).toEqual(['account', 'company', 'locale', 'dashboard'])
    expect(onboardingProgress(s)).toEqual({ done: 4, total: 10 })
  })
  it('each step is done only by the real data', () => {
    const s = onboardingSteps({ emailConfirmed: true, profile: { legal_name: 'X LLC', phone: '787', address: 'Calle 1' }, branches: 1, members: 1, employees: 2, invitations: 0,
      subscriptionStatus: 'trialing', localeChosen: true })
    expect(onboardingProgress(s)).toEqual({ done: 10, total: 10 })
    expect(onboardingSteps({ ...fresh, profile: { legal_name: 'X', phone: null, address: 'A' } }).find((x) => x.key === 'profile')!.done).toBe(false)
    expect(onboardingSteps({ ...fresh, subscriptionStatus: 'past_due' }).find((x) => x.key === 'plan')!.done).toBe(false)
    expect(onboardingSteps({ ...fresh, invitations: 1 }).find((x) => x.key === 'team')!.done).toBe(true)
  })
  it('pending steps link to the screens that already do them', () => {
    for (const s of onboardingSteps(fresh).filter((x) => !x.done && x.href)) expect(s.href).toMatch(/^\/(settings\/company|crm\/settings|settings\/team|billing)$/)
  })
})

describe('plans as approved', () => {
  it('Basic 19.99 · Pro 39.99 · Premium 59.99 per month', () => {
    expect(PLANS.map((p) => [p.plan, p.listPriceCents])).toEqual([['basic', 1999], ['pro', 3999], ['premium', 5999]])
  })
  it('the limits in the database migration are the approved ones', () => {
    const sql = readFileSync('supabase/migrations/0017_plan_features.sql', 'utf8')
    expect(sql).toContain("('basic', 'branches', 1), ('pro', 'branches', 3), ('premium', 'branches', 10)")
    expect(sql).toContain("('basic', 'employees', 3), ('pro', 'employees', 25), ('premium', 'employees', 100)")
    expect(sql).toContain("('pro', 'payroll', null), ('premium', 'payroll', null)")
    expect(sql).not.toMatch(/\('basic', 'payroll'/)
  })
})

describe('dependencies', () => {
  it('Next.js is past the 16.3.0–16.4.4 advisory (root params disclosure with unstable_cache)', () => {
    const v = JSON.parse(readFileSync('node_modules/next/package.json', 'utf8')).version as string
    const [maj, min, pat] = v.split('.').map(Number)
    expect(maj > 16 || (maj === 16 && (min > 4 || (min === 4 && pat >= 5)))).toBe(true)
  })
})

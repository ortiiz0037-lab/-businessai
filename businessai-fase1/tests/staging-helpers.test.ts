// Unit tests of the staging guard (no network, runs in CI).
import { describe, expect, it } from 'vitest'
import { PRODUCTION_PROJECT_REF, resolveStagingEnv } from './staging-helpers'

const STAGING = 'wbfpvxptoujgvflljasc'
const base = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  RLS_TEST_PROJECT_REF: STAGING,
}

describe('resolveStagingEnv', () => {
  it('enables the staging project when the ref matches the URL', () => {
    expect(resolveStagingEnv(base)).toMatchObject({ enabled: true, ref: STAGING })
  })

  it('stays disabled when anything is missing', () => {
    for (const key of Object.keys(base)) {
      expect(resolveStagingEnv({ ...base, [key]: '' }).enabled).toBe(false)
    }
  })

  it('refuses a ref that does not match the URL', () => {
    expect(resolveStagingEnv({ ...base, RLS_TEST_PROJECT_REF: 'otherprojectref' })).toEqual({
      enabled: false, reason: 'RLS_TEST_PROJECT_REF does not match the URL',
    })
  })

  it('refuses the production project even when the ref matches', () => {
    const prod = {
      ...base,
      NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      RLS_TEST_PROJECT_REF: PRODUCTION_PROJECT_REF,
    }
    expect(resolveStagingEnv(prod)).toEqual({ enabled: false, reason: 'refusing the production project' })
  })

  it('refuses a URL that is not a Supabase project URL', () => {
    expect(resolveStagingEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.example.com` }).enabled).toBe(false)
    expect(resolveStagingEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'not a url' }).enabled).toBe(false)
  })

  it('pins the same production ref as the staging workflows', async () => {
    const { readFileSync } = await import('node:fs')
    for (const wf of ['staging.yml', 'staging-test.yml']) {
      const text = readFileSync(new URL(`../../.github/workflows/${wf}`, import.meta.url), 'utf8')
      expect(text).toContain(`PINNED_PRODUCTION_REF: ${PRODUCTION_PROJECT_REF}`)
    }
  })
})

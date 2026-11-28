import { describe, expect, it } from 'vitest'
import { assertStripeKeyAllowed, getAppEnv, getStripeConfig, normalizeAppUrl, stripeKeyMode } from '@/lib/env'

// Placeholder strings shaped like Stripe keys. They are NOT credentials.
const TEST_KEY = 'sk_test_placeholder_not_a_real_key'
const LIVE_KEY = 'sk_live_placeholder_not_a_real_key'

describe('environments', () => {
  it('defaults to development and rejects unknown values', () => {
    expect(getAppEnv({})).toBe('development')
    expect(getAppEnv({ APP_ENV: 'staging' })).toBe('staging')
    expect(() => getAppEnv({ APP_ENV: 'prod' })).toThrow(/APP_ENV/)
  })

  it('detects the Stripe key mode without exposing it', () => {
    expect(stripeKeyMode(TEST_KEY)).toBe('test')
    expect(stripeKeyMode('rk_test_x')).toBe('test')
    expect(stripeKeyMode(LIVE_KEY)).toBe('live')
    expect(stripeKeyMode('pk_test_x')).toBe('unknown')
  })

  it('refuses LIVE keys outside production and TEST keys in production', () => {
    expect(() => assertStripeKeyAllowed(LIVE_KEY, 'development')).toThrow(/LIVE/)
    expect(() => assertStripeKeyAllowed(LIVE_KEY, 'staging')).toThrow(/LIVE/)
    expect(() => assertStripeKeyAllowed(TEST_KEY, 'production')).toThrow(/TEST/)
    expect(() => assertStripeKeyAllowed('pk_live_x', 'production')).toThrow(/not a Stripe secret/)
    expect(() => assertStripeKeyAllowed(TEST_KEY, 'staging')).not.toThrow()
    expect(() => assertStripeKeyAllowed(LIVE_KEY, 'production')).not.toThrow()
  })

  it('error messages never contain the key', () => {
    try { assertStripeKeyAllowed(LIVE_KEY, 'staging') } catch (e) {
      expect(String(e)).not.toContain(LIVE_KEY)
    }
  })

  it('requires https app URLs outside development and strips trailing slashes', () => {
    expect(normalizeAppUrl('http://localhost:3000/', 'development')).toBe('http://localhost:3000')
    expect(normalizeAppUrl('https://staging.example.com/', 'staging')).toBe('https://staging.example.com')
    expect(() => normalizeAppUrl('http://staging.example.com', 'staging')).toThrow(/https/)
    expect(() => normalizeAppUrl(undefined, 'production')).toThrow(/NEXT_PUBLIC_APP_URL/)
  })

  it('validates the webhook secret shape', () => {
    const base = { APP_ENV: 'staging', STRIPE_SECRET_KEY: TEST_KEY, NEXT_PUBLIC_APP_URL: 'https://s.example.com' }
    expect(getStripeConfig(base).webhookSecret).toBeNull()
    expect(() => getStripeConfig({ ...base, STRIPE_WEBHOOK_SECRET: 'nope' })).toThrow(/whsec_/)
    expect(getStripeConfig({ ...base, STRIPE_WEBHOOK_SECRET: 'whsec_placeholder' }).webhookSecret).toBe('whsec_placeholder')
  })
})

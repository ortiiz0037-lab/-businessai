/**
 * Environment configuration (server only).
 *
 * APP_ENV selects the environment: development | staging | production.
 * Each environment has its OWN Supabase project and its OWN Stripe mode:
 *   development, staging → Stripe TEST keys (sk_test_…) only
 *   production           → Stripe LIVE keys (sk_live_…) only
 * A key from the wrong mode is refused, so staging can never charge real
 * cards and production can never silently run in test mode.
 * See docs/ENVIRONMENTS.md.
 */

export type AppEnv = 'development' | 'staging' | 'production'

const APP_ENVS: readonly AppEnv[] = ['development', 'staging', 'production']

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function assertServer() {
  if (typeof window !== 'undefined') {
    throw new ConfigError('Server configuration must not be read in the browser')
  }
}

type Source = Record<string, string | undefined>

export function getAppEnv(source: Source = process.env): AppEnv {
  const value = (source.APP_ENV ?? 'development').trim()
  if (!APP_ENVS.includes(value as AppEnv)) {
    throw new ConfigError(`APP_ENV must be one of ${APP_ENVS.join(', ')}`)
  }
  return value as AppEnv
}

/** Mode encoded in a Stripe secret/restricted key, without revealing it. */
export function stripeKeyMode(key: string): 'test' | 'live' | 'unknown' {
  if (/^(sk|rk)_test_/.test(key)) return 'test'
  if (/^(sk|rk)_live_/.test(key)) return 'live'
  return 'unknown'
}

export function assertStripeKeyAllowed(key: string, env: AppEnv) {
  const mode = stripeKeyMode(key)
  if (mode === 'unknown') {
    throw new ConfigError('STRIPE_SECRET_KEY is not a Stripe secret or restricted key')
  }
  if (env !== 'production' && mode === 'live') {
    throw new ConfigError(`Refusing a LIVE Stripe key in APP_ENV=${env}; use a test key`)
  }
  if (env === 'production' && mode === 'test') {
    throw new ConfigError('Refusing a TEST Stripe key in APP_ENV=production; use a live key')
  }
}

export function normalizeAppUrl(value: string | undefined, env: AppEnv): string {
  if (!value) throw new ConfigError('NEXT_PUBLIC_APP_URL is not set')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError('NEXT_PUBLIC_APP_URL is not a valid URL')
  }
  if (env !== 'development' && url.protocol !== 'https:') {
    throw new ConfigError('NEXT_PUBLIC_APP_URL must use https outside development')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export type StripeConfig = {
  env: AppEnv
  secretKey: string
  webhookSecret: string | null
  appUrl: string
}

/** Stripe settings for this environment, validated. Throws ConfigError. */
export function getStripeConfig(source: Source = process.env): StripeConfig {
  assertServer()
  const env = getAppEnv(source)
  const secretKey = source.STRIPE_SECRET_KEY?.trim()
  if (!secretKey) throw new ConfigError('STRIPE_SECRET_KEY is not set')
  assertStripeKeyAllowed(secretKey, env)
  const webhookSecret = source.STRIPE_WEBHOOK_SECRET?.trim() || null
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
    throw new ConfigError('STRIPE_WEBHOOK_SECRET must start with whsec_')
  }
  return { env, secretKey, webhookSecret, appUrl: normalizeAppUrl(source.NEXT_PUBLIC_APP_URL, env) }
}

export function isStripeConfigured(source: Source = process.env): boolean {
  try {
    getStripeConfig(source)
    return true
  } catch {
    return false
  }
}

/** Supabase service role (server only): webhook and billing writes. */
export function getServiceRoleConfig(source: Source = process.env) {
  assertServer()
  const url = source.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = source.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) {
    throw new ConfigError('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  return { url, key }
}

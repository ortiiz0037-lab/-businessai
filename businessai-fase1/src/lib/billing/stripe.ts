import Stripe from 'stripe'
import { getStripeConfig } from '@/lib/env'

/**
 * Stripe client for this environment (server only). The key mode is
 * validated by getStripeConfig: test keys outside production, live keys in
 * production. Throws ConfigError when Stripe is not configured.
 */
export function getStripe(): { stripe: Stripe; appUrl: string; webhookSecret: string | null } {
  const config = getStripeConfig()
  return {
    stripe: new Stripe(config.secretKey, { appInfo: { name: 'BusinessAI' } }),
    appUrl: config.appUrl,
    webhookSecret: config.webhookSecret,
  }
}

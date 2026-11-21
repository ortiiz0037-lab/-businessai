import { NextResponse } from 'next/server'
import { getStripe } from '@/lib/billing/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBillingStore } from '@/lib/billing/store'
import { handleStripeWebhook } from '@/lib/billing/webhook'
import { ConfigError } from '@/lib/env'

export const runtime = 'nodejs'

/**
 * Stripe webhook. Public route (see src/lib/supabase/proxy.ts): it is
 * authenticated by the `stripe-signature` header, verified in
 * handleStripeWebhook before anything else.
 */
export async function POST(request: Request) {
  let config: ReturnType<typeof getStripe>
  try {
    config = getStripe()
  } catch (error) {
    console.error('STRIPE_WEBHOOK_CONFIG_ERROR', {
      message: error instanceof ConfigError ? error.message : 'unexpected',
    })
    return NextResponse.json({ error: 'not_configured' }, { status: 500 })
  }
  if (!config.webhookSecret) {
    console.error('STRIPE_WEBHOOK_CONFIG_ERROR', { message: 'STRIPE_WEBHOOK_SECRET is not set' })
    return NextResponse.json({ error: 'not_configured' }, { status: 500 })
  }

  const result = await handleStripeWebhook({
    rawBody: await request.text(),
    signature: request.headers.get('stripe-signature'),
    webhookSecret: config.webhookSecret,
    stripe: config.stripe,
    store: createBillingStore(createAdminClient()),
  })
  return NextResponse.json(result.body, { status: result.status })
}

import type Stripe from 'stripe'

/**
 * Stripe Checkout requires a trial_end at least 48 hours in the future.
 * A small margin covers the time between building and opening the session.
 */
export const MIN_CHECKOUT_TRIAL_MS = 48 * 60 * 60 * 1000 + 10 * 60 * 1000

/**
 * The 7-day trial is granted by the app at sign-up (no card). Subscribing
 * during the trial keeps the remaining days: Stripe starts charging at the
 * original trial end. Too little time left (< 48 h) or no trial → charged
 * immediately. A company never gets a second trial from Stripe.
 */
export function checkoutTrialEnd(appTrialEndsAt: string | null, now: Date): number | null {
  if (!appTrialEndsAt) return null
  const end = new Date(appTrialEndsAt).getTime()
  if (!Number.isFinite(end) || end - now.getTime() < MIN_CHECKOUT_TRIAL_MS) return null
  return Math.floor(end / 1000)
}

export function buildCheckoutSessionParams(input: {
  companyId: string
  customerId: string
  priceId: string
  appUrl: string
  appTrialEndsAt: string | null
  now: Date
}): Stripe.Checkout.SessionCreateParams {
  const trialEnd = checkoutTrialEnd(input.appTrialEndsAt, input.now)
  const metadata = { company_id: input.companyId }
  return {
    mode: 'subscription',
    customer: input.customerId,
    client_reference_id: input.companyId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    metadata,
    subscription_data: {
      metadata,
      ...(trialEnd ? { trial_end: trialEnd } : {}),
    },
    // Collect a card even while the remaining trial runs.
    payment_method_collection: 'always',
    customer_update: { name: 'auto', address: 'auto' },
    billing_address_collection: 'auto',
    success_url: `${input.appUrl}/billing?checkout=success`,
    cancel_url: `${input.appUrl}/billing?checkout=cancelled`,
  }
}

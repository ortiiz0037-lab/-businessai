import type Stripe from 'stripe'

/**
 * Customer Portal session that opens directly on the confirmation of a plan
 * change (Stripe shows the new price and the proration before confirming).
 * The price must be listed in the portal configuration
 * (features.subscription_update.products), as scripts/stripe-setup-test.mjs
 * configures it.
 */
export function buildPlanChangeSession(input: {
  customerId: string
  subscriptionId: string
  itemId: string
  priceId: string
  appUrl: string
}): Stripe.BillingPortal.SessionCreateParams {
  return {
    customer: input.customerId,
    return_url: `${input.appUrl}/billing`,
    flow_data: {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: input.subscriptionId,
        items: [{ id: input.itemId, price: input.priceId, quantity: 1 }],
      },
      after_completion: { type: 'redirect', redirect: { return_url: `${input.appUrl}/billing?changed=1` } },
    },
  }
}

/** The single item of a subscription, or null when it cannot be changed through the portal flow. */
export function singleItemId(subscription: { items: { data: { id: string }[] } }): string | null {
  return subscription.items.data.length === 1 ? subscription.items.data[0].id : null
}

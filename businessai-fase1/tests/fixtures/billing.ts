import type Stripe from 'stripe'

export const CO = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455'
export const PLANS = [
  { plan: 'basic' as const, stripe_lookup_key: 'businessai_basic_monthly' },
  { plan: 'pro' as const, stripe_lookup_key: 'businessai_pro_monthly' },
  { plan: 'premium' as const, stripe_lookup_key: 'businessai_premium_monthly' },
]
export const T0 = 1_800_000_000 // unix seconds

export function fakeSubscription(over: Partial<Record<string, unknown>> = {}, item: Record<string, unknown> = {}) {
  return {
    id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1',
    metadata: { company_id: CO },
    cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
    trial_start: null, trial_end: null,
    items: { data: [{ id: 'si_1', current_period_start: T0, current_period_end: T0 + 30 * 86400,
                      price: { id: 'price_pro', lookup_key: 'businessai_pro_monthly' }, ...item }] },
    ...over,
  } as unknown as Stripe.Subscription
}


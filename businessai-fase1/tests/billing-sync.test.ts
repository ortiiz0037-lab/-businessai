import { describe, expect, it } from 'vitest'
import { BillingSyncError, decideApply, hasLiveStripeSubscription, subscriptionToRow } from '@/lib/billing/sync'
import { buildCheckoutSessionParams, checkoutTrialEnd } from '@/lib/billing/checkout'
import { billingBanner, billingErrorCode, daysLeft, type BillingState } from '@/lib/billing/state'
import { CO, PLANS, T0, fakeSubscription } from './fixtures/billing'

describe('subscriptionToRow', () => {
  it('maps plan by lookup key and period dates from the subscription item', () => {
    const { companyId, row } = subscriptionToRow(fakeSubscription(), PLANS, new Date(0))
    expect(companyId).toBe(CO)
    expect(row).toMatchObject({
      plan: 'pro', status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
      stripe_price_id: 'price_pro',
      current_period_start: new Date(T0 * 1000).toISOString(),
      current_period_end: new Date((T0 + 30 * 86400) * 1000).toISOString(),
      cancel_at_period_end: false,
    })
  })

  it('keeps cancellation and trial dates', () => {
    const { row } = subscriptionToRow(fakeSubscription({
      status: 'trialing', cancel_at_period_end: true, cancel_at: T0 + 10, canceled_at: T0 + 5,
      trial_start: T0, trial_end: T0 + 7 * 86400,
    }), PLANS)
    expect(row.cancel_at).toBe(new Date((T0 + 10) * 1000).toISOString())
    expect(row.trial_end).toBe(new Date((T0 + 7 * 86400) * 1000).toISOString())
    expect(row.cancel_at_period_end).toBe(true)
  })

  it('rejects unknown prices, missing company, odd statuses and multiple items', () => {
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as BillingSyncError).code } }
    expect(code(() => subscriptionToRow(fakeSubscription({}, { price: { id: 'p', lookup_key: 'other' } }), PLANS))).toBe('unknown_price')
    expect(code(() => subscriptionToRow(fakeSubscription({ metadata: {} }), PLANS))).toBe('missing_company')
    expect(code(() => subscriptionToRow(fakeSubscription({ metadata: { company_id: 'x' } }), PLANS))).toBe('missing_company')
    expect(code(() => subscriptionToRow(fakeSubscription({ status: 'weird' }), PLANS))).toBe('unknown_status')
    const two = fakeSubscription()
    ;(two.items.data as unknown[]).push(two.items.data[0])
    expect(code(() => subscriptionToRow(two, PLANS))).toBe('items')
  })
})

describe('decideApply (out-of-order and duplicate subscriptions)', () => {
  const incoming = (id: string, status: string) => ({ stripe_subscription_id: id, stripe_customer_id: 'cus_1', status: status as 'active' })
  it('applies the first subscription and updates of the same one', () => {
    expect(decideApply(null, incoming('sub_1', 'active')).apply).toBe(true)
    expect(decideApply({ stripe_customer_id: 'cus_1', stripe_subscription_id: null, status: 'trialing' }, incoming('sub_1', 'active')).apply).toBe(true)
    expect(decideApply({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'active' }, incoming('sub_1', 'canceled')).apply).toBe(true)
  })
  it('ignores a late event of an old, ended subscription', () => {
    const d = decideApply({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_2', status: 'active' }, incoming('sub_1', 'canceled'))
    expect(d).toEqual({ apply: false, reason: 'ignores_old_ended_subscription' })
  })
  it('lets a new subscription replace an ended one', () => {
    expect(decideApply({ stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'canceled' }, incoming('sub_2', 'active')).apply).toBe(true)
  })
  it('refuses a subscription of another customer', () => {
    expect(() => decideApply({ stripe_customer_id: 'cus_other', stripe_subscription_id: 'sub_1', status: 'active' }, incoming('sub_1', 'active'))).toThrow(/customer/)
  })
  it('knows when checkout would create a duplicate', () => {
    expect(hasLiveStripeSubscription({ stripe_customer_id: 'c', stripe_subscription_id: 's', status: 'active' })).toBe(true)
    expect(hasLiveStripeSubscription({ stripe_customer_id: 'c', stripe_subscription_id: 's', status: 'past_due' })).toBe(true)
    expect(hasLiveStripeSubscription({ stripe_customer_id: 'c', stripe_subscription_id: 's', status: 'canceled' })).toBe(false)
    expect(hasLiveStripeSubscription({ stripe_customer_id: 'c', stripe_subscription_id: null, status: 'trialing' })).toBe(false)
  })
})

describe('checkout', () => {
  const now = new Date('2026-11-08T12:00:00Z')
  it('keeps the remaining app trial when at least 48 h are left', () => {
    const end = '2026-11-14T12:00:00Z'
    expect(checkoutTrialEnd(end, now)).toBe(Date.parse(end) / 1000)
  })
  it('charges immediately with less than 48 h, an expired trial or no trial', () => {
    expect(checkoutTrialEnd('2026-11-10T11:00:00Z', now)).toBeNull()
    expect(checkoutTrialEnd('2026-11-01T00:00:00Z', now)).toBeNull()
    expect(checkoutTrialEnd(null, now)).toBeNull()
  })
  it('builds a subscription session tied to the company and its customer', () => {
    const p = buildCheckoutSessionParams({ companyId: CO, customerId: 'cus_1', priceId: 'price_pro',
      appUrl: 'https://staging.example.com', appTrialEndsAt: '2026-11-14T12:00:00Z', now })
    expect(p).toMatchObject({
      mode: 'subscription', customer: 'cus_1', client_reference_id: CO,
      line_items: [{ price: 'price_pro', quantity: 1 }],
      metadata: { company_id: CO },
      subscription_data: { metadata: { company_id: CO }, trial_end: Date.parse('2026-11-14T12:00:00Z') / 1000 },
      payment_method_collection: 'always',
      success_url: 'https://staging.example.com/billing?checkout=success',
      cancel_url: 'https://staging.example.com/billing?checkout=cancelled',
    })
    const noTrial = buildCheckoutSessionParams({ companyId: CO, customerId: 'cus_1', priceId: 'p',
      appUrl: 'https://s.example.com', appTrialEndsAt: null, now })
    expect(noTrial.subscription_data).not.toHaveProperty('trial_end')
  })
})

describe('billing state helpers', () => {
  const base = { plan: 'pro', plan_name: 'Pro', can_write: true, trial_ends_at: null, current_period_start: null,
    current_period_end: null, cancel_at_period_end: false, cancel_at: null, last_payment_failed_at: null,
    max_clients: 1, max_documents_per_month: 1, max_members: 1, clients_used: 0, documents_this_month: 0 }
  const now = new Date('2026-11-08T12:00:00Z')
  it('maps database errors to UI codes', () => {
    expect(billingErrorCode({ message: 'BILLING_INACTIVE' })).toBe('billing')
    expect(billingErrorCode({ message: 'PLAN_LIMIT_CLIENTS' })).toBe('limit_clients')
    expect(billingErrorCode({ message: 'PLAN_LIMIT_DOCUMENTS' })).toBe('limit_documents')
    expect(billingErrorCode({ message: 'duplicate key' })).toBeNull()
    expect(billingErrorCode(null)).toBeNull()
  })
  it('counts trial days and builds the banner', () => {
    expect(daysLeft('2026-11-10T11:00:00Z', now)).toBe(2)
    expect(daysLeft('2026-11-01T00:00:00Z', now)).toBe(0)
    const trial = billingBanner({ ...base, state: 'trialing', trial_ends_at: '2026-11-15T12:00:00Z' } as BillingState, now)
    expect(trial).toEqual({ tone: 'info', text: 'Prueba gratuita: quedan 7 días.' })
    expect(billingBanner({ ...base, state: 'trialing', trial_ends_at: '2026-11-09T12:00:00Z' } as BillingState, now)?.tone).toBe('warning')
    expect(billingBanner({ ...base, state: 'past_due' } as BillingState, now)?.tone).toBe('warning')
    expect(billingBanner({ ...base, state: 'canceled', can_write: false } as BillingState, now)?.tone).toBe('danger')
    expect(billingBanner({ ...base, state: 'trial_expired', can_write: false } as BillingState, now)?.text).toMatch(/solo lectura/)
    expect(billingBanner({ ...base, state: 'active' } as BillingState, now)).toBeNull()
    expect(billingBanner({ ...base, state: 'active', cancel_at_period_end: true } as BillingState, now)?.text).toMatch(/cancelará/)
    expect(billingBanner(null)).toBeNull()
  })
})

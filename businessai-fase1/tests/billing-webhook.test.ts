import { beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import { handleStripeWebhook, type BillingStore } from '@/lib/billing/webhook'
import type { ExistingSubscription, SubscriptionRow } from '@/lib/billing/sync'
import { CO, PLANS, fakeSubscription } from './fixtures/billing'

// Offline: placeholder key (no network calls are made) and a made-up
// webhook secret used both to sign and to verify test payloads.
const stripe = new Stripe('sk_test_placeholder_offline')
const SECRET = 'whsec_unit_test_placeholder'

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event)
  return { rawBody: payload, signature: stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) }
}

function memoryStore() {
  const events = new Map<string, { status: string; attempts: number; last_error?: string }>()
  const subs = new Map<string, ExistingSubscription & Partial<SubscriptionRow> & Record<string, unknown>>()
  const store: BillingStore & { events: typeof events; subs: typeof subs } = {
    events, subs,
    async claimEvent(id) {
      const e = events.get(id)
      if (!e) { events.set(id, { status: 'processing', attempts: 1 }); return 'new' }
      if (e.status === 'processed') return 'processed'
      e.attempts += 1; e.status = 'processing'; return 'retry'
    },
    async markProcessed(id) { events.get(id)!.status = 'processed' },
    async markFailed(id, err) { const e = events.get(id)!; e.status = 'failed'; e.last_error = err },
    async loadPlans() { return PLANS },
    async companyExists(id) { return id === CO },
    async getSubscription(id) { return (subs.get(id) as ExistingSubscription) ?? null },
    async saveSubscription(id, row) { subs.set(id, { ...(subs.get(id) ?? {}), ...row }) },
    async setPaymentFailure(id, f) {
      const s = subs.get(id)!; s.last_payment_failed_at = f?.at ?? null; s.last_payment_error = f?.message ?? null
    },
  }
  return store
}

let current: Stripe.Subscription
const retrieve = vi.fn(async () => current)
const fakeStripe = { webhooks: stripe.webhooks, subscriptions: { retrieve } }
const silent = () => {}

async function deliver(store: ReturnType<typeof memoryStore>, event: Record<string, unknown>, sig?: string) {
  const s = signed(event)
  return handleStripeWebhook({ ...s, signature: sig ?? s.signature, webhookSecret: SECRET,
    stripe: fakeStripe, store, log: silent, now: () => new Date('2026-11-08T12:00:00Z') })
}

const ev = (id: string, type: string, object: Record<string, unknown>) =>
  ({ id, object: 'event', type, api_version: '2026-10-28.endive', created: 1, livemode: false,
     pending_webhooks: 1, request: null, data: { object } })

beforeEach(() => { retrieve.mockClear(); current = fakeSubscription() })

describe('Stripe webhook', () => {
  it('rejects a missing or forged signature (400) without touching the store', async () => {
    const store = memoryStore()
    const e = ev('evt_1', 'customer.subscription.updated', { id: 'sub_1' })
    expect((await handleStripeWebhook({ rawBody: '{}', signature: null, webhookSecret: SECRET, stripe: fakeStripe, store, log: silent })).status).toBe(400)
    expect((await deliver(store, e, 't=1,v1=forged')).status).toBe(400)
    const other = new Stripe('sk_test_placeholder_offline').webhooks.generateTestHeaderString({ payload: JSON.stringify(e), secret: 'whsec_other' })
    expect((await deliver(store, e, other)).status).toBe(400)
    expect(store.events.size).toBe(0)
  })

  it('checkout completed → stores the subscription with plan and period dates', async () => {
    const store = memoryStore()
    const r = await deliver(store, ev('evt_c', 'checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_1' }))
    expect(r.status).toBe(200)
    expect(retrieve).toHaveBeenCalledWith('sub_1')
    expect(store.subs.get(CO)).toMatchObject({ status: 'active', plan: 'pro', stripe_customer_id: 'cus_1' })
    expect(store.subs.get(CO)?.current_period_end).toBeTruthy()
    expect(store.events.get('evt_c')?.status).toBe('processed')
  })

  it('a duplicate delivery is acknowledged and not processed again', async () => {
    const store = memoryStore()
    const e = ev('evt_d', 'customer.subscription.updated', { id: 'sub_1' })
    await deliver(store, e)
    const again = await deliver(store, e)
    expect(again).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('re-reads the subscription from Stripe: the event payload is never trusted', async () => {
    const store = memoryStore()
    current = fakeSubscription({ status: 'past_due' })
    await deliver(store, ev('evt_p', 'customer.subscription.updated', { id: 'sub_1', status: 'active' }))
    expect(store.subs.get(CO)?.status).toBe('past_due')
  })

  it('payment failed → past_due and failure recorded; payment succeeded → cleared', async () => {
    const store = memoryStore()
    current = fakeSubscription({ status: 'past_due' })
    const invoice = { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } },
                      last_finalization_error: { message: 'Your card was declined.' } }
    await deliver(store, ev('evt_f', 'invoice.payment_failed', invoice))
    expect(store.subs.get(CO)).toMatchObject({ status: 'past_due', last_payment_error: 'Your card was declined.' })
    current = fakeSubscription({ status: 'active' })
    await deliver(store, ev('evt_ok', 'invoice.paid', invoice))
    expect(store.subs.get(CO)).toMatchObject({ status: 'active', last_payment_failed_at: null, last_payment_error: null })
  })

  it('cancellation at period end, then expiry', async () => {
    const store = memoryStore()
    current = fakeSubscription({ cancel_at_period_end: true, cancel_at: 1_802_592_000 })
    await deliver(store, ev('evt_x1', 'customer.subscription.updated', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ status: 'active', cancel_at_period_end: true })
    current = fakeSubscription({ status: 'canceled', ended_at: 1_802_592_000, canceled_at: 1_800_000_100 })
    await deliver(store, ev('evt_x2', 'customer.subscription.deleted', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ status: 'canceled', ended_at: new Date(1_802_592_000 * 1000).toISOString() })
  })

  it('a late event of an old subscription does not overwrite the current one', async () => {
    const store = memoryStore()
    current = fakeSubscription({ id: 'sub_new' })
    await deliver(store, ev('evt_n', 'customer.subscription.created', { id: 'sub_new' }))
    current = fakeSubscription({ id: 'sub_old', status: 'canceled' })
    const r = await deliver(store, ev('evt_o', 'customer.subscription.deleted', { id: 'sub_old' }))
    expect(r.status).toBe(200)
    expect(store.subs.get(CO)).toMatchObject({ stripe_subscription_id: 'sub_new', status: 'active' })
  })

  it('processing errors → 500 so Stripe retries; the retry succeeds', async () => {
    const store = memoryStore()
    current = fakeSubscription({}, { price: { id: 'price_x', lookup_key: 'unknown_key' } })
    const e = ev('evt_r', 'customer.subscription.updated', { id: 'sub_1' })
    const first = await deliver(store, e)
    expect(first.status).toBe(500)
    expect(store.events.get('evt_r')).toMatchObject({ status: 'failed' })
    expect(store.events.get('evt_r')?.last_error).toMatch(/unknown_price/)
    current = fakeSubscription()
    const retry = await deliver(store, e)
    expect(retry.status).toBe(200)
    expect(store.events.get('evt_r')).toMatchObject({ status: 'processed', attempts: 2 })
  })

  it('refuses subscriptions for unknown companies or another customer', async () => {
    const store = memoryStore()
    current = fakeSubscription({ metadata: { company_id: '0a0b0c0d-1111-4222-8333-444455556666' } })
    expect((await deliver(store, ev('evt_u', 'customer.subscription.updated', { id: 'sub_1' }))).status).toBe(500)
    store.subs.set(CO, { stripe_customer_id: 'cus_other', stripe_subscription_id: 'sub_1', status: 'active' })
    current = fakeSubscription()
    expect((await deliver(store, ev('evt_m', 'customer.subscription.updated', { id: 'sub_1' }))).status).toBe(500)
    expect(store.subs.get(CO)?.stripe_customer_id).toBe('cus_other')
  })

  it('ignores unrelated events (200) without calling Stripe', async () => {
    const store = memoryStore()
    const r = await deliver(store, ev('evt_i', 'customer.created', { id: 'cus_1' }))
    expect(r.status).toBe(200)
    expect(retrieve).not.toHaveBeenCalled()
  })
})

describe('Stripe webhook: 7-day trial with a card', () => {
  const TRIAL_START = 1_800_000_000
  const TRIAL_END = TRIAL_START + 7 * 86400
  const trialing = (over: Record<string, unknown> = {}) => fakeSubscription(
    { status: 'trialing', trial_start: TRIAL_START, trial_end: TRIAL_END, ...over },
    { current_period_start: TRIAL_START, current_period_end: TRIAL_END })
  const invoice = (over: Record<string, unknown> = {}) =>
    ({ id: 'in_t', parent: { subscription_details: { subscription: 'sub_1' } }, ...over })

  it('checkout completed → trialing with trial dates (nothing charged)', async () => {
    const store = memoryStore()
    current = trialing()
    const r = await deliver(store, ev('evt_t1', 'checkout.session.completed', { id: 'cs', mode: 'subscription', subscription: 'sub_1' }))
    expect(r.status).toBe(200)
    expect(store.subs.get(CO)).toMatchObject({
      status: 'trialing', plan: 'pro',
      trial_start: new Date(TRIAL_START * 1000).toISOString(),
      trial_end: new Date(TRIAL_END * 1000).toISOString(),
      cancel_at_period_end: false,
    })
    expect(store.subs.get(CO)?.last_payment_error).toBeUndefined()
  })

  it('trial ends, card charged → active', async () => {
    const store = memoryStore()
    current = trialing()
    await deliver(store, ev('evt_t2a', 'customer.subscription.created', { id: 'sub_1' }))
    current = fakeSubscription({ status: 'active', trial_start: TRIAL_START, trial_end: TRIAL_END },
      { current_period_start: TRIAL_END, current_period_end: TRIAL_END + 30 * 86400 })
    await deliver(store, ev('evt_t2b', 'invoice.paid', invoice()))
    expect(store.subs.get(CO)).toMatchObject({
      status: 'active', last_payment_error: null,
      current_period_start: new Date(TRIAL_END * 1000).toISOString(),
    })
  })

  it('trial ends, card declined (e.g. 4000 0000 0000 0341) → past_due + failure recorded', async () => {
    const store = memoryStore()
    current = trialing()
    await deliver(store, ev('evt_t3a', 'customer.subscription.created', { id: 'sub_1' }))
    current = fakeSubscription({ status: 'past_due', trial_start: TRIAL_START, trial_end: TRIAL_END })
    await deliver(store, ev('evt_t3b', 'invoice.payment_failed',
      invoice({ last_finalization_error: { message: 'Your card was declined.' } })))
    expect(store.subs.get(CO)).toMatchObject({ status: 'past_due', last_payment_error: 'Your card was declined.' })
    expect(store.subs.get(CO)?.last_payment_failed_at).toBe('2026-11-08T12:00:00.000Z')
  })

  it('trial ends, bank asks for authentication → failure "authentication_required"', async () => {
    const store = memoryStore()
    current = fakeSubscription({ status: 'past_due', trial_start: TRIAL_START, trial_end: TRIAL_END })
    await deliver(store, ev('evt_t4', 'invoice.payment_action_required', invoice()))
    expect(store.subs.get(CO)).toMatchObject({ status: 'past_due', last_payment_error: 'authentication_required' })
  })

  it('cancel during the trial → no charge: trialing with cancellation, then canceled at trial end', async () => {
    const store = memoryStore()
    current = trialing()
    await deliver(store, ev('evt_c1', 'customer.subscription.created', { id: 'sub_1' }))
    current = trialing({ cancel_at_period_end: true, cancel_at: TRIAL_END, canceled_at: TRIAL_START + 3600 })
    await deliver(store, ev('evt_c2', 'customer.subscription.updated', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ status: 'trialing', cancel_at_period_end: true,
      cancel_at: new Date(TRIAL_END * 1000).toISOString() })
    current = trialing({ status: 'canceled', cancel_at_period_end: true, ended_at: TRIAL_END })
    await deliver(store, ev('evt_c3', 'customer.subscription.deleted', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ status: 'canceled', ended_at: new Date(TRIAL_END * 1000).toISOString() })
    // No invoice event was involved: nothing was charged or recorded as a payment.
    expect(store.subs.get(CO)?.last_payment_failed_at).toBeUndefined()
  })

  it('card declined at Checkout → no subscription is created; the expired session is ignored', async () => {
    const store = memoryStore()
    const r = await deliver(store, ev('evt_e', 'checkout.session.expired', { id: 'cs_x', mode: 'subscription', subscription: null }))
    expect(r.status).toBe(200)
    expect(retrieve).not.toHaveBeenCalled()
    expect(store.subs.size).toBe(0)
    // A completed session without a subscription (should not happen) is also a no-op.
    await deliver(store, ev('evt_e2', 'checkout.session.completed', { id: 'cs_y', mode: 'subscription', subscription: null }))
    expect(store.subs.size).toBe(0)
  })

  it('duplicated trial events (Stripe resends) are processed once', async () => {
    const store = memoryStore()
    current = trialing()
    const created = ev('evt_dup', 'customer.subscription.created', { id: 'sub_1' })
    expect((await deliver(store, created)).status).toBe(200)
    expect((await deliver(store, created)).body).toEqual({ received: true, duplicate: true })
    expect((await deliver(store, created)).body).toEqual({ received: true, duplicate: true })
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(store.events.get('evt_dup')).toMatchObject({ status: 'processed' })
  })
})

describe('Stripe webhook: plan changes update permissions', () => {
  it('upgrade and downgrade through the portal change the stored plan (limits follow)', async () => {
    const store = memoryStore()
    current = fakeSubscription({}, { price: { id: 'price_basic', lookup_key: 'businessai_basic_monthly' } })
    await deliver(store, ev('evt_pl1', 'customer.subscription.created', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ plan: 'basic', stripe_price_id: 'price_basic' })
    current = fakeSubscription({}, { price: { id: 'price_premium', lookup_key: 'businessai_premium_monthly' } })
    await deliver(store, ev('evt_pl2', 'customer.subscription.updated', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ plan: 'premium', stripe_price_id: 'price_premium' })
    current = fakeSubscription({}, { price: { id: 'price_basic', lookup_key: 'businessai_basic_monthly' } })
    await deliver(store, ev('evt_pl3', 'customer.subscription.updated', { id: 'sub_1' }))
    expect(store.subs.get(CO)).toMatchObject({ plan: 'basic' })
  })

  it('renewal stores the new period (the monthly document counter resets on it)', async () => {
    const store = memoryStore()
    current = fakeSubscription({}, { current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 })
    await deliver(store, ev('evt_rn1', 'invoice.paid', { id: 'in_r1', parent: { subscription_details: { subscription: 'sub_1' } } }))
    current = fakeSubscription({}, { current_period_start: 1_802_592_000, current_period_end: 1_805_184_000 })
    await deliver(store, ev('evt_rn2', 'invoice.paid', { id: 'in_r2', parent: { subscription_details: { subscription: 'sub_1' } } }))
    expect(store.subs.get(CO)?.current_period_start).toBe(new Date(1_802_592_000 * 1000).toISOString())
  })
})

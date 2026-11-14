import type Stripe from 'stripe'

/** Statuses accepted by company_subscriptions_status_check. */
export const SUBSCRIPTION_STATUSES = [
  'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete_expired', 'paused',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

const TERMINAL: readonly string[] = ['canceled', 'incomplete_expired']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlanKey = 'basic' | 'pro' | 'premium'
export type PlanCatalogEntry = { plan: PlanKey; stripe_lookup_key: string }

export class BillingSyncError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BillingSyncError'
  }
}

/** Columns of company_subscriptions written from Stripe. */
export type SubscriptionRow = {
  stripe_customer_id: string
  stripe_subscription_id: string
  stripe_price_id: string
  plan: PlanKey
  status: SubscriptionStatus
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  cancel_at: string | null
  canceled_at: string | null
  ended_at: string | null
  trial_start: string | null
  trial_end: string | null
  stripe_synced_at: string
  updated_at: string
}

const iso = (unix: number | null | undefined) =>
  typeof unix === 'number' && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : null

export const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  !ref ? null : typeof ref === 'string' ? ref : ref.id

export function companyIdFromMetadata(metadata: Stripe.Metadata | null | undefined): string {
  const id = metadata?.company_id
  if (!id || !UUID.test(id)) {
    throw new BillingSyncError('missing_company', 'Subscription has no valid metadata.company_id')
  }
  return id
}

/**
 * Maps the CURRENT state of a Stripe subscription (always re-read from the
 * API, never taken from the event payload) to the database row.
 * Period dates come from the subscription item (Stripe API ≥ 2025).
 */
export function subscriptionToRow(
  sub: Stripe.Subscription,
  plans: PlanCatalogEntry[],
  now: Date = new Date()
): { companyId: string; row: SubscriptionRow } {
  const companyId = companyIdFromMetadata(sub.metadata)

  if (sub.items.data.length !== 1) {
    throw new BillingSyncError('items', `Expected 1 subscription item, got ${sub.items.data.length}`)
  }
  const item = sub.items.data[0]
  const lookupKey = item.price.lookup_key
  const entry = plans.find((p) => p.stripe_lookup_key === lookupKey)
  if (!lookupKey || !entry) {
    throw new BillingSyncError('unknown_price', `Price ${item.price.id} has no known lookup_key`)
  }

  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) {
    throw new BillingSyncError('unknown_status', `Unsupported subscription status ${sub.status}`)
  }

  const customer = idOf(sub.customer)
  if (!customer) throw new BillingSyncError('customer', 'Subscription has no customer')

  const stamp = now.toISOString()
  return {
    companyId,
    row: {
      stripe_customer_id: customer,
      stripe_subscription_id: sub.id,
      stripe_price_id: item.price.id,
      plan: entry.plan,
      status: sub.status as SubscriptionStatus,
      current_period_start: iso(item.current_period_start),
      current_period_end: iso(item.current_period_end),
      cancel_at_period_end: sub.cancel_at_period_end,
      cancel_at: iso(sub.cancel_at),
      canceled_at: iso(sub.canceled_at),
      ended_at: iso(sub.ended_at),
      trial_start: iso(sub.trial_start),
      trial_end: iso(sub.trial_end),
      stripe_synced_at: stamp,
      updated_at: stamp,
    },
  }
}

export type ExistingSubscription = {
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  status: string
} | null

/**
 * Whether an incoming subscription may overwrite the company's row.
 * Protects against late events of an OLD subscription (e.g. the deletion of
 * a previous, canceled one) overwriting the current one.
 */
export function decideApply(
  existing: ExistingSubscription,
  incoming: Pick<SubscriptionRow, 'stripe_subscription_id' | 'stripe_customer_id' | 'status'>
): { apply: boolean; reason: string } {
  if (existing?.stripe_customer_id && existing.stripe_customer_id !== incoming.stripe_customer_id) {
    throw new BillingSyncError('customer_mismatch',
      'Subscription customer differs from the company customer')
  }
  if (!existing || !existing.stripe_subscription_id) return { apply: true, reason: 'first_subscription' }
  if (existing.stripe_subscription_id === incoming.stripe_subscription_id) return { apply: true, reason: 'same_subscription' }
  if (TERMINAL.includes(existing.status)) return { apply: true, reason: 'replaces_ended_subscription' }
  if (TERMINAL.includes(incoming.status)) return { apply: false, reason: 'ignores_old_ended_subscription' }
  return { apply: true, reason: 'replaces_other_subscription' }
}

/** Subscription statuses for which a new checkout would create a duplicate. */
export function hasLiveStripeSubscription(existing: ExistingSubscription): boolean {
  return Boolean(
    existing?.stripe_subscription_id &&
      ['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(existing.status)
  )
}

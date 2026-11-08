import type Stripe from 'stripe'
import {
  BillingSyncError,
  decideApply,
  idOf,
  subscriptionToRow,
  type ExistingSubscription,
  type PlanCatalogEntry,
  type SubscriptionRow,
} from './sync'

/** Storage operations the webhook needs (implemented with the service role). */
export interface BillingStore {
  /** 'new' → process; 'processed' → duplicate delivery; 'retry' → earlier attempt failed/unfinished. */
  claimEvent(id: string, type: string): Promise<'new' | 'processed' | 'retry'>
  markProcessed(id: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  loadPlans(): Promise<PlanCatalogEntry[]>
  companyExists(companyId: string): Promise<boolean>
  getSubscription(companyId: string): Promise<ExistingSubscription>
  saveSubscription(companyId: string, row: SubscriptionRow): Promise<void>
  setPaymentFailure(companyId: string, failure: { at: string; message: string } | null): Promise<void>
}

export type StripeLike = {
  webhooks: Pick<Stripe['webhooks'], 'constructEvent'>
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> }
}

export type WebhookResult = { status: number; body: Record<string, unknown> }

/** Events that change a subscription; all are handled by re-reading it. */
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
])

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription ?? null)
}

async function syncSubscription(
  subscriptionId: string,
  stripe: StripeLike,
  store: BillingStore,
  now: Date
): Promise<{ companyId: string; applied: boolean; reason: string }> {
  // Always the CURRENT state from Stripe: event order does not matter.
  const sub = await stripe.subscriptions.retrieve(subscriptionId)
  const plans = await store.loadPlans()
  const { companyId, row } = subscriptionToRow(sub, plans, now)
  if (!(await store.companyExists(companyId))) {
    throw new BillingSyncError('unknown_company', `Company ${companyId} does not exist`)
  }
  const decision = decideApply(await store.getSubscription(companyId), row)
  if (decision.apply) await store.saveSubscription(companyId, row)
  return { companyId, applied: decision.apply, reason: decision.reason }
}

/**
 * Verifies, de-duplicates and processes one Stripe webhook delivery.
 * Returns 400 for an invalid signature, 200 when handled (or ignored), and
 * 500 on processing errors so that Stripe retries the delivery.
 */
export async function handleStripeWebhook(input: {
  rawBody: string
  signature: string | null
  webhookSecret: string
  stripe: StripeLike
  store: BillingStore
  now?: () => Date
  log?: (message: string, data: Record<string, unknown>) => void
}): Promise<WebhookResult> {
  const { stripe, store } = input
  const now = input.now ?? (() => new Date())
  const log = input.log ?? ((m, d) => console.log(m, d))

  if (!input.signature) return { status: 400, body: { error: 'missing_signature' } }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(input.rawBody, input.signature, input.webhookSecret)
  } catch {
    return { status: 400, body: { error: 'invalid_signature' } }
  }

  const claim = await store.claimEvent(event.id, event.type)
  if (claim === 'processed') {
    return { status: 200, body: { received: true, duplicate: true } }
  }

  try {
    let outcome: Record<string, unknown> = { ignored: true }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const subscriptionId = idOf(session.subscription)
      if (session.mode === 'subscription' && subscriptionId) {
        outcome = await syncSubscription(subscriptionId, stripe, store, now())
      }
    } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const sub = event.data.object as Stripe.Subscription
      outcome = await syncSubscription(sub.id, stripe, store, now())
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed'
               || event.type === 'invoice.payment_action_required') {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = invoiceSubscriptionId(invoice)
      if (subscriptionId) {
        const synced = await syncSubscription(subscriptionId, stripe, store, now())
        if (synced.applied) {
          await store.setPaymentFailure(
            synced.companyId,
            event.type === 'invoice.paid'
              ? null
              : {
                  at: now().toISOString(),
                  message: event.type === 'invoice.payment_action_required'
                    ? 'authentication_required'
                    : (invoice.last_finalization_error?.message ?? 'payment_failed').slice(0, 300),
                }
          )
        }
        outcome = { ...synced, payment: event.type }
      }
    }

    await store.markProcessed(event.id)
    log('STRIPE_WEBHOOK_OK', { id: event.id, type: event.type, ...outcome })
    return { status: 200, body: { received: true } }
  } catch (error) {
    const message = error instanceof BillingSyncError
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error)
    await store.markFailed(event.id, message.slice(0, 500))
    log('STRIPE_WEBHOOK_FAILED', { id: event.id, type: event.type, error: message })
    return { status: 500, body: { error: 'processing_failed' } }
  }
}

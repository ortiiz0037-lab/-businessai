import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStripe } from '@/lib/billing/stripe'
import { getUserCompany } from '@/lib/billing/company'
import { buildCheckoutSessionParams, chargeTerms, toPriceInfo } from '@/lib/billing/checkout'
import { hasLiveStripeSubscription } from '@/lib/billing/sync'
import { ConfigError } from '@/lib/env'
import { personTrialAvailable } from '@/lib/billing/trial'

export const runtime = 'nodejs'

function back(request: NextRequest, query: string) {
  return NextResponse.redirect(new URL(`/billing?${query}`, request.url), 303)
}

/**
 * Form POST from /billing with `plan` and `accept_terms=yes` → 303 to Stripe
 * Checkout (or to the portal when a subscription already exists).
 * Checkout always collects a card; the first subscription of a company gets
 * the free trial (billing_config.trial_days) if neither the company nor the
 * person used one before; otherwise it is charged at once.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/billing', request.url), 303)

  const company = await getUserCompany(supabase, user)
  if (!company) return NextResponse.redirect(new URL('/onboarding', request.url), 303)
  if (!company.canManageBilling) return back(request, 'error=forbidden')

  const form = await request.formData().catch(() => null)
  const planKey = String(form?.get('plan') ?? '')
  // The price, first charge date and conditions are shown on /billing; the
  // customer must confirm them before going to Stripe.
  if (form?.get('accept_terms') !== 'yes') return back(request, 'error=terms')

  try {
    const { stripe, appUrl } = getStripe()
    const admin = createAdminClient()

    const { data: plan } = await admin
      .from('billing_plans')
      .select('plan, name, stripe_lookup_key, active')
      .eq('plan', planKey)
      .maybeSingle()
    if (!plan || !plan.active) return back(request, 'error=plan')

    const { data: current, error: currentError } = await admin
      .from('company_subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, status, trial_consumed_at')
      .eq('company_id', company.companyId)
      .maybeSingle()
    if (currentError) throw currentError

    // Already subscribed: changes and cancellations go through the portal,
    // never through a second checkout (no duplicate subscriptions).
    if (current && hasLiveStripeSubscription(current) && current.stripe_customer_id) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: current.stripe_customer_id,
        return_url: `${appUrl}/billing`,
      })
      return NextResponse.redirect(portal.url, 303)
    }

    const prices = await stripe.prices.list({ lookup_keys: [plan.stripe_lookup_key], active: true, limit: 1 })
    const price = prices.data[0]
    const priceInfo = price ? toPriceInfo(price) : null
    if (!price || price.type !== 'recurring' || !priceInfo) {
      console.error('CHECKOUT_PRICE_NOT_FOUND', { lookup_key: plan.stripe_lookup_key })
      return back(request, 'error=price')
    }

    // One Stripe customer per company, reused for every checkout.
    let customerId = current?.stripe_customer_id ?? null
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email: user.email ?? undefined,
          name: company.companyName ?? undefined,
          metadata: { company_id: company.companyId },
        },
        { idempotencyKey: `customer-${company.companyId}` }
      )
      customerId = customer.id
      const { error: saveError } = current
        ? await admin.from('company_subscriptions')
            .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
            .eq('company_id', company.companyId)
        : await admin.from('company_subscriptions')
            .insert({ company_id: company.companyId, stripe_customer_id: customerId, plan: plan.plan, status: 'incomplete' })
      if (saveError) throw saveError
    }

    const { data: config } = await admin.from('billing_config').select('trial_days').maybeSingle()
    // One trial per company AND per person (C3): creating more companies
    // does not chain free trials.
    const trialDays = !current?.trial_consumed_at && await personTrialAvailable(admin, company.companyId, user.id, true)
      ? (config?.trial_days ?? 7)
      : null
    const { terms } = chargeTerms({ planName: plan.name, price: priceInfo, trialDays, now: new Date() })

    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams({
        companyId: company.companyId,
        customerId,
        priceId: price.id,
        appUrl,
        trialDays,
        terms,
      })
    )
    if (!session.url) throw new Error('Checkout session without URL')
    return NextResponse.redirect(session.url, 303)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('CHECKOUT_CONFIG_ERROR', { message: error.message })
      return back(request, 'error=config')
    }
    console.error('CHECKOUT_ERROR', { message: error instanceof Error ? error.message : String(error) })
    return back(request, 'error=checkout')
  }
}

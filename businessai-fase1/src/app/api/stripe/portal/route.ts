import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStripe } from '@/lib/billing/stripe'
import { getUserCompany } from '@/lib/billing/company'
import { ConfigError } from '@/lib/env'
import { isPlanKey } from '@/lib/billing/catalog'
import { buildPlanChangeSession, singleItemId } from '@/lib/billing/portal'

export const runtime = 'nodejs'

function back(request: NextRequest, query: string) {
  return NextResponse.redirect(new URL(`/billing?${query}`, request.url), 303)
}

/**
 * Form POST from /billing → 303 to the Stripe Customer Portal (change plan,
 * card, cancel). With `plan` (basic|pro|premium) different from the current
 * one, the portal opens directly on the confirmation of the change to that
 * plan; if that flow is not possible it falls back to the portal home.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/billing', request.url), 303)

  const company = await getUserCompany(supabase, user)
  if (!company) return NextResponse.redirect(new URL('/onboarding', request.url), 303)
  if (!company.canManageBilling) return back(request, 'error=forbidden')

  try {
    const { stripe, appUrl } = getStripe()
    const form = await request.formData().catch(() => null)
    const requested = form?.get('plan') ?? null
    if (requested !== null && !isPlanKey(requested)) return back(request, 'error=plan')

    const admin = createAdminClient()
    const { data, error } = await admin
      .from('company_subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, plan')
      .eq('company_id', company.companyId)
      .maybeSingle()
    if (error) throw error
    if (!data?.stripe_customer_id) return back(request, 'error=no_customer')

    if (requested && requested !== data.plan && data.stripe_subscription_id) {
      try {
        const { data: plan } = await admin
          .from('billing_plans').select('stripe_lookup_key, active').eq('plan', requested).maybeSingle()
        if (!plan?.active) return back(request, 'error=plan')
        const [prices, subscription] = await Promise.all([
          stripe.prices.list({ lookup_keys: [plan.stripe_lookup_key], active: true, limit: 1 }),
          stripe.subscriptions.retrieve(data.stripe_subscription_id),
        ])
        const priceId = prices.data[0]?.id
        const itemId = singleItemId(subscription)
        if (priceId && itemId) {
          const session = await stripe.billingPortal.sessions.create(buildPlanChangeSession({
            customerId: data.stripe_customer_id,
            subscriptionId: data.stripe_subscription_id,
            itemId,
            priceId,
            appUrl,
          }))
          return NextResponse.redirect(session.url, 303)
        }
        console.warn('PORTAL_PLAN_CHANGE_FALLBACK', { reason: priceId ? 'items' : 'price' })
      } catch (flowError) {
        // e.g. the subscription can no longer be updated: the portal home still lets the customer act.
        console.warn('PORTAL_PLAN_CHANGE_FALLBACK', { message: flowError instanceof Error ? flowError.message : String(flowError) })
      }
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${appUrl}/billing`,
    })
    return NextResponse.redirect(portal.url, 303)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('PORTAL_CONFIG_ERROR', { message: error.message })
      return back(request, 'error=config')
    }
    console.error('PORTAL_ERROR', { message: error instanceof Error ? error.message : String(error) })
    return back(request, 'error=portal')
  }
}

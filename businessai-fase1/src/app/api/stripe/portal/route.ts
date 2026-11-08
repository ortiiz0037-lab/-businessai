import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStripe } from '@/lib/billing/stripe'
import { getUserCompany } from '@/lib/billing/company'
import { ConfigError } from '@/lib/env'

export const runtime = 'nodejs'

function back(request: NextRequest, query: string) {
  return NextResponse.redirect(new URL(`/billing?${query}`, request.url), 303)
}

/** Form POST from /billing → 303 to the Stripe Customer Portal (change plan, card, cancel). */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/billing', request.url), 303)

  const company = await getUserCompany(supabase, user)
  if (!company) return NextResponse.redirect(new URL('/onboarding', request.url), 303)
  if (!company.canManageBilling) return back(request, 'error=forbidden')

  try {
    const { stripe, appUrl } = getStripe()
    const { data, error } = await createAdminClient()
      .from('company_subscriptions')
      .select('stripe_customer_id')
      .eq('company_id', company.companyId)
      .maybeSingle()
    if (error) throw error
    if (!data?.stripe_customer_id) return back(request, 'error=no_customer')

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

import { getStripe } from '@/lib/billing/stripe'
import { toPriceInfo, type PriceInfo } from '@/lib/billing/checkout'

/**
 * Active Stripe prices by lookup key (server only). Never throws: returns an
 * empty map when Stripe is not configured in this environment, so pages
 * still render.
 */
export async function loadPrices(lookupKeys: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>()
  if (lookupKeys.length === 0) return prices
  try {
    const { stripe } = getStripe()
    const list = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 })
    for (const p of list.data) {
      const info = toPriceInfo(p)
      if (p.lookup_key && info) prices.set(p.lookup_key, info)
    }
  } catch {
    // Not configured in this environment: callers fall back.
  }
  return prices
}

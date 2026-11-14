#!/usr/bin/env node
/**
 * Prepares a Stripe account in TEST MODE for BusinessAI (idempotent):
 *   - one product + monthly price per plan, with the lookup keys used by
 *     public.billing_plans (businessai_<plan>_monthly);
 *   - a Customer Portal configuration (update card, cancel at period end,
 *     switch plan, invoice history).
 *
 * Usage (amounts in CENTS, chosen by you; currency default usd):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-test.mjs \
 *     --basic 1900 --pro 3900 --premium 7900 [--currency usd]
 *
 * --plan-only: shows which prices already exist and what would be created.
 * Writes nothing; amounts are optional in this mode.
 *
 * Refuses live keys. Never prints the key. Existing prices are left as they
 * are (Stripe prices are immutable): to change an amount, archive the old
 * price in the Dashboard and run again.
 */
import Stripe from 'stripe'

const PLANS = [
  { plan: 'basic', name: 'BusinessAI Básico' },
  { plan: 'pro', name: 'BusinessAI Pro' },
  { plan: 'premium', name: 'BusinessAI Premium' },
]

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) fail('STRIPE_SECRET_KEY must be a TEST key (sk_test_… / rk_test_…). Live keys are refused.')

const planOnly = args.includes('--plan-only')
const currency = (arg('currency') ?? 'usd').toLowerCase()
if (!/^[a-z]{3}$/.test(currency)) fail('--currency must be a 3-letter ISO code')
const amounts = {}
for (const { plan } of PLANS) {
  const raw = arg(plan)
  if (planOnly && !raw) continue
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 50) fail(`--${plan} <amount in cents> is required (>= 50)`)
  amounts[plan] = Number(raw)
}

const stripe = new Stripe(key)
const lookupKey = (plan) => `businessai_${plan}_monthly`

if (planOnly) {
  console.log('PLAN ONLY — nothing is written:')
  for (const { plan } of PLANS) {
    const found = (await stripe.prices.list({ lookup_keys: [lookupKey(plan)], active: true, limit: 1 })).data[0]
    console.log(found
      ? `  = ${plan}: price exists (${found.unit_amount} ${found.currency})`
      : `  + ${plan}: would create ${amounts[plan] ?? '<amount>'} ${currency} / month (${lookupKey(plan)})`)
  }
  const portal = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })
  console.log(portal.data[0] ? '  = portal: default configuration would be updated' : '  + portal: would be created')
  process.exit(0)
}

const priceIds = []
for (const { plan, name } of PLANS) {
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey(plan)], active: true, limit: 1 })
  let price = existing.data[0]
  if (price) {
    console.log(`= ${plan}: price exists (${price.id}, ${price.unit_amount} ${price.currency})`)
    if (price.unit_amount !== amounts[plan] || price.currency !== currency) {
      console.log(`  ! differs from the requested ${amounts[plan]} ${currency}; left unchanged`)
    }
  } else {
    const product = await stripe.products.create({ name, metadata: { businessai_plan: plan } })
    price = await stripe.prices.create({
      product: product.id,
      currency,
      unit_amount: amounts[plan],
      recurring: { interval: 'month' },
      lookup_key: lookupKey(plan),
      metadata: { businessai_plan: plan },
    })
    console.log(`+ ${plan}: created ${price.id} (${price.unit_amount} ${price.currency})`)
  }
  priceIds.push({ product: typeof price.product === 'string' ? price.product : price.product.id, prices: [price.id] })
}

const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })
const features = {
  customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name'] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end' },
  subscription_update: {
    enabled: true,
    default_allowed_updates: ['price'],
    proration_behavior: 'create_prorations',
    products: priceIds,
  },
}
if (configs.data[0]) {
  await stripe.billingPortal.configurations.update(configs.data[0].id, { features })
  console.log(`= portal: default configuration updated (${configs.data[0].id})`)
} else {
  const created = await stripe.billingPortal.configurations.create({ features })
  console.log(`+ portal: configuration created (${created.id})`)
}
console.log('Done (test mode).')

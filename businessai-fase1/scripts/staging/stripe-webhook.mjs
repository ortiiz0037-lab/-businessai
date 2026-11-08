#!/usr/bin/env node
/**
 * Creates the STAGING webhook endpoint in Stripe TEST MODE and outputs its
 * signing secret for the next step (Vercel Preview variables).
 *
 *   STRIPE_SECRET_KEY=sk_test_... STAGING_URL=https://… \
 *   [VERCEL_AUTOMATION_BYPASS_SECRET=…] [GITHUB_ENV=path] node scripts/staging/stripe-webhook.mjs
 *
 * - Refuses live keys and non-https URLs.
 * - Stripe reveals a signing secret only when an endpoint is created, so the
 *   previous staging endpoint (metadata businessai_env=staging) is deleted
 *   and a new one created. Endpoints of other environments are never touched.
 * - The secret is written to $GITHUB_ENV (masked in the logs) or, locally,
 *   only its last 4 characters are printed.
 */
import Stripe from 'stripe'
import { appendFileSync } from 'node:fs'

export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
]

export function webhookUrl(stagingUrl, bypassSecret) {
  const base = new URL(stagingUrl)
  if (base.protocol !== 'https:') throw new Error('STAGING_URL must be https')
  const url = new URL('/api/stripe/webhook', base.origin)
  // Vercel Deployment Protection: lets Stripe reach a protected preview.
  if (bypassSecret) url.searchParams.set('x-vercel-protection-bypass', bypassSecret)
  return url.toString()
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (!/^(sk|rk)_test_/.test(key)) fail('STRIPE_SECRET_KEY must be a TEST key. Live keys are refused.')
  if (!process.env.STAGING_URL) fail('STAGING_URL is required')

  let url
  try {
    url = webhookUrl(process.env.STAGING_URL, process.env.VERCEL_AUTOMATION_BYPASS_SECRET)
  } catch (e) {
    fail(e.message)
  }

  const stripe = new Stripe(key)
  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  for (const ep of existing.data) {
    if (ep.metadata?.businessai_env === 'staging') {
      await stripe.webhookEndpoints.del(ep.id)
      console.log(`- removed previous staging endpoint ${ep.id}`)
    }
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: 'BusinessAI staging',
    metadata: { businessai_env: 'staging' },
  })
  console.log(`+ staging endpoint ${created.id} → ${new URL(url).origin}/api/stripe/webhook (${WEBHOOK_EVENTS.length} events)`)

  const secret = created.secret
  if (!secret) fail('Stripe did not return a signing secret')
  if (process.env.GITHUB_ENV) {
    console.log(`::add-mask::${secret}`)
    appendFileSync(process.env.GITHUB_ENV, `STRIPE_WEBHOOK_SECRET=${secret}\n`)
    console.log('Signing secret handed to the next step (masked).')
  } else {
    console.log(`Signing secret created (…${secret.slice(-4)}). Store it as STRIPE_WEBHOOK_SECRET in Vercel Preview.`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message))
}

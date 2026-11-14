#!/usr/bin/env node
/**
 * End-to-end billing test against STAGING (Supabase staging + Stripe TEST
 * mode + the deployed staging webhook). Creates throw-away users,
 * companies, Stripe customers and subscriptions, checks what the webhook
 * stored, and deletes everything at the end.
 *
 * Required: STAGING_PROJECT_REF, STAGING_SUPABASE_URL,
 *           STAGING_SUPABASE_PUBLISHABLE_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *           STRIPE_SECRET_KEY (sk_test_… only).
 * Optional: PRODUCTION_PROJECT_REF (refused if it matches), E2E_TIMEOUT_MS.
 *
 * Checkout itself (the hosted page) needs a browser; it is covered by the
 * manual step in docs/STAGING_SETUP.md. Here subscriptions are created with
 * the same parameters Checkout uses (trial_period_days, card on file,
 * metadata.company_id) and Stripe's test payment methods. Each scenario runs
 * on its own Stripe TEST CLOCK, advanced past the trial, so Stripe behaves
 * exactly as it would on day 8 (charge, failed charge, cancellation).
 */
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const env = process.env
const TIMEOUT = Number(env.E2E_TIMEOUT_MS ?? 90_000)
const stamp = Date.now()
const results = []
const cleanup = []

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function guards() {
  for (const k of ['STAGING_PROJECT_REF', 'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_PUBLISHABLE_KEY',
                   'STAGING_SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY']) {
    if (!env[k]) fail(`${k} is required`)
  }
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)) fail('STRIPE_SECRET_KEY must be a TEST key')
  const host = new URL(env.STAGING_SUPABASE_URL).hostname
  if (!host.startsWith(`${env.STAGING_PROJECT_REF}.`)) fail('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF')
  if (env.PRODUCTION_PROJECT_REF && host.startsWith(`${env.PRODUCTION_PROJECT_REF}.`)) fail('refusing to run against PRODUCTION')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(label, read, predicate) {
  const start = Date.now()
  let last
  while (Date.now() - start < TIMEOUT) {
    last = await read()
    if (last && predicate(last)) return last
    await sleep(3000)
  }
  throw new Error(`timeout waiting for ${label}; last value: ${JSON.stringify(last)}`)
}

/** Documented generic-decline test PaymentMethod (docs.stripe.com/testing). */
export const DECLINED_TEST_PM = 'pm_card_visa_chargeDeclined'

/**
 * Reads Stripe's answer to storing a card on a customer. A decline arrives as
 * a card error (thrown); a SetupIntent can also report it as
 * requires_payment_method + last_setup_error. The summary carries technical
 * fields only (HTTP status, error type/code/param, decline code, request id and
 * Stripe's message with anything key- or email-like redacted): no keys,
 * customer data or card details.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '[key]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[secret]')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .slice(0, 200)
}

export function declineOutcome({ error, setupIntent, attached }) {
  if (error) {
    const code = error.code ?? error.raw?.code
    const decline = error.decline_code ?? error.raw?.decline_code
    const param = error.param ?? error.raw?.param
    const isCardError = error.type === 'StripeCardError' || error.raw?.type === 'card_error'
    const summary = `HTTP ${error.statusCode ?? '?'} ${error.type ?? error.raw?.type ?? 'error'}`
      + ` code=${code ?? '-'} decline_code=${decline ?? '-'} param=${param ?? '-'} request=${error.requestId ?? '-'}`
      + ` message="${redact(error.message ?? error.raw?.message)}"`
    return { declined: isCardError && code === 'card_declined', summary }
  }
  if (attached) return { declined: false, summary: 'card attached to the customer (not declined)' }
  const last = setupIntent?.last_setup_error
  const summary = `SetupIntent status=${setupIntent?.status ?? '-'} last_setup_error=${last?.code ?? '-'}`
    + ` decline_code=${last?.decline_code ?? '-'}`
  return { declined: setupIntent?.status === 'requires_payment_method' && last?.code === 'card_declined', summary }
}

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  guards()
  const stripe = new Stripe(env.STRIPE_SECRET_KEY)
  const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } })

  // Guard: the database must be staging (no production-only objects).
  const { data: plans, error: plansError } = await admin.from('billing_plans').select('plan, stripe_lookup_key')
  if (plansError) fail(`billing not installed on staging (run the migrations first): ${plansError.message}`)
  const pro = plans.find((p) => p.plan === 'pro')
  const prices = await stripe.prices.list({ lookup_keys: [pro.stripe_lookup_key], active: true, limit: 1 })
  const price = prices.data[0]
  if (!price) fail(`no active test price with lookup key ${pro.stripe_lookup_key} (run the Stripe setup step)`)
  const { data: cfg } = await admin.from('billing_config').select('trial_days').single()
  const trialDays = cfg?.trial_days ?? 7

  const password = `E2e-${stamp}-Aa1!`
  async function newCompany(tag) {
    const email = `e2e-${tag}-${stamp}@example.test`
    const { data: u, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    cleanup.push(async () => { await admin.auth.admin.deleteUser(u.user.id) })
    const user = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } })
    const { error: signInError } = await user.auth.signInWithPassword({ email, password })
    if (signInError) throw signInError
    const { data: companyId, error: rpcError } = await user.rpc('create_company', { company_name: `E2E ${tag} ${stamp}` })
    if (rpcError) throw rpcError
    cleanup.unshift(async () => {
      for (const t of ['payments', 'documents', 'clients', 'company_subscriptions', 'company_profiles']) {
        await admin.from(t).delete().eq('company_id', companyId)
      }
      await admin.from('companies').delete().eq('id', companyId)
    })
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000), name: `businessai-e2e-${tag}-${stamp}` })
    // Deleting the clock also deletes its customers and subscriptions.
    cleanup.unshift(async () => { await stripe.testHelpers.testClocks.del(clock.id).catch(() => {}) })
    const customer = await stripe.customers.create({ email, test_clock: clock.id,
      metadata: { company_id: companyId, businessai_e2e: String(stamp) } })
    customer.clock = clock
    await admin.from('company_subscriptions')
      .insert({ company_id: companyId, stripe_customer_id: customer.id, plan: 'pro', status: 'incomplete' })
    return { companyId, customer, user }
  }

  /** Moves the scenario's clock past the end of the trial and waits for Stripe. */
  async function passTrial(customer) {
    const clock = customer.clock
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: clock.frozen_time + (trialDays + 1) * 86400 })
    await waitFor('test clock', () => stripe.testHelpers.testClocks.retrieve(clock.id), (c) => c.status === 'ready')
  }

  async function withCard(customer, pm) {
    const attached = await stripe.paymentMethods.attach(pm, { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: attached.id } })
    return attached.id
  }

  // Same subscription parameters as Checkout (docs/BILLING.md).
  const startTrial = (customer, companyId) => stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    trial_period_days: trialDays,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { company_id: companyId },
  })

  const row = (companyId) => async () => (await admin.from('company_subscriptions')
    .select('status, trial_end, trial_consumed_at, cancel_at_period_end, last_payment_failed_at, current_period_end')
    .eq('company_id', companyId).maybeSingle()).data
  const state = async (client, companyId) => (await client.rpc('company_billing_state', { target: companyId })).data?.[0]
  const tryCreateClient = async (client, companyId) =>
    (await client.from('clients').insert({ company_id: companyId, name: 'E2E client' })).error?.message ?? 'ok'

  // ---------------------------------------------------- 1. trial → charge
  {
    const { companyId, customer, user } = await newCompany('charge')
    check('before Checkout: cannot create clients', (await tryCreateClient(user, companyId)) === 'BILLING_INACTIVE')
    await withCard(customer, 'pm_card_visa')
    const sub = await startTrial(customer, companyId)
    const r = await waitFor('trialing', row(companyId), (x) => x.status === 'trialing')
    check('webhook stored the 7-day trial', Boolean(r.trial_end && r.trial_consumed_at),
      `trial ends ${r.trial_end}`)
    const first = await stripe.invoices.retrieve(sub.latest_invoice)
    check('nothing charged at the start of the trial', first.amount_paid === 0, `invoice ${first.amount_paid}`)
    check('during the trial: can create clients', (await tryCreateClient(user, companyId)) === 'ok')
    const usage = (await user.rpc('company_usage', { target: companyId })).data ?? []
    const clients = usage.find((u) => u.metric === 'clients')
    check('usage limits follow the plan chosen at Checkout (Pro)',
      usage.length === 3 && clients?.max_allowed === 500 && clients?.used === 1 && clients?.level === 'ok',
      `${clients?.used}/${clients?.max_allowed} ${clients?.level}`)
    await passTrial(customer)
    await waitFor('active after trial', row(companyId), (x) => x.status === 'active')
    const after = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] })
    check('trial ended: plan price charged automatically',
      after.latest_invoice.status === 'paid' && after.latest_invoice.amount_paid === price.unit_amount,
      `${after.latest_invoice.amount_paid} ${after.latest_invoice.currency}`)
  }

  // ---------------------------------------- 2. card fails at the first charge
  {
    const { companyId, customer, user } = await newCompany('fail')
    await withCard(customer, 'pm_card_chargeCustomerFail') // 4000 0000 0000 0341
    await startTrial(customer, companyId)
    await waitFor('trialing', row(companyId), (x) => x.status === 'trialing')
    await passTrial(customer)
    const r = await waitFor('past_due', row(companyId), (x) => x.status === 'past_due' && x.last_payment_failed_at)
    check('declined charge after the trial → past_due with failure recorded', Boolean(r.last_payment_failed_at))
    const st = await state(user, companyId)
    check('past_due keeps access (grace) and shows the failure', st?.state === 'past_due' && st.can_write === true)
  }

  // ------------------------------------------ 3. cancel during the trial
  {
    const { companyId, customer, user } = await newCompany('cancel')
    await withCard(customer, 'pm_card_visa')
    const sub = await startTrial(customer, companyId)
    await waitFor('trialing', row(companyId), (x) => x.status === 'trialing')
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true })
    await waitFor('cancel scheduled', row(companyId), (x) => x.cancel_at_period_end === true)
    check('cancelled during trial: still trialing until the end', (await state(user, companyId))?.state === 'trialing')
    await passTrial(customer)
    await waitFor('canceled at trial end', row(companyId), (x) => x.status === 'canceled')
    const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 })
    const charged = invoices.data.reduce((sum, i) => sum + (i.amount_paid ?? 0), 0)
    check('cancelled during the trial → nothing charged', charged === 0, `total charged ${charged}`)
    check('after the cancelled trial: read-only', (await tryCreateClient(user, companyId)) === 'BILLING_INACTIVE')
  }

  // -------------------------------------------- 4. card declined at sign-up
  // Stripe docs (docs.stripe.com/testing, "Simulate a declined payment"): the
  // generic-decline test PaymentMethod is `pm_card_visa_chargeDeclined`
  // (card_declined / generic_decline), and "You can't attach cards that
  // simulate issuer declines to a Customer object". So attaching it to the
  // customer (the same call withCard() uses for a valid card) must be declined.
  {
    const { companyId, customer, user } = await newCompany('declined')
    let result
    try {
      result = { attached: await stripe.paymentMethods.attach(DECLINED_TEST_PM, { customer: customer.id }) }
    } catch (error) {
      result = { error }
    }
    const outcome = declineOutcome(result)
    console.log(`      Stripe response to attaching ${DECLINED_TEST_PM}: ${outcome.summary}`)
    check('declined card cannot be attached to the customer (Stripe answers card_declined)', outcome.declined, outcome.summary)
    const cards = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 })
    check('declined card: no card stored on the Stripe customer', cards.data.length === 0, `${cards.data.length} stored`)
    // The script never creates a subscription here; these two confirm the
    // company stays without a subscription and without access.
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 1 })
    check('declined card: the customer has no subscription', subs.data.length === 0)
    check('declined card: the company has no access (billing state "none")', (await state(user, companyId))?.state === 'none')
  }

  // ---------------------------------------------- 5. webhook bookkeeping
  {
    const { data } = await admin.from('stripe_events').select('status').gte('created_at', new Date(stamp).toISOString())
    const failed = (data ?? []).filter((e) => e.status !== 'processed').length
    check('every webhook delivery of this run was processed', (data ?? []).length > 0 && failed === 0,
      `${(data ?? []).length} events, ${failed} not processed`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
  .catch((e) => { check('unexpected error', false, e?.message ?? String(e)) })
  .finally(async () => {
    for (const step of cleanup) { try { await step() } catch { /* best effort */ } }
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} checks passed; test data removed.`)
    process.exit(failed ? 1 : 0)
  })

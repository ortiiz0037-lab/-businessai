import type Stripe from 'stripe'

/**
 * Trial model: 7-day free trial WITH a card collected by Stripe Checkout.
 * Nothing is charged during the trial; Stripe charges the plan price
 * automatically when it ends; cancelling before that means no charge.
 * One trial per company and per person (company_subscriptions.trial_consumed_at;
 * trial_claims from migration 0016). Texts in Spanish or English.
 */

export type PriceInfo = {
  unitAmount: number // smallest currency unit (cents)
  currency: string // ISO code, e.g. 'usd'
  interval: 'day' | 'week' | 'month' | 'year'
}

type Lang = 'es' | 'en'

const INTERVAL: Record<PriceInfo['interval'], string> = {
  day: 'día', week: 'semana', month: 'mes', year: 'año',
}
const INTERVAL_EN: Record<PriceInfo['interval'], string> = {
  day: 'day', week: 'week', month: 'month', year: 'year',
}

/** Stripe price → PriceInfo, or null for anything we cannot describe exactly. */
export function toPriceInfo(price: {
  unit_amount: number | null
  currency: string
  recurring: { interval: string } | null
}): PriceInfo | null {
  const interval = price.recurring?.interval
  if (price.unit_amount === null || !interval || !(interval in INTERVAL)) return null
  return { unitAmount: price.unit_amount, currency: price.currency, interval: interval as PriceInfo['interval'] }
}

export function formatAmount(price: PriceInfo): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency.toUpperCase() })
    .format(price.unitAmount / 100)
}

export function formatPrice(price: PriceInfo, lang: Lang = 'es'): string {
  return `${formatAmount(price)} / ${(lang === 'en' ? INTERVAL_EN : INTERVAL)[price.interval]}`
}

/** "$39.00 y, después, $39.00 cada mes" / "$39.00 and then $39.00 every month" */
function recurringText(price: PriceInfo, lang: Lang): string {
  const amount = formatAmount(price)
  return lang === 'en'
    ? `${amount} and then ${amount} every ${INTERVAL_EN[price.interval]}`
    : `${amount} y, después, ${amount} cada ${INTERVAL[price.interval]}`
}

export function formatDate(date: Date, lang: Lang = 'es'): string {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-PR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Puerto_Rico' })
    .format(date)
}

/** When the first charge happens: after the trial, or now without trial. */
export function firstChargeAt(trialDays: number | null, now: Date): Date {
  return trialDays ? new Date(now.getTime() + trialDays * 86_400_000) : now
}

/**
 * The exact conditions shown before confirming — the same text on the
 * BusinessAI plan page and inside Stripe Checkout.
 */
export function chargeTerms(input: {
  planName: string
  price: PriceInfo
  trialDays: number | null
  now: Date
  lang?: Lang
}): { headline: string; terms: string; firstCharge: Date } {
  const lang = input.lang ?? 'es'
  const price = formatPrice(input.price, lang)
  const first = firstChargeAt(input.trialDays, input.now)
  if (lang === 'en') {
    return input.trialDays
      ? {
          headline: `${input.trialDays} days free, then ${price}`,
          terms:
            `Nothing is charged today. Your card is saved for the ${input.planName} plan subscription. ` +
            `Unless you cancel first, on ${formatDate(first, 'en')} you will be charged ${recurringText(input.price, 'en')} ` +
            `automatically. If you cancel during the trial nothing is charged. ` +
            `You can cancel at any time from "Manage subscription".`,
          firstCharge: first,
        }
      : {
          headline: `${price}`,
          terms:
            `The free trial was already used (one per company and per person). Today you will be charged ${recurringText(input.price, 'en')} ` +
            `for the ${input.planName} plan. You can cancel at any time; you keep access until the end of the paid period.`,
          firstCharge: first,
        }
  }
  if (input.trialDays) {
    return {
      headline: `${input.trialDays} días gratis, luego ${price}`,
      terms:
        `Hoy no se cobra nada. Tu tarjeta se guarda para la suscripción al plan ${input.planName}. ` +
        `Si no cancelas antes, el ${formatDate(first)} se cobrarán ${recurringText(input.price, 'es')} ` +
        `automáticamente. Si cancelas durante la prueba no se realizará ningún cobro. ` +
        `Puedes cancelar en cualquier momento desde "Administrar suscripción".`,
      firstCharge: first,
    }
  }
  return {
    headline: `${price}`,
    terms:
      `La prueba gratuita ya se usó: tu empresa ya usó su prueba gratuita o ya la usaste en otra empresa (es una por empresa y por persona). Hoy se cobrarán ${recurringText(input.price, 'es')} ` +
      `por el plan ${input.planName}. Puedes cancelar en cualquier momento; mantendrás el acceso hasta el final del periodo pagado.`,
    firstCharge: first,
  }
}

export function buildCheckoutSessionParams(input: {
  companyId: string
  customerId: string
  priceId: string
  appUrl: string
  /** Trial length if the company has not used its trial yet, else null. */
  trialDays: number | null
  /** Checkout page language (default Spanish). */
  lang?: 'es' | 'en'
  /** Conditions text shown above the confirm button (chargeTerms().terms). */
  terms: string
}): Stripe.Checkout.SessionCreateParams {
  const metadata = { company_id: input.companyId }
  return {
    mode: 'subscription',
    locale: input.lang ?? 'es',
    customer: input.customerId,
    client_reference_id: input.companyId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    metadata,
    subscription_data: {
      metadata,
      ...(input.trialDays
        ? {
            trial_period_days: input.trialDays,
            // Safety net: if a trial ever ended without a card, cancel instead
            // of creating an unpaid invoice.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
    },
    // A card is ALWAYS collected and saved, also when nothing is charged today.
    payment_method_collection: 'always',
    custom_text: { submit: { message: input.terms.slice(0, 1200) } },
    customer_update: { name: 'auto', address: 'auto' },
    billing_address_collection: 'auto',
    success_url: `${input.appUrl}/billing?checkout=success`,
    cancel_url: `${input.appUrl}/billing?checkout=cancelled`,
  }
}

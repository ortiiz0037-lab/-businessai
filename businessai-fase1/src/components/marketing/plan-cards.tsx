import Link from 'next/link'
import { PLAN_CATALOG, limitText, type CatalogPlan } from '@/lib/billing/catalog'
import { formatAmount, type PriceInfo } from '@/lib/billing/checkout'
import type { LandingCopy, Locale } from '@/lib/i18n/landing'
import { Icon } from '@/components/ui/icon'

/** Stripe price when configured in this environment; otherwise the catalog list price. */
export function displayPrice(plan: CatalogPlan, prices: Map<string, PriceInfo>) {
  const price = prices.get(plan.lookupKey) ?? { unitAmount: plan.listPriceCents, currency: 'usd', interval: 'month' as const }
  return { amount: formatAmount(price), interval: price.interval }
}

/** Where each plan button leads: signup with the plan (signed out) or the plan page (signed in). */
export function planHrefs(plan: string, signedIn: boolean, locale: Locale = 'es') {
  const billing = `/billing?plan=${plan}#plan-${plan}`
  const lang = locale === 'en' ? '&lang=en' : ''
  return {
    start: signedIn ? billing : `/signup?plan=${plan}${lang}`,
    login: `/login?next=${encodeURIComponent(billing)}${lang}`,
  }
}

/** The three plan cards (Básico/Basic, Pro, Premium), in the given language. The recommended plan is dark/gold. */
export function PlanCards({ copy, prices, signedIn, locale = 'es' }: {
  copy: LandingCopy['pricing']; prices: Map<string, PriceInfo>; signedIn: boolean; locale?: Locale
}) {
  return (
    <div className="mx-auto grid max-w-xl gap-8 lg:max-w-none lg:grid-cols-3 lg:gap-6">
      {PLAN_CATALOG.map((p) => {
        const price = displayPrice(p, prices)
        const text = copy.plans[p.plan]
        const hrefs = planHrefs(p.plan, signedIn, locale)
        const perInterval = price.interval === 'month' ? copy.perMonth : `/ ${price.interval}`
        const dark = p.recommended
        return (
          <article key={p.plan}
            className={`relative flex flex-col rounded-3xl p-7 sm:p-8 ${
              dark ? 'card-hero ring-1 ring-electric/40 lg:-translate-y-4' : 'card'
            }`}>
            {dark && (
              <span className="absolute right-6 top-6 rounded-full border border-electric/40 bg-brand/15 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
                {copy.recommended}
              </span>
            )}
            <h3 className={`font-display text-2xl font-semibold ${dark ? 'text-white' : 'text-fg'}`}>{text.name}</h3>
            <p className={`mt-2 min-h-12 text-sm leading-6 ${dark ? 'text-white/60' : 'text-muted'}`}>{text.tagline}</p>

            <p className="mt-6 flex items-baseline gap-1.5">
              <span className={`text-5xl font-extrabold tracking-tight tabular-nums ${dark ? 'text-white' : 'text-fg'}`}>{price.amount}</span>
              <span className={`text-sm font-semibold ${dark ? 'text-white/55' : 'text-muted'}`}>{perInterval}</span>
            </p>
            <p className={`mt-1 text-xs ${dark ? 'text-white/40' : 'text-slate-500'}`}>{copy.taxes}</p>

            <p className={`mt-6 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ${
              dark ? 'border border-electric/25 bg-brand/10 text-accent' : 'border border-electric/30 bg-electric/10 text-blue-300'}`}>
              <Icon name="sparkle" className="h-4 w-4 shrink-0" />
              {copy.trial}
            </p>

            <div className={`my-7 h-px ${dark ? 'bg-card/10' : 'bg-line'}`} />

            <ul className="space-y-3.5 text-sm">
              <Line dark={dark}>{p.maxClients === null ? copy.limits.unlimitedClients : copy.limits.clients(limitText(p.maxClients))}</Line>
              <Line dark={dark}>{p.maxDocumentsPerMonth === null ? copy.limits.unlimitedDocuments : copy.limits.documents(limitText(p.maxDocumentsPerMonth))}</Line>
              <Line dark={dark}>{copy.limits.users(limitText(p.maxMembers))}</Line>
            </ul>

            <div className="mt-auto pt-9">
              <Link href={hrefs.start} className={`${dark ? 'btn-accent' : 'btn-primary'} btn-lg w-full`}>
                {signedIn ? `${copy.choose} ${text.name}` : copy.start}
              </Link>
              {!signedIn && (
                <p className={`mt-3 text-center text-xs ${dark ? 'text-white/50' : 'text-muted'}`}>
                  {copy.haveAccount}{' '}
                  <Link href={hrefs.login} className={`font-semibold underline underline-offset-4 ${dark ? 'text-white' : 'text-fg'}`}>{copy.login}</Link>
                </p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function Check({ className = 'text-blue-400' }: { className?: string }) {
  return <Icon name="check" className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} strokeWidth={2.2} />
}

function Line({ children, dark }: { children: React.ReactNode; dark: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <Check className={dark ? 'text-accent' : 'text-blue-400'} />
      <span className={`font-medium ${dark ? 'text-white/85' : 'text-fg'}`}>{children}</span>
    </li>
  )
}

import Link from 'next/link'
import { PLAN_CATALOG, limitText, type CatalogPlan } from '@/lib/billing/catalog'
import { formatAmount, type PriceInfo } from '@/lib/billing/checkout'
import type { LandingCopy } from '@/lib/i18n/landing'

/** Stripe price when configured in this environment; otherwise the catalog list price. */
export function displayPrice(plan: CatalogPlan, prices: Map<string, PriceInfo>) {
  const price = prices.get(plan.lookupKey) ?? { unitAmount: plan.listPriceCents, currency: 'usd', interval: 'month' as const }
  return { amount: formatAmount(price), interval: price.interval }
}

/** Where each plan button leads: signup with the plan (signed out) or the plan page (signed in). */
export function planHrefs(plan: string, signedIn: boolean) {
  const billing = `/billing?plan=${plan}#plan-${plan}`
  return {
    start: signedIn ? billing : `/signup?plan=${plan}`,
    login: `/login?next=${encodeURIComponent(billing)}`,
  }
}

/** The three plan cards (Básico/Basic, Pro, Premium), in the given language. */
export function PlanCards({ copy, prices, signedIn }: {
  copy: LandingCopy['pricing']; prices: Map<string, PriceInfo>; signedIn: boolean
}) {
  return (
    <div className="mx-auto grid max-w-xl gap-8 lg:max-w-none lg:grid-cols-3 lg:gap-6">
      {PLAN_CATALOG.map((p) => {
        const price = displayPrice(p, prices)
        const text = copy.plans[p.plan]
        const hrefs = planHrefs(p.plan, signedIn)
        const perInterval = price.interval === 'month' ? copy.perMonth : `/ ${price.interval}`
        return (
          <article key={p.plan}
            className={`relative flex flex-col rounded-3xl bg-white p-7 shadow-xl ring-1 sm:p-8 ${
              p.recommended
                ? 'shadow-blue-950/20 ring-2 ring-blue-600 lg:-translate-y-3'
                : 'shadow-slate-900/10 ring-slate-200'
            }`}>
            {p.recommended && (
              <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-md">
                {copy.recommended}
              </span>
            )}
            <h3 className="text-xl font-extrabold text-slate-950">{text.name}</h3>
            <p className="mt-2 min-h-12 text-sm leading-6 text-slate-500">{text.tagline}</p>

            <p className="mt-6 flex items-baseline gap-1.5">
              <span className="text-5xl font-black tracking-tight text-slate-950">{price.amount}</span>
              <span className="text-sm font-semibold text-slate-500">{perInterval}</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">{copy.taxes}</p>

            <p className="mt-5 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{copy.trial}</p>

            <ul className="mt-6 space-y-3 text-sm">
              <Line>{p.maxClients === null ? copy.limits.unlimitedClients : copy.limits.clients(limitText(p.maxClients))}</Line>
              <Line>{p.maxDocumentsPerMonth === null ? copy.limits.unlimitedDocuments : copy.limits.documents(limitText(p.maxDocumentsPerMonth))}</Line>
              <Line>{copy.limits.users(limitText(p.maxMembers))}</Line>
            </ul>

            <div className="mt-auto pt-8">
              <Link href={hrefs.start}
                className={`block w-full rounded-2xl px-5 py-3.5 text-center text-sm font-bold shadow-sm transition ${
                  p.recommended ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-950 text-white hover:bg-slate-800'
                }`}>
                {signedIn ? `${copy.choose} ${text.name}` : copy.start}
              </Link>
              {!signedIn && (
                <p className="mt-3 text-center text-xs text-slate-500">
                  {copy.haveAccount}{' '}
                  <Link href={hrefs.login} className="font-semibold text-slate-700 underline">{copy.login}</Link>
                </p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function Check({ className = 'text-blue-600' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} fill="currentColor">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
    </svg>
  )
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <Check />
      <span className="font-medium text-slate-900">{children}</span>
    </li>
  )
}

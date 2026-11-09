import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PLAN_CATALOG } from '@/lib/billing/catalog'
import { loadPrices } from '@/lib/billing/prices'
import { LANDING, toLocale, type LandingCopy } from '@/lib/i18n/landing'
import { Check, PlanCards } from '@/components/marketing/plan-cards'
import { Brand } from '@/components/ui/brand'
import { Icon, type IconName } from '@/components/ui/icon'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ lang?: string }> }

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const copy = LANDING[toLocale((await searchParams).lang)]
  return {
    title: `BusinessAI · ${copy.hero.title}`,
    description: copy.hero.subtitle,
    alternates: { languages: { es: '/', en: '/?lang=en' } },
  }
}

const FEATURE_ICONS: IconName[] = ['users', 'receipt', 'clipboard', 'sparkle', 'printer', 'wallet']
const BENEFIT_ICONS: IconName[] = ['crown', 'shield', 'chart']

/** Public home page (bilingual: / in Spanish, /?lang=en in English). */
export default async function HomePage({ searchParams }: Props) {
  const locale = toLocale((await searchParams).lang)
  const copy = LANDING[locale]
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const prices = await loadPrices(PLAN_CATALOG.map((p) => p.lookupKey))
  const signedIn = Boolean(user)
  const q = locale === 'en' ? '?lang=en' : ''
  const links = { signup: `/signup${q}`, login: `/login${q}`, other: locale === 'es' ? '/?lang=en' : '/' }

  return (
    <div lang={copy.htmlLang} className="min-h-screen bg-canvas text-ink-900">
      <Header copy={copy} signedIn={signedIn} links={links} />

      <main>
        {/* Hero */}
        <section className="relative isolate overflow-hidden bg-ink-950 text-white">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_85%_10%,rgb(195_154_60/0.28),transparent_60%),radial-gradient(50%_50%_at_0%_100%,rgb(255_255_255/0.06),transparent)]" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-[0.06] [background-image:linear-gradient(rgb(255_255_255)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(60%_60%_at_50%_30%,black,transparent)]" />
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.08fr_0.92fr] lg:py-28">
            <div className="text-center lg:text-left">
              <p className="inline-flex items-center gap-2 rounded-full border border-gold-400/30 bg-gold-400/10 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-gold-200">
                <span className="h-1.5 w-1.5 rounded-full bg-gold-300" aria-hidden="true" />
                {copy.hero.badge}
              </p>
              <h1 className="mt-7 font-display text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-[4.1rem]">
                {copy.hero.title}
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-white/65 sm:text-lg lg:mx-0">{copy.hero.subtitle}</p>
              <div className="mt-10 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center lg:justify-start">
                <Link href={signedIn ? '/dashboard' : links.signup} className="btn-gold btn-lg">
                  {signedIn ? copy.nav.dashboard : copy.hero.primary}
                  <Icon name="arrowRight" className="h-4 w-4" />
                </Link>
                <a href="#pricing" className="btn-outline-light btn-lg">{copy.hero.secondary}</a>
              </div>
              <p className="mt-6 flex items-center justify-center gap-2 text-sm text-white/50 lg:justify-start">
                <Icon name="shield" className="h-4 w-4 text-gold-300" /> {copy.hero.note}
              </p>
            </div>
            <DocumentPreview copy={copy} />
          </div>
          <div className="divider-gold opacity-50" />
        </section>

        {/* Features */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <p className="eyebrow">{copy.features.kicker}</p>
              <h2 id="features-title" className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink-950 sm:text-[2.75rem] sm:leading-tight">{copy.features.title}</h2>
              <p className="mt-4 text-base leading-7 text-stone-500">{copy.features.subtitle}</p>
            </div>
            <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {copy.features.items.map((f, i) => (
                <article key={f.title} className="card-interactive group p-7">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-950 text-gold-300 shadow-[inset_0_0_0_1px_rgb(212_173_85/0.3)] transition group-hover:bg-gold-400 group-hover:text-ink-950">
                    <Icon name={FEATURE_ICONS[i % FEATURE_ICONS.length]} />
                  </span>
                  <h3 className="mt-6 text-lg font-bold text-ink-950">{f.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-500">{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits + steps */}
        <section aria-labelledby="benefits-title" className="border-y border-stone-200/70 bg-white">
          <div className="mx-auto grid max-w-6xl gap-14 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2">
            <div>
              <p className="eyebrow">BusinessAI</p>
              <h2 id="benefits-title" className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink-950 sm:text-4xl">{copy.benefits.title}</h2>
              <div className="mt-10 space-y-7">
                {copy.benefits.items.map((b, i) => (
                  <div key={b.title} className="flex gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gold-200 bg-gold-50 text-gold-700">
                      <Icon name={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} />
                    </span>
                    <div>
                      <h3 className="font-bold text-ink-950">{b.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-stone-500">{b.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card-dark p-7 sm:p-10">
              <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{copy.steps.title}</h2>
              <ol className="mt-9 space-y-8">
                {copy.steps.items.map((s, i) => (
                  <li key={s.title} className="flex gap-5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold-400/40 font-display text-lg font-semibold text-gold-300">{i + 1}</span>
                    <div>
                      <h3 className="font-bold text-white">{s.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-white/60">{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <p className="eyebrow">{copy.pricing.kicker}</p>
              <h2 id="pricing-title" className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink-950 sm:text-[2.75rem] sm:leading-tight">{copy.pricing.title}</h2>
              <p className="mt-4 text-base leading-7 text-stone-500">{copy.pricing.subtitle}</p>
            </div>
            <div className="mt-16 lg:mt-20">
              <PlanCards copy={copy.pricing} prices={prices} signedIn={signedIn} locale={locale} />
            </div>
            <div className="card mt-14 p-7 sm:p-9">
              <h3 className="font-display text-xl font-semibold text-ink-950">{copy.pricing.included}</h3>
              <ul className="mt-5 grid gap-3 text-sm text-stone-600 sm:grid-cols-2">
                {copy.pricing.common.map((c) => (
                  <li key={c} className="flex gap-3"><Check /><span>{c}</span></li>
                ))}
              </ul>
              <p className="mt-7 text-sm">
                <Link href="/precios" className="inline-flex items-center gap-1.5 font-semibold text-ink-950 underline decoration-gold-400 underline-offset-4">
                  {copy.pricing.more} <Icon name="arrowRight" className="h-4 w-4" />
                </Link>
              </p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-4 pb-20 sm:px-6 sm:pb-28">
          <div className="card-dark mx-auto max-w-6xl px-6 py-16 text-center sm:px-12">
            <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">{copy.cta.title}</h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-white/60">{copy.cta.subtitle}</p>
            <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
              {signedIn ? (
                <Link href="/dashboard" className="btn-gold btn-lg">{copy.nav.dashboard}</Link>
              ) : (
                <>
                  <Link href={links.signup} className="btn-gold btn-lg">{copy.cta.primary}</Link>
                  <Link href={links.login} className="btn-outline-light btn-lg">{copy.cta.secondary}</Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-stone-500 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <Brand href={links.other === '/' ? '/?lang=en' : '/'} />
          </div>
          <div className="md:text-right">
            <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
              <Link href="/precios" className="hover:text-ink-900">{copy.footer.pricing}</Link>
              <Link href="/terminos" className="hover:text-ink-900">{copy.footer.terms}</Link>
              <Link href="/privacidad" className="hover:text-ink-900">{copy.footer.privacy}</Link>
            </nav>
            <p className="mt-2 text-xs">© {new Date().getFullYear()} {copy.footer.rights} · {copy.footer.legalNote}</p>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Header({ copy, signedIn, links }: { copy: LandingCopy; signedIn: boolean; links: { signup: string; login: string; other: string } }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/90 text-white backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
        <Brand href={links.other === '/' ? '/?lang=en' : '/'} tone="light" />
        <nav aria-label={copy.nav.features} className="flex items-center gap-1 text-sm font-semibold">
          <a href="#features" className="hidden rounded-lg px-3 py-2 text-white/65 hover:text-white md:inline">{copy.nav.features}</a>
          <a href="#pricing" className="hidden rounded-lg px-3 py-2 text-white/65 hover:text-white md:inline">{copy.nav.pricing}</a>
          <Link href={links.other} aria-label={copy.nav.switchLabel} title={copy.nav.switchLabel}
            className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-bold text-white/80 hover:bg-white/10">
            {copy.nav.switchTo}
          </Link>
          {signedIn ? (
            <Link href="/dashboard" className="btn-gold btn-sm ml-1">{copy.nav.dashboard}</Link>
          ) : (
            <>
              <Link href={links.login} className="hidden rounded-lg px-3 py-2 text-white/65 hover:text-white sm:inline">{copy.nav.login}</Link>
              <Link href={links.signup} className="btn-gold btn-sm ml-1">{copy.nav.signup}</Link>
            </>
          )}
        </nav>
      </div>
      {!signedIn && (
        <div className="border-t border-white/10 px-4 py-2 text-center text-xs sm:hidden">
          <Link href={links.login} className="font-semibold text-white/80 underline underline-offset-4">{copy.nav.login}</Link>
        </div>
      )}
    </header>
  )
}

/** Illustrative document (sample data, decorative). */
function DocumentPreview({ copy }: { copy: LandingCopy }) {
  const p = copy.preview
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-md lg:max-w-none">
      <div className="absolute -inset-6 rounded-[2.5rem] bg-gold-400/15 blur-3xl" />
      <div className="relative rounded-3xl bg-white p-6 text-ink-900 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.7)] ring-1 ring-gold-300/40 sm:p-8 lg:rotate-[1.5deg]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-950 font-display text-base font-bold text-gold-300">R</span>
            <div>
              <p className="text-sm font-bold">Rivera Construction LLC</p>
              <p className="text-xs text-stone-400">San Juan, PR</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-700">{p.title}</p>
            <p className="text-lg font-bold tabular-nums">#F-0042</p>
          </div>
        </div>
        <div className="divider-gold mt-6" />
        <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
          <div><p className="text-stone-400">{p.client}</p><p className="mt-1 font-semibold">Santiago Bakery</p></div>
          <div className="text-right"><p className="text-stone-400">{p.status}</p>
            <p className="mt-1 inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">{p.paid}</p></div>
        </div>
        <ul className="mt-5 divide-y divide-stone-100 text-sm">
          {p.items.map(([label, amount]) => (
            <li key={label} className="flex justify-between py-3"><span className="text-stone-600">{label}</span><span className="font-semibold tabular-nums">{amount}</span></li>
          ))}
        </ul>
        <div className="mt-3 flex items-end justify-between rounded-2xl bg-ink-950 px-5 py-4 text-white">
          <p className="font-display text-xl italic text-gold-300">A. Rivera</p>
          <div className="text-right"><p className="text-[10px] uppercase tracking-[0.2em] text-white/50">{p.total}</p><p className="text-2xl font-extrabold tabular-nums">$850.00</p></div>
        </div>
      </div>
    </div>
  )
}

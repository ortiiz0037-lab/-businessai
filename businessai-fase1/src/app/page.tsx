import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PLAN_CATALOG } from '@/lib/billing/catalog'
import { loadPrices } from '@/lib/billing/prices'
import { LANDING, toLocale, type LandingCopy } from '@/lib/i18n/landing'
import { Check, PlanCards } from '@/components/marketing/plan-cards'

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

/** Public home page (bilingual: / in Spanish, /?lang=en in English). */
export default async function HomePage({ searchParams }: Props) {
  const locale = toLocale((await searchParams).lang)
  const copy = LANDING[locale]
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const prices = await loadPrices(PLAN_CATALOG.map((p) => p.lookupKey))
  const signedIn = Boolean(user)
  const otherLang = locale === 'es' ? '/?lang=en' : '/'

  return (
    <div lang={copy.htmlLang} className="min-h-screen bg-white text-slate-900">
      <Header copy={copy} signedIn={signedIn} otherLang={otherLang} />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-slate-950 text-white">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(37,99,235,0.45),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(14,165,233,0.18),transparent_50%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-28">
            <div className="text-center lg:text-left">
              <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-blue-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                {copy.hero.badge}
              </p>
              <h1 className="mt-6 text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">{copy.hero.title}</h1>
              <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg lg:mx-0">{copy.hero.subtitle}</p>
              <div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center lg:justify-start">
                <Link href={signedIn ? '/dashboard' : '/signup'}
                  className="rounded-2xl bg-blue-600 px-7 py-4 text-center text-sm font-bold text-white shadow-lg shadow-blue-600/30 transition hover:bg-blue-500">
                  {signedIn ? copy.nav.dashboard : copy.hero.primary}
                </Link>
                <a href="#pricing"
                  className="rounded-2xl border border-white/20 bg-white/5 px-7 py-4 text-center text-sm font-bold text-white transition hover:bg-white/10">
                  {copy.hero.secondary}
                </a>
              </div>
              <p className="mt-5 text-sm text-slate-400">{copy.hero.note}</p>
            </div>
            <DocumentPreview copy={copy} />
          </div>
        </section>

        {/* Features */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-20 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">{copy.features.kicker}</p>
              <h2 id="features-title" className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">{copy.features.title}</h2>
              <p className="mt-4 text-base leading-7 text-slate-600">{copy.features.subtitle}</p>
            </div>
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {copy.features.items.map((f, i) => (
                <article key={f.title} className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 text-white shadow-md shadow-blue-600/25">
                    <FeatureIcon index={i} />
                  </span>
                  <h3 className="mt-5 text-lg font-extrabold text-slate-950">{f.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits + steps */}
        <section aria-labelledby="benefits-title" className="bg-slate-50">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2">
            <div>
              <h2 id="benefits-title" className="text-3xl font-black tracking-tight text-slate-950">{copy.benefits.title}</h2>
              <div className="mt-8 space-y-6">
                {copy.benefits.items.map((b) => (
                  <div key={b.title} className="flex gap-4">
                    <Check className="text-emerald-600" />
                    <div>
                      <h3 className="font-extrabold text-slate-950">{b.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{b.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-3xl bg-white p-7 shadow-xl shadow-slate-900/5 ring-1 ring-slate-200 sm:p-9">
              <h2 className="text-2xl font-black tracking-tight text-slate-950">{copy.steps.title}</h2>
              <ol className="mt-8 space-y-7">
                {copy.steps.items.map((s, i) => (
                  <li key={s.title} className="flex gap-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-950 text-sm font-black text-white">{i + 1}</span>
                    <div>
                      <h3 className="font-extrabold text-slate-950">{s.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">{copy.pricing.kicker}</p>
              <h2 id="pricing-title" className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">{copy.pricing.title}</h2>
              <p className="mt-4 text-base leading-7 text-slate-600">{copy.pricing.subtitle}</p>
            </div>
            <div className="mt-16">
              <PlanCards copy={copy.pricing} prices={prices} signedIn={signedIn} />
            </div>
            <div className="mt-14 rounded-3xl border border-slate-200 bg-slate-50 p-7 sm:p-9">
              <h3 className="text-xl font-extrabold text-slate-950">{copy.pricing.included}</h3>
              <ul className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
                {copy.pricing.common.map((c) => (
                  <li key={c} className="flex gap-3"><Check /><span>{c}</span></li>
                ))}
              </ul>
              <p className="mt-6 text-sm">
                <Link href="/precios" className="font-semibold text-blue-700 underline">{copy.pricing.more}</Link>
              </p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-4 pb-20 sm:px-6">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-gradient-to-br from-blue-700 via-blue-800 to-slate-950 px-6 py-14 text-center text-white shadow-2xl shadow-blue-950/30 sm:px-12">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{copy.cta.title}</h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-blue-100">{copy.cta.subtitle}</p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              {signedIn ? (
                <Link href="/dashboard" className="rounded-2xl bg-white px-7 py-4 text-sm font-bold text-slate-950 hover:bg-blue-50">{copy.nav.dashboard}</Link>
              ) : (
                <>
                  <Link href="/signup" className="rounded-2xl bg-white px-7 py-4 text-sm font-bold text-slate-950 hover:bg-blue-50">{copy.cta.primary}</Link>
                  <Link href="/login" className="rounded-2xl border border-white/30 px-7 py-4 text-sm font-bold text-white hover:bg-white/10">{copy.cta.secondary}</Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-10 text-sm text-slate-500 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-semibold text-slate-700">© {new Date().getFullYear()} {copy.footer.rights}</p>
            <p className="mt-1 text-xs">{copy.footer.legalNote}</p>
          </div>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/precios" className="hover:text-slate-900">{copy.footer.pricing}</Link>
            <Link href="/terminos" className="hover:text-slate-900">{copy.footer.terms}</Link>
            <Link href="/privacidad" className="hover:text-slate-900">{copy.footer.privacy}</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}

function Header({ copy, signedIn, otherLang }: { copy: LandingCopy; signedIn: boolean; otherLang: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
        <Link href={copy.htmlLang === 'en' ? '/?lang=en' : '/'} className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-950 to-blue-700 text-base font-black text-white shadow-lg shadow-blue-950/20">B</span>
          <span className="text-lg font-extrabold tracking-tight text-slate-950">Business<span className="text-blue-600">AI</span></span>
        </Link>
        <nav aria-label={copy.nav.features} className="flex items-center gap-1 text-sm font-semibold">
          <a href="#features" className="hidden rounded-xl px-3 py-2 text-slate-600 hover:text-slate-950 md:inline">{copy.nav.features}</a>
          <a href="#pricing" className="hidden rounded-xl px-3 py-2 text-slate-600 hover:text-slate-950 md:inline">{copy.nav.pricing}</a>
          <Link href={otherLang} aria-label={copy.nav.switchLabel} title={copy.nav.switchLabel}
            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">
            {copy.nav.switchTo}
          </Link>
          {signedIn ? (
            <Link href="/dashboard" className="ml-1 rounded-xl bg-slate-950 px-4 py-2 text-white hover:bg-slate-800">{copy.nav.dashboard}</Link>
          ) : (
            <>
              <Link href="/login" className="hidden rounded-xl px-3 py-2 text-slate-600 hover:text-slate-950 sm:inline">{copy.nav.login}</Link>
              <Link href="/signup" className="ml-1 rounded-xl bg-slate-950 px-4 py-2 text-white hover:bg-slate-800">{copy.nav.signup}</Link>
            </>
          )}
        </nav>
      </div>
      {!signedIn && (
        <div className="border-t border-slate-100 px-4 py-2 text-center text-xs sm:hidden">
          <Link href="/login" className="font-semibold text-slate-700 underline">{copy.nav.login}</Link>
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
      <div className="absolute -inset-4 rounded-[2rem] bg-blue-500/20 blur-2xl" />
      <div className="relative rotate-1 rounded-3xl bg-white p-6 text-slate-900 shadow-2xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-slate-950 to-blue-700 text-sm font-black text-white">B</span>
            <div>
              <p className="text-sm font-extrabold">Tu Empresa LLC</p>
              <p className="text-xs text-slate-400">San Juan, PR</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-widest text-blue-600">{p.title}</p>
            <p className="text-sm font-bold">#F-0042</p>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4 text-xs">
          <div><p className="text-slate-400">{p.client}</p><p className="mt-0.5 font-semibold">Comercial Rivera</p></div>
          <div className="text-right"><p className="text-slate-400">{p.status}</p>
            <p className="mt-0.5 inline-block rounded-full bg-emerald-100 px-2 py-0.5 font-bold text-emerald-700">{p.paid}</p></div>
        </div>
        <ul className="mt-5 divide-y divide-slate-100 text-sm">
          {p.items.map(([label, amount]) => (
            <li key={label} className="flex justify-between py-2.5"><span className="text-slate-600">{label}</span><span className="font-semibold">{amount}</span></li>
          ))}
        </ul>
        <div className="mt-4 flex items-end justify-between border-t border-slate-200 pt-4">
          <p className="font-[cursive] text-2xl text-slate-500">J. Rivera</p>
          <div className="text-right"><p className="text-xs text-slate-400">{p.total}</p><p className="text-2xl font-black">$850.00</p></div>
        </div>
      </div>
    </div>
  )
}

const ICONS = [
  'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 20a8 8 0 0 1 16 0', // clients
  'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6', // invoice
  'M4 6h16M4 12h16M4 18h10', // more types
  'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z', // brand
  'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z', // print
  'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', // payments
]

function FeatureIcon({ index }: { index: number }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[index % ICONS.length]} />
    </svg>
  )
}

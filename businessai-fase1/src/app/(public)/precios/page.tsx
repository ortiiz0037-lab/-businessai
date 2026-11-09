import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { COMMON_FEATURES, PLAN_CATALOG, TRIAL_DAYS, limitLine, type CatalogPlan } from '@/lib/billing/catalog'
import { formatAmount, type PriceInfo } from '@/lib/billing/checkout'
import { loadPrices } from '@/lib/billing/prices'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Precios · BusinessAI',
  description: `Planes Básico, Pro y Premium de BusinessAI con ${TRIAL_DAYS} días de prueba gratuita.`,
}

const INTERVAL: Record<PriceInfo['interval'], string> = { day: 'día', week: 'semana', month: 'mes', year: 'año' }

/** Stripe price when configured in this environment; otherwise the catalog list price. */
function displayPrice(plan: CatalogPlan, prices: Map<string, PriceInfo>) {
  const price = prices.get(plan.lookupKey) ?? { unitAmount: plan.listPriceCents, currency: 'usd', interval: 'month' as const }
  return { amount: formatAmount(price), interval: INTERVAL[price.interval], currency: price.currency.toUpperCase() }
}

const FAQ = [
  {
    q: '¿Cuándo se me cobra?',
    a: `Al elegir un plan empiezas una prueba gratuita de ${TRIAL_DAYS} días. Se pide una tarjeta de crédito o débito, pero no se cobra nada durante la prueba. El primer cobro se realiza automáticamente al terminar la prueba, y después cada mes. Antes de confirmar verás la fecha exacta del primer cobro.`,
  },
  {
    q: '¿Puedo cancelar?',
    a: 'Sí, en cualquier momento desde “Plan” → “Administrar suscripción”. Si cancelas durante la prueba no se realiza ningún cobro. Si cancelas después, conservas el acceso hasta el final del periodo ya pagado.',
  },
  {
    q: '¿Puedo cambiar de plan?',
    a: 'Sí. Desde la página “Plan” eliges el nuevo plan y Stripe te muestra el importe del cambio antes de confirmarlo.',
  },
  {
    q: '¿Qué pasa si llego al límite de mi plan?',
    a: 'Te avisamos al llegar al 80 % y al 90 % del límite. Al 100 % no podrás crear más clientes, documentos o usuarios hasta mejorar el plan o hasta que se reinicie el contador mensual de documentos. Tus datos nunca se borran ni se modifican.',
  },
  {
    q: '¿Cómo se procesan los pagos?',
    a: 'Con Stripe. BusinessAI no ve ni guarda los datos de tu tarjeta.',
  },
  {
    q: '¿Los precios incluyen impuestos?',
    // PENDIENTE (propietario): tratamiento contributivo (IVU) por verificar. No afirmar que está incluido.
    a: 'El tratamiento de los impuestos aplicables, incluido el IVU, está pendiente de confirmación.',
  },
]

export default async function PricingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const prices = await loadPrices(PLAN_CATALOG.map((p) => p.lookupKey))

  const startHref = (plan: string) => (user ? `/billing?plan=${plan}#plan-${plan}` : `/signup?plan=${plan}`)
  const loginHref = (plan: string) => `/login?next=${encodeURIComponent(`/billing?plan=${plan}#plan-${plan}`)}`

  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900 to-blue-950 text-white">
        <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-blue-600/25 blur-3xl" />
        <div className="relative mx-auto max-w-4xl px-4 pb-36 pt-16 text-center sm:px-6 sm:pt-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
            {TRIAL_DAYS} días de prueba gratuita en todos los planes
          </p>
          <h1 className="mt-6 text-4xl font-black tracking-tight sm:text-5xl lg:text-6xl">
            Un plan para cada etapa de tu negocio
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
            Clientes, documentos y pagos de tu empresa en un solo lugar. Empieza gratis, cambia de plan cuando
            lo necesites y cancela en cualquier momento.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section aria-labelledby="planes" className="relative mx-auto -mt-24 max-w-6xl px-4 sm:px-6">
        <h2 id="planes" className="sr-only">Planes</h2>
        <div className="grid gap-6 lg:grid-cols-3">
          {PLAN_CATALOG.map((p) => {
            const price = displayPrice(p, prices)
            return (
              <article key={p.plan}
                className={`relative flex flex-col rounded-3xl bg-white p-7 shadow-xl ring-1 sm:p-8 ${
                  p.recommended ? 'shadow-blue-950/20 ring-2 ring-blue-600 lg:-translate-y-3' : 'shadow-slate-900/10 ring-slate-200'
                }`}>
                {p.recommended && (
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-md">
                    Recomendado
                  </span>
                )}
                <h3 className="text-xl font-extrabold text-slate-950">{p.name}</h3>
                <p className="mt-2 min-h-12 text-sm leading-6 text-slate-500">{p.tagline}</p>

                <p className="mt-6 flex items-baseline gap-1.5">
                  <span className="text-5xl font-black tracking-tight text-slate-950">{price.amount}</span>
                  <span className="text-sm font-semibold text-slate-500">/ {price.interval}</span>
                </p>
                <p className="mt-1 text-xs text-slate-400">{price.currency} · impuestos pendientes de confirmar</p>

                <p className="mt-5 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                  {TRIAL_DAYS} días gratis · sin cobro durante la prueba
                </p>

                <ul className="mt-6 space-y-3 text-sm text-slate-700">
                  <Limit text={limitLine(p.maxClients, 'cliente', 'clientes')} />
                  <Limit text={p.maxDocumentsPerMonth === null ? 'Documentos ilimitados' : `${limitLine(p.maxDocumentsPerMonth, 'documento', 'documentos')} al mes`} />
                  <Limit text={limitLine(p.maxMembers, 'usuario', 'usuarios')} />
                </ul>

                <div className="mt-auto pt-8">
                  <Link href={startHref(p.plan)}
                    className={`block w-full rounded-2xl px-5 py-3.5 text-center text-sm font-bold shadow-sm transition ${
                      p.recommended ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-950 text-white hover:bg-slate-800'
                    }`}>
                    {user ? `Elegir ${p.name}` : `Empezar prueba de ${TRIAL_DAYS} días`}
                  </Link>
                  {!user && (
                    <p className="mt-3 text-center text-xs text-slate-500">
                      ¿Ya tienes cuenta?{' '}
                      <Link href={loginHref(p.plan)} className="font-semibold text-slate-700 underline">Inicia sesión</Link>
                    </p>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      {/* Included in every plan */}
      <section aria-labelledby="incluido" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-7 sm:p-10">
          <h2 id="incluido" className="text-2xl font-extrabold tracking-tight text-slate-950">Incluido en todos los planes</h2>
          <ul className="mt-6 grid gap-4 text-sm text-slate-700 sm:grid-cols-2">
            {COMMON_FEATURES.map((f) => (
              <li key={f} className="flex gap-3">
                <Check />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* FAQ */}
      <section aria-labelledby="preguntas" className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
        <h2 id="preguntas" className="text-center text-2xl font-extrabold tracking-tight text-slate-950">Preguntas frecuentes</h2>
        <div className="mt-8 divide-y divide-slate-200 rounded-3xl border border-slate-200 bg-white">
          {FAQ.map((item) => (
            <details key={item.q} className="group p-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-slate-950">
                {item.q}
                <span aria-hidden="true" className="text-xl text-slate-400 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-600">{item.a}</p>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center text-xs leading-5 text-slate-500">
          Al suscribirte se aplican los <Link href="/terminos" className="underline">Términos y condiciones</Link> y
          la <Link href="/privacidad" className="underline">Política de privacidad</Link>.
        </p>
      </section>
    </main>
  )
}

function Limit({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-3">
      <Check />
      <span className="font-medium text-slate-900">{text}</span>
    </li>
  )
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" fill="currentColor">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
    </svg>
  )
}

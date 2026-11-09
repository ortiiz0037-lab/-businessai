import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { COMMON_FEATURES, PLAN_CATALOG, TRIAL_DAYS } from '@/lib/billing/catalog'
import { loadPrices } from '@/lib/billing/prices'
import { LANDING } from '@/lib/i18n/landing'
import { Check, PlanCards } from '@/components/marketing/plan-cards'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Precios · BusinessAI',
  description: `Planes Básico, Pro y Premium de BusinessAI con ${TRIAL_DAYS} días de prueba gratuita.`,
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
        <PlanCards copy={LANDING.es.pricing} prices={prices} signedIn={Boolean(user)} />
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

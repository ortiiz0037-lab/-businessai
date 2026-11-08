import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserCompany } from '@/lib/billing/company'
import { fetchBillingState, STATE_LABEL, daysLeft } from '@/lib/billing/state'
import { getStripe } from '@/lib/billing/stripe'

export const dynamic = 'force-dynamic'

type PlanRow = {
  plan: string
  name: string
  stripe_lookup_key: string
  max_clients: number | null
  max_documents_per_month: number | null
  max_members: number | null
  sort_order: number
}

const ERRORS: Record<string, string> = {
  forbidden: 'Solo el propietario o un administrador puede gestionar la suscripción.',
  plan: 'Ese plan no está disponible.',
  price: 'El precio de ese plan no está configurado en Stripe para este entorno.',
  config: 'Los pagos no están configurados en este entorno.',
  checkout: 'No se pudo iniciar el pago. Inténtalo de nuevo.',
  portal: 'No se pudo abrir el portal de facturación. Inténtalo de nuevo.',
  no_customer: 'Todavía no tienes una suscripción que administrar.',
}

function date(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es-PR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value))
}

function limit(value: number | null) {
  return value === null ? 'Ilimitado' : String(value)
}

/** Display prices from Stripe (by lookup key). Never throws. */
async function loadPrices(lookupKeys: string[]) {
  const prices = new Map<string, string>()
  try {
    const { stripe } = getStripe()
    const list = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 })
    for (const p of list.data) {
      if (!p.lookup_key || p.unit_amount === null) continue
      const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency.toUpperCase() })
        .format(p.unit_amount / 100)
      const interval = p.recurring?.interval === 'year' ? 'año' : 'mes'
      prices.set(p.lookup_key, `${amount} / ${interval}`)
    }
  } catch {
    // Not configured in this environment: the page still renders.
  }
  return prices
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/billing')

  const company = await getUserCompany(supabase, user)
  if (!company) redirect('/onboarding')

  const [state, plansResult] = await Promise.all([
    fetchBillingState(supabase, company.companyId),
    supabase.from('billing_plans').select('*').order('sort_order'),
  ])
  const plans = (plansResult.data ?? []) as PlanRow[]
  const prices = await loadPrices(plans.map((p) => p.stripe_lookup_key))
  const hasStripeSubscription = Boolean(
    state && ['active', 'past_due', 'unpaid', 'paused', 'canceled'].includes(state.state)
  ) || Boolean(state?.current_period_end)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-950">Plan y facturación</h1>
        <p className="mt-1 text-slate-500">Tu prueba gratuita, tu plan y tus pagos.</p>
      </div>

      {params.checkout === 'success' && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          ¡Gracias! Estamos confirmando tu suscripción con Stripe; puede tardar unos segundos. Recarga la página si no ves el cambio.
        </div>
      )}
      {params.checkout === 'cancelled' && (
        <div role="status" className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          Cancelaste el pago. No se ha realizado ningún cargo.
        </div>
      )}
      {params.error && ERRORS[params.error] && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {ERRORS[params.error]}
        </div>
      )}

      {!state ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          La facturación todavía no está configurada en este entorno.
        </div>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm text-slate-500">Estado</p>
              <p className="mt-1 text-2xl font-bold text-slate-950">{STATE_LABEL[state.state] ?? state.state}</p>
              <p className="mt-1 text-sm text-slate-600">
                Plan: <span className="font-semibold">{state.plan_name ?? '—'}</span>
              </p>
            </div>
            {company.canManageBilling && hasStripeSubscription && (
              <form action="/api/stripe/portal" method="post">
                <button type="submit" className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                  Administrar suscripción
                </button>
              </form>
            )}
          </div>

          <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-3">
            {state.state === 'trialing' && (
              <div>
                <dt className="text-slate-500">La prueba termina</dt>
                <dd className="font-semibold">{date(state.trial_ends_at)} ({daysLeft(state.trial_ends_at)} días)</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Inicio del periodo</dt>
              <dd className="font-semibold">{date(state.current_period_start)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">{state.cancel_at_period_end ? 'Se cancela el' : 'Fin del periodo / próximo cobro'}</dt>
              <dd className="font-semibold">{date(state.cancel_at ?? state.current_period_end)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Clientes</dt>
              <dd className="font-semibold">{state.clients_used} / {limit(state.max_clients)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Documentos este mes</dt>
              <dd className="font-semibold">{state.documents_this_month} / {limit(state.max_documents_per_month)}</dd>
            </div>
          </dl>

          {state.state === 'past_due' && (
            <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
              El último cobro falló{state.last_payment_failed_at ? ` el ${date(state.last_payment_failed_at)}` : ''}.
              Stripe volverá a intentarlo; actualiza tu tarjeta en “Administrar suscripción” para no perder el acceso.
            </p>
          )}
          {!state.can_write && (
            <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
              Modo solo lectura: puedes ver, imprimir y cobrar tus documentos, pero no crear nuevos clientes ni documentos.
            </p>
          )}
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const current = state?.plan === p.plan && ['active', 'past_due'].includes(state.state)
          return (
            <div key={p.plan} className={`rounded-2xl border bg-white p-6 shadow-sm ${current ? 'border-blue-500' : 'border-slate-200'}`}>
              <h2 className="text-lg font-bold">{p.name}</h2>
              <p className="mt-1 text-2xl font-bold">{prices.get(p.stripe_lookup_key) ?? '—'}</p>
              <ul className="mt-4 space-y-1 text-sm text-slate-600">
                <li>Clientes: {limit(p.max_clients)}</li>
                <li>Documentos al mes: {limit(p.max_documents_per_month)}</li>
                <li>Usuarios: {limit(p.max_members)}</li>
              </ul>
              {company.canManageBilling && (
                <form action="/api/stripe/checkout" method="post" className="mt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <button
                    type="submit"
                    disabled={current}
                    className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {current ? 'Plan actual' : hasStripeSubscription ? 'Cambiar de plan' : 'Suscribirme'}
                  </button>
                </form>
              )}
            </div>
          )
        })}
      </section>

      {!company.canManageBilling && (
        <p className="text-sm text-slate-500">Solo el propietario o un administrador puede cambiar el plan.</p>
      )}
      <p className="text-xs text-slate-400">
        Los pagos se procesan con Stripe. Puedes cancelar en cualquier momento desde “Administrar suscripción”;
        mantendrás el acceso hasta el final del periodo pagado. <Link href="/dashboard" className="underline">Volver al inicio</Link>
      </p>
    </div>
  )
}

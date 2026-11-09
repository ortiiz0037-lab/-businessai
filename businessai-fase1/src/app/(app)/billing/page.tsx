import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserCompany } from '@/lib/billing/company'
import { fetchBillingState, STATE_LABEL, daysLeft } from '@/lib/billing/state'
import { getStripe } from '@/lib/billing/stripe'
import { chargeTerms, formatDate, toPriceInfo, type PriceInfo } from '@/lib/billing/checkout'
import { fetchUsage, usageNotice, type UsageRow } from '@/lib/billing/usage'

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
  terms: 'Para continuar, confirma que aceptas las condiciones del plan.',
}

function date(value: string | null) {
  return value ? formatDate(new Date(value)) : '—'
}

function limit(value: number | null) {
  return value === null ? 'Ilimitado' : String(value)
}

/** Prices from Stripe by lookup key. Never throws (empty when not configured). */
async function loadPrices(lookupKeys: string[]) {
  const prices = new Map<string, PriceInfo>()
  try {
    const { stripe } = getStripe()
    const list = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 })
    for (const p of list.data) {
      const info = toPriceInfo(p)
      if (p.lookup_key && info) prices.set(p.lookup_key, info)
    }
  } catch {
    // Not configured in this environment: the page still renders.
  }
  return prices
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string; welcome?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/billing')

  const company = await getUserCompany(supabase, user)
  if (!company) redirect('/onboarding')

  const [state, plansResult, usage] = await Promise.all([
    fetchBillingState(supabase, company.companyId),
    supabase.from('billing_plans').select('*').order('sort_order'),
    fetchUsage(supabase, company.companyId),
  ])
  const plans = (plansResult.data ?? []) as PlanRow[]
  const prices = await loadPrices(plans.map((p) => p.stripe_lookup_key))
  const now = new Date()
  const hasSubscription = Boolean(state && state.state !== 'none')
  const trialDays = state?.trial_eligible ? (state.trial_days ?? 7) : null

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-950">Plan y facturación</h1>
        <p className="mt-1 text-slate-500">Tu prueba gratuita, tu plan y tus pagos.</p>
      </div>

      {params.welcome === '1' && state?.state === 'none' && (
        <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          ¡Tu empresa está creada! Último paso: elige un plan para empezar tu prueba gratuita
          de {state.trial_days ?? 7} días. Se pide una tarjeta de crédito o débito, pero no se cobra
          nada durante la prueba.
        </div>
      )}
      {params.checkout === 'success' && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          ¡Listo! Estamos confirmando tu suscripción con Stripe; puede tardar unos segundos. Recarga la página si no ves el cambio.
        </div>
      )}
      {params.checkout === 'cancelled' && (
        <div role="status" className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          No completaste el pago. No se ha guardado ninguna tarjeta ni se ha realizado ningún cargo.
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
            {company.canManageBilling && hasSubscription && (
              <form action="/api/stripe/portal" method="post">
                <button type="submit" className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                  Administrar suscripción
                </button>
              </form>
            )}
          </div>

          {hasSubscription && (
            <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-3">
              {state.state === 'trialing' && (
                <div>
                  <dt className="text-slate-500">{state.cancel_at_period_end ? 'La prueba termina (sin cobro)' : 'Primer cobro'}</dt>
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
          )}

          {state.state === 'past_due' && (
            <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
              El último cobro falló{state.last_payment_failed_at ? ` el ${date(state.last_payment_failed_at)}` : ''}.
              Stripe volverá a intentarlo; actualiza tu tarjeta en “Administrar suscripción” para no perder el acceso.
            </p>
          )}
          {!state.can_write && (
            <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
              {state.state === 'none'
                ? 'Elige un plan para empezar. Mientras tanto puedes ver tus datos, pero no crear clientes ni documentos.'
                : 'Modo solo lectura: puedes ver, imprimir y cobrar tus documentos, pero no crear nuevos clientes ni documentos.'}
            </p>
          )}
        </section>
      )}

      {hasSubscription && usage.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold">Uso de tu plan</h2>
          <div className="mt-4 space-y-4">
            {usage.map((u: UsageRow) => {
              const notice = usageNotice(u)
              const label = u.metric === 'clients' ? 'Clientes' : u.metric === 'documents' ? 'Documentos en este periodo' : 'Usuarios'
              const bar = u.level === 'blocked' ? 'bg-red-600' : u.level === 'upgrade' ? 'bg-orange-500'
                : u.level === 'warning' ? 'bg-amber-400' : 'bg-blue-600'
              return (
                <div key={u.metric}>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="text-slate-600">
                      {u.used} / {u.max_allowed ?? 'Ilimitado'}{u.percent !== null ? ` (${u.percent} %)` : ''}
                    </span>
                  </div>
                  {u.max_allowed !== null && (
                    <div className="mt-1 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={u.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                      <div className={`h-2 rounded-full ${bar}`} style={{ width: `${u.percent ?? 0}%` }} />
                    </div>
                  )}
                  {notice && <p className="mt-1 text-xs text-slate-600">{notice.text}</p>}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const price = prices.get(p.stripe_lookup_key)
          const current = hasSubscription && state?.plan === p.plan && state.can_write
          const offer = price ? chargeTerms({ planName: p.name, price, trialDays, now }) : null
          return (
            <div key={p.plan} className={`flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${current ? 'border-blue-500' : 'border-slate-200'}`}>
              <h2 className="text-lg font-bold">{p.name}</h2>
              <p className="mt-1 text-xl font-bold">{offer?.headline ?? 'Precio no disponible'}</p>
              <ul className="mt-4 space-y-1 text-sm text-slate-600">
                <li>Clientes: {limit(p.max_clients)}</li>
                <li>Documentos al mes: {limit(p.max_documents_per_month)}</li>
                <li>Usuarios: {limit(p.max_members)}</li>
              </ul>

              {company.canManageBilling && hasSubscription && (
                <form action="/api/stripe/portal" method="post" className="mt-auto pt-5">
                  <button type="submit" disabled={current}
                    className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                    {current ? 'Plan actual' : 'Cambiar de plan'}
                  </button>
                </form>
              )}

              {company.canManageBilling && !hasSubscription && offer && (
                <form action="/api/stripe/checkout" method="post" className="mt-auto space-y-3 pt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <p className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                    {offer.terms}
                  </p>
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input type="checkbox" name="accept_terms" value="yes" required className="mt-0.5 h-4 w-4" />
                    <span>
                      Acepto estas condiciones{trialDays ? ` y el cobro automático el ${formatDate(offer.firstCharge)}` : ''}.
                    </span>
                  </label>
                  <button type="submit"
                    className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">
                    {trialDays ? `Empezar prueba de ${trialDays} días` : 'Suscribirme'}
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
        Los pagos se procesan con Stripe; BusinessAI no ve ni guarda los datos de tu tarjeta. Puedes cancelar en
        cualquier momento desde “Administrar suscripción”: durante la prueba no se cobra nada; después, mantienes el
        acceso hasta el final del periodo pagado. <Link href="/dashboard" className="underline">Volver al inicio</Link>
      </p>
    </div>
  )
}

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserCompany } from '@/lib/billing/company'
import { fetchBillingState, STATE_LABEL, daysLeft } from '@/lib/billing/state'
import { chargeTerms, formatDate } from '@/lib/billing/checkout'
import { loadPrices } from '@/lib/billing/prices'
import { isPlanKey } from '@/lib/billing/catalog'
import { PageHeader } from '@/components/ui/page'
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

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string; welcome?: string; plan?: string; changed?: string }>
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
  // Plan chosen on /precios (or kept through signup): highlighted below.
  const selected = isPlanKey(params.plan) ? plans.find((p) => p.plan === params.plan) ?? null : null

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader eyebrow="Suscripción" title="Plan y facturación" description="Tu prueba gratuita, tu plan y tus pagos." />

      {params.welcome === '1' && state?.state === 'none' && (
        <div role="status" className="alert-info p-4">
          ¡Tu empresa está creada! Último paso: {selected ? <>confirma el plan <strong>{selected.name}</strong></> : 'elige un plan'} para
          empezar tu prueba gratuita de {state.trial_days ?? 7} días. Se pide una tarjeta de crédito o débito, pero no se
          cobra nada durante la prueba.
        </div>
      )}
      {params.changed === '1' && (
        <div role="status" className="alert-success p-4">
          Cambio de plan confirmado en Stripe. Puede tardar unos segundos en reflejarse aquí; recarga la página si no lo ves.
        </div>
      )}
      {params.checkout === 'success' && (
        <div role="status" className="alert-success p-4">
          ¡Listo! Estamos confirmando tu suscripción con Stripe; puede tardar unos segundos. Recarga la página si no ves el cambio.
        </div>
      )}
      {params.checkout === 'cancelled' && (
        <div role="status" className="alert border-stone-200 bg-white p-4 text-stone-700">
          No completaste el pago. No se ha guardado ninguna tarjeta ni se ha realizado ningún cargo.
        </div>
      )}
      {params.error && ERRORS[params.error] && (
        <div role="alert" className="alert-danger p-4">
          {ERRORS[params.error]}
        </div>
      )}

      {!state ? (
        <div className="alert-warning rounded-2xl p-6">
          La facturación todavía no está configurada en este entorno.
        </div>
      ) : (
        <section className="card-dark p-7 sm:p-9">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-gold-300">Estado</p>
              <p className="mt-2 font-display text-3xl font-semibold sm:text-4xl">{STATE_LABEL[state.state] ?? state.state}</p>
              <p className="mt-2 text-sm text-white/60">
                Plan: <span className="font-semibold text-white">{state.plan_name ?? '—'}</span>
              </p>
            </div>
            {company.canManageBilling && hasSubscription && (
              <form action="/api/stripe/portal" method="post">
                <button type="submit" className="btn-outline-light">
                  Administrar suscripción
                </button>
              </form>
            )}
          </div>

          {hasSubscription && (
            <dl className="mt-8 grid gap-x-6 gap-y-5 border-t border-white/10 pt-6 text-sm sm:grid-cols-3">
              {state.state === 'trialing' && (
                <div>
                  <dt className="text-white/50">{state.cancel_at_period_end ? 'La prueba termina (sin cobro)' : 'Primer cobro'}</dt>
                  <dd className="mt-1 font-semibold text-white">{date(state.trial_ends_at)} ({daysLeft(state.trial_ends_at)} días)</dd>
                </div>
              )}
              <div>
                <dt className="text-white/50">Inicio del periodo</dt>
                <dd className="mt-1 font-semibold text-white">{date(state.current_period_start)}</dd>
              </div>
              <div>
                <dt className="text-white/50">{state.cancel_at_period_end ? 'Se cancela el' : 'Fin del periodo / próximo cobro'}</dt>
                <dd className="mt-1 font-semibold text-white">{date(state.cancel_at ?? state.current_period_end)}</dd>
              </div>
              <div>
                <dt className="text-white/50">Clientes</dt>
                <dd className="mt-1 font-semibold text-white">{state.clients_used} / {limit(state.max_clients)}</dd>
              </div>
              <div>
                <dt className="text-white/50">Documentos este mes</dt>
                <dd className="mt-1 font-semibold text-white">{state.documents_this_month} / {limit(state.max_documents_per_month)}</dd>
              </div>
            </dl>
          )}

          {state.state === 'past_due' && (
            <p role="alert" className="alert-warning mt-6 p-4">
              El último cobro falló{state.last_payment_failed_at ? ` el ${date(state.last_payment_failed_at)}` : ''}.
              Stripe volverá a intentarlo; actualiza tu tarjeta en “Administrar suscripción” para no perder el acceso.
            </p>
          )}
          {!state.can_write && (
            <p role="alert" className="alert-danger mt-6 p-4">
              {state.state === 'none'
                ? 'Elige un plan para empezar. Mientras tanto puedes ver tus datos, pero no crear clientes ni documentos.'
                : 'Modo solo lectura: puedes ver, imprimir y cobrar tus documentos, pero no crear nuevos clientes ni documentos.'}
            </p>
          )}
        </section>
      )}

      {hasSubscription && usage.length > 0 && (
        <section className="card p-6">
          <p className="eyebrow">Consumo</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink-950">Uso de tu plan</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {usage.map((u: UsageRow) => {
              const notice = usageNotice(u)
              const label = u.metric === 'clients' ? 'Clientes' : u.metric === 'documents' ? 'Documentos en este periodo' : 'Usuarios'
              const bar = u.level === 'blocked' ? 'bg-red-600' : u.level === 'upgrade' ? 'bg-orange-500'
                : u.level === 'warning' ? 'bg-amber-400' : 'bg-gradient-to-r from-gold-400 to-gold-600'
              return (
                <div key={u.metric}>
                  <div className="flex justify-between text-sm">
                    <span className="font-semibold text-ink-900">{label}</span>
                    <span className="tabular-nums text-stone-500">
                      {u.used} / {u.max_allowed ?? 'Ilimitado'}{u.percent !== null ? ` (${u.percent} %)` : ''}
                    </span>
                  </div>
                  {u.max_allowed !== null && (
                    <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={u.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                      <div className={`h-2 rounded-full ${bar}`} style={{ width: `${u.percent ?? 0}%` }} />
                    </div>
                  )}
                  {notice && <p className="mt-2 text-xs text-stone-600">{notice.text}</p>}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="grid gap-5 lg:grid-cols-3">
        {plans.map((p) => {
          const price = prices.get(p.stripe_lookup_key)
          const current = hasSubscription && state?.plan === p.plan && state.can_write
          const offer = price ? chargeTerms({ planName: p.name, price, trialDays, now }) : null
          const isSelected = selected?.plan === p.plan && !current
          return (
            <div key={p.plan} id={`plan-${p.plan}`}
              className={`card flex scroll-mt-28 flex-col p-7 ${
                current ? 'border-gold-400 ring-1 ring-gold-400/60' : isSelected ? 'border-gold-500 ring-2 ring-gold-400/40' : ''}`}>
              {current && <p className="badge-gold mb-4 w-fit">Tu plan actual</p>}
              {isSelected && <p className="badge-gold mb-4 w-fit">Plan elegido</p>}
              <h2 className="font-display text-2xl font-semibold text-ink-950">{p.name}</h2>
              <p className={`mt-2 font-bold ${offer ? 'text-2xl tracking-tight text-ink-950' : 'text-sm text-stone-400'}`}>{offer?.headline ?? 'Precio no disponible en este entorno'}</p>
              <ul className="mt-5 space-y-2 border-t border-stone-100 pt-5 text-sm text-stone-600">
                <li>Clientes: {limit(p.max_clients)}</li>
                <li>Documentos al mes: {limit(p.max_documents_per_month)}</li>
                <li>Usuarios: {limit(p.max_members)}</li>
              </ul>

              {company.canManageBilling && hasSubscription && (
                <form action="/api/stripe/portal" method="post" className="mt-auto pt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <button type="submit" disabled={current}
                    className="btn-primary w-full">
                    {current ? 'Plan actual' : `Cambiar a ${p.name}`}
                  </button>
                  {!current && (
                    <p className="mt-2 text-center text-xs text-stone-500">Stripe te mostrará el importe del cambio antes de confirmarlo.</p>
                  )}
                </form>
              )}

              {company.canManageBilling && !hasSubscription && offer && (
                <form action="/api/stripe/checkout" method="post" className="mt-auto space-y-3 pt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <p className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-600">
                    {offer.terms}
                  </p>
                  <label className="flex items-start gap-2 text-xs text-stone-700">
                    <input type="checkbox" name="accept_terms" value="yes" required className="mt-0.5 h-4 w-4" />
                    <span>
                      Acepto estas condiciones{trialDays ? ` y el cobro automático el ${formatDate(offer.firstCharge)}` : ''}
                      {' '}(ver <Link href="/terminos" target="_blank" className="underline">Términos</Link>).
                    </span>
                  </label>
                  <button type="submit"
                    className="btn-gold w-full">
                    {trialDays ? `Empezar prueba de ${trialDays} días con ${p.name}` : `Suscribirme a ${p.name}`}
                  </button>
                </form>
              )}
            </div>
          )
        })}
      </section>

      {!company.canManageBilling && (
        <p className="text-sm text-stone-500">Solo el propietario o un administrador puede cambiar el plan.</p>
      )}
      <p className="text-xs text-stone-400">
        Los pagos se procesan con Stripe; BusinessAI no ve ni guarda los datos de tu tarjeta. Puedes cancelar en
        cualquier momento desde “Administrar suscripción”: durante la prueba no se cobra nada; después, mantienes el
        acceso hasta el final del periodo pagado. <Link href="/precios" className="underline">Precios</Link> ·{' '}
        <Link href="/terminos" className="underline">Términos</Link> · <Link href="/privacidad" className="underline">Privacidad</Link> ·{' '}
        <Link href="/dashboard" className="underline">Volver al inicio</Link>
      </p>
    </div>
  )
}

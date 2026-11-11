import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { personTrialAvailable } from '@/lib/billing/trial'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserCompany } from '@/lib/billing/company'
import { fetchBillingState, STATE_LABEL, STATE_LABEL_EN, daysLeft } from '@/lib/billing/state'
import { getLocale } from '@/lib/i18n/server'
import { translator, type Tr } from '@/lib/i18n/t'
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

const errors = (tr: Tr): Record<string, string> => ({
  forbidden: tr('Solo el propietario de la empresa puede gestionar la suscripción.', 'Only the company owner can manage the subscription.'),
  plan: tr('Ese plan no está disponible.', 'That plan is not available.'),
  price: tr('El precio de ese plan no está configurado en Stripe para este entorno.', 'That plan\'s price is not configured in Stripe for this environment.'),
  config: tr('Los pagos no están configurados en este entorno.', 'Payments are not configured in this environment.'),
  checkout: tr('No se pudo iniciar el pago. Inténtalo de nuevo.', 'The payment could not be started. Please try again.'),
  portal: tr('No se pudo abrir el portal de facturación. Inténtalo de nuevo.', 'The billing portal could not be opened. Please try again.'),
  no_customer: tr('Todavía no tienes una suscripción que administrar.', 'You have no subscription to manage yet.'),
  terms: tr('Para continuar, confirma que aceptas las condiciones del plan.', 'To continue, confirm that you accept the plan conditions.'),
})

/** Read-only trial check for the page; without service-role config, show no trial promise. */
async function personTrialForPage(companyId: string, userId: string): Promise<boolean> {
  try {
    return await personTrialAvailable(createAdminClient(), companyId, userId, false)
  } catch {
    return false
  }
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; error?: string; welcome?: string; plan?: string; changed?: string }>
}) {
  const params = await searchParams
  const locale = await getLocale()
  const tr = translator(locale)
  const ERRORS = errors(tr)
  const date = (value: string | null) => (value ? formatDate(new Date(value), locale) : '—')
  const limit = (value: number | null) => (value === null ? tr('Ilimitado', 'Unlimited') : String(value))
  const stateLabel = (code: string) => ((locale === 'en' ? STATE_LABEL_EN : STATE_LABEL) as Record<string, string>)[code] ?? code
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
  // One trial per person (C3): the company may be eligible while its owner
  // already used a trial in another company.
  const personEligible = state?.trial_eligible ? await personTrialForPage(company.companyId, user.id) : false
  const trialDays = state?.trial_eligible && personEligible ? (state.trial_days ?? 7) : null
  if (state && !personEligible) state.trial_eligible = false
  // Plan chosen on /precios (or kept through signup): highlighted below.
  const selected = isPlanKey(params.plan) ? plans.find((p) => p.plan === params.plan) ?? null : null

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader eyebrow={tr('Suscripción', 'Subscription')} title={tr('Plan y facturación', 'Plan and billing')} description={tr('Tu prueba gratuita, tu plan y tus pagos.', 'Your free trial, your plan and your payments.')} />

      {params.welcome === '1' && state?.state === 'none' && (
        <div role="status" className="alert-info p-4">
          {tr('¡Tu empresa está creada! Último paso: ', 'Your company is ready! Last step: ')}
          {selected ? <>{tr('confirma el plan', 'confirm the')} <strong>{selected.name}</strong>{tr('', ' plan')}</> : tr('elige un plan', 'choose a plan')}
          {trialDays
            ? tr(` para empezar tu prueba gratuita de ${trialDays} días. Se pide una tarjeta de crédito o débito, pero no se cobra nada durante la prueba.`,
                ` to start your ${trialDays}-day free trial. A credit or debit card is required, but nothing is charged during the trial.`)
            : tr('. La prueba gratuita ya se usó (es una por persona): el plan se cobra desde hoy.', '. The free trial was already used (one per person): the plan is charged from today.')}
        </div>
      )}
      {params.changed === '1' && (
        <div role="status" className="alert-success p-4">
          {tr('Cambio de plan confirmado en Stripe. Puede tardar unos segundos en reflejarse aquí; recarga la página si no lo ves.',
            'Plan change confirmed in Stripe. It may take a few seconds to show here; reload the page if you do not see it.')}
        </div>
      )}
      {params.checkout === 'success' && (
        <div role="status" className="alert-success p-4">
          {tr('¡Listo! Estamos confirmando tu suscripción con Stripe; puede tardar unos segundos. Recarga la página si no ves el cambio.',
            'Done! We are confirming your subscription with Stripe; it may take a few seconds. Reload the page if you do not see the change.')}
        </div>
      )}
      {params.checkout === 'cancelled' && (
        <div role="status" className="alert border-line bg-card p-4 text-slate-300">
          {tr('No completaste el pago. No se ha guardado ninguna tarjeta ni se ha realizado ningún cargo.', 'You did not complete the payment. No card was saved and nothing was charged.')}
        </div>
      )}
      {params.error && ERRORS[params.error] && (
        <div role="alert" className="alert-danger p-4">
          {ERRORS[params.error]}
        </div>
      )}

      {!state ? (
        <div className="alert-warning rounded-2xl p-6">
          {tr('La facturación todavía no está configurada en este entorno.', 'Billing is not configured in this environment yet.')}
        </div>
      ) : (
        <section className="card-hero p-7 sm:p-9">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{tr('Estado', 'Status')}</p>
              <p className="mt-2 font-display text-3xl font-semibold sm:text-4xl">{stateLabel(state.state)}</p>
              <p className="mt-2 text-sm text-white/60">
                {tr('Plan', 'Plan')}: <span className="font-semibold text-white">{state.plan_name ?? '—'}</span>
              </p>
            </div>
            {company.canManageBilling && hasSubscription && (
              <form action="/api/stripe/portal" method="post">
                <button type="submit" className="btn-outline-light">
                  {tr('Administrar suscripción', 'Manage subscription')}
                </button>
              </form>
            )}
          </div>

          {hasSubscription && (
            <dl className="mt-8 grid gap-x-6 gap-y-5 border-t border-white/10 pt-6 text-sm sm:grid-cols-3">
              {state.state === 'trialing' && (
                <div>
                  <dt className="text-white/50">{state.cancel_at_period_end ? tr('La prueba termina (sin cobro)', 'Trial ends (no charge)') : tr('Primer cobro', 'First charge')}</dt>
                  <dd className="mt-1 font-semibold text-white">{date(state.trial_ends_at)} ({daysLeft(state.trial_ends_at)} {tr('días', 'days')})</dd>
                </div>
              )}
              <div>
                <dt className="text-white/50">{tr('Inicio del periodo', 'Period start')}</dt>
                <dd className="mt-1 font-semibold text-white">{date(state.current_period_start)}</dd>
              </div>
              <div>
                <dt className="text-white/50">{state.cancel_at_period_end ? tr('Se cancela el', 'Cancels on') : tr('Fin del periodo / próximo cobro', 'Period end / next charge')}</dt>
                <dd className="mt-1 font-semibold text-white">{date(state.cancel_at ?? state.current_period_end)}</dd>
              </div>
              <div>
                <dt className="text-white/50">{tr('Clientes', 'Clients')}</dt>
                <dd className="mt-1 font-semibold text-white">{state.clients_used} / {limit(state.max_clients)}</dd>
              </div>
              <div>
                <dt className="text-white/50">{tr('Documentos este mes', 'Documents this period')}</dt>
                <dd className="mt-1 font-semibold text-white">{state.documents_this_month} / {limit(state.max_documents_per_month)}</dd>
              </div>
            </dl>
          )}

          {state.state === 'past_due' && (
            <p role="alert" className="alert-warning mt-6 p-4">
              {tr('El último cobro falló', 'The last charge failed')}{state.last_payment_failed_at ? ` ${tr('el', 'on')} ${date(state.last_payment_failed_at)}` : ''}.{' '}
              {tr('Stripe volverá a intentarlo; actualiza tu tarjeta en “Administrar suscripción” para no perder el acceso.',
                'Stripe will retry; update your card in "Manage subscription" to keep access.')}
            </p>
          )}
          {!state.can_write && (
            <p role="alert" className="alert-danger mt-6 p-4">
              {state.state === 'none'
                ? tr('Elige un plan para empezar. Mientras tanto puedes ver tus datos, pero no crear clientes ni documentos.',
                    'Choose a plan to start. Meanwhile you can see your data, but not create clients or documents.')
                : tr('Modo solo lectura: puedes ver, imprimir y cobrar tus documentos, pero no crear nuevos clientes ni documentos.',
                    'Read-only mode: you can view, print and collect your documents, but not create new clients or documents.')}
            </p>
          )}
        </section>
      )}

      {hasSubscription && usage.length > 0 && (
        <section className="card p-6">
          <p className="eyebrow">{tr('Consumo', 'Usage')}</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">{tr('Uso de tu plan', 'Your plan usage')}</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {usage.map((u: UsageRow) => {
              const notice = usageNotice(u, locale)
              const label = u.metric === 'clients' ? tr('Clientes', 'Clients') : u.metric === 'documents' ? tr('Documentos en este periodo', 'Documents this period') : tr('Usuarios', 'Users')
              const bar = u.level === 'blocked' ? 'bg-red-600' : u.level === 'upgrade' ? 'bg-orange-500'
                : u.level === 'warning' ? 'bg-warning' : 'bg-gradient-to-r from-blue-500 to-cyan-400'
              return (
                <div key={u.metric}>
                  <div className="flex justify-between text-sm">
                    <span className="font-semibold text-fg">{label}</span>
                    <span className="tabular-nums text-muted">
                      {u.used} / {u.max_allowed ?? tr('Ilimitado', 'Unlimited')}{u.percent !== null ? ` (${u.percent} %)` : ''}
                    </span>
                  </div>
                  {u.max_allowed !== null && (
                    <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-valuenow={u.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                      <div className={`h-2 rounded-full ${bar}`} style={{ width: `${u.percent ?? 0}%` }} />
                    </div>
                  )}
                  {notice && <p className="mt-2 text-xs text-slate-400">{notice.text}</p>}
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
          const offer = price ? chargeTerms({ planName: p.name, price, trialDays, now, lang: locale }) : null
          const isSelected = selected?.plan === p.plan && !current
          return (
            <div key={p.plan} id={`plan-${p.plan}`}
              className={`card flex scroll-mt-28 flex-col p-7 ${
                current ? 'border-electric/50 ring-1 ring-electric/60' : isSelected ? 'border-electric ring-2 ring-electric/40' : ''}`}>
              {current && <p className="badge-accent mb-4 w-fit">{tr('Tu plan actual', 'Your current plan')}</p>}
              {isSelected && <p className="badge-accent mb-4 w-fit">{tr('Plan elegido', 'Chosen plan')}</p>}
              <h2 className="font-display text-2xl font-semibold text-fg">{p.name}</h2>
              <p className={`mt-2 font-bold ${offer ? 'text-2xl tracking-tight text-fg' : 'text-sm text-slate-500'}`}>{offer?.headline ?? tr('Precio no disponible en este entorno', 'Price not available in this environment')}</p>
              <ul className="mt-5 space-y-2 border-t border-line pt-5 text-sm text-slate-400">
                <li>{tr('Clientes', 'Clients')}: {limit(p.max_clients)}</li>
                <li>{tr('Documentos al mes', 'Documents per month')}: {limit(p.max_documents_per_month)}</li>
                <li>{tr('Usuarios', 'Users')}: {limit(p.max_members)}</li>
              </ul>

              {company.canManageBilling && hasSubscription && (
                <form action="/api/stripe/portal" method="post" className="mt-auto pt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <button type="submit" disabled={current}
                    className="btn-primary w-full">
                    {current ? tr('Plan actual', 'Current plan') : tr(`Cambiar a ${p.name}`, `Switch to ${p.name}`)}
                  </button>
                  {!current && (
                    <p className="mt-2 text-center text-xs text-muted">{tr('Stripe te mostrará el importe del cambio antes de confirmarlo.', 'Stripe will show you the amount of the change before you confirm it.')}</p>
                  )}
                </form>
              )}

              {company.canManageBilling && !hasSubscription && offer && (
                <form action="/api/stripe/checkout" method="post" className="mt-auto space-y-3 pt-5">
                  <input type="hidden" name="plan" value={p.plan} />
                  <p className="rounded-xl border border-line bg-white/[0.03] p-3 text-xs leading-5 text-slate-400">
                    {offer.terms}
                  </p>
                  <label className="flex items-start gap-2 text-xs text-slate-300">
                    <input type="checkbox" name="accept_terms" value="yes" required className="mt-0.5 h-4 w-4" />
                    <span>
                      {tr('Acepto estas condiciones', 'I accept these conditions')}{trialDays ? tr(` y el cobro automático el ${formatDate(offer.firstCharge)}`, ` and the automatic charge on ${formatDate(offer.firstCharge, 'en')}`) : ''}
                      {' '}({tr('ver', 'see')} <Link href="/terminos" target="_blank" className="underline">{tr('Términos', 'Terms')}</Link>).
                    </span>
                  </label>
                  <button type="submit"
                    className="btn-accent w-full">
                    {trialDays ? tr(`Empezar prueba de ${trialDays} días con ${p.name}`, `Start ${trialDays}-day trial of ${p.name}`) : tr(`Suscribirme a ${p.name}`, `Subscribe to ${p.name}`)}
                  </button>
                </form>
              )}
            </div>
          )
        })}
      </section>

      {!company.canManageBilling && (
        <p className="text-sm text-muted">{tr('Solo el propietario de la empresa puede cambiar el plan o administrar la suscripción.', 'Only the company owner can change the plan or manage the subscription.')}</p>
      )}
      <p className="text-xs text-slate-500">
        {tr('Los pagos se procesan con Stripe; BusinessAI no ve ni guarda los datos de tu tarjeta. Puedes cancelar en cualquier momento desde “Administrar suscripción”: durante la prueba no se cobra nada; después, mantienes el acceso hasta el final del periodo pagado.',
          'Payments are processed by Stripe; BusinessAI never sees or stores your card details. You can cancel at any time from "Manage subscription": nothing is charged during the trial; afterwards you keep access until the end of the paid period.')}{' '}
        <Link href="/precios" className="underline">{tr('Precios', 'Pricing')}</Link> ·{' '}
        <Link href="/terminos" className="underline">{tr('Términos', 'Terms')}</Link> · <Link href="/privacidad" className="underline">{tr('Privacidad', 'Privacy')}</Link> ·{' '}
        <Link href="/dashboard" className="underline">{tr('Volver al inicio', 'Back to home')}</Link>
      </p>
    </div>
  )
}

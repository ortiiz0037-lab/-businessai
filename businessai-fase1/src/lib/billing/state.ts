/**
 * Billing state as returned by public.company_billing_state() (migration
 * 0010) — the database is the single source of truth for access.
 */
/** none = no Stripe subscription yet (plan not chosen / card not entered). */
export type BillingStateName =
  | 'none' | 'trialing' | 'active' | 'past_due'
  | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused'

export type BillingState = {
  state: BillingStateName
  plan: string | null
  plan_name: string | null
  can_write: boolean
  /** The company has not used its free trial yet. */
  trial_eligible: boolean
  trial_days: number | null
  trial_ends_at: string | null
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  cancel_at: string | null
  last_payment_failed_at: string | null
  max_clients: number | null
  max_documents_per_month: number | null
  max_members: number | null
  clients_used: number
  documents_this_month: number
}

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { code?: string; message: string } | null
  }>
}

/**
 * Billing state of a company for the signed-in member, or null when billing
 * is not set up in this environment yet (0010 not applied) or on error.
 */
export async function fetchBillingState(supabase: RpcClient, companyId: string): Promise<BillingState | null> {
  try {
    const { data, error } = await supabase.rpc('company_billing_state', { target: companyId })
    if (error) {
      // 42883 / PGRST202: function not found → billing not installed here.
      if (error.code !== '42883' && error.code !== 'PGRST202') {
        console.error('BILLING_STATE_ERROR', { code: error.code, message: error.message })
      }
      return null
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row) return null
    const r = row as BillingState
    return { ...r, clients_used: Number(r.clients_used ?? 0), documents_this_month: Number(r.documents_this_month ?? 0) }
  } catch (error) {
    console.error('BILLING_STATE_ERROR', { message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export const STATE_LABEL: Record<BillingStateName, string> = {
  none: 'Sin plan',
  trialing: 'Prueba gratuita',
  active: 'Activa',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  unpaid: 'Impagada',
  incomplete: 'Pago incompleto',
  incomplete_expired: 'Pago no completado',
  paused: 'Pausada',
}

export function daysLeft(until: string | null, now: Date = new Date()): number | null {
  if (!until) return null
  const ms = new Date(until).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000)
}

/** Maps the errors raised by enforce_billing_limits() to a UI error code. */
export function billingErrorCode(error: { message?: string } | null | undefined):
  'billing' | 'limit_clients' | 'limit_documents' | 'limit_members' | null {
  switch (error?.message) {
    case 'BILLING_INACTIVE': return 'billing'
    case 'PLAN_LIMIT_CLIENTS': return 'limit_clients'
    case 'PLAN_LIMIT_DOCUMENTS': return 'limit_documents'
    case 'PLAN_LIMIT_MEMBERS': return 'limit_members'
    default: return null
  }
}

export const BILLING_ERROR_MESSAGE: Record<'billing' | 'limit_clients' | 'limit_documents' | 'limit_members', string> = {
  billing: 'Para crear clientes y documentos necesitas una prueba gratuita o una suscripción activa. Puedes consultar e imprimir lo que ya tienes.',
  limit_clients: 'Has alcanzado el máximo de clientes de tu plan. Mejora tu plan para añadir más.',
  limit_documents: 'Has alcanzado el máximo de documentos de este periodo en tu plan. Mejora tu plan para crear más.',
  limit_members: 'Has alcanzado el máximo de usuarios de tu plan. Mejora tu plan para añadir más.',
}

/** Banner shown in the app layout, or null when nothing needs attention. */
export function billingBanner(state: BillingState | null, now: Date = new Date(), locale: 'es' | 'en' = 'es'):
  { tone: 'info' | 'warning' | 'danger'; text: string } | null {
  if (!state) return null
  if (locale === 'en') return billingBannerEn(state, now)
  switch (state.state) {
    case 'none':
      return state.trial_eligible
        ? { tone: 'info', text: `Elige un plan para empezar tu prueba gratuita de ${state.trial_days ?? 7} días. Se pide tarjeta, pero no se cobra nada durante la prueba.` }
        : { tone: 'danger', text: 'Modo solo lectura: elige un plan para crear clientes y documentos.' }
    case 'trialing': {
      const days = daysLeft(state.trial_ends_at, now)
      if (state.cancel_at_period_end) {
        return { tone: 'info', text: 'Cancelaste durante la prueba: no se realizará ningún cobro y el acceso termina al final de la prueba.' }
      }
      return { tone: days !== null && days <= 2 ? 'warning' : 'info',
               text: `Prueba gratuita: ${days === 1 ? 'queda 1 día' : `quedan ${days ?? 0} días`}. El primer cobro será al terminar la prueba.` }
    }
    case 'past_due':
      return { tone: 'warning', text: 'No pudimos cobrar tu suscripción. Actualiza tu método de pago para no perder el acceso.' }
    case 'active':
      return state.cancel_at_period_end
        ? { tone: 'info', text: 'Tu suscripción se cancelará al final del periodo actual.' }
        : null
    default:
      return { tone: 'danger', text: 'Modo solo lectura: activa un plan para crear clientes y documentos.' }
  }
}

function billingBannerEn(state: BillingState, now: Date): { tone: 'info' | 'warning' | 'danger'; text: string } | null {
  switch (state.state) {
    case 'none':
      return state.trial_eligible
        ? { tone: 'info', text: `Choose a plan to start your ${state.trial_days ?? 7}-day free trial. A card is required, but nothing is charged during the trial.` }
        : { tone: 'danger', text: 'Read-only mode: choose a plan to create clients and documents.' }
    case 'trialing': {
      const days = daysLeft(state.trial_ends_at, now)
      if (state.cancel_at_period_end) {
        return { tone: 'info', text: 'You cancelled during the trial: you will not be charged and access ends when the trial ends.' }
      }
      return { tone: days !== null && days <= 2 ? 'warning' : 'info',
               text: `Free trial: ${days === 1 ? '1 day left' : `${days ?? 0} days left`}. The first charge happens when the trial ends.` }
    }
    case 'past_due':
      return { tone: 'warning', text: 'We could not charge your subscription. Update your payment method to keep access.' }
    case 'active':
      return state.cancel_at_period_end
        ? { tone: 'info', text: 'Your subscription will be cancelled at the end of the current period.' }
        : null
    default:
      return { tone: 'danger', text: 'Read-only mode: activate a plan to create clients and documents.' }
  }
}

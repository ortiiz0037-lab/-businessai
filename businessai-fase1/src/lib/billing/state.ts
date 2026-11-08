/**
 * Billing state as returned by public.company_billing_state() (migration
 * 0010) — the database is the single source of truth for access.
 */
export type BillingStateName =
  | 'none' | 'trialing' | 'trial_expired' | 'active' | 'past_due'
  | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused'

export type BillingState = {
  state: BillingStateName
  plan: string | null
  plan_name: string | null
  can_write: boolean
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
  none: 'Sin suscripción',
  trialing: 'Prueba gratuita',
  trial_expired: 'Prueba finalizada',
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
  'billing' | 'limit_clients' | 'limit_documents' | null {
  switch (error?.message) {
    case 'BILLING_INACTIVE': return 'billing'
    case 'PLAN_LIMIT_CLIENTS': return 'limit_clients'
    case 'PLAN_LIMIT_DOCUMENTS': return 'limit_documents'
    default: return null
  }
}

export const BILLING_ERROR_MESSAGE: Record<'billing' | 'limit_clients' | 'limit_documents', string> = {
  billing: 'Tu prueba gratuita o tu suscripción no está activa. Puedes consultar e imprimir tus documentos, pero para crear nuevos activa un plan.',
  limit_clients: 'Has alcanzado el máximo de clientes de tu plan. Mejora tu plan para añadir más.',
  limit_documents: 'Has alcanzado el máximo de documentos de este mes en tu plan. Mejora tu plan para crear más.',
}

/** Banner shown in the app layout, or null when nothing needs attention. */
export function billingBanner(state: BillingState | null, now: Date = new Date()):
  { tone: 'info' | 'warning' | 'danger'; text: string } | null {
  if (!state) return null
  switch (state.state) {
    case 'trialing': {
      const days = daysLeft(state.trial_ends_at, now)
      return { tone: days !== null && days <= 2 ? 'warning' : 'info',
               text: `Prueba gratuita: ${days === 1 ? 'queda 1 día' : `quedan ${days ?? 0} días`}.` }
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

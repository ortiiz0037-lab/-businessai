/**
 * Public plan catalog (shown on /precios before signing in).
 *
 * The database (billing_plans, migration 0010) remains the source of truth
 * for limits and enforcement, and Stripe for prices. This catalog mirrors
 * them so the public page can render without a session; a unit test keeps
 * it in sync with 0010. Prices shown come from Stripe when available; the
 * list prices below are only the fallback when Stripe is not configured.
 */
export type PlanKey = 'basic' | 'pro' | 'premium'

export type CatalogPlan = {
  plan: PlanKey
  name: string
  lookupKey: string
  /** List price in cents (USD / month) — fallback when Stripe is unavailable. */
  listPriceCents: number
  maxClients: number | null
  maxDocumentsPerMonth: number | null
  maxMembers: number | null
  tagline: string
  recommended: boolean
}

/** Free trial length for every plan (billing_config.trial_days in 0010). */
export const TRIAL_DAYS = 7

export const PLAN_CATALOG: readonly CatalogPlan[] = [
  {
    plan: 'basic', name: 'Básico', lookupKey: 'businessai_basic_monthly', listPriceCents: 1999,
    maxClients: 50, maxDocumentsPerMonth: 40, maxMembers: 1,
    tagline: 'Para profesionales que empiezan a facturar con orden.', recommended: false,
  },
  {
    plan: 'pro', name: 'Pro', lookupKey: 'businessai_pro_monthly', listPriceCents: 3999,
    maxClients: 500, maxDocumentsPerMonth: 300, maxMembers: 3,
    tagline: 'Para negocios en crecimiento con un equipo pequeño.', recommended: true,
  },
  {
    plan: 'premium', name: 'Premium', lookupKey: 'businessai_premium_monthly', listPriceCents: 5999,
    maxClients: null, maxDocumentsPerMonth: null, maxMembers: 10,
    tagline: 'Para empresas con más volumen y más usuarios.', recommended: false,
  },
] as const

/** Features every plan includes (all exist in the app today). */
export const COMMON_FEATURES = [
  'Clientes y documentos de tu empresa en un solo lugar',
  'Logo, datos y firma de tu empresa en los documentos',
  'Documentos listos para imprimir o guardar en PDF',
  'Registro de pagos de cada documento',
  'Cancela cuando quieras desde la propia aplicación',
] as const

export function isPlanKey(value: unknown): value is PlanKey {
  return value === 'basic' || value === 'pro' || value === 'premium'
}

export function catalogPlan(plan: PlanKey): CatalogPlan {
  return PLAN_CATALOG.find((p) => p.plan === plan)!
}

/** "Ilimitados" / number, for the plan limit lines. */
export function limitText(value: number | null, unlimited = 'Ilimitados'): string {
  return value === null ? unlimited : new Intl.NumberFormat('es-PR').format(value)
}

/** "50 clientes", "1 usuario", "Clientes ilimitados" — for plan limit lines. */
export function limitLine(value: number | null, singular: string, plural: string): string {
  if (value === null) return `${plural.charAt(0).toUpperCase()}${plural.slice(1)} ilimitados`
  return `${limitText(value)} ${value === 1 ? singular : plural}`
}

/** Cookie that carries the plan chosen on /precios through signup and onboarding. */
export const SELECTED_PLAN_COOKIE = 'ba_selected_plan'

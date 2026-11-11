/**
 * Plan features (migration 0017): branches, employees, payroll. DENY BY
 * DEFAULT — when the database has no answer (migration not applied, no
 * active subscription, feature not in the plan, any error) the feature is
 * not available. Modules of Phases C–E show their entry points only when
 * featureAccess(...).available; their database triggers enforce it again.
 */
export type PlanFeature = 'branches' | 'employees' | 'payroll'
export type FeatureAccess = { available: boolean; maxAllowed: number | null; used: number; atLimit: boolean }

const DENIED: FeatureAccess = { available: false, maxAllowed: null, used: 0, atLimit: false }

/** Pure: one row of company_feature() → access. */
export function toFeatureAccess(row: { available?: boolean | null; max_allowed?: number | null; used?: number | null } | null | undefined): FeatureAccess {
  if (!row || row.available !== true) return DENIED
  const used = Number(row.used ?? 0)
  const maxAllowed = row.max_allowed ?? null
  return { available: true, maxAllowed, used, atLimit: maxAllowed !== null && used >= maxAllowed }
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }

export async function featureAccess(supabase: Rpc, companyId: string, feature: PlanFeature): Promise<FeatureAccess> {
  const { data, error } = await supabase.rpc('company_feature', { target: companyId, feature })
  if (error || !Array.isArray(data)) return DENIED
  return toFeatureAccess(data[0] as never)
}

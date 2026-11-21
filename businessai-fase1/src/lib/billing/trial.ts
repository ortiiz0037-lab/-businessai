/**
 * One free trial per PERSON (review finding C3). Server only: uses the
 * service-role client given by the caller.
 *
 * With migration 0016 the database decides (claim_trial / user_trial_available:
 * one claim per user, concurrent checkouts cannot both win, an abandoned
 * checkout frees the claim after 25 hours). Without 0016 the same rule is
 * checked here from company_subscriptions: no trial when any other company
 * the person created or owns already consumed one.
 */
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
type AdminLike = {
  rpc: Rpc
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Missing function (migration not applied): PostgREST PGRST202 / Postgres 42883. */
export function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message ?? ''))
}

/** Pure rule used without 0016: other companies of the person with a consumed trial. */
export function trialUsedElsewhere(
  companyId: string,
  rows: { company_id: string; trial_consumed_at: string | null }[],
): boolean {
  return rows.some((r) => r.company_id !== companyId && r.trial_consumed_at !== null)
}

async function fallbackUsedElsewhere(admin: AdminLike, companyId: string, userId: string): Promise<boolean> {
  const [{ data: created }, { data: owned }] = await Promise.all([
    admin.from('companies').select('id').eq('created_by', userId).limit(500),
    admin.from('memberships').select('company_id').eq('user_id', userId).eq('role', 'owner').limit(500),
  ])
  const ids = [...new Set([
    ...((created ?? []) as { id: string }[]).map((c) => c.id),
    ...((owned ?? []) as { company_id: string }[]).map((m) => m.company_id),
  ])].filter((id) => id !== companyId)
  if (!ids.length) return false
  const { data: subs } = await admin.from('company_subscriptions').select('company_id, trial_consumed_at').in('company_id', ids)
  return trialUsedElsewhere(companyId, (subs ?? []) as { company_id: string; trial_consumed_at: string | null }[])
}

/**
 * claim = true: Checkout is about to start with a trial — reserve it.
 * claim = false: only asks (the /billing page).
 */
export async function personTrialAvailable(admin: AdminLike, companyId: string, userId: string, claim: boolean): Promise<boolean> {
  const { data, error } = await admin.rpc(claim ? 'claim_trial' : 'user_trial_available', { target: companyId, claimant: userId })
  if (!error) return data === true
  if (!isMissingFunction(error)) {
    console.error('TRIAL_CHECK_ERROR', { code: error.code })
    return false // when in doubt, no free trial (the customer is charged only with the shown terms)
  }
  return !(await fallbackUsedElsewhere(admin, companyId, userId))
}

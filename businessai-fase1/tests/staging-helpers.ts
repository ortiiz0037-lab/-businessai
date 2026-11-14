// Shared helpers for the suites that run against the STAGING Supabase project
// (label `staging:test`). TEST-ONLY.
//
// Safety:
//   * A suite runs only when the URL, the publishable key, the service role
//     key and RLS_TEST_PROJECT_REF are all set, the ref equals the subdomain
//     of the URL, and that ref is NOT the production project. Otherwise every
//     suite is skipped (and the staging workflow fails on any skipped test).
//   * Everything a suite creates is temporary and identifiable: users
//     `<prefix>-<tag>-<stamp>@example.test`, companies named
//     `<prefix> <tag> <stamp>`, fake Stripe ids `cus_<prefix>_…`.
//   * Cleanup only touches companies this run created (and checks that their
//     creator is one of this run's users), in foreign-key order, and reports
//     anything it could not remove. Existing data is never read for deletion.
//   * Payments are immutable evidence (0015 / 0025: PAYMENT_IMMUTABLE), so a
//     company of this run that recorded payments is RETAINED whole: no
//     attempt is made to delete its payments, documents, clients or the
//     company (the database would refuse, and must). Its users cannot be
//     deleted either (companies.created_by is ON DELETE RESTRICT, payments
//     keep created_by), so they are BANNED: they can never sign in again.
//     Retained companies are listed in the output, not reported as failures.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** The production project: refused here whatever the environment says. */
export const PRODUCTION_PROJECT_REF = 'rugqcumiuqrjbfwpuslm'

export type StagingEnv =
  | { enabled: true; url: string; anonKey: string; serviceKey: string; ref: string }
  | { enabled: false; reason: string }

/** Pure: decides whether the staging suites may run with this environment. */
export function resolveStagingEnv(env: Record<string, string | undefined>): StagingEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const ref = env.RLS_TEST_PROJECT_REF ?? ''
  if (!url || !anonKey || !serviceKey || !ref) return { enabled: false, reason: 'environment not set' }
  let urlRef = ''
  try {
    const host = new URL(url).hostname
    if (host.endsWith('.supabase.co')) urlRef = host.split('.')[0]
  } catch {
    return { enabled: false, reason: 'invalid NEXT_PUBLIC_SUPABASE_URL' }
  }
  if (urlRef !== ref) return { enabled: false, reason: 'RLS_TEST_PROJECT_REF does not match the URL' }
  if (ref === PRODUCTION_PROJECT_REF || [url, anonKey].some((v) => v.includes(PRODUCTION_PROJECT_REF))) {
    return { enabled: false, reason: 'refusing the production project' }
  }
  return { enabled: true, url, anonKey, serviceKey, ref }
}

export const stagingEnv = resolveStagingEnv(process.env)
export const opts = { auth: { persistSession: false, autoRefreshToken: false } }

/** An 8-byte PNG signature: accepted as image/png by the buckets. */
export const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })

export type Role = 'owner' | 'admin' | 'member'
export type Actor = { tag: string; id: string; email: string; client: SupabaseClient }
export type Company = { id: string; owner: Actor }

/**
 * Temporary users and companies for one suite. `prefix` makes the data
 * recognisable (e.g. `e3-roles`); `stamp` makes it unique per run.
 */
export function createFixture(prefix: string) {
  if (!stagingEnv.enabled) throw new Error('staging environment not enabled')
  const env = stagingEnv
  const stamp = Date.now()
  const password = `Test-passw0rd-${stamp}`
  const admin = createClient(env.url, env.serviceKey, opts)
  const userIds: string[] = []
  const companyIds: string[] = []

  async function makeActor(tag: string): Promise<Actor> {
    const email = `${prefix}-${tag}-${stamp}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    userIds.push(data.user.id)
    const client = createClient(env.url, env.anonKey, opts)
    const signIn = await client.auth.signInWithPassword({ email, password })
    if (signIn.error) throw signIn.error
    return { tag, id: data.user.id, email, client }
  }

  /** A company created through the app RPC by its owner, with an active subscription. */
  async function makeCompany(tag: string): Promise<Company> {
    const owner = await makeActor(`${tag}-owner`)
    const { data: id, error } = await owner.client.rpc('create_company', { company_name: `${prefix} ${tag} ${stamp}` })
    if (error) throw error
    companyIds.push(id as string)
    // What the Stripe webhook stores after Checkout (fake ids, no Stripe call).
    const sub = await admin.from('company_subscriptions').insert({
      company_id: id, stripe_customer_id: `cus_${prefix}_${tag}_${stamp}`,
      stripe_subscription_id: `sub_${prefix}_${tag}_${stamp}`, plan: 'premium', status: 'active',
    })
    if (sub.error) throw sub.error
    return { id: id as string, owner }
  }

  /** Adds a member with a role (service role: there are no invitations yet). */
  async function addMember(company: Company, tag: string, role: Role): Promise<Actor> {
    const actor = await makeActor(tag)
    const r = await admin.from('memberships').insert({ company_id: company.id, user_id: actor.id, role })
    if (r.error) throw r.error
    return actor
  }

  /**
   * Removes what this fixture created and may be removed; retains companies
   * holding immutable payments (and bans their users). Throws listing anything
   * else that remained.
   */
  async function cleanup(): Promise<void> {
    const problems: string[] = []
    const seen: { id: string; createdBy: string; payments: number; members: string[]; paymentAuthors: string[] }[] = []
    for (const companyId of companyIds) {
      const company = await admin.from('companies').select('id, created_by').eq('id', companyId).maybeSingle()
      if (company.error) { problems.push(`read company ${companyId}: ${company.error.message}`); continue }
      if (!company.data) continue
      const [pays, mems] = await Promise.all([
        admin.from('payments').select('created_by').eq('company_id', companyId),
        admin.from('memberships').select('user_id').eq('company_id', companyId),
      ])
      if (pays.error || mems.error) { problems.push(`read ${companyId}: ${(pays.error ?? mems.error)!.message}`); continue }
      seen.push({ id: companyId, createdBy: company.data.created_by, payments: (pays.data ?? []).length,
        members: (mems.data ?? []).map((m) => m.user_id), paymentAuthors: (pays.data ?? []).map((p) => p.created_by).filter(Boolean) })
    }
    const plan = planCleanup({ runUsers: userIds, companies: seen })
    for (const id of plan.foreignCompanies) problems.push(`company ${id} not created by this run: left untouched`)
    for (const companyId of [...plan.removeCompanies, ...plan.retainCompanies]) {
      for (const bucket of ['Company-assets', 'Company-signatures']) {
        const files = await admin.storage.from(bucket).list(companyId)
        if (files.data?.length) {
          const removed = await admin.storage.from(bucket).remove(files.data.map((f) => `${companyId}/${f.name}`))
          if (removed.error) problems.push(`${bucket}/${companyId}: ${removed.error.message}`)
        }
      }
    }
    for (const companyId of plan.removeCompanies) {
      for (const table of ['document_deletion_audit', 'documents', 'clients', 'company_profiles', 'company_subscriptions', 'memberships']) {
        const r = await admin.from(table).delete().eq('company_id', companyId)
        if (r.error) problems.push(`${table} of ${companyId}: ${r.error.message}`)
      }
      const r = await admin.from('companies').delete().eq('id', companyId)
      if (r.error) problems.push(`company ${companyId}: ${r.error.message}`)
    }
    for (const id of plan.deleteUsers) {
      const r = await admin.auth.admin.deleteUser(id)
      if (r.error) problems.push(`user ${id}: ${r.error.message}`)
    }
    for (const id of plan.banUsers) {
      const r = await admin.auth.admin.updateUserById(id, { ban_duration: '876000h' })
      if (r.error) problems.push(`ban user ${id}: ${r.error.message}`)
    }
    if (plan.retainCompanies.length) {
      console.log(`cleanup: retained ${plan.retainCompanies.length} test compan${plan.retainCompanies.length === 1 ? 'y' : 'ies'} holding immutable payments `
        + `(${plan.retainCompanies.join(', ')}); ${plan.banUsers.length} test users banned (cannot sign in)`)
    }
    if (problems.length) throw new Error(`cleanup left data behind:\n  ${problems.join('\n  ')}`)
  }

  return { admin, stamp, makeActor, makeCompany, addMember, cleanup }
}

/**
 * Pure: what cleanup does with this run's data. A company with payments is
 * retained (immutable evidence); the users who own, belong to or recorded
 * payments in a retained company are banned instead of deleted; everything
 * else is deleted as before. A company not created by this run is never touched.
 */
export function planCleanup(input: {
  runUsers: string[]
  companies: { id: string; createdBy: string; payments: number; members: string[]; paymentAuthors: string[] }[]
}) {
  const ours = input.companies.filter((c) => input.runUsers.includes(c.createdBy))
  const foreign = input.companies.filter((c) => !input.runUsers.includes(c.createdBy)).map((c) => c.id)
  const retain = ours.filter((c) => c.payments > 0)
  const remove = ours.filter((c) => c.payments === 0).map((c) => c.id)
  const pinned = new Set(retain.flatMap((c) => [c.createdBy, ...c.members, ...c.paymentAuthors]))
  const runPinned = input.runUsers.filter((u) => pinned.has(u))
  return {
    removeCompanies: remove,
    retainCompanies: retain.map((c) => c.id),
    foreignCompanies: foreign,
    deleteUsers: input.runUsers.filter((u) => !pinned.has(u)),
    banUsers: runPinned,
  }
}

/** True when a write was refused: an error, or no row affected/returned. */
export const blocked = (r: { error: unknown; data: unknown }) =>
  r.error !== null || (Array.isArray(r.data) ? r.data.length === 0 : r.data === null)

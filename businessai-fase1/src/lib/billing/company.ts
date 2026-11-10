import type { SupabaseClient, User } from '@supabase/supabase-js'
import { getActiveMembership } from '@/lib/active-company'

/**
 * The user's ACTIVE company (see lib/active-company.ts: the selected one,
 * validated against the memberships, else the oldest) and role.
 * Billing actions require owner/admin.
 */
export async function getUserCompany(supabase: SupabaseClient, user: User) {
  const active = await getActiveMembership(supabase, user.id)
  if (!active) return null
  return {
    companyId: active.companyId,
    role: active.role,
    companyName: active.companyName,
    canManageBilling: active.role === 'owner' || active.role === 'admin',
  }
}

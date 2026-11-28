import type { SupabaseClient, User } from '@supabase/supabase-js'
import { getActiveMembership } from '@/lib/active-company'

/**
 * The user's ACTIVE company (see lib/active-company.ts: the selected one,
 * validated against the memberships, else the oldest) and role.
 * Billing actions (Checkout, Customer Portal) are reserved to the OWNER
 * (owner decision; matches billing.manage after migration 0015).
 */
export async function getUserCompany(supabase: SupabaseClient, user: User) {
  const active = await getActiveMembership(supabase, user.id)
  if (!active) return null
  return {
    companyId: active.companyId,
    role: active.role,
    companyName: active.companyName,
    canManageBilling: canManageBilling(active.role),
  }
}

/** Only the owner manages the subscription; admins run the operations. */
export function canManageBilling(role: string | null | undefined): boolean {
  return role === 'owner'
}

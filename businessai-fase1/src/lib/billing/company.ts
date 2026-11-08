import type { SupabaseClient, User } from '@supabase/supabase-js'

/**
 * The user's company (first membership, deterministic order) and role.
 * Billing actions require owner/admin.
 */
export async function getUserCompany(supabase: SupabaseClient, user: User) {
  const { data, error } = await supabase
    .from('memberships')
    .select('company_id, role, company:companies(name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const company = data.company as unknown as { name: string } | null
  return {
    companyId: data.company_id as string,
    role: data.role as 'owner' | 'admin' | 'member',
    companyName: company?.name ?? null,
    canManageBilling: data.role === 'owner' || data.role === 'admin',
  }
}

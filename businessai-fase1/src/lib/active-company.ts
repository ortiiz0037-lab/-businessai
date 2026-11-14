import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Active company of the signed-in user. A user can belong to several
 * companies (e.g. their own and "BusinessAI Demo (QA)"); the choice is kept
 * in a cookie that only holds a company id. It is NEVER trusted on its own:
 * it is matched against the user's memberships read through RLS on every
 * request, so a forged value simply falls back to the first company.
 */
export const COMPANY_COOKIE = 'ba_company'

export type MembershipOption = {
  companyId: string
  companyName: string | null
  role: 'owner' | 'admin' | 'member'
}

/** Pure: the membership chosen by the cookie, else the oldest one. */
export function pickMembership(options: MembershipOption[], cookieValue: string | undefined): MembershipOption | null {
  if (options.length === 0) return null
  return options.find((o) => o.companyId === cookieValue) ?? options[0]
}

/**
 * Companies the user can open (oldest first). A company whose row RLS does
 * not return (e.g. a suspended membership) is left out.
 */
export async function listMemberships(supabase: SupabaseClient, userId: string): Promise<MembershipOption[]> {
  const { data, error } = await supabase
    .from('memberships')
    .select('company_id, role, created_at, company:companies(id, name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data
    .map((row): MembershipOption | null => {
      const company = row.company as unknown as { id: string; name: string | null } | null
      return company ? { companyId: row.company_id as string, companyName: company.name ?? null, role: row.role as MembershipOption['role'] } : null
    })
    .filter((o): o is MembershipOption => o !== null)
}

export async function getActiveMembership(supabase: SupabaseClient, userId: string): Promise<MembershipOption | null> {
  const [options, jar] = await Promise.all([listMemberships(supabase, userId), cookies()])
  return pickMembership(options, jar.get(COMPANY_COOKIE)?.value)
}

/** `{ company_id }` of the active company (drop-in for the old "first membership" query). */
export async function activeCompanyRow(supabase: SupabaseClient, userId: string): Promise<{ company_id: string } | null> {
  const active = await getActiveMembership(supabase, userId)
  return active ? { company_id: active.companyId } : null
}

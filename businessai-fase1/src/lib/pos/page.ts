import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'

export type PosAccess = { view: boolean; sell: boolean; approve: boolean; manage: boolean; bank: boolean; available: boolean }
export type Branch = { id: string; name: string; code: string }

export async function posAccess(supabase: SupabaseClient, companyId: string): Promise<PosAccess> {
  const keys = ['pos.view', 'pos.sell', 'pos.approve', 'pos.manage', 'bank.manage']
  const [answers, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    supabase.from('pos_settings').select('company_id').limit(1),
  ])
  const [view, sell, approve, manage, bank] = answers.map((a) => !a.error && a.data === true)
  return { view, sell, approve, manage, bank, available: !probe.error }
}

/** Common context of the POS pages (/pos/*). */
export async function posPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/pos')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const access = await posAccess(supabase, companyId)
  const money = (c: number | string | bigint | null | undefined) => formatCents(c ?? 0, locale)
  return { locale, tr, f, money, supabase, user, companyId, access }
}

/** Branches the caller may sell in (the database applies the same rule on every write). */
export async function posBranches(supabase: SupabaseClient, companyId: string): Promise<Branch[]> {
  const { data } = await supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name')
  const all = (data ?? []) as Branch[]
  const ok = await Promise.all(all.map((b) => supabase.rpc('pos_branch_ok', { target: companyId, branch: b.id })))
  return all.filter((_, i) => ok[i].data === true)
}

/** Puerto Rico calendar day (YYYY-MM-DD) n days from today. */
export function prDay(offset = 0): string {
  const d = new Date(Date.now() - 4 * 3600 * 1000 + offset * 86400000)
  return d.toISOString().slice(0, 10)
}

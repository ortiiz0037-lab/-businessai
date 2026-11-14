import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { supervisesAnyone, workforceAccess, workforceRules } from '@/lib/workforce/context'

/** Common context of the supervisor pages (/workforce/*). */
export async function workforcePage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/workforce')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const access = await workforceAccess(supabase, member.companyId, user.id)
  const rules = await workforceRules(supabase, member.companyId)
  const allowed = supervisesAnyone(access)
  return { locale, tr, f, supabase, user, companyId: member.companyId, access, rules, allowed }
}

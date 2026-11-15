import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { catalogAccess } from '@/lib/catalog'
import { formatCents } from '@/lib/finance/money'

/** Common context of the catalog pages (/catalog/*). */
export async function catalogPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/catalog')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const access = await catalogAccess(supabase, member.companyId)
  const money = (c: number | string | bigint | null | undefined) => formatCents(c ?? 0, locale)
  return { locale, tr, f, money, supabase, companyId: member.companyId, access }
}

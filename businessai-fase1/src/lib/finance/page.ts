import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { accountingAccess } from '@/lib/finance/ledger'
import { formatCents } from '@/lib/finance/money'

/** Common context of the accounting pages (/accounting/*). */
export async function accountingPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/accounting')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const access = await accountingAccess(supabase, member.companyId)
  const money = (c: number | string | bigint | null | undefined) => formatCents(c ?? 0, locale)
  /** Today in the business time zone (same as the database ba_today()). */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return { locale, tr, f, money, today, supabase, user, companyId: member.companyId, access }
}

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { bankAccess } from '@/lib/finance/bank'
import { formatCents } from '@/lib/finance/money'

/** Common context of the bank pages (/bank/*). */
export async function bankPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/bank')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const access = await bankAccess(supabase, member.companyId)
  const money = (c: number | string | bigint | null | undefined) => formatCents(c ?? 0, locale)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const who = async () => {
    const { data } = await supabase.rpc('company_members', { target: member.companyId })
    const m = new Map(((data ?? []) as { user_id: string; email: string | null }[]).map((x) => [x.user_id, x.email ?? '']))
    return (id: string | null) => (id ? m.get(id) || tr('usuario', 'user') : tr('Sistema', 'System'))
  }
  return { locale, tr, f, money, today, supabase, user, companyId: member.companyId, access, who }
}

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { featureAccess } from '@/lib/billing/features'
import { formatCents } from '@/lib/finance/money'

/**
 * Common context of the payroll pages: who may see (payroll.view), manage
 * (payroll.manage) or approve (payroll.approve), and whether the plan includes
 * payroll. The database checks all of it again on every read and write.
 */
export async function payrollPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/payroll')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const [view, manage, approve, plan, settings] = await Promise.all([
    supabase.rpc('has_permission', { target: companyId, permission: 'payroll.view' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'payroll.manage' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'payroll.approve' }),
    featureAccess(supabase, companyId, 'payroll'),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', companyId).maybeSingle(),
  ])
  const currency = (settings.data as { base_currency?: string } | null)?.base_currency ?? 'USD'
  const money = (c: string | number | bigint | null | undefined) => formatCents(c ?? 0, locale, currency)
  return {
    locale, tr, f, supabase, user, companyId, currency, money,
    can: { view: view.data === true, manage: manage.data === true, approve: approve.data === true },
    plan, available: !view.error,
  }
}

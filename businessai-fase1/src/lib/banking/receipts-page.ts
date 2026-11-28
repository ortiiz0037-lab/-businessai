import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'

/** Receipt pages: open to whoever may capture evidence (expenses, payments or banking), not only the bank team. */
export async function receiptsPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/bank/receipts')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const [cap, view, payables] = await Promise.all([
    supabase.rpc('can_capture_evidence', { target: companyId }),
    supabase.rpc('has_permission', { target: companyId, permission: 'bank.view' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'payables.view' }),
  ])
  return {
    locale, tr, f, supabase, user, companyId,
    money: (c: number | null | undefined) => formatCents(c ?? 0, locale),
    available: !cap.error, capture: cap.data === true, bankView: view.data === true, payablesView: payables.data === true,
  }
}

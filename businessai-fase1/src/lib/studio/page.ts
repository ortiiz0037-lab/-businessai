import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

export type StudioAccess = { view: boolean; edit: boolean; issue: boolean; templates: boolean; brand: boolean; clients: boolean; documents: boolean; employees: boolean; vendors: boolean; available: boolean }

export async function studioAccess(supabase: SupabaseClient, companyId: string): Promise<StudioAccess> {
  const keys = ['studio.view', 'studio.edit', 'studio.issue', 'studio.templates', 'studio.brand', 'clients.view', 'documents.view', 'workforce.manage', 'payables.view']
  const [answers, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    supabase.from('studio_documents').select('id').eq('company_id', companyId).limit(1),
  ])
  const [view, edit, issue, templates, brand, clients, documents, employees, vendors] = answers.map((a) => !a.error && a.data === true)
  return { view, edit, issue, templates, brand, clients, documents, employees, vendors, available: !probe.error }
}

/** Common context of the Document Studio pages (/studio/*). */
export async function studioPage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/studio')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const access = await studioAccess(supabase, member.companyId)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const who = async () => {
    const { data } = await supabase.rpc('company_members', { target: member.companyId })
    const m = new Map(((data ?? []) as { user_id: string; email: string | null }[]).map((x) => [x.user_id, x.email ?? '']))
    return (id: string | null) => (id ? m.get(id) || tr('usuario', 'user') : tr('Sistema', 'System'))
  }
  return { locale, tr, f, today, supabase, user, companyId: member.companyId, access, who }
}

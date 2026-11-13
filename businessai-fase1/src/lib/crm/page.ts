import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'

export type Stage = { id: string; key: string; name_es: string; name_en: string; position: number; probability_bp: number; outcome: 'open' | 'won' | 'lost'; active: boolean }
export type Member = { user_id: string; email: string | null; role: string }

const PERMS = ['crm.view', 'crm.manage', 'crm.view_all', 'crm.configure', 'branches.manage', 'clients.view', 'clients.edit', 'clients.create',
  'documents.view', 'documents.create', 'receivables.view'] as const

/**
 * Common context of the CRM pages. Permissions decide what is SHOWN; the
 * database checks them again on every read (RLS) and write (functions).
 */
export async function crmPage(next = '/crm') {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`)
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const companyId = member.companyId
  const [perms, settings, access] = await Promise.all([
    supabase.rpc('assistant_access', { target: companyId, keys: [...PERMS] }),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', companyId).maybeSingle(),
    supabase.from('crm_pipeline_stages').select('id', { head: true, count: 'exact' }).eq('company_id', companyId),
  ])
  const p = ((perms.error ? null : perms.data) as { perms?: Record<string, boolean> } | null)?.perms ?? {}
  const has = (k: (typeof PERMS)[number]) => p[k] === true
  const currency = (settings.data as { base_currency?: string } | null)?.base_currency ?? 'USD'
  const money = (c: string | number | bigint | null | undefined) => formatCents(c ?? 0, locale, currency)
  // the pipeline is created on first use (crm.view): an ordinary, idempotent function
  if (has('crm.view') && !access.error && (access.count ?? 0) === 0) await supabase.rpc('crm_ensure_setup', { target: companyId })
  return {
    locale, tr, f, supabase, user, companyId, currency, money,
    available: !access.error,
    can: {
      view: has('crm.view'), manage: has('crm.manage'), viewAll: has('crm.view_all'), configure: has('crm.configure'), branches: has('branches.manage'),
      clientsView: has('clients.view'), clientsEdit: has('clients.edit'), clientsCreate: has('clients.create'),
      docsView: has('documents.view'), docsCreate: has('documents.create'), receivables: has('receivables.view'),
    },
  }
}

/** Stages of the company in pipeline order. */
export async function loadStages(supabase: SupabaseClient, companyId: string): Promise<Stage[]> {
  const { data } = await supabase.from('crm_pipeline_stages').select('id, key, name_es, name_en, position, probability_bp, outcome, active')
    .eq('company_id', companyId).order('position').order('key')
  return (data ?? []) as Stage[]
}

/** Members of the company (responsible / assignee pickers). Falls back to the caller when the list is not readable. */
export async function loadMembers(supabase: SupabaseClient, companyId: string, self: { id: string; email?: string | null }): Promise<Member[]> {
  const { data, error } = await supabase.rpc('company_members', { target: companyId })
  const rows = ((error ? [] : data) ?? []) as { user_id: string; email: string | null; role: string; status: string }[]
  const active = rows.filter((m) => m.status === 'active').map((m) => ({ user_id: m.user_id, email: m.email, role: m.role }))
  return active.length ? active : [{ user_id: self.id, email: self.email ?? null, role: 'member' }]
}
export const memberName = (members: Member[], id: string | null | undefined, fallback = '—') =>
  (id && members.find((m) => m.user_id === id)?.email) || fallback

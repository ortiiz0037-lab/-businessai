import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { computeDashboard, type DashClient, type DashDocument, type DashPayment } from '@/lib/dashboard/metrics'
import { fetchBillingState } from '@/lib/billing/state'
import { fetchUsage } from '@/lib/billing/usage'
import { APP } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { EmptyState } from '@/components/ui/page'
import { DashboardView } from '@/components/dashboard/dashboard-view'

export const dynamic = 'force-dynamic'

/** Every row comes from the active company through RLS (has_permission). */
async function loadData(companyId: string) {
  const supabase = await createClient()
  const [docs, pays, clients, billing, usage] = await Promise.all([
    supabase.from('documents')
      .select('id, client_id, document_type, document_number, title, status, total, issue_date, due_date, created_at')
      .eq('company_id', companyId).order('created_at', { ascending: false }).limit(5000),
    supabase.from('payments')
      .select('id, document_id, amount, paid_at, created_at')
      .eq('company_id', companyId).order('created_at', { ascending: false }).limit(10000),
    supabase.from('clients').select('id, name, created_at')
      .eq('company_id', companyId).order('created_at', { ascending: false }).limit(5000),
    fetchBillingState(supabase, companyId),
    fetchUsage(supabase, companyId),
  ])
  if (docs.error || pays.error || clients.error) {
    console.error('DASHBOARD_LOAD_ERROR', { documents: docs.error?.code, payments: pays.error?.code, clients: clients.error?.code })
  }
  return {
    documents: (docs.data ?? []) as DashDocument[],
    payments: (pays.data ?? []) as DashPayment[],
    clients: (clients.data ?? []) as DashClient[],
    billing,
    usage,
  }
}

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<{ password?: string }> }) {
  const passwordUpdated = (await searchParams)?.password === 'updated'
  const locale = await getLocale()
  const d = APP[locale].dashboard
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const active = await getActiveMembership(supabase, user.id)
  if (!active) {
    return (
      <div className="card">
        <EmptyState icon="building" title={d.noCompanyTitle} description={d.noCompanyText}
          action={<Link href="/onboarding" className="btn-primary">{d.createCompany}</Link>} />
      </div>
    )
  }

  const data = await loadData(active.companyId)
  const metrics = computeDashboard({ documents: data.documents, payments: data.payments, clients: data.clients, now: new Date() })
  const firstName = (user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ?? null
  return (
    <>
      {passwordUpdated && (
        <p role="status" className="alert-success mb-6">
          {locale === 'en' ? 'Your password was updated.' : 'Tu contraseña se actualizó.'}
        </p>
      )}
      <DashboardView locale={locale} m={metrics} companyName={active.companyName} firstName={firstName}
        billing={data.billing} usage={data.usage} />
    </>
  )
}

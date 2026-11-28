import { activePayments } from '@/lib/documents/payments'
import { chunks, fetchAllPages as selectAll } from '@/lib/supabase/paged'
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
import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist'

export const dynamic = 'force-dynamic'

/**
 * Every row comes from the active company through RLS (has_permission). Only what the metrics need is
 * read, completely (paginated: the API returns at most 1 000 rows per request): every open invoice and
 * quote whatever its age, documents of the last 13 months, the payments of those months and of the
 * open invoices, and the clients they name (the client total is an exact count).
 */
async function loadData(companyId: string) {
  const supabase = await createClient()
  const now = new Date()
  const cut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString()
  const cutDay = cut.slice(0, 10)
  const docCols = 'id, client_id, document_type, document_number, title, status, total, issue_date, due_date, created_at'
  const [docs, recentPays, clientCount, recentClients, billing, usage] = await Promise.all([
    selectAll((a, b) => supabase.from('documents').select(docCols).eq('company_id', companyId)
      .or(`status.in.(sent,overdue),created_at.gte.${cut},issue_date.gte.${cutDay}`).order('created_at', { ascending: false }).order('id').range(a, b)),
    selectAll((a, b) => supabase.from('payments').select('*').eq('company_id', companyId)
      .or(`paid_at.gte.${cut},created_at.gte.${cut}`).order('created_at', { ascending: false }).order('id').range(a, b)),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    selectAll((a, b) => supabase.from('clients').select('id, name, created_at').eq('company_id', companyId).gte('created_at', cut).order('created_at', { ascending: false }).order('id').range(a, b)),
    fetchBillingState(supabase, companyId),
    fetchUsage(supabase, companyId),
  ])
  const documents = docs.rows as DashDocument[]
  // payments of open invoices issued before the window (partial payments count for the receivable)
  const known = new Set((recentPays.rows as { id: string }[]).map((p) => p.id))
  const olderOpen = documents.filter((d) => d.document_type === 'invoice' && (d.status === 'sent' || d.status === 'overdue')).map((d) => d.id)
  const extraPays: unknown[] = []
  for (const ids of chunks(olderOpen)) {
    const r = await selectAll((a, b) => supabase.from('payments').select('*').in('document_id', ids).order('id').range(a, b))
    for (const p of r.rows as { id: string }[]) if (!known.has(p.id)) { known.add(p.id); extraPays.push(p) }
  }
  // names of the clients the listed documents point to
  const clientsById = new Map((recentClients.rows as DashClient[]).map((c) => [c.id, c]))
  const missing = [...new Set(documents.map((d) => d.client_id).filter((x): x is string => !!x && !clientsById.has(x)))]
  for (const ids of chunks(missing)) {
    const { data } = await supabase.from('clients').select('id, name, created_at').in('id', ids)
    for (const c of (data ?? []) as DashClient[]) clientsById.set(c.id, c)
  }
  const error = docs.error ?? recentPays.error ?? recentClients.error ?? clientCount.error
  if (error) console.error('DASHBOARD_LOAD_ERROR', { message: error.message?.slice(0, 80) })
  return {
    documents,
    payments: activePayments([...recentPays.rows, ...extraPays] as never[]) as DashPayment[],
    clients: [...clientsById.values()],
    clientCount: clientCount.count ?? clientsById.size,
    truncated: docs.truncated || recentPays.truncated,
    loadError: !!error,
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
  const metrics = computeDashboard({ documents: data.documents, payments: data.payments, clients: data.clients, clientCount: data.clientCount, now: new Date() })
  const firstName = (user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ?? null
  return (
    <>
      {(data.loadError || data.truncated) && (
        <p role="alert" className="alert-warning mb-6">
          {data.loadError
            ? (locale === 'en' ? 'Part of the dashboard could not be loaded; the figures may be incomplete. Reload the page.' : 'Parte del panel no se pudo cargar; las cifras pueden estar incompletas. Recarga la página.')
            : (locale === 'en' ? 'Very large volume: the dashboard shows the first 50,000 records of each kind.' : 'Volumen muy grande: el panel muestra los primeros 50 000 registros de cada tipo.')}
        </p>
      )}
      {passwordUpdated && (
        <p role="status" className="alert-success mb-6">
          {locale === 'en' ? 'Your password was updated.' : 'Tu contraseña se actualizó.'}
        </p>
      )}
      <OnboardingChecklist supabase={supabase} user={user} companyId={active.companyId} locale={locale} />
      <DashboardView locale={locale} m={metrics} companyName={active.companyName} firstName={firstName}
        billing={data.billing} usage={data.usage} />
    </>
  )
}

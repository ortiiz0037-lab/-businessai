import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Icon } from '@/components/ui/icon'
import { EmptyState, StatCard } from '@/components/ui/page'
import { StatusBadge, documentIcon } from '@/components/ui/status'

export const dynamic = 'force-dynamic'

type Doc = {
  id: string
  document_type: string | null
  title: string | null
  status: string | null
  total: number | null
  created_at: string | null
}

const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value)

const typeName = (type: string | null) => {
  const names: Record<string, string> = {
    invoice: 'Factura',
    quote: 'Cotización',
    receipt: 'Recibo',
    work_order: 'Orden de trabajo',
    letter: 'Carta',
    payment_reminder: 'Recordatorio de pago',
    contract: 'Contrato',
    report: 'Reporte',
  }

  return names[type || ''] || 'Documento'
}

const dateLabel = (value: string | null) => {
  if (!value) return 'Fecha no disponible'

  return new Intl.DateTimeFormat('es-PR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    return (
      <div className="card p-8">
        <EmptyState icon="building" title="Configura tu empresa"
          description="No encontramos una empresa asociada a tu usuario."
          action={<Link href="/settings/company" className="btn-primary">Configurar empresa</Link>} />
      </div>
    )
  }

  const companyId = membership.company_id

  const [companyResult, profileResult, clientsResult, documentsResult] =
    await Promise.all([
      // `companies` solo tiene `name`; los nombres comerciales/legales
      // viven en `company_profiles`.
      supabase
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .maybeSingle(),

      supabase
        .from('company_profiles')
        .select('display_name, legal_name')
        .eq('company_id', companyId)
        .maybeSingle(),

      supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),

      supabase
        .from('documents')
        .select('id, document_type, title, status, total, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(50),
    ])

  if (companyResult.error) {
    console.error('DASHBOARD_COMPANY_ERROR', { code: companyResult.error.code })
  }
  if (profileResult.error) {
    console.error('DASHBOARD_PROFILE_ERROR', { code: profileResult.error.code })
  }

  const company = companyResult.data
  const profile = profileResult.data
  const clientCount = clientsResult.count || 0
  const documents = (documentsResult.data || []) as Doc[]

  const invoices = documents.filter(
    (doc) => doc.document_type === 'invoice'
  )

  const receivable = invoices
    .filter(
      (doc) =>
        doc.status !== 'paid' && doc.status !== 'cancelled'
    )
    .reduce((sum, doc) => sum + Number(doc.total || 0), 0)

  const paid = invoices
    .filter((doc) => doc.status === 'paid')
    .reduce((sum, doc) => sum + Number(doc.total || 0), 0)

  const recent = documents.slice(0, 5)

  const businessName =
    profile?.display_name ||
    profile?.legal_name ||
    company?.name ||
    'Tu negocio'

  const firstName =
    user.user_metadata?.full_name?.split(' ')[0] ||
    user.email?.split('@')[0] ||
    'bienvenido'

  const quickActions = [
    { href: '/documents/new?type=invoice', icon: 'filePlus' as const, title: 'Nueva factura', text: 'Crea una factura y organiza tus cobros.' },
    { href: '/documents/new?type=quote', icon: 'clipboard' as const, title: 'Nueva cotización', text: 'Prepara una propuesta con partidas y totales.' },
    { href: '/clients', icon: 'users' as const, title: 'Administrar clientes', text: 'Consulta y organiza tus contactos comerciales.' },
    { href: '/settings/company', icon: 'building' as const, title: 'Configurar empresa', text: 'Logo, datos y firma de tus documentos.' },
  ]

  return (
    <div className="space-y-10">
      {/* Welcome */}
      <section className="card-dark p-7 sm:p-10">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-gold-400/25 bg-gold-400/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-gold-200">
              <span className="h-1.5 w-1.5 rounded-full bg-gold-300" aria-hidden="true" />
              {businessName}
            </p>
            <h1 className="mt-6 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
              Hola, {firstName}<span className="text-gold-400">.</span>
            </h1>
            <p className="mt-3 text-base text-white/60 sm:text-lg">
              Todo lo importante de tu negocio, en un solo lugar.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/documents/new?type=invoice" className="btn-gold btn-lg">
              <Icon name="plus" className="h-4 w-4" /> Crear factura
            </Link>
            <Link href="/documents" className="btn-outline-light btn-lg">
              Ver documentos <Icon name="arrowRight" className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* KPIs */}
      <section aria-labelledby="kpi-title">
        <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow">Resumen financiero</p>
            <h2 id="kpi-title" className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink-950">Tu negocio de un vistazo</h2>
          </div>
          <p className="text-sm text-stone-500">Basado en tus documentos registrados</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <StatCard label="Por cobrar" value={money(receivable)} hint="Facturas pendientes de pago" icon="clock" tone="warning" />
          <StatCard label="Cobrado" value={money(paid)} hint="Facturas marcadas como pagadas" icon="check" tone="success" />
          <StatCard label="Clientes" value={clientCount} hint="Clientes registrados" icon="users" tone="gold" />
          <StatCard label="Documentos" value={documents.length} hint="Documentos recientes consultados" icon="file" />
        </div>
      </section>

      {/* Quick actions */}
      <section aria-labelledby="actions-title">
        <p className="eyebrow">Productividad</p>
        <h2 id="actions-title" className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink-950">Acciones rápidas</h2>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {quickActions.map((a) => (
            <Link key={a.href} href={a.href} className="card-interactive group p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-950 text-gold-300 transition group-hover:bg-gold-400 group-hover:text-ink-950">
                  <Icon name={a.icon} />
                </span>
                <Icon name="arrowRight" className="h-4 w-4 text-stone-300 transition group-hover:translate-x-1 group-hover:text-gold-600" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-ink-950 sm:mt-5 sm:text-base">{a.title}</h3>
              <p className="mt-1 hidden text-sm leading-6 text-stone-500 sm:block">{a.text}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent documents */}
      <section className="card overflow-hidden" aria-labelledby="recent-title">
        <div className="flex flex-col gap-3 border-b border-stone-100 p-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="eyebrow">Actividad</p>
            <h2 id="recent-title" className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink-950">Documentos recientes</h2>
          </div>
          <Link href="/documents" className="btn-secondary btn-sm w-fit">
            Ver todos <Icon name="arrowRight" className="h-4 w-4" />
          </Link>
        </div>

        {recent.length === 0 ? (
          <EmptyState icon="file" title="Todo listo para comenzar"
            description="Cuando crees una factura, cotización u otro documento, aparecerá aquí para que puedas consultarlo rápidamente."
            action={<Link href="/documents/new?type=invoice" className="btn-primary">Crear mi primera factura</Link>} />
        ) : (
          <ul className="divide-y divide-stone-100">
            {recent.map((doc) => (
              <li key={doc.id}>
                <Link href={`/documents/${doc.id}`}
                  className="group flex flex-col gap-4 px-6 py-5 transition hover:bg-gold-50/40 sm:flex-row sm:items-center sm:justify-between sm:px-8">
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-ink-700 transition group-hover:bg-ink-950 group-hover:text-gold-300">
                      <Icon name={documentIcon(doc.document_type)} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink-950">{doc.title || typeName(doc.document_type)}</p>
                      <p className="mt-1 text-xs text-stone-500">{typeName(doc.document_type)} · {dateLabel(doc.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 sm:justify-end">
                    <StatusBadge status={doc.status} />
                    <span className="min-w-28 text-right font-bold tabular-nums text-ink-950">{money(Number(doc.total || 0))}</span>
                    <Icon name="chevronRight" className="hidden h-4 w-4 text-stone-300 transition group-hover:translate-x-1 group-hover:text-gold-600 sm:block" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Payments CTA */}
      <section className="card-dark flex flex-col gap-5 p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9">
        <div className="max-w-2xl">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-gold-300">Cobros</p>
          <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight">Tu negocio, bajo control.</h2>
          <p className="mt-2 text-sm leading-6 text-white/60">Administra clientes, documentos y cobros desde un solo espacio de trabajo.</p>
        </div>
        <Link href="/payments" className="btn-gold w-fit shrink-0">
          Revisar pagos <Icon name="arrowRight" className="h-4 w-4" />
        </Link>
      </section>
    </div>
  )
}

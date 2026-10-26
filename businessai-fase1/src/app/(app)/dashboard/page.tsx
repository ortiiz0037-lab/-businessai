import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

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

const statusName = (status: string | null) => {
  const names: Record<string, string> = {
    draft: 'Borrador',
    sent: 'Enviado',
    paid: 'Pagado',
    overdue: 'Vencido',
    cancelled: 'Cancelado',
  }

  return names[status || ''] || status || 'Pendiente'
}

const statusStyle = (status: string | null) => {
  const styles: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600',
    sent: 'bg-blue-50 text-blue-700',
    paid: 'bg-emerald-50 text-emerald-700',
    overdue: 'bg-rose-50 text-rose-700',
    cancelled: 'bg-slate-100 text-slate-500',
  }

  return styles[status || ''] || 'bg-amber-50 text-amber-700'
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
      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-8 text-amber-900">
        <h2 className="text-lg font-bold">Configura tu empresa</h2>
        <p className="mt-2 text-sm">
          No encontramos una empresa asociada a tu usuario.
        </p>
        <Link
          href="/settings/company"
          className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
        >
          Configurar empresa
        </Link>
      </div>
    )
  }

  const companyId = membership.company_id

  const [companyResult, clientsResult, documentsResult] =
    await Promise.all([
      supabase
        .from('companies')
        .select('legal_name, display_name')
        .eq('id', companyId)
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

  const company = companyResult.data
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
    company?.display_name || company?.legal_name || 'Tu negocio'

  const firstName =
    user.user_metadata?.full_name?.split(' ')[0] ||
    user.email?.split('@')[0] ||
    'bienvenido'

  return (
    <div className="space-y-8 lg:space-y-10">
      <section className="relative isolate overflow-hidden rounded-[28px] bg-[#081426] p-7 text-white shadow-2xl shadow-slate-900/10 sm:p-10 lg:p-12">
        <div className="absolute -right-20 -top-28 -z-10 h-80 w-80 rounded-full bg-blue-600/30 blur-3xl" />
        <div className="absolute -bottom-36 right-1/4 -z-10 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />

        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold tracking-wide text-blue-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              CENTRO DE CONTROL EMPRESARIAL
            </div>

            <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Hola, {firstName}
              <span className="text-blue-400">.</span>
            </h1>

            <p className="mt-3 text-base text-slate-300 sm:text-lg">
              Todo lo importante de tu negocio, en un solo lugar.
            </p>

            <div className="mt-6 flex items-center gap-3 text-sm text-slate-300">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.07] text-blue-200">
                ◈
              </span>
              <div>
                <p className="font-semibold text-white">{businessName}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Panel de administración
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/documents/new?type=invoice"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-950 shadow-lg transition hover:-translate-y-0.5 hover:bg-blue-50"
            >
              <span className="text-lg">＋</span>
              Crear factura
            </Link>

            <Link
              href="/documents"
              className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Ver documentos →
            </Link>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
              Resumen financiero
            </p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">
              Tu negocio de un vistazo
            </h2>
          </div>
          <p className="text-sm text-slate-500">
            Basado en tus documentos registrados
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">
                Por cobrar
              </span>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-lg text-amber-700">
                ◷
              </span>
            </div>
            <p className="mt-5 text-3xl font-bold tracking-tight text-slate-950">
              {money(receivable)}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Facturas pendientes de pago
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">
                Cobrado
              </span>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-lg text-emerald-700">
                ✓
              </span>
            </div>
            <p className="mt-5 text-3xl font-bold tracking-tight text-slate-950">
              {money(paid)}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Facturas marcadas como pagadas
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">
                Clientes
              </span>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-lg text-blue-700">
                ♧
              </span>
            </div>
            <p className="mt-5 text-3xl font-bold tracking-tight text-slate-950">
              {clientCount}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Clientes registrados
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">
                Documentos
              </span>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-lg text-violet-700">
                ▤
              </span>
            </div>
            <p className="mt-5 text-3xl font-bold tracking-tight text-slate-950">
              {documents.length}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Documentos recientes consultados
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-5">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
            Productividad
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">
            Acciones rápidas
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Accede directamente a las herramientas que utilizas a diario.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            href="/documents/new?type=invoice"
            className="group rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-xl text-blue-700 transition group-hover:bg-blue-600 group-hover:text-white">
                ＋
              </span>
              <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-blue-600">
                →
              </span>
            </div>
            <h3 className="mt-5 font-bold text-slate-950">
              Nueva factura
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Crea una factura y organiza tus cobros.
            </p>
          </Link>

          <Link
            href="/clients"
            className="group rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-emerald-200 hover:shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-xl text-emerald-700 transition group-hover:bg-emerald-600 group-hover:text-white">
                ♧
              </span>
              <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-emerald-600">
                →
              </span>
            </div>
            <h3 className="mt-5 font-bold text-slate-950">
              Administrar clientes
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Consulta y organiza tus contactos comerciales.
            </p>
          </Link>

          <Link
            href="/settings/company"
            className="group rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-violet-200 hover:shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-xl text-violet-700 transition group-hover:bg-violet-600 group-hover:text-white">
                ⚙
              </span>
              <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-violet-600">
                →
              </span>
            </div>
            <h3 className="mt-5 font-bold text-slate-950">
              Configurar empresa
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Revisa la información de tu negocio.
            </p>
          </Link>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
              Actividad
            </p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950">
              Documentos recientes
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Consulta los últimos documentos de tu empresa.
            </p>
          </div>

          <Link
            href="/documents"
            className="inline-flex w-fit items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Ver todos <span>→</span>
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="px-6 py-14 text-center sm:px-8">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-2xl text-slate-500">
              ▤
            </div>
            <h3 className="mt-4 font-bold text-slate-950">
              Todo listo para comenzar
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
              Cuando crees una factura, cotización u otro documento,
              aparecerá aquí para que puedas consultarlo rápidamente.
            </p>
            <Link
              href="/documents/new?type=invoice"
              className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Crear mi primera factura
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map((doc) => (
              <Link
                key={doc.id}
                href={`/documents/${doc.id}`}
                className="group flex flex-col gap-4 px-6 py-5 transition hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:px-8"
              >
                <div className="flex min-w-0 items-center gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-lg text-slate-600 transition group-hover:bg-blue-50 group-hover:text-blue-700">
                    ▤
                  </span>

                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-950">
                      {doc.title || typeName(doc.document_type)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {typeName(doc.document_type)} ·{' '}
                      {dateLabel(doc.created_at)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 sm:justify-end">
                  <span
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusStyle(doc.status)}`}
                  >
                    {statusName(doc.status)}
                  </span>

                  <span className="min-w-24 text-right font-bold tabular-nums text-slate-950">
                    {money(Number(doc.total || 0))}
                  </span>

                  <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-blue-600">
                    →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50/70 px-6 py-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>Información de tu empresa</span>
          <span>Actualizado al consultar el panel</span>
        </div>
      </section>

      <section className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-r from-slate-950 via-[#10264a] to-blue-900 p-7 text-white shadow-xl sm:p-9">
        <div className="absolute -right-12 -top-20 -z-10 h-64 w-64 rounded-full bg-blue-400/20 blur-3xl" />

        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-blue-300">
              BUSINESSAI INTELLIGENCE
            </span>
            <h2 className="mt-3 text-2xl font-bold tracking-tight">
              Tu negocio, bajo control.
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Administra clientes, documentos y cobros desde un solo
              espacio de trabajo.
            </p>
          </div>

          <Link
            href="/payments"
            className="inline-flex w-fit shrink-0 items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-blue-50"
          >
            Revisar pagos <span>→</span>
          </Link>
        </div>
      </section>
    </div>
  )
}
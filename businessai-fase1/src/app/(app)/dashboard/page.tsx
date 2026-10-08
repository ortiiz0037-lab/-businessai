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

const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(n)

const typeName = (type: string | null) => {
  const names: Record<string, string> = {
    invoice: 'Factura',
    quote: 'Cotización',
    receipt: 'Recibo',
    work_order: 'Orden de trabajo',
    letter: 'Carta',
    payment_reminder: 'Recordatorio',
    contract: 'Contrato',
    report: 'Reporte',
  }

  return names[type || ''] || 'Documento'
}

const statusName = (status: string | null) => {
  const names: Record<string, string> = {
    draft: 'Borrador',
    sent: 'Enviada',
    paid: 'Pagada',
    overdue: 'Vencida',
    cancelled: 'Cancelada',
  }

  return names[status || ''] || 'Borrador'
}

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    return (
      <div className="rounded-2xl bg-red-50 p-6 text-red-700">
        No encontramos tu empresa.
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
        .select(
          'id, document_type, title, status, total, created_at'
        )
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
    .filter((doc) => doc.status !== 'paid' && doc.status !== 'cancelled')
    .reduce((sum, doc) => sum + Number(doc.total || 0), 0)

  const paid = invoices
    .filter((doc) => doc.status === 'paid')
    .reduce((sum, doc) => sum + Number(doc.total || 0), 0)

  const recent = documents.slice(0, 5)

  const businessName =
    company?.display_name ||
    company?.legal_name ||
    'Tu negocio'

  return (
    <main className="space-y-8">

      <section className="rounded-3xl bg-slate-950 p-8 text-white shadow-xl">
        <p className="text-sm font-semibold text-blue-300">
          BUSINESSAI
        </p>

        <h1 className="mt-2 text-3xl font-bold">
          Bienvenido 👋
        </h1>

        <p className="mt-3 text-slate-300">
          {businessName}
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/documents/new?type=invoice"
            className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-slate-950"
          >
            + Crear factura
          </Link>

          <Link
            href="/documents"
            className="rounded-xl border border-white/20 px-5 py-3 text-sm font-semibold text-white"
          >
            Ver documentos
          </Link>
        </div>
      </section>

      <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">
            Por cobrar
          </p>

          <p className="mt-2 text-3xl font-bold text-slate-950">
            {money(receivable)}
          </p>

          <p className="mt-2 text-xs text-slate-400">
            Facturas pendientes
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">
            Cobrado
          </p>

          <p className="mt-2 text-3xl font-bold text-slate-950">
            {money(paid)}
          </p>

          <p className="mt-2 text-xs text-slate-400">
            Facturas marcadas como pagadas
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">
            Clientes
          </p>

          <p className="mt-2 text-3xl font-bold text-slate-950">
            {clientCount}
          </p>

          <p className="mt-2 text-xs text-slate-400">
            Clientes registrados
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">
            Documentos
          </p>

          <p className="mt-2 text-3xl font-bold text-slate-950">
            {documents.length}
          </p>

          <p className="mt-2 text-xs text-slate-400">
            Documentos creados
          </p>
        </div>

      </section>

      <section>
        <h2 className="text-xl font-bold text-slate-950">
          Acciones rápidas
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">

          <Link
            href="/clients"
            className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md"
          >
            <div className="text-2xl">👥</div>
            <h3 className="mt-3 font-bold">
              Clientes
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Administrar clientes
            </p>
          </Link>

          <Link
            href="/documents/new?type=invoice"
            className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md"
          >
            <div className="text-2xl">🧾</div>
            <h3 className="mt-3 font-bold">
              Nueva factura
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Crear una factura
            </p>
          </Link>

          <Link
            href="/settings/company"
            className="rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md"
          >
            <div className="text-2xl">⚙️</div>
            <h3 className="mt-3 font-bold">
              Mi empresa
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Configuración
            </p>
          </Link>

        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border bg-white shadow-sm">

        <div className="flex items-center justify-between border-b p-6">
          <div>
            <h2 className="text-xl font-bold">
              Documentos recientes
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Los últimos documentos creados.
            </p>
          </div>

          <Link
            href="/documents"
            className="text-sm font-semibold"
          >
            Ver todos →
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="p-8 text-center text-slate-500">
            Todavía no tienes documentos.
          </div>
        ) : (
          <div className="divide-y">
            {recent.map((doc) => (
              <Link
                key={doc.id}
                href={`/documents/${doc.id}`}
                className="flex items-center justify-between gap-4 p-5 hover:bg-slate-50"
              >
                <div>
                  <p className="font-semibold">
                    {doc.title || typeName(doc.document_type)}
                  </p>

                  <p className="mt-1 text-xs text-slate-500">
                    {typeName(doc.document_type)} ·{' '}
                    {statusName(doc.status)}
                  </p>
                </div>

                <p className="font-bold">
                  {money(Number(doc.total || 0))}
                </p>
              </Link>
            ))}
          </div>
        )}

      </section>

      <section className="rounded-3xl bg-slate-950 p-7 text-white">
        <p className="text-xs font-bold tracking-widest text-blue-300">
          BUSINESSAI
        </p>

        <h2 className="mt-2 text-2xl font-bold">
          Tu asistente empresarial 🤖
        </h2>

        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
          BusinessAI podrá ayudarte a consultar clientes,
          facturas, documentos, cobros y la información de tu empresa.
        </p>
      </section>

    </main>
  )
}
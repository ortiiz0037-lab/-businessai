import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

type DocumentRow = {
  id: string
  document_type: string
  title: string
  status: string
  total: number | null
  created_at: string
}

const documentTypes = [
  {
    type: 'quote',
    title: 'Cotización',
    description: 'Crea una cotización profesional para tus clientes.',
    icon: '📋',
  },
  {
    type: 'invoice',
    title: 'Factura',
    description: 'Crea facturas y lleva control de tus cuentas por cobrar.',
    icon: '🧾',
  },
  {
    type: 'receipt',
    title: 'Recibo',
    description: 'Registra pagos recibidos de tus clientes.',
    icon: '💵',
  },
  {
    type: 'work_order',
    title: 'Orden de trabajo',
    description: 'Organiza servicios, trabajos y órdenes pendientes.',
    icon: '🛠️',
  },
  {
    type: 'letter',
    title: 'Carta comercial',
    description: 'Genera cartas y comunicaciones profesionales.',
    icon: '✉️',
  },
  {
    type: 'payment_reminder',
    title: 'Recordatorio de pago',
    description: 'Prepara recordatorios para cuentas pendientes.',
    icon: '🔔',
  },
]

function formatMoney(value: number | null) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value ?? 0)
}

function typeLabel(type: string) {
  const found = documentTypes.find((item) => item.type === type)
  return found?.title ?? 'Documento'
}

export default async function DocumentsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return null
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const companyId = membership?.company_id

  let documents: DocumentRow[] = []

  if (companyId) {
    const { data } = await supabase
      .from('documents')
      .select(
        'id, document_type, title, status, total, created_at'
      )
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(20)

    documents = (data ?? []) as DocumentRow[]
  }

  return (
    <div className="space-y-8">
      {/* HERO */}
      <section className="relative overflow-hidden rounded-3xl bg-slate-950 px-6 py-8 text-white shadow-xl sm:px-8 lg:px-10">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-medium text-slate-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Documentos inteligentes
            </div>

            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Documentos
            </h1>

            <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
              Crea y administra cotizaciones, facturas, recibos y documentos
              comerciales desde un solo lugar.
            </p>
          </div>

          <Link
            href="#crear-documento"
            className="inline-flex items-center justify-center rounded-2xl bg-white px-5 py-3.5 text-sm font-semibold text-slate-950 shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-100"
          >
            + Nuevo documento
          </Link>
        </div>
      </section>

      {/* CREAR DOCUMENTO */}
      <section id="crear-documento">
        <div className="mb-5">
          <h2 className="text-xl font-bold text-slate-900">
            Crear un documento
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            Selecciona el tipo de documento que necesitas.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {documentTypes.map((item) => (
            <Link
              key={item.type}
              href={`/documents/new?type=${item.type}`}
              className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-slate-300 hover:shadow-lg"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-2xl transition group-hover:bg-slate-900 group-hover:text-white">
                  {item.icon}
                </div>

                <span className="text-sm font-semibold text-slate-400 transition group-hover:text-slate-900">
                  Crear →
                </span>
              </div>

              <h3 className="mt-5 text-lg font-bold text-slate-900">
                {item.title}
              </h3>

              <p className="mt-2 text-sm leading-6 text-slate-500">
                {item.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* DOCUMENTOS EXISTENTES */}
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              Documentos recientes
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Los documentos que hayas creado aparecerán aquí.
            </p>
          </div>

          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500">
            {documents.length} documento{documents.length === 1 ? '' : 's'}
          </span>
        </div>

        {documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
            <div className="text-4xl">📄</div>

            <h3 className="mt-4 font-semibold text-slate-800">
              Todavía no tienes documentos
            </h3>

            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
              Crea tu primera factura, cotización, recibo u otro documento
              comercial utilizando las opciones de arriba.
            </p>

            <Link
              href="#crear-documento"
              className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Crear mi primer documento →
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="divide-y divide-slate-100">
              {documents.map((document) => (
                <Link
                  key={document.id}
                  href={`/documents/${document.id}`}
                  className="block transition hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-4 p-5">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl">
                        📄
                      </div>

                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">
                          {document.title || typeLabel(document.document_type)}
                        </p>

                        <p className="mt-1 text-sm text-slate-500">
                          {typeLabel(document.document_type)}
                        </p>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="font-semibold text-slate-900">
                        {formatMoney(document.total)}
                      </p>

                      <p className="mt-1 text-xs text-slate-400">
                        {document.status}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* BUSINESSAI */}
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="relative bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 px-6 py-8 text-white sm:px-8">
          <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-blue-500/20 blur-3xl" />

          <div className="relative">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10">
                🤖
              </span>

              <span className="text-sm font-semibold text-blue-200">
                BUSINESSAI
              </span>
            </div>

            <h2 className="text-2xl font-bold sm:text-3xl">
              Crea documentos con lenguaje natural.
            </h2>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              En la siguiente etapa podrás pedirle a BusinessAI que prepare
              documentos utilizando la información de tu empresa y tus clientes.
            </p>

            <div className="mt-6 max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Ejemplo
              </p>

              <p className="mt-3 text-sm leading-6 text-slate-200">
                “Créame una factura para Juan Pérez por $450 por el servicio
                realizado.”
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
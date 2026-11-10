import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Icon } from '@/components/ui/icon'
import { StatusBadge, documentIcon } from '@/components/ui/status'
import { activeCompanyRow } from '@/lib/active-company'

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
  },
  {
    type: 'invoice',
    title: 'Factura',
    description: 'Crea facturas y lleva control de tus cuentas por cobrar.',
  },
  {
    type: 'receipt',
    title: 'Recibo',
    description: 'Registra pagos recibidos de tus clientes.',
  },
  {
    type: 'work_order',
    title: 'Orden de trabajo',
    description: 'Organiza servicios, trabajos y órdenes pendientes.',
  },
  {
    type: 'letter',
    title: 'Carta comercial',
    description: 'Genera cartas y comunicaciones profesionales.',
  },
  {
    type: 'payment_reminder',
    title: 'Recordatorio de pago',
    description: 'Prepara recordatorios para cuentas pendientes.',
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

  const membership = await activeCompanyRow(supabase, user.id)

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
      <section className="card-hero px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-electric/25 bg-brand/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-electric" />
              Documentos inteligentes
            </div>

            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">
              Documentos
            </h1>

            <p className="mt-3 text-sm leading-6 text-white/60 sm:text-base">
              Crea y administra cotizaciones, facturas, recibos y documentos
              comerciales desde un solo lugar.
            </p>
          </div>

          <Link
            href="#crear-documento"
            className="btn-accent btn-lg"
          >
            <Icon name="plus" className="h-4 w-4" /> Nuevo documento
          </Link>
        </div>
      </section>

      {/* CREAR DOCUMENTO */}
      <section id="crear-documento">
        <div className="mb-5">
          <p className="eyebrow">Nuevo</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">
            Crear un documento
          </h2>

          <p className="mt-1 text-sm text-muted">
            Selecciona el tipo de documento que necesitas.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {documentTypes.map((item) => (
            <Link
              key={item.type}
              href={`/documents/new?type=${item.type}`}
              className="card-interactive group p-6"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-app-2 text-accent transition group-hover:bg-brand group-hover:text-fg">
                  <Icon name={documentIcon(item.type)} />
                </div>

                <span className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 transition group-hover:text-blue-400">
                  Crear <Icon name="arrowRight" className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </span>
              </div>

              <h3 className="mt-5 text-lg font-bold text-fg">
                {item.title}
              </h3>

              <p className="mt-2 text-sm leading-6 text-muted">
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
            <p className="eyebrow">Actividad</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">
              Documentos recientes
            </h2>

            <p className="mt-1 text-sm text-muted">
              Los documentos que hayas creado aparecerán aquí.
            </p>
          </div>

          <span className="badge-neutral">
            {documents.length} documento{documents.length === 1 ? '' : 's'}
          </span>
        </div>

        {documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-electric/50 bg-electric/10 p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-electric/10 text-blue-400 ring-1 ring-inset ring-electric/30">
              <Icon name="file" className="h-6 w-6" />
            </span>

            <h3 className="mt-4 font-semibold text-fg">
              Todavía no tienes documentos
            </h3>

            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
              Crea tu primera factura, cotización, recibo u otro documento
              comercial utilizando las opciones de arriba.
            </p>

            <Link
              href="#crear-documento"
              className="btn-primary mt-5"
            >
              Crear mi primer documento <Icon name="arrowRight" className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="divide-y divide-line">
              {documents.map((document) => (
                <Link
                  key={document.id}
                  href={`/documents/${document.id}`}
                  className="group block transition hover:bg-electric/40"
                >
                  <div className="flex items-center justify-between gap-4 p-5">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-elevated text-slate-300 transition group-hover:bg-app-2 group-hover:text-accent">
                        <Icon name={documentIcon(document.document_type)} />
                      </div>

                      <div className="min-w-0">
                        <p className="truncate font-semibold text-fg">
                          {document.title || typeLabel(document.document_type)}
                        </p>

                        <p className="mt-1 text-sm text-muted">
                          {typeLabel(document.document_type)}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                      <span className="hidden sm:inline-flex"><StatusBadge status={document.status} /></span>
                      <div className="text-right">
                        <p className="font-bold tabular-nums text-fg">
                          {formatMoney(document.total)}
                        </p>
                        <p className="mt-1 sm:hidden"><StatusBadge status={document.status} /></p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* BUSINESSAI */}
      <section className="card overflow-hidden">
        <div className="card-hero rounded-none border-0 px-6 py-8 shadow-none sm:px-8">
          <div className="relative">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-electric/30 bg-brand/10 text-accent">
                <Icon name="sparkle" className="h-4 w-4" />
              </span>

              <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">
                Próximamente
              </span>
            </div>

            <h2 className="font-display text-2xl font-semibold sm:text-3xl">
              Crea documentos con lenguaje natural.
            </h2>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60 sm:text-base">
              En la siguiente etapa podrás pedirle a BusinessAI que prepare
              documentos utilizando la información de tu empresa y tus clientes.
            </p>

            <div className="mt-6 max-w-2xl rounded-2xl border border-white/10 bg-card/5 p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/40">
                Ejemplo
              </p>

              <p className="mt-3 font-display text-lg italic leading-7 text-white/85">
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
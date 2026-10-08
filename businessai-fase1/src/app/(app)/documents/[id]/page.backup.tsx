import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

function money(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value)
}

const typeLabels: Record<string, string> = {
  quote: 'Cotización',
  invoice: 'Factura',
  receipt: 'Recibo',
  work_order: 'Orden de trabajo',
  letter: 'Carta comercial',
  payment_reminder: 'Recordatorio de pago',
  contract: 'Contrato / plantilla',
  report: 'Reporte',
}

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    notFound()
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    notFound()
  }

  const companyId = membership.company_id

  const { data: document } = await supabase
    .from('documents')
    .select(
      `
      id,
      document_number,
      document_type,
      title,
      status,
      issue_date,
      due_date,
      subtotal,
      tax,
      total,
      notes,
      client_id
      `
    )
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!document) {
    notFound()
  }

  const [{ data: company }, { data: client }] = await Promise.all([
    supabase
      .from('company_profiles')
      .select(
        'legal_name, display_name, phone, email, address, city, state, postal_code, primary_color, logo_url'
      )
      .eq('company_id', companyId)
      .maybeSingle(),

    document.client_id
      ? supabase
          .from('clients')
          .select(
            'name, business_name, email, phone, address, city, state, postal_code'
          )
          .eq('id', document.client_id)
          .eq('company_id', companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const companyName =
    company?.display_name ||
    company?.legal_name ||
    'Tu empresa'

  const primaryColor = company?.primary_color || '#0f172a'

  return (
    <div className="min-h-screen bg-slate-100 py-8">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        {/* CONTROLES */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/documents"
            className="text-sm font-semibold text-slate-600 hover:text-slate-950"
          >
            ← Volver a Documentos
          </Link>

          <div className="flex gap-3">
            <button
              type="button"
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm"
            >
              🖨️ Imprimir
            </button>

            <button
              type="button"
              className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
            >
              📄 Descargar PDF
            </button>
          </div>
        </div>

        {/* FACTURA */}
        <article className="overflow-hidden rounded-3xl bg-white shadow-xl">
          {/* HEADER */}
          <header
            className="px-7 py-8 text-white sm:px-10"
            style={{ backgroundColor: primaryColor }}
          >
            <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
              <div>
                {company?.logo_url ? (
                  <img
                    src={company.logo_url}
                    alt={companyName}
                    className="mb-5 h-16 max-w-52 object-contain"
                  />
                ) : (
                  <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-2xl font-bold">
                    {companyName.charAt(0)}
                  </div>
                )}

                <h1 className="text-2xl font-bold">{companyName}</h1>

                {company?.legal_name &&
                  company.legal_name !== company.display_name && (
                    <p className="mt-1 text-sm text-white/70">
                      {company.legal_name}
                    </p>
                  )}

                <div className="mt-4 space-y-1 text-sm text-white/80">
                  {company?.phone && <p>{company.phone}</p>}
                  {company?.email && <p>{company.email}</p>}
                  {company?.address && <p>{company.address}</p>}
                  {(company?.city || company?.state) && (
                    <p>
                      {company.city}
                      {company.city && company.state ? ', ' : ''}
                      {company.state} {company.postal_code || ''}
                    </p>
                  )}
                </div>
              </div>

              <div className="sm:text-right">
                <p className="text-sm font-medium uppercase tracking-widest text-white/60">
                  {typeLabels[document.document_type] || 'Documento'}
                </p>

                <p className="mt-2 text-2xl font-bold">
                  {document.document_number}
                </p>

                <div className="mt-5 inline-flex rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold capitalize">
                  {document.status}
                </div>
              </div>
            </div>
          </header>

          {/* INFORMACIÓN */}
          <div className="grid gap-8 border-b border-slate-200 px-7 py-8 sm:grid-cols-2 sm:px-10">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Facturar a
              </p>

              <h2 className="mt-2 text-lg font-bold text-slate-900">
                {client?.name || 'Cliente no especificado'}
              </h2>

              {client?.business_name && (
                <p className="mt-1 text-sm text-slate-600">
                  {client.business_name}
                </p>
              )}

              <div className="mt-3 space-y-1 text-sm text-slate-500">
                {client?.email && <p>{client.email}</p>}
                {client?.phone && <p>{client.phone}</p>}
                {client?.address && <p>{client.address}</p>}
                {(client?.city || client?.state) && (
                  <p>
                    {client.city}
                    {client.city && client.state ? ', ' : ''}
                    {client.state} {client.postal_code || ''}
                  </p>
                )}
              </div>
            </div>

            <div className="sm:text-right">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Detalles
              </p>

              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-8 sm:justify-end">
                  <span className="text-slate-500">Fecha:</span>
                  <span className="font-semibold text-slate-900">
                    {document.issue_date}
                  </span>
                </div>

                {document.due_date && (
                  <div className="flex justify-between gap-8 sm:justify-end">
                    <span className="text-slate-500">Vencimiento:</span>
                    <span className="font-semibold text-slate-900">
                      {document.due_date}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CONCEPTO */}
          <div className="px-7 py-8 sm:px-10">
            <div className="overflow-hidden rounded-2xl border border-slate-200">
              <div className="grid grid-cols-[1fr_auto] bg-slate-50 px-5 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">
                <span>Descripción</span>
                <span>Importe</span>
              </div>

              <div className="grid grid-cols-[1fr_auto] px-5 py-6">
                <div>
                  <p className="font-semibold text-slate-900">
                    {document.title}
                  </p>

                  <p className="mt-1 text-sm text-slate-500">
                    Servicio o concepto facturado
                  </p>
                </div>

                <p className="font-semibold text-slate-900">
                  {money(Number(document.subtotal || 0))}
                </p>
              </div>
            </div>

            {/* TOTALES */}
            <div className="mt-8 flex justify-end">
              <div className="w-full max-w-sm space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Subtotal</span>
                  <span className="font-medium text-slate-900">
                    {money(Number(document.subtotal || 0))}
                  </span>
                </div>

                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Impuesto</span>
                  <span className="font-medium text-slate-900">
                    {money(Number(document.tax || 0))}
                  </span>
                </div>

                <div className="border-t border-slate-200 pt-4">
                  <div className="flex items-end justify-between">
                    <span className="text-base font-bold text-slate-900">
                      TOTAL
                    </span>

                    <span className="text-3xl font-bold text-slate-950">
                      {money(Number(document.total || 0))}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* NOTAS */}
            {document.notes && (
              <div className="mt-10 rounded-2xl bg-slate-50 p-5">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Notas
                </p>

                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                  {document.notes}
                </p>
              </div>
            )}
          </div>

          {/* FOOTER */}
          <footer className="border-t border-slate-200 bg-slate-50 px-7 py-6 sm:px-10">
            <div className="flex flex-col gap-2 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <p>
                Gracias por confiar en <strong>{companyName}</strong>.
              </p>

              <p className="text-xs">
                Generado con BusinessAI
              </p>
            </div>
          </footer>
        </article>
      </div>
    </div>
  )
}
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

type DocumentRow = {
  id: string
  company_id: string
  document_type?: string | null
  title?: string | null
  document_number?: string | null
  client_id?: string | null
  issue_date?: string | null
  due_date?: string | null
  subtotal?: number | null
  tax?: number | null
  total?: number | null
  notes?: string | null
  status?: string | null
  created_at?: string | null
}

type ClientRow = {
  id: string
  name?: string | null
  business_name?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
}

type CompanyRow = {
  id: string
  legal_name?: string | null
  display_name?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  primary_color?: string | null
  secondary_color?: string | null
  logo_url?: string | null
  payment_info?: string | null
}

function money(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value ?? 0))
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'

  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('es-PR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

function documentType(value: string | null | undefined) {
  const types: Record<string, string> = {
    invoice: 'Factura',
    factura: 'Factura',
    quote: 'Cotización',
    quotation: 'Cotización',
    receipt: 'Recibo',
    recibo: 'Recibo',
    work_order: 'Orden de trabajo',
    'orden de trabajo': 'Orden de trabajo',
    letter: 'Carta comercial',
    reminder: 'Recordatorio de pago',
    contract: 'Contrato / plantilla',
    report: 'Reporte',
  }

  return types[value ?? ''] ?? value ?? 'Documento'
}

function statusLabel(value: string | null | undefined) {
  const statuses: Record<string, string> = {
    draft: 'Borrador',
    sent: 'Enviado',
    paid: 'Pagado',
    overdue: 'Vencido',
    cancelled: 'Cancelado',
  }

  return statuses[value ?? ''] ?? value ?? 'Borrador'
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
    redirect('/login')
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    redirect('/dashboard')
  }

  const { data: document, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .eq('company_id', membership.company_id)
    .maybeSingle()

  if (error || !document) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12">
        <div className="rounded-3xl border border-red-200 bg-red-50 p-8 text-center">
          <div className="text-4xl">⚠️</div>
          <h1 className="mt-4 text-2xl font-bold text-slate-900">
            Documento no encontrado
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            No pudimos encontrar este documento o no tienes acceso a él.
          </p>

          <Link
            href="/documents"
            className="mt-6 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
          >
            ← Volver a Documentos
          </Link>
        </div>
      </main>
    )
  }

  const doc = document as DocumentRow

  const { data: client } = doc.client_id
    ? await supabase
        .from('clients')
        .select('*')
        .eq('id', doc.client_id)
        .eq('company_id', membership.company_id)
        .maybeSingle()
    : { data: null }

  const { data: company } = await supabase
    .from('company_profiles')
    .select('*')
    .eq('company_id', membership.company_id)
    .maybeSingle()

  const clientData = client as ClientRow | null
  const companyData = company as CompanyRow | null
  
async function updateStatus(formData: FormData) {
  'use server'

  const status = String(formData.get('status') || '')

  if (status !== 'sent' && status !== 'paid') {
    return
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: member } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.company_id) {
    redirect('/documents')
  }

  const { data: currentDoc } = await supabase
    .from('documents')
    .select('id, document_type, total, status')
    .eq('id', id)
    .eq('company_id', member.company_id)
    .maybeSingle()

  if (!currentDoc) {
    redirect('/documents')
  }

  if (status === 'paid') {
    const amount = Number(currentDoc.total ?? 0)

    if (amount <= 0) {
      redirect(`/documents/${id}`)
    }

    const { error: paymentError } = await supabase
      .from('payments')
      .insert({
        company_id: member.company_id,
        document_id: id,
        amount,
        payment_method: 'manual',
        created_by: user.id,
      })

    if (paymentError) {
      console.error('PAYMENT_CREATE_ERROR', paymentError)
      redirect(`/documents/${id}`)
    }
  }

  const { error: updateError } = await supabase
    .from('documents')
    .update({ status })
    .eq('id', id)
    .eq('company_id', member.company_id)

  if (updateError) {
    console.error('DOCUMENT_STATUS_ERROR', updateError)
    redirect(`/documents/${id}`)
  }

  redirect(`/documents/${id}`)
}
  const subtotal = Number(doc.subtotal ?? 0)
  const tax = Number(doc.tax ?? 0)
  const total =
    doc.total !== null && doc.total !== undefined
      ? Number(doc.total)
      : subtotal + tax

  const primaryColor = companyData?.primary_color || '#0f172a'

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        {/* TOP BAR */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              href="/documents"
              className="text-sm font-semibold text-slate-500 transition hover:text-slate-900"
            >
              ← Volver a Documentos
            </Link>

            <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">
              Vista del documento
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              Revisa la información antes de enviarla al cliente.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
              {statusLabel(doc.status)}
            </span>
          </div>
        </div>
{doc.document_type === 'invoice' && (
  <div className="mt-4 flex flex-wrap gap-3">
    {doc.status === 'draft' && (
      <form action={updateStatus}>
        <input type="hidden" name="status" value="sent" />
        <button
          type="submit"
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
        >
          Marcar como enviada
        </button>
      </form>
    )}

    {(doc.status === 'sent' || doc.status === 'overdue') && (
      <form action={updateStatus}>
        <input type="hidden" name="status" value="paid" />
        <button
          type="submit"
          className="rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white"
        >
          Marcar como pagada
        </button>
      </form>
    )}

    {doc.status === 'paid' && (
      <span className="rounded-xl bg-green-100 px-4 py-2 text-sm font-semibold text-green-700">
        ✓ Factura pagada
      </span>
    )}
  </div>
)}
        {/* DOCUMENT */}
        <article className="overflow-hidden rounded-3xl bg-white shadow-xl ring-1 ring-slate-200">
          {/* HEADER */}
          <header
            className="px-6 py-8 text-white sm:px-10"
            style={{ backgroundColor: primaryColor }}
          >
            <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
              <div>
                {companyData?.logo_url ? (
                  <img
                    src={companyData.logo_url}
                    alt="Logo de la empresa"
                    className="mb-5 h-16 max-w-[220px] object-contain object-left"
                  />
                ) : (
                  <div className="mb-5 inline-flex h-12 items-center rounded-xl bg-white/10 px-4 text-sm font-bold tracking-wide">
                    BUSINESSAI
                  </div>
                )}

                <h2 className="text-2xl font-bold">
                  {companyData?.display_name ||
                    companyData?.legal_name ||
                    'Tu empresa'}
                </h2>

                {companyData?.legal_name &&
                  companyData.display_name !== companyData.legal_name && (
                    <p className="mt-1 text-sm text-white/70">
                      {companyData.legal_name}
                    </p>
                  )}

                <div className="mt-4 space-y-1 text-sm text-white/75">
                  {companyData?.address && <p>{companyData.address}</p>}

                  {(companyData?.city ||
                    companyData?.state ||
                    companyData?.postal_code) && (
                    <p>
                      {[companyData.city, companyData.state, companyData.postal_code]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}

                  {companyData?.phone && <p>{companyData.phone}</p>}
                  {companyData?.email && <p>{companyData.email}</p>}
                </div>
              </div>

              <div className="sm:text-right">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
                  {documentType(doc.document_type)}
                </p>

                <p className="mt-2 text-2xl font-bold">
                  {doc.document_number || 'Documento'}
                </p>

                <div className="mt-5 space-y-1 text-sm text-white/75">
                  <p>
                    Fecha:{' '}
                    <span className="font-semibold text-white">
                      {formatDate(doc.issue_date)}
                    </span>
                  </p>

                  {doc.due_date && (
                    <p>
                      Vencimiento:{' '}
                      <span className="font-semibold text-white">
                        {formatDate(doc.due_date)}
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </header>

          {/* CLIENT */}
          <section className="grid gap-6 border-b border-slate-200 px-6 py-7 sm:grid-cols-2 sm:px-10">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Facturado a
              </p>

              <h3 className="mt-2 text-lg font-bold text-slate-900">
                {clientData?.business_name ||
                  clientData?.name ||
                  'Cliente no especificado'}
              </h3>

              {clientData?.business_name && clientData?.name && (
                <p className="mt-1 text-sm text-slate-600">
                  {clientData.name}
                </p>
              )}

              <div className="mt-3 space-y-1 text-sm text-slate-500">
                {clientData?.email && <p>{clientData.email}</p>}
                {clientData?.phone && <p>{clientData.phone}</p>}
                {clientData?.address && <p>{clientData.address}</p>}
                {(clientData?.city ||
                  clientData?.state ||
                  clientData?.postal_code) && (
                  <p>
                    {[clientData.city, clientData.state, clientData.postal_code]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 p-5 sm:text-right">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Resumen
              </p>

              <p className="mt-2 text-3xl font-bold text-slate-950">
                {money(total)}
              </p>

              <p className="mt-1 text-sm text-slate-500">
                Total del documento
              </p>
            </div>
          </section>

          {/* DESCRIPTION */}
          <section className="px-6 py-8 sm:px-10">
            <div className="rounded-2xl border border-slate-200">
              <div className="grid grid-cols-1 bg-slate-50 px-5 py-3 text-xs font-bold uppercase tracking-wider text-slate-500 sm:grid-cols-[1fr_140px]">
                <span>Descripción</span>
                <span className="sm:text-right">Importe</span>
              </div>

              <div className="grid grid-cols-1 gap-3 px-5 py-6 sm:grid-cols-[1fr_140px]">
                <div>
                  <p className="font-semibold text-slate-900">
                    {doc.title || 'Servicio profesional'}
                  </p>

                  <p className="mt-1 text-sm text-slate-500">
                    {documentType(doc.document_type)}
                  </p>
                </div>

                <p className="text-lg font-bold text-slate-900 sm:text-right">
                  {money(subtotal)}
                </p>
              </div>
            </div>

            {/* TOTALS */}
            <div className="mt-6 flex justify-end">
              <div className="w-full max-w-sm space-y-3">
                <div className="flex justify-between text-sm text-slate-500">
                  <span>Subtotal</span>
                  <span className="font-medium text-slate-800">
                    {money(subtotal)}
                  </span>
                </div>

                <div className="flex justify-between text-sm text-slate-500">
                  <span>Impuesto</span>
                  <span className="font-medium text-slate-800">
                    {money(tax)}
                  </span>
                </div>

                <div className="border-t border-slate-200 pt-4">
                  <div className="flex items-end justify-between">
                    <span className="text-base font-bold text-slate-900">
                      Total
                    </span>

                    <span
                      className="text-3xl font-bold"
                      style={{ color: primaryColor }}
                    >
                      {money(total)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* NOTES */}
          {doc.notes && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                Notas y condiciones
              </h3>

              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {doc.notes}
              </p>
            </section>
          )}

          {/* PAYMENT INFO */}
          {companyData?.payment_info && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                Información de pago
              </h3>

              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {companyData.payment_info}
              </p>
            </section>
          )}

          {/* FOOTER */}
          <footer className="border-t border-slate-200 bg-slate-50 px-6 py-6 text-center sm:px-10">
            <p className="text-xs text-slate-400">
              Documento generado con BusinessAI
            </p>

            <p className="mt-1 text-xs text-slate-400">
              {companyData?.display_name ||
                companyData?.legal_name ||
                'BusinessAI'}
            </p>
          </footer>
        </article>

        {/* BOTTOM */}
        <div className="mt-6 flex justify-center">
          <Link
            href="/documents"
            className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            ← Volver a Documentos
          </Link>
        </div>
      </div>
    </main>
  )
}

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type ClientRow = {
  id: string
  name: string | null
  business_name: string | null
  email: string | null
}

type InvoiceRow = {
  id: string
  document_number: string | null
  title: string | null
  total: number | null
  due_date: string | null
  client_id: string | null
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function text(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim()
}

function docTitle(type: string) {
  const titles: Record<string, string> = {
    invoice: 'Factura',
  quote: 'Cotización',
    letter: 'Carta comercial',
    work_order: 'Orden de trabajo',
    payment_reminder: 'Recordatorio de pago',
  }
  return titles[type] ?? 'Documento'
}

async function createDocument(formData: FormData) {
  'use server'

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

  if (!membership?.company_id) redirect('/documents')

  const companyId = membership.company_id
  const type = text(formData, 'type')

  if (!['invoice', 'quote', 'letter', 'work_order', 'payment_reminder'].includes(type)) {
    redirect('/documents/new?error=type')
  }

  const clientId = text(formData, 'client_id')
  const title = text(formData, 'title')
  const issueDate = text(formData, 'issue_date') || today()
  const dueDate = text(formData, 'due_date')
  const notes = text(formData, 'notes')

  let clientName = ''
  let total = 0
  let subtotal = 0
  let tax = 0
  let documentNotes = notes

  if (type === 'invoice') {
    const service = text(formData, 'service')
    const quantity = Number(formData.get('quantity') ?? 1)
    const unitPrice = Number(formData.get('unit_price') ?? 0)
    const taxRate = Number(formData.get('tax_rate') ?? 0)

    if (
      !clientId ||
      !service ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) redirect('/documents/new?type=invoice&error=required')

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      redirect('/documents/new?type=invoice&error=price')
    }

    if (!Number.isFinite(taxRate) || taxRate < 0) {
      redirect('/documents/new?type=invoice&error=tax')
    }

    const { data: client } = await supabase
      .from('clients')
      .select('name,business_name')
      .eq('id', clientId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!client) redirect('/documents/new?type=invoice&error=client')

    clientName = client.business_name?.trim() || client.name?.trim() || 'Cliente'
    subtotal = Number((quantity * unitPrice).toFixed(2))
    tax = Number((subtotal * taxRate / 100).toFixed(2))
    total = Number((subtotal + tax).toFixed(2))

    documentNotes = [
      `Servicio: ${service}`,
      `Cantidad: ${quantity}`,
      `Precio unitario: $${unitPrice.toFixed(2)}`,
      taxRate > 0 ? `Impuesto: ${taxRate}%` : null,
      notes ? `Notas: ${notes}` : null,
    ].filter(Boolean).join('\n')
  } else if (type === 'payment_reminder') {
    const invoiceId = text(formData, 'invoice_id')

    if (!invoiceId) {
      redirect('/documents/new?type=payment_reminder&error=invoice')
    }

    const { data: invoice } = await supabase
      .from('documents')
      .select('id,document_number,title,total,due_date,client_id')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', ['draft', 'sent', 'overdue'])
      .maybeSingle()

    if (!invoice || !invoice.client_id) {
      redirect('/documents/new?type=payment_reminder&error=invoice')
    }

    const { data: client } = await supabase
      .from('clients')
      .select('name,business_name')
      .eq('id', invoice.client_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!client) {
      redirect('/documents/new?type=payment_reminder&error=client')
    }

    clientName = client.business_name?.trim() || client.name?.trim() || 'Cliente'
    total = Number(invoice.total ?? 0)

    documentNotes = [
      `Factura relacionada: ${invoice.document_number || invoice.title || invoice.id}`,
      `Importe pendiente: $${total.toFixed(2)}`,
      invoice.due_date ? `Fecha de vencimiento: ${invoice.due_date}` : null,
      '',
      notes || 'Le recordamos amablemente que tiene un pago pendiente. Gracias por su atención.',
    ].filter((line) => line !== null).join('\n')
  } else {
    if (!title || !notes) {
      redirect(`/documents/new?type=${type}&error=required`)
    }

    if (clientId) {
      const { data: client } = await supabase
        .from('clients')
        .select('name,business_name')
        .eq('id', clientId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (!client) redirect(`/documents/new?type=${type}&error=client`)

      clientName = client.business_name?.trim() || client.name?.trim() || 'Cliente'
    }

    documentNotes = notes
  }

  const prefix: Record<string, string> = {
    invoice: 'FAC',
  quote: 'COT',
    letter: 'CARTA',
    work_order: 'OT',
    payment_reminder: 'REC',
  }

  const documentNumber = `${prefix[type]}-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`

  const { data: document, error } = await supabase
    .from('documents')
    .insert({
      company_id: companyId,
      document_type: type,
      title: type === 'invoice'
        ? `Factura - ${clientName}`
        : type === 'quote'
          ? `Cotización - ${clientName}`
          : type === 'payment_reminder'
            ? `Recordatorio de pago - ${clientName}`
            : title,
      document_number: documentNumber,
      client_id: clientId || null,
      issue_date: issueDate,
      due_date: dueDate || null,
      subtotal,
      tax,
      total,
      status: 'draft',
      notes: documentNotes,
    })
    .select('id')
    .single()

  if (error || !document) {
    console.error('DOCUMENT_CREATE_ERROR', error)
    redirect(`/documents/new?type=${type}&error=save`)
  }

  revalidatePath('/documents')
  revalidatePath('/dashboard')
  revalidatePath('/payments')

  redirect(`/documents/${document.id}`)
}

export default async function NewDocumentPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string; error?: string }>
}) {
  const params = await searchParams
  const type = params?.type ?? 'invoice'
  const error = params?.error

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

  if (!membership?.company_id) redirect('/dashboard')

  const { data: clients } = await supabase
    .from('clients')
    .select('id,name,business_name,email')
    .eq('company_id', membership.company_id)
    .order('name')

  const { data: invoices } = await supabase
    .from('documents')
    .select('id,document_number,title,total,due_date,client_id')
    .eq('company_id', membership.company_id)
    .eq('document_type', 'invoice')
    .in('status', ['draft', 'sent', 'overdue'])
    .order('created_at', { ascending: false })

  const clientList = (clients ?? []) as ClientRow[]
  const invoiceList = (invoices ?? []) as InvoiceRow[]
  const validTypes = ['invoice', 'quote', 'letter', 'work_order', 'payment_reminder']
  const selectedType = validTypes.includes(type) ? type : 'invoice'

  const errorMessage: Record<string, string> = {
    required: 'Completa los campos obligatorios.',
    price: 'El precio debe ser cero o mayor.',
    tax: 'El impuesto debe ser un número válido.',
    client: 'No encontramos ese cliente en tu empresa.',
    invoice: 'Selecciona una factura pendiente válida para el recordatorio.',
    save: 'No se pudo guardar. Revisa los registros del servidor.',
    type: 'Ese tipo de documento no está permitido.',
  }

  const fieldClass = 'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-950 focus:ring-2 focus:ring-slate-200'

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Link href="/documents" className="text-sm font-semibold text-slate-500 hover:text-slate-950">
        ← Volver a Documentos
      </Link>

      <header className="rounded-3xl bg-slate-950 p-7 text-white sm:p-9">
        <p className="text-xs font-bold uppercase tracking-widest text-blue-300">
          BUSINESSAI · DOCUMENTOS
        </p>
        <h1 className="mt-3 text-3xl font-bold">{docTitle(selectedType)}</h1>
        <p className="mt-2 text-sm text-slate-300">
          Crea y guarda documentos de tu empresa en un solo lugar.
        </p>
      </header>

      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {validTypes.map((item) => (
          <Link
            key={item}
            href={`/documents/new?type=${item}`}
            className={`rounded-xl border px-3 py-3 text-center text-sm font-semibold ${
              selectedType === item
                ? 'border-slate-950 bg-slate-950 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {docTitle(item)}
          </Link>
        ))}
      </nav>

      {error && errorMessage[error] && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {errorMessage[error]}
        </div>
      )}

      <form action={createDocument} className="space-y-6">
        <input type="hidden" name="type" value={selectedType} />

        {selectedType === 'payment_reminder' ? (
          <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-950">Factura pendiente</h2>
            {invoiceList.length === 0 ? (
              <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
                No hay facturas pendientes disponibles. Crea una factura primero para poder preparar un recordatorio.
                <Link href="/documents/new?type=invoice" className="mt-3 block font-bold underline">
                  Crear factura
                </Link>
              </div>
            ) : (
              <>
                <label className="block text-sm font-semibold text-slate-700">
                  Selecciona la factura *
                  <select name="invoice_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                    <option value="" disabled>Seleccionar factura pendiente</option>
                    {invoiceList.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {(invoice.document_number || invoice.title || 'Factura')} — ${Number(invoice.total ?? 0).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Fecha del recordatorio
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Mensaje *
                  <textarea name="notes" required rows={5} defaultValue="Le recordamos amablemente que tiene un pago pendiente. Si ya realizó el pago, puede ignorar este aviso. Gracias por su atención." className={`${fieldClass} mt-2`} />
                </label>
              </>
            )}
          </section>
        ) : (
          <>
            {selectedType !== 'invoice' && (
              <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-xl font-bold text-slate-950">Información del documento</h2>
                <label className="block text-sm font-semibold text-slate-700">
                  Título *
                  <input name="title" required className={`${fieldClass} mt-2`} placeholder={
                    selectedType === 'letter' ? 'Ej. Carta comercial para cliente' : 'Ej. Reparación y mantenimiento'
                  } />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Cliente (opcional)
                  <select name="client_id" defaultValue="" className={`${fieldClass} mt-2`}>
                    <option value="">Sin cliente específico</option>
                    {clientList.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.business_name || client.name || 'Cliente'}
                        {client.email ? ` — ${client.email}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Fecha
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                {selectedType === 'work_order' && (
                  <label className="block text-sm font-semibold text-slate-700">
                    Fecha límite (opcional)
                    <input name="due_date" type="date" className={`${fieldClass} mt-2`} />
                  </label>
                )}
                <label className="block text-sm font-semibold text-slate-700">
                  {selectedType === 'letter' ? 'Contenido de la carta *' : 'Descripción del trabajo *'}
                  <textarea name="notes" required rows={8} className={`${fieldClass} mt-2`} placeholder={
                    selectedType === 'letter'
                      ? 'Escribe aquí el destinatario, el propósito y el contenido de la carta.'
                      : 'Describe el trabajo solicitado, materiales, instrucciones y detalles importantes.'
                  } />
                </label>
              </section>
            )}

            {selectedType === 'invoice' && (
              <>
                <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-xl font-bold text-slate-950">Información del cliente</h2>
                  {clientList.length === 0 ? (
                    <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
                      Primero registra un cliente.
                      <Link href="/clients" className="ml-1 font-bold underline">Ir a Clientes</Link>
                    </div>
                  ) : (
                    <label className="block text-sm font-semibold text-slate-700">
                      Cliente *
                      <select name="client_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                        <option value="" disabled>Selecciona un cliente</option>
                        {clientList.map((client) => (
                          <option key={client.id} value={client.id}>
                            {client.business_name || client.name || 'Cliente'}
                            {client.email ? ` — ${client.email}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </section>

                <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-xl font-bold text-slate-950">Detalle de la factura</h2>
                  <label className="block text-sm font-semibold text-slate-700">
                    Servicio o descripción *
                    <input name="service" required className={`${fieldClass} mt-2`} placeholder="Ej. Servicio profesional" />
                  </label>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <label className="block text-sm font-semibold text-slate-700">
                      Cantidad *
                      <input name="quantity" type="number" min="0.01" step="0.01" defaultValue="1" required className={`${fieldClass} mt-2`} />
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">
                      Precio unitario *
                      <input name="unit_price" type="number" min="0" step="0.01" required className={`${fieldClass} mt-2`} placeholder="0.00" />
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">
                      Impuesto %
                      <input name="tax_rate" type="number" min="0" step="0.01" defaultValue="0" className={`${fieldClass} mt-2`} />
                    </label>
                    <label className="block text-sm font-semibold text-slate-700">
                      Fecha de factura
                      <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                    </label>
                  </div>
                  <label className="block text-sm font-semibold text-slate-700">
                    Notas
                    <textarea name="notes" rows={4} className={`${fieldClass} mt-2`} />
                  </label>
                </section>
              </>
            )}
          </>
        )}

        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600">
            El documento se guardará en la empresa asociada a tu cuenta.
          </p>
          <button
            type="submit"
            disabled={
              selectedType === 'payment_reminder' && invoiceList.length === 0
            }
            className="rounded-xl bg-slate-950 px-6 py-3.5 text-sm font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar {docTitle(selectedType)} →
          </button>
        </div>
      </form>
    </main>
  )
}
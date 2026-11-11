
import Link from 'next/link'
import { paidByDocument } from '@/lib/supabase/paged'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { BILLING_ERROR_MESSAGE, billingErrorCode } from '@/lib/billing/state'
import { fetchUsage, isBlocked, usageNotice } from '@/lib/billing/usage'
import { activeCompanyRow } from '@/lib/active-company'
import { computeTotals, parseItemsInput, type LineItem } from '@/lib/documents/items'
import { insertDocument } from '@/lib/documents/numbering'
import { todayIn } from '@/lib/documents/lifecycle'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { createReceipt } from '@/app/actions/documents'

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
  return todayIn()
}

/** Types created with this form. Receipts come from a payment. */
const FORM_TYPES = ['invoice', 'quote', 'letter', 'work_order', 'payment_reminder']

function text(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim()
}

function docTitle(type: string) {
  const titles: Record<string, string> = {
    invoice: 'Factura',
    quote: 'Cotización',
    receipt: 'Recibo',
    letter: 'Carta comercial',
    work_order: 'Orden de trabajo',
    payment_reminder: 'Recordatorio de pago',
  }
  return titles[type] ?? 'Documento'
}

async function createDocument(formData: FormData) {
  'use server'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await activeCompanyRow(supabase, user.id)

  if (!membership?.company_id) redirect('/documents')

  const companyId = membership.company_id
  const type = text(formData, 'type')

  // Server-side check before inserting (the database enforces it too).
  if (isBlocked(await fetchUsage(supabase, companyId), 'documents')) {
    redirect(`/documents/new?type=${encodeURIComponent(type || 'invoice')}&error=limit_documents`)
  }

  // Receipts are created from a payment (actions/documents.createReceipt), never here.
  if (!FORM_TYPES.includes(type)) {
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
  let items: LineItem[] = []
  let metadata: Record<string, unknown> = {}

  if (type === 'invoice' || type === 'quote') {
    const parsed = parseItemsInput((key) => text(formData, key))
    if (parsed.error) redirect(`/documents/new?type=${type}&error=${parsed.error}`)

    const taxRate = Number(formData.get('tax_rate') ?? 0)
    const discount = Number(formData.get('discount') ?? 0)

    if (!clientId || parsed.items.length === 0 || (type === 'quote' && !title)) {
      redirect(`/documents/new?type=${type}&error=required`)
    }

    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100 ||
        !Number.isFinite(discount) || discount < 0 || discount > parsed.subtotal) {
      redirect(`/documents/new?type=${type}&error=tax`)
    }

    const { data: client } = await supabase
      .from('clients')
      .select('name,business_name')
      .eq('id', clientId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!client) redirect(`/documents/new?type=${type}&error=client`)

    clientName = client.business_name?.trim() || client.name?.trim() || 'Cliente'

    // Items are stored as data (documents.items); notes keep only the user's notes.
    items = parsed.items
    subtotal = parsed.subtotal
    ;({ tax, total } = computeTotals(subtotal, discount, taxRate))
    metadata = { discount: Math.round(discount * 100) / 100, tax_rate: taxRate }
    documentNotes = notes
  } else if (type === 'payment_reminder') {
    const invoiceId = text(formData, 'invoice_id')
    if (!invoiceId) redirect('/documents/new?type=payment_reminder&error=invoice')

    const { data: invoice } = await supabase
      .from('documents')
      .select('id,document_number,title,total,due_date,client_id')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', ['sent', 'overdue'])
      .maybeSingle()

    if (!invoice || !invoice.client_id) {
      redirect('/documents/new?type=payment_reminder&error=invoice')
    }
    // The reminder asks for what is still owed, not the original total (I6).
    const paidSoFar = (await paidByDocument(supabase, [invoice.id])).get(invoice.id) ?? 0
    const owed = Math.round(Math.max(Number(invoice.total ?? 0) - paidSoFar, 0) * 100) / 100
    if (owed <= 0) redirect('/documents/new?type=payment_reminder&error=invoice')

    const { data: client } = await supabase
      .from('clients')
      .select('name,business_name')
      .eq('id', invoice.client_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!client) redirect('/documents/new?type=payment_reminder&error=client')

    clientName = client.business_name?.trim() || client.name?.trim() || 'Cliente'
    total = owed

    documentNotes = [
      `Factura relacionada: ${invoice.document_number || invoice.title || invoice.id}`,
      `Total de la factura: $${Number(invoice.total ?? 0).toFixed(2)}`,
      paidSoFar > 0 ? `Pagado: $${paidSoFar.toFixed(2)}` : null,
      `Balance pendiente: $${owed.toFixed(2)}`,
      invoice.due_date ? `Fecha de vencimiento: ${invoice.due_date}` : null,
      '',
      notes || 'Le recordamos amablemente que tiene un pago pendiente. Gracias por su atención.',
    ].filter((line) => line !== null).join('\n')
  } else {
    if (!title || !notes) redirect(`/documents/new?type=${type}&error=required`)

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

  // The database assigns the consecutive number (0015); see lib/documents/numbering.
  const { data: document, error } = await insertDocument(supabase, {
    company_id: companyId,
    created_by: user.id,
    document_type: type,
    title: type === 'invoice'
      ? `Factura - ${clientName}`
      : type === 'quote'
        ? title
        : type === 'payment_reminder'
          ? `Recordatorio de pago - ${clientName}`
          : title,
    client_id: clientId || null,
    issue_date: issueDate,
    due_date: dueDate || null,
    subtotal,
    tax,
    total,
    status: 'draft',
    notes: documentNotes || null,
    items,
    metadata,
  })

  if (error || !document) {
    // Subscription inactive or plan limit (enforced in the database, 0010).
    const billing = billingErrorCode(error)
    if (billing) redirect(`/documents/new?type=${type}&error=${billing}`)
    console.error('DOCUMENT_CREATE_ERROR', { code: error?.code, message: error?.message })
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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await activeCompanyRow(supabase, user.id)

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
    .in('status', ['sent', 'overdue'])
    .order('created_at', { ascending: false })
    .limit(200)

  const clientList = (clients ?? []) as ClientRow[]
  // Reminders: issued invoices with an open balance, shown with that balance (I6).
  const invoicePaid = await paidByDocument(supabase, (invoices ?? []).map((i) => i.id as string))
  const invoiceList = ((invoices ?? []) as InvoiceRow[])
    .map((i) => ({ ...i, balance: Math.round(Math.max(Number(i.total ?? 0) - (invoicePaid.get(i.id) ?? 0), 0) * 100) / 100 }))
    .filter((i) => i.balance > 0)
  const usage = membership?.company_id ? await fetchUsage(supabase, membership.company_id) : []
  const documentNotice = usageNotice(usage.find((u) => u.metric === 'documents'))
  const documentsBlocked = documentNotice?.level === 'blocked'
  const validTypes = FORM_TYPES
  const isReceipt = type === 'receipt'
  const unknownType = !isReceipt && !validTypes.includes(type)
  const selectedType = validTypes.includes(type) ? type : isReceipt ? 'receipt' : 'invoice'

  // Receipts: payments of this company that do not have a receipt yet.
  let receiptCandidates: { id: string; amount: number; method: string | null; paidAt: string | null; reference: string | null; invoice: string }[] = []
  if (isReceipt) {
    const companyId = membership.company_id
    const { data: payments } = await supabase.from('payments').select('id, document_id, amount, payment_method, reference, paid_at')
      .eq('company_id', companyId).order('paid_at', { ascending: false }).limit(100)
    // Receipts of exactly these payments, voided ones excluded (M3, I7).
    const ids = (payments ?? []).map((p) => p.id as string)
    const { data: receipts } = ids.length
      ? await supabase.from('documents').select('metadata').eq('company_id', companyId).eq('document_type', 'receipt')
          .neq('status', 'cancelled').in('metadata->>payment_id', ids)
      : { data: [] as { metadata: unknown }[] }
    const withReceipt = new Set((receipts ?? []).map((r) => String((r.metadata as Record<string, unknown> | null)?.payment_id ?? '')))
    const pending = (payments ?? []).filter((p) => !withReceipt.has(p.id))
    const docIds = [...new Set(pending.map((p) => p.document_id))]
    const { data: docs } = docIds.length
      ? await supabase.from('documents').select('id, document_number, title').in('id', docIds)
      : { data: [] as { id: string; document_number: string | null; title: string | null }[] }
    const docName = new Map((docs ?? []).map((d) => [d.id, d.document_number || d.title || 'Factura']))
    receiptCandidates = pending.map((p) => ({
      id: p.id, amount: Number(p.amount ?? 0), method: p.payment_method, paidAt: p.paid_at, reference: p.reference,
      invoice: docName.get(p.document_id) ?? 'Factura',
    }))
  }

  const errorMessage: Record<string, string> = {
    required: 'Completa los campos obligatorios y añade al menos una partida.',
    price: 'La cantidad debe ser mayor que cero y el precio no puede ser negativo.',
    tax: 'Revisa el impuesto y el descuento.',
    client: 'No encontramos ese cliente en tu empresa.',
    invoice: 'Selecciona una factura pendiente válida para el recordatorio.',
    save: 'No se pudo guardar. Revisa los registros del servidor.',
    type: 'Ese tipo de documento no está permitido.',
    payment: 'Elige un pago válido de tu empresa para crear el recibo.',
    receipt_exists: 'Ese pago ya tiene su recibo.',
    receipt_payment_required: 'Elige un pago válido de tu empresa para crear el recibo.',
    receipt_amount_mismatch: 'El recibo debe ser por la cantidad exacta del pago.',
    forbidden: 'Tu rol no permite crear este documento.',
    billing: `${BILLING_ERROR_MESSAGE.billing} Ve a "Plan" para activarlo.`,
    limit_documents: `${BILLING_ERROR_MESSAGE.limit_documents} Ve a "Plan" para mejorarlo.`,
  }

  const fieldClass = 'field'

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Link href="/documents" className="text-sm font-semibold text-muted hover:text-fg">
        ← Volver a Documentos
      </Link>

      <header className="card-hero p-7 sm:p-10">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">BUSINESSAI · DOCUMENTOS</p>
        <h1 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">{unknownType ? 'Documento' : docTitle(selectedType)}</h1>
        <p className="mt-2 text-sm text-muted">
          {selectedType === 'receipt'
            ? 'Emite el recibo de un pago ya registrado.'
            : selectedType === 'quote'
            ? 'Prepara una propuesta comercial profesional con partidas y precios detallados.'
            : 'Crea y guarda documentos de tu empresa en un solo lugar.'}
        </p>
      </header>

      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[...validTypes.slice(0, 2), 'receipt', ...validTypes.slice(2)].map((item) => (
          <Link key={item} href={`/documents/new?type=${item}`}
            className={`rounded-xl border px-3 py-3 text-center text-sm font-semibold transition ${
              selectedType === item
                ? 'border-app-2 bg-app-2 text-accent shadow-sm'
                : 'border-line bg-card text-slate-300 hover:border-electric/40 hover:bg-electric/40'
            }`}>
            {docTitle(item)}
          </Link>
        ))}
      </nav>

      {documentNotice && (
        <div role={documentNotice.level === 'warning' ? 'status' : 'alert'}
          className={`p-4 font-medium ${documentNotice.level === 'warning' ? 'alert-warning' : 'alert-danger'}`}>
          {documentNotice.text}{' '}
          {documentNotice.offerUpgrade && <a href="/billing" className="underline">Mejorar plan</a>}
        </div>
      )}

      {error && errorMessage[error] && (
        <div role="alert" className="alert-danger p-4">
          {errorMessage[error]}
        </div>
      )}

      {unknownType ? (
        <section className="card p-8 text-center">
          <h2 className="font-display text-2xl font-semibold text-fg">Tipo de documento no válido</h2>
          <p className="mt-2 text-sm text-muted">El enlace no corresponde a ningún tipo de documento. Elige uno de los tipos de arriba.</p>
          <Link href="/documents" className="btn-primary mt-5">Ver documentos</Link>
        </section>
      ) : isReceipt ? (
        <section className="card space-y-5 p-6">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">Recibo de un pago</h2>
            <p className="mt-1 text-sm text-muted">
              Un recibo confirma un pago registrado. Elige el pago; el recibo toma su cantidad, fecha, método y referencia.
            </p>
          </div>
          {receiptCandidates.length === 0 ? (
            <div className="alert-info p-4">
              No hay pagos sin recibo. Registra un pago en una factura emitida y marca «Crear recibo».
              <Link href="/payments/new" className="mt-3 block font-bold underline">Registrar un pago</Link>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {receiptCandidates.map((p) => (
                <li key={p.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-fg">${p.amount.toFixed(2)} · {paymentMethodLabel(p.method)}</p>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {p.invoice}{p.paidAt ? ` · ${new Date(p.paidAt).toLocaleDateString('es-PR', { timeZone: 'America/Puerto_Rico' })}` : ''}
                      {p.reference ? ` · Ref. ${p.reference}` : ''}
                    </p>
                  </div>
                  <form action={createReceipt}>
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button type="submit" disabled={documentsBlocked} className="btn-primary btn-sm w-full sm:w-auto">Crear recibo</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
      <form action={createDocument} className="space-y-6">
        <input type="hidden" name="type" value={selectedType} />

        {selectedType === 'payment_reminder' ? (
          <section className="card space-y-5 p-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">Factura pendiente</h2>
            {invoiceList.length === 0 ? (
              <div className="alert-warning p-4">
                No hay facturas pendientes disponibles. Crea una factura primero para preparar un recordatorio.
                <Link href="/documents/new?type=invoice" className="mt-3 block font-bold underline">Crear factura</Link>
              </div>
            ) : (
              <>
                <label className="field-label">Selecciona la factura *
                  <select name="invoice_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                    <option value="" disabled>Seleccionar factura pendiente</option>
                    {invoiceList.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.document_number || invoice.title || 'Factura'} — balance ${invoice.balance.toFixed(2)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">Fecha del recordatorio
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">Mensaje *
                  <textarea name="notes" required rows={5} defaultValue="Le recordamos amablemente que tiene un pago pendiente. Si ya realizó el pago, puede ignorar este aviso. Gracias por su atención." className={`${fieldClass} mt-2`} />
                </label>
              </>
            )}
          </section>
        ) : selectedType === 'invoice' || selectedType === 'quote' ? (
          <>
            <section className="card space-y-5 p-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">Cliente y detalles</h2>
              <label className="field-label">Cliente *
                <select name="client_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                  <option value="" disabled>Selecciona un cliente</option>
                  {clientList.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.business_name || client.name || 'Cliente'}{client.email ? ` — ${client.email}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              {selectedType === 'quote' && (
                <label className="field-label">Título de la cotización *
                  <input name="title" required className={`${fieldClass} mt-2`} placeholder="Ej. Cotización para remodelación" />
                </label>
              )}

              <div className="grid gap-5 sm:grid-cols-2">
                <label className="field-label">Fecha de emisión
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">Válida hasta
                  <input name="due_date" type="date" className={`${fieldClass} mt-2`} />
                </label>
              </div>
            </section>

            <section className="card space-y-5 p-6">
              <div>
                <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                  {selectedType === 'quote' ? 'Partidas de la cotización' : 'Detalle de la factura'}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Añade materiales, piezas, mano de obra o servicios. Puedes usar hasta 30 partidas.
                </p>
              </div>

              <div className="space-y-4">
                {Array.from({ length: 3 }, (_, index) => index + 1).map((index) => (
                  <div key={index} className="grid gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm sm:grid-cols-6">
                    <label className="field-label sm:col-span-3">
                      {`Partida ${index} — descripción`}
                      <input
                        name={`item_description_${index}`}
                        required={index === 1}
                        className={`${fieldClass} mt-2`}
                        placeholder={index === 1 ? 'Ej. Materiales de construcción' : 'Material, pieza o servicio (opcional)'}
                      />
                    </label>
                    <label className="field-label">
                      Cantidad
                      <input name={`item_quantity_${index}`} type="number" min="0.01" step="0.01" defaultValue={index === 1 ? '1' : ''} required={index === 1} className={`${fieldClass} mt-2`} />
                    </label>
                    <label className="field-label sm:col-span-2">
                      Precio unitario ($)
                      <input name={`item_price_${index}`} type="number" min="0" step="0.01" defaultValue="" required={index === 1} className={`${fieldClass} mt-2`} placeholder="0.00" />
                    </label>
                  </div>
                ))}
                <details className="group rounded-2xl border border-dashed border-electric/50 bg-electric/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-fg">
                    <span>Añadir más partidas (hasta 30)</span>
                    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full border border-electric/40 text-blue-400 transition group-open:rotate-45">+</span>
                  </summary>
                  <div className="space-y-4 px-4 pb-4">
                {Array.from({ length: 27 }, (_, index) => index + 4).map((index) => (
                  <div key={index} className="grid gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm sm:grid-cols-6">
                    <label className="field-label sm:col-span-3">
                      {`Partida ${index} — descripción`}
                      <input
                        name={`item_description_${index}`}
                        required={index === 1}
                        className={`${fieldClass} mt-2`}
                        placeholder={index === 1 ? 'Ej. Materiales de construcción' : 'Material, pieza o servicio (opcional)'}
                      />
                    </label>
                    <label className="field-label">
                      Cantidad
                      <input name={`item_quantity_${index}`} type="number" min="0.01" step="0.01" defaultValue={index === 1 ? '1' : ''} required={index === 1} className={`${fieldClass} mt-2`} />
                    </label>
                    <label className="field-label sm:col-span-2">
                      Precio unitario ($)
                      <input name={`item_price_${index}`} type="number" min="0" step="0.01" defaultValue="" required={index === 1} className={`${fieldClass} mt-2`} placeholder="0.00" />
                    </label>
                  </div>
                ))}
                  </div>
                </details>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <label className="field-label">Descuento ($)
                  <input name="discount" type="number" min="0" step="0.01" defaultValue="0" className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">Impuesto (%)
                  <input name="tax_rate" type="number" min="0" step="0.01" defaultValue="0" className={`${fieldClass} mt-2`} />
                </label>
              </div>

              <label className="field-label">Notas, condiciones y términos
                <textarea name="notes" rows={4} className={`${fieldClass} mt-2`} placeholder="Vigencia, tiempo estimado, condiciones de pago y detalles adicionales." />
              </label>
            </section>
          </>
        ) : (
          <section className="card space-y-5 p-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">Información del documento</h2>
            <label className="field-label">Título *
              <input name="title" required className={`${fieldClass} mt-2`} placeholder={selectedType === 'letter' ? 'Ej. Carta comercial para cliente' : 'Ej. Reparación y mantenimiento'} />
            </label>
            <label className="field-label">Cliente (opcional)
              <select name="client_id" defaultValue="" className={`${fieldClass} mt-2`}>
                <option value="">Sin cliente específico</option>
                {clientList.map((client) => (
                  <option key={client.id} value={client.id}>{client.business_name || client.name || 'Cliente'}{client.email ? ` — ${client.email}` : ''}</option>
                ))}
              </select>
            </label>
            <label className="field-label">Fecha
              <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
            </label>
            {selectedType === 'work_order' && (
              <label className="field-label">Fecha límite (opcional)
                <input name="due_date" type="date" className={`${fieldClass} mt-2`} />
              </label>
            )}
            <label className="field-label">
              {selectedType === 'letter' ? 'Contenido de la carta *' : 'Descripción del trabajo *'}
              <textarea name="notes" required rows={8} className={`${fieldClass} mt-2`} placeholder={selectedType === 'letter' ? 'Escribe aquí el destinatario, el propósito y el contenido de la carta.' : 'Describe el trabajo solicitado, materiales, instrucciones y detalles importantes.'} />
            </label>
          </section>
        )}

        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-400">
            {selectedType === 'quote'
              ? 'La cotización se guardará como borrador para revisarla antes de enviarla al cliente.'
              : 'El documento se guardará en la empresa asociada a tu cuenta.'}
          </p>
          <button type="submit" disabled={documentsBlocked || (selectedType === 'payment_reminder' && invoiceList.length === 0)}
            className="btn-primary btn-lg">
            {documentsBlocked ? 'Límite del plan alcanzado' : `Guardar ${docTitle(selectedType)} →`}
          </button>
        </div>
      </form>
      )}
    </main>
  )
}

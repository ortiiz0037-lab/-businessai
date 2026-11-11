
import Link from 'next/link'
import { paidByDocument } from '@/lib/supabase/paged'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { billingErrorCode, billingErrorMessage } from '@/lib/billing/state'
import { fetchUsage, isBlocked, usageNotice } from '@/lib/billing/usage'
import { activeCompanyRow } from '@/lib/active-company'
import { computeTotals, parseItemsInput, type LineItem } from '@/lib/documents/items'
import { insertDocument } from '@/lib/documents/numbering'
import { todayIn } from '@/lib/documents/lifecycle'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { createReceipt } from '@/app/actions/documents'
import { documentTypeName } from '@/components/ui/status'
import { SubmitButton } from '@/components/submit-button'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

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

async function createDocument(formData: FormData) {
  'use server'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await activeCompanyRow(supabase, user.id)

  if (!membership?.company_id) redirect('/documents')

  const companyId = membership.company_id
  const type = text(formData, 'type')
  const locale = await getLocale()
  const tr = translator(locale)

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

    clientName = client.business_name?.trim() || client.name?.trim() || tr('Cliente', 'Client')

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

    clientName = client.business_name?.trim() || client.name?.trim() || tr('Cliente', 'Client')
    total = owed

    documentNotes = [
      `${tr('Factura relacionada', 'Related invoice')}: ${invoice.document_number || invoice.title || invoice.id}`,
      `${tr('Total de la factura', 'Invoice total')}: $${Number(invoice.total ?? 0).toFixed(2)}`,
      paidSoFar > 0 ? `${tr('Pagado', 'Paid')}: $${paidSoFar.toFixed(2)}` : null,
      `${tr('Balance pendiente', 'Open balance')}: $${owed.toFixed(2)}`,
      invoice.due_date ? `${tr('Fecha de vencimiento', 'Due date')}: ${invoice.due_date}` : null,
      '',
      notes || tr('Le recordamos amablemente que tiene un pago pendiente. Gracias por su atención.', 'This is a friendly reminder that you have a pending payment. Thank you.'),
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
      clientName = client.business_name?.trim() || client.name?.trim() || tr('Cliente', 'Client')
    }

    documentNotes = notes
  }

  // The database assigns the consecutive number (0015); see lib/documents/numbering.
  const { data: document, error } = await insertDocument(supabase, {
    company_id: companyId,
    created_by: user.id,
    document_type: type,
    title: type === 'invoice'
      ? `${tr('Factura', 'Invoice')} - ${clientName}`
      : type === 'quote'
        ? title.slice(0, 200)
        : type === 'payment_reminder'
          ? `${tr('Recordatorio de pago', 'Payment reminder')} - ${clientName}`
          : title.slice(0, 200),
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
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
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
    .neq('status', 'inactive')
    .order('name')
    .limit(1000)

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
  const documentNotice = usageNotice(usage.find((u) => u.metric === 'documents'), locale)
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
    const docName = new Map((docs ?? []).map((d) => [d.id, d.document_number || d.title || tr('Factura', 'Invoice')]))
    receiptCandidates = pending.map((p) => ({
      id: p.id, amount: Number(p.amount ?? 0), method: p.payment_method, paidAt: p.paid_at, reference: p.reference,
      invoice: docName.get(p.document_id) ?? tr('Factura', 'Invoice'),
    }))
  }

  const errorMessage: Record<string, string> = {
    required: tr('Completa los campos obligatorios y añade al menos una partida.', 'Fill in the required fields and add at least one line item.'),
    price: tr('La cantidad debe ser mayor que cero y el precio no puede ser negativo.', 'The quantity must be greater than zero and the price cannot be negative.'),
    tax: tr('Revisa el impuesto y el descuento.', 'Check the tax and the discount.'),
    client: tr('No encontramos ese cliente en tu empresa.', 'We could not find that client in your company.'),
    invoice: tr('Selecciona una factura emitida con balance pendiente para el recordatorio.', 'Choose an issued invoice with an open balance for the reminder.'),
    save: tr('No se pudo guardar. Inténtalo nuevamente.', 'It could not be saved. Please try again.'),
    type: tr('Ese tipo de documento no está permitido.', 'That document type is not allowed.'),
    payment: tr('Elige un pago válido de tu empresa para crear el recibo.', 'Choose a valid payment of your company to create the receipt.'),
    receipt_exists: tr('Ese pago ya tiene su recibo.', 'That payment already has its receipt.'),
    receipt_payment_required: tr('Elige un pago válido de tu empresa para crear el recibo.', 'Choose a valid payment of your company to create the receipt.'),
    receipt_amount_mismatch: tr('El recibo debe ser por la cantidad exacta del pago.', 'The receipt must be for the exact payment amount.'),
    receipt_client_mismatch: tr('El recibo debe ser para el cliente de la factura.', 'The receipt must be for the invoice\'s client.'),
    forbidden: tr('Tu rol no permite crear este documento.', 'Your role cannot create this document.'),
    billing: `${billingErrorMessage('billing', locale)} ${tr('Ve a "Plan" para activarlo.', 'Go to "Plan" to activate it.')}`,
    limit_documents: `${billingErrorMessage('limit_documents', locale)} ${tr('Ve a "Plan" para mejorarlo.', 'Go to "Plan" to upgrade.')}`,
  }

  const fieldClass = 'field'
  const clientOptions = clientList.map((client) => (
    <option key={client.id} value={client.id}>
      {client.business_name || client.name || tr('Cliente', 'Client')}{client.email ? ` — ${client.email}` : ''}
    </option>
  ))
  const itemRow = (index: number) => (
    <div key={index} className="grid gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm sm:grid-cols-6">
      <label className="field-label sm:col-span-3">
        {tr(`Partida ${index} — descripción`, `Item ${index} — description`)}
        <input name={`item_description_${index}`} required={index === 1} maxLength={500} className={`${fieldClass} mt-2`}
          placeholder={index === 1 ? tr('Ej. Materiales de construcción', 'e.g. Building materials') : tr('Material, pieza o servicio (opcional)', 'Material, part or service (optional)')} />
      </label>
      <label className="field-label">
        {tr('Cantidad', 'Quantity')}
        <input name={`item_quantity_${index}`} type="number" min="0.01" step="0.01" defaultValue={index === 1 ? '1' : ''} required={index === 1} className={`${fieldClass} mt-2`} />
      </label>
      <label className="field-label sm:col-span-2">
        {tr('Precio unitario ($)', 'Unit price ($)')}
        <input name={`item_price_${index}`} type="number" min="0" step="0.01" defaultValue="" required={index === 1} className={`${fieldClass} mt-2`} placeholder="0.00" />
      </label>
    </div>
  )

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Link href="/documents" className="text-sm font-semibold text-muted hover:text-fg">
        {tr('← Volver a Documentos', '← Back to Documents')}
      </Link>

      <header className="card-hero p-7 sm:p-10">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{tr('BUSINESSAI · DOCUMENTOS', 'BUSINESSAI · DOCUMENTS')}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">{unknownType ? tr('Documento', 'Document') : documentTypeName(selectedType, locale)}</h1>
        <p className="mt-2 text-sm text-muted">
          {selectedType === 'receipt'
            ? tr('Emite el recibo de un pago ya registrado.', 'Issue the receipt of a recorded payment.')
            : selectedType === 'quote'
            ? tr('Prepara una propuesta comercial profesional con partidas y precios detallados.', 'Prepare a professional proposal with detailed items and prices.')
            : tr('Crea y guarda documentos de tu empresa en un solo lugar.', 'Create and keep your company\'s documents in one place.')}
        </p>
      </header>

      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label={tr('Tipo de documento', 'Document type')}>
        {[...validTypes.slice(0, 2), 'receipt', ...validTypes.slice(2)].map((item) => (
          <Link key={item} href={`/documents/new?type=${item}`} aria-current={selectedType === item ? 'page' : undefined}
            className={`rounded-xl border px-3 py-3 text-center text-sm font-semibold transition ${
              selectedType === item
                ? 'border-app-2 bg-app-2 text-accent shadow-sm'
                : 'border-line bg-card text-slate-300 hover:border-electric/40 hover:bg-electric/40'
            }`}>
            {documentTypeName(item, locale)}
          </Link>
        ))}
      </nav>

      {documentNotice && (
        <div role={documentNotice.level === 'warning' ? 'status' : 'alert'}
          className={`p-4 font-medium ${documentNotice.level === 'warning' ? 'alert-warning' : 'alert-danger'}`}>
          {documentNotice.text}{' '}
          {documentNotice.offerUpgrade && <a href="/billing" className="underline">{tr('Mejorar plan', 'Upgrade plan')}</a>}
        </div>
      )}

      {error && (
        <div role="alert" className="alert-danger p-4">
          {errorMessage[error] ?? errorMessage.save}
        </div>
      )}

      {unknownType ? (
        <section className="card p-8 text-center">
          <h2 className="font-display text-2xl font-semibold text-fg">{tr('Tipo de documento no válido', 'Invalid document type')}</h2>
          <p className="mt-2 text-sm text-muted">{tr('El enlace no corresponde a ningún tipo de documento. Elige uno de los tipos de arriba.', 'The link does not match any document type. Choose one of the types above.')}</p>
          <Link href="/documents" className="btn-primary mt-5">{tr('Ver documentos', 'View documents')}</Link>
        </section>
      ) : isReceipt ? (
        <section className="card space-y-5 p-6">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">{tr('Recibo de un pago', 'Receipt of a payment')}</h2>
            <p className="mt-1 text-sm text-muted">
              {tr('Un recibo confirma un pago registrado. Elige el pago; el recibo toma su cantidad, fecha, método y referencia.',
                'A receipt confirms a recorded payment. Choose the payment; the receipt takes its amount, date, method and reference.')}
            </p>
          </div>
          {receiptCandidates.length === 0 ? (
            <div className="alert-info p-4">
              {tr('No hay pagos sin recibo. Registra un pago en una factura emitida y marca «Crear recibo».', 'There are no payments without a receipt. Record a payment on an issued invoice and tick "Create receipt".')}
              <Link href="/payments/new" className="mt-3 block font-bold underline">{tr('Registrar un pago', 'Record a payment')}</Link>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {receiptCandidates.map((p) => (
                <li key={p.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-fg">{f.money(p.amount)} · {paymentMethodLabel(p.method, locale)}</p>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {p.invoice}{p.paidAt ? ` · ${f.date(p.paidAt)}` : ''}
                      {p.reference ? ` · Ref. ${p.reference}` : ''}
                    </p>
                  </div>
                  <form action={createReceipt}>
                    <input type="hidden" name="payment_id" value={p.id} />
                    <SubmitButton pendingLabel={tr('Creando…', 'Creating…')} className="w-full sm:w-auto">{tr('Crear recibo', 'Create receipt')}</SubmitButton>
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
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">{tr('Factura pendiente', 'Open invoice')}</h2>
            {invoiceList.length === 0 ? (
              <div className="alert-warning p-4">
                {tr('No hay facturas emitidas con balance pendiente. Emite una factura primero para preparar un recordatorio.',
                  'There are no issued invoices with an open balance. Issue an invoice first to prepare a reminder.')}
                <Link href="/documents/new?type=invoice" className="mt-3 block font-bold underline">{tr('Crear factura', 'Create invoice')}</Link>
              </div>
            ) : (
              <>
                <label className="field-label">{tr('Selecciona la factura *', 'Choose the invoice *')}
                  <select name="invoice_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                    <option value="" disabled>{tr('Seleccionar factura pendiente', 'Select an open invoice')}</option>
                    {invoiceList.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.document_number || invoice.title || tr('Factura', 'Invoice')} — {tr('balance', 'balance')} {f.money(invoice.balance)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">{tr('Fecha del recordatorio', 'Reminder date')}
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">{tr('Mensaje *', 'Message *')}
                  <textarea name="notes" required rows={5} maxLength={5000} className={`${fieldClass} mt-2`}
                    defaultValue={tr('Le recordamos amablemente que tiene un pago pendiente. Si ya realizó el pago, puede ignorar este aviso. Gracias por su atención.',
                      'This is a friendly reminder that you have a pending payment. If you have already paid, please disregard this notice. Thank you.')} />
                </label>
              </>
            )}
          </section>
        ) : selectedType === 'invoice' || selectedType === 'quote' ? (
          <>
            <section className="card space-y-5 p-6">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">{tr('Cliente y detalles', 'Client and details')}</h2>
              <label className="field-label">{tr('Cliente *', 'Client *')}
                <select name="client_id" required defaultValue="" className={`${fieldClass} mt-2`}>
                  <option value="" disabled>{tr('Selecciona un cliente', 'Choose a client')}</option>
                  {clientOptions}
                </select>
              </label>

              {selectedType === 'quote' && (
                <label className="field-label">{tr('Título de la cotización *', 'Quote title *')}
                  <input name="title" required maxLength={200} className={`${fieldClass} mt-2`} placeholder={tr('Ej. Cotización para remodelación', 'e.g. Remodeling quote')} />
                </label>
              )}

              <div className="grid gap-5 sm:grid-cols-2">
                <label className="field-label">{tr('Fecha de emisión', 'Issue date')}
                  <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">{selectedType === 'quote' ? tr('Válida hasta', 'Valid until') : tr('Fecha de vencimiento', 'Due date')}
                  <input name="due_date" type="date" className={`${fieldClass} mt-2`} />
                </label>
              </div>
            </section>

            <section className="card space-y-5 p-6">
              <div>
                <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                  {selectedType === 'quote' ? tr('Partidas de la cotización', 'Quote items') : tr('Detalle de la factura', 'Invoice items')}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {tr('Añade materiales, piezas, mano de obra o servicios. Puedes usar hasta 30 partidas.', 'Add materials, parts, labor or services. You can use up to 30 items.')}
                </p>
              </div>

              <div className="space-y-4">
                {Array.from({ length: 3 }, (_, index) => index + 1).map(itemRow)}
                <details className="group rounded-2xl border border-dashed border-electric/50 bg-electric/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-fg">
                    <span>{tr('Añadir más partidas (hasta 30)', 'Add more items (up to 30)')}</span>
                    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full border border-electric/40 text-blue-400 transition group-open:rotate-45">+</span>
                  </summary>
                  <div className="space-y-4 px-4 pb-4">
                    {Array.from({ length: 27 }, (_, index) => index + 4).map(itemRow)}
                  </div>
                </details>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <label className="field-label">{tr('Descuento ($)', 'Discount ($)')}
                  <input name="discount" type="number" min="0" step="0.01" defaultValue="0" className={`${fieldClass} mt-2`} />
                </label>
                <label className="field-label">{tr('Impuesto (%)', 'Tax (%)')}
                  <input name="tax_rate" type="number" min="0" max="100" step="0.01" defaultValue="0" className={`${fieldClass} mt-2`} />
                </label>
              </div>

              <label className="field-label">{tr('Notas, condiciones y términos', 'Notes, conditions and terms')}
                <textarea name="notes" rows={4} maxLength={5000} className={`${fieldClass} mt-2`}
                  placeholder={tr('Vigencia, tiempo estimado, condiciones de pago y detalles adicionales.', 'Validity, estimated time, payment conditions and other details.')} />
              </label>
            </section>
          </>
        ) : (
          <section className="card space-y-5 p-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">{tr('Información del documento', 'Document information')}</h2>
            <label className="field-label">{tr('Título *', 'Title *')}
              <input name="title" required maxLength={200} className={`${fieldClass} mt-2`}
                placeholder={selectedType === 'letter' ? tr('Ej. Carta comercial para cliente', 'e.g. Business letter to a client') : tr('Ej. Reparación y mantenimiento', 'e.g. Repair and maintenance')} />
            </label>
            <label className="field-label">{tr('Cliente (opcional)', 'Client (optional)')}
              <select name="client_id" defaultValue="" className={`${fieldClass} mt-2`}>
                <option value="">{tr('Sin cliente específico', 'No specific client')}</option>
                {clientOptions}
              </select>
            </label>
            <label className="field-label">{tr('Fecha', 'Date')}
              <input name="issue_date" type="date" defaultValue={today()} className={`${fieldClass} mt-2`} />
            </label>
            {selectedType === 'work_order' && (
              <label className="field-label">{tr('Fecha límite (opcional)', 'Deadline (optional)')}
                <input name="due_date" type="date" className={`${fieldClass} mt-2`} />
              </label>
            )}
            <label className="field-label">
              {selectedType === 'letter' ? tr('Contenido de la carta *', 'Letter content *') : tr('Descripción del trabajo *', 'Job description *')}
              <textarea name="notes" required rows={8} maxLength={10000} className={`${fieldClass} mt-2`}
                placeholder={selectedType === 'letter'
                  ? tr('Escribe aquí el destinatario, el propósito y el contenido de la carta.', 'Write the recipient, purpose and content of the letter here.')
                  : tr('Describe el trabajo solicitado, materiales, instrucciones y detalles importantes.', 'Describe the requested work, materials, instructions and important details.')} />
            </label>
          </section>
        )}

        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white/[0.03] p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-400">
            {tr('El documento se guardará como borrador para revisarlo antes de emitirlo.', 'The document is saved as a draft so you can review it before issuing it.')}
          </p>
          {documentsBlocked || (selectedType === 'payment_reminder' && invoiceList.length === 0) ? (
            <button type="button" disabled className="btn-primary btn-lg">
              {documentsBlocked ? tr('Límite del plan alcanzado', 'Plan limit reached') : tr('Guardar', 'Save')}
            </button>
          ) : (
            <SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="sm:w-auto">
              {tr(`Guardar ${documentTypeName(selectedType, 'es').toLowerCase()} →`, `Save ${documentTypeName(selectedType, 'en').toLowerCase()} →`)}
            </SubmitButton>
          )}
        </div>
      </form>
      )}
    </main>
  )
}

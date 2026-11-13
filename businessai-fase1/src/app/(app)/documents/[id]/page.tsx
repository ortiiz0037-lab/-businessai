import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PrintButton from '@/components/PrintButton'
import { StatusBadge } from '@/components/ui/status'
import { getSignatureDisplayUrl } from '@/lib/branding-assets'
import { documentItems } from '@/lib/documents/items'
import { balanceOf, documentActions, effectiveStatus, todayIn, type Role } from '@/lib/documents/lifecycle'
import { activePayments, PAYMENT_METHODS, paymentErrorMessage, paymentMethodLabel } from '@/lib/documents/payments'
import { billingErrorMessage } from '@/lib/billing/state'
import { intlTag, type Locale } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator, type Tr } from '@/lib/i18n/t'
import { createReceipt, deleteDraft, registerPayment, setDocumentStatus, voidDocument } from '@/app/actions/documents'
import { DepositAccountField } from '@/components/deposit-account-field'
import { lifecycleAvailable, newIdempotencyKey } from '@/lib/documents/capabilities'
import { SubmitButton } from '@/components/submit-button'

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
  items?: unknown
  metadata?: Record<string, unknown> | null
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
  signature_url?: string | null
  payment_info?: string | null
}

type PaymentRow = {
  id: string
  amount: number | string
  payment_method: string | null
  reference: string | null
  paid_at: string | null
  voided_at?: string | null
  void_reason?: string | null
}

function money(value: number | string | null | undefined) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value ?? 0))
}

function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(intlTag(locale), { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function formatTimestamp(value: string | null | undefined, locale: Locale) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(intlTag(locale), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Puerto_Rico' }).format(date)
}

function documentType(value: string | null | undefined, tr: Tr) {
  const types: Record<string, string> = {
    invoice: tr('Factura', 'Invoice'),
    factura: tr('Factura', 'Invoice'),
    quote: tr('Cotización', 'Quote'),
    quotation: tr('Cotización', 'Quote'),
    receipt: tr('Recibo', 'Receipt'),
    recibo: tr('Recibo', 'Receipt'),
    work_order: tr('Orden de trabajo', 'Work order'),
    'orden de trabajo': tr('Orden de trabajo', 'Work order'),
    letter: tr('Carta comercial', 'Business letter'),
    reminder: tr('Recordatorio de pago', 'Payment reminder'),
    payment_reminder: tr('Recordatorio de pago', 'Payment reminder'),
    contract: tr('Contrato / plantilla', 'Contract / template'),
    report: tr('Reporte', 'Report'),
  }
  return types[value ?? ''] ?? value ?? tr('Documento', 'Document')
}

const doneMessages = (tr: Tr): Record<string, string> => ({
  sent: tr('Documento marcado como enviado.', 'Document marked as sent.'),
  accepted: tr('Cotización marcada como aceptada.', 'Quote marked as accepted.'),
  rejected: tr('Cotización marcada como rechazada.', 'Quote marked as rejected.'),
  cancelled: tr('Documento anulado. Se conserva en el historial con el motivo.', 'Document voided. It is kept in the history with the reason.'),
  payment: tr('Pago registrado.', 'Payment recorded.'),
  receipt: tr('Recibo creado.', 'Receipt created.'),
})

const actionErrors = (tr: Tr): Record<string, string> => ({
  transition: tr('Esa acción no está disponible para este documento.', 'That action is not available for this document.'),
  changed: tr('El documento cambió mientras tanto. Revisa su estado e inténtalo de nuevo.', 'The document changed in the meantime. Check its status and try again.'),
  forbidden: tr('Solo el propietario o un administrador de la empresa puede hacer esto.', 'Only the company owner or an admin can do this.'),
  confirm: tr('Marca la casilla de confirmación para eliminar el borrador.', 'Tick the confirmation box to delete the draft.'),
  issued: tr('Un documento emitido no se elimina: anúlalo para conservar la trazabilidad.', 'An issued document is not deleted: void it to keep the record.'),
  document_issued: tr('Un documento emitido no se modifica ni se elimina: anúlalo para conservar la trazabilidad.', 'An issued document cannot be changed or deleted: void it to keep the record.'),
  document_cancelled: tr('Un documento anulado no se puede reabrir.', 'A voided document cannot be reopened.'),
  document_void_forbidden: tr('Solo el propietario o un administrador puede anular documentos.', 'Only the owner or an admin can void documents.'),
  void_reason: tr('Escribe el motivo de la anulación (entre 3 y 300 caracteres).', 'Write the reason for voiding (3 to 300 characters).'),
  void_has_payments: tr('Esta factura tiene pagos registrados: no se puede anular. Los pagos se conservan como historial.', 'This invoice has recorded payments: it cannot be voided. Payments are kept as history.'),
  document_has_payments: tr('Esta factura tiene pagos registrados: no se puede anular. Los pagos se conservan como historial.', 'This invoice has recorded payments: it cannot be voided. Payments are kept as history.'),
  void_reason_required: tr('Escribe el motivo de la anulación (entre 3 y 300 caracteres).', 'Write the reason for voiding (3 to 300 characters).'),
  document_transition: tr('Ese cambio de estado no está permitido para este tipo de documento.', 'That status change is not allowed for this document type.'),
  document_not_paid: tr('La factura solo pasa a pagada cuando los pagos cubren el total.', 'An invoice is paid only when payments cover the total.'),
  document_field_locked: tr('El número y el tipo de un documento no se cambian.', 'A document\'s number and type cannot be changed.'),
  company_immutable: tr('Un documento no se puede mover a otra empresa.', 'A document cannot be moved to another company.'),
  receipt_client_mismatch: tr('El recibo debe ser para el cliente de la factura.', 'The receipt must be for the invoice\'s client.'),
  receipt_exists: tr('Ese pago ya tiene un recibo vigente.', 'That payment already has a valid receipt.'),
  receipt_amount_mismatch: tr('El recibo debe ser por la cantidad exacta del pago.', 'The receipt must be for the exact payment amount.'),
  receipt_payment_required: tr('El recibo necesita un pago válido de tu empresa.', 'The receipt needs a valid payment of your company.'),
  audit: tr('No se pudo registrar el historial del borrador; no se eliminó nada. Inténtalo nuevamente.', 'The draft history could not be recorded; nothing was deleted. Please try again.'),
  save: tr('No se pudo completar la acción. Inténtalo nuevamente.', 'The action could not be completed. Please try again.'),
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function DocumentUnavailable({ title, message, tr }: { title: string; message: string; tr: Tr }) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <div className="rounded-3xl border border-danger/40 bg-danger/10 p-8 text-center">
        <div className="text-4xl">⚠️</div>
        <h1 className="mt-4 text-2xl font-bold text-fg">{title}</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/documents" className="btn-primary">{tr('← Volver a Documentos', '← Back to Documents')}</Link>
          <Link href="/payments" className="btn-secondary">{tr('Ir a Pagos', 'Go to Payments')}</Link>
        </div>
      </div>
    </main>
  )
}

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ done?: string; actionError?: string; paymentError?: string; receiptError?: string }>
}) {
  const { id } = await params
  const query = searchParams ? await searchParams : undefined
  const locale = await getLocale()
  const tr = translator(locale)
  const DONE_MESSAGE = doneMessages(tr)
  const ACTION_ERROR = actionErrors(tr)
  const billingText = (code: string | undefined) => (code ? billingErrorMessage(code, locale) : null)

  // Broken links (e.g. /documents/null from a payment without document) are
  // detected before querying, so they are not mistaken for a database error.
  if (!UUID_RE.test(id)) {
    console.warn('DOCUMENT_LOOKUP_INVALID_ID', { id })
    return (
      <DocumentUnavailable
        tr={tr}
        title={tr('Documento no encontrado', 'Document not found')}
        message={tr('El enlace no corresponde a un documento válido. Es posible que el pago no esté vinculado a ningún documento.', 'The link does not match a valid document. The payment may not be linked to any document.')}
      />
    )
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // The document decides the company. RLS limits rows to the user's
  // companies; an explicit membership is also required below.
  const { data: document, error } = await supabase.from('documents').select('*').eq('id', id).maybeSingle()

  if (error) {
    console.error('DOCUMENT_LOOKUP_ERROR', { id, code: error.code, message: error.message })
    return (
      <DocumentUnavailable
        tr={tr}
        title={tr('No se pudo cargar el documento', 'The document could not be loaded')}
        message={tr('Ocurrió un error al consultar el documento. Inténtalo nuevamente en unos minutos.', 'An error occurred while loading the document. Please try again in a few minutes.')}
      />
    )
  }

  if (!document) {
    return (
      <DocumentUnavailable
        tr={tr}
        title={tr('Documento no encontrado', 'Document not found')}
        message={tr('No pudimos encontrar este documento o no tienes acceso a él. Puede que haya sido eliminado.', 'We could not find this document or you do not have access to it. It may have been deleted.')}
      />
    )
  }

  const { data: membership, error: membershipError } = await supabase
    .from('memberships')
    .select('company_id, role')
    .eq('user_id', user.id)
    .eq('company_id', document.company_id)
    .maybeSingle()

  if (membershipError || !membership?.company_id) {
    return (
      <DocumentUnavailable tr={tr} title={tr('Documento no encontrado', 'Document not found')} message={tr('No pudimos encontrar este documento o no tienes acceso a él.', 'We could not find this document or you do not have access to it.')} />
    )
  }

  const companyId: string = membership.company_id
  const role = membership.role as Role
  const doc = document as DocumentRow
  const meta = (doc.metadata ?? {}) as Record<string, unknown>

  const isLetter = doc.document_type === 'letter'
  const isWorkOrder = doc.document_type === 'work_order'
  const isReminder = doc.document_type === 'payment_reminder' || doc.document_type === 'reminder'
  const isInvoice = doc.document_type === 'invoice' || doc.document_type === 'factura'
  const isQuote = doc.document_type === 'quote' || doc.document_type === 'quotation'
  const isReceipt = doc.document_type === 'receipt'

  const [{ data: client }, { data: company }, { data: paymentRows }] = await Promise.all([
    doc.client_id
      ? supabase.from('clients').select('*').eq('id', doc.client_id).eq('company_id', companyId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('company_profiles').select('*').eq('company_id', companyId).maybeSingle(),
    isInvoice
      ? supabase.from('payments').select('*')
          .eq('document_id', id).order('paid_at', { ascending: true })
      : Promise.resolve({ data: [] as PaymentRow[] }),
  ])

  const clientData = client as ClientRow | null
  const companyData = company as CompanyRow | null
  const payments = (paymentRows ?? []) as PaymentRow[]

  // Receipts already issued for these payments.
  const receiptByPayment = new Map<string, { id: string; number: string | null }>()
  if (payments.length) {
    const { data: receipts } = await supabase
      .from('documents').select('id, document_number, metadata')
      .eq('company_id', companyId).eq('document_type', 'receipt').neq('status', 'cancelled')
      .in('metadata->>payment_id', payments.map((p) => p.id))
    for (const r of receipts ?? []) {
      const pid = String((r.metadata as Record<string, unknown> | null)?.payment_id ?? '')
      if (pid) receiptByPayment.set(pid, { id: r.id, number: r.document_number })
    }
  }

  // Receipt: the invoice it belongs to.
  const receiptInvoiceId = isReceipt && typeof meta.invoice_id === 'string' && UUID_RE.test(meta.invoice_id) ? meta.invoice_id : null

  const signature = await getSignatureDisplayUrl(supabase, companyData?.signature_url, companyId)

  const today = todayIn()
  const paid = Math.round(activePayments(payments).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100
  const lifecycle = { document_type: doc.document_type ?? null, status: doc.status ?? null, total: doc.total ?? 0, due_date: doc.due_date ?? null }
  const shownStatus = effectiveStatus(lifecycle, paid, today)
  const actions = documentActions(lifecycle, paid, today, role, await lifecycleAvailable())
  const balance = balanceOf(lifecycle, paid)
  const voidInfo = (meta.void ?? null) as { reason?: string; voided_at?: string } | null

  const subtotal = Number(doc.subtotal ?? 0)
  const tax = Number(doc.tax ?? 0)
  const total = doc.total !== null && doc.total !== undefined ? Number(doc.total) : subtotal + tax
  const primaryColor = companyData?.primary_color || '#0f172a'
  // The document itself is shown in its own language (0019); older documents
  // without one follow the reader's language.
  const docLocale: 'es' | 'en' = (doc as { language?: string | null }).language === 'en' ? 'en'
    : (doc as { language?: string | null }).language === 'es' ? 'es' : locale
  const dt = translator(docLocale)
  const lines = documentItems({ items: doc.items, metadata: doc.metadata, notes: doc.notes })

  const errorText =
    (query?.actionError && (ACTION_ERROR[query.actionError] ?? billingText(query.actionError) ?? ACTION_ERROR.save)) ||
    (query?.paymentError && (paymentErrorMessage(query.paymentError, locale) ?? billingText(query.paymentError) ?? paymentErrorMessage('save', locale))) ||
    null

  return (
    <div>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/documents" className="text-sm font-semibold text-muted transition hover:text-fg">
              {tr('← Volver a Documentos', '← Back to Documents')}
            </Link>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-fg">
              {documentType(doc.document_type, tr)} {doc.document_number ? <span className="text-muted">· {doc.document_number}</span> : null}
            </h1>
            <p className="mt-1 text-sm text-muted">{tr('Revisa la información antes de enviarla al cliente.', 'Review the information before sending it to the client.')}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={shownStatus} locale={locale} />
            <PrintButton />
            {['invoice', 'quote', 'receipt', 'work_order'].includes(doc.document_type ?? '') && (
              <Link href={`/studio/new?source=${doc.id}&template=sys:${({ invoice: 'invoice_classic', quote: 'quote_classic', receipt: 'receipt_classic', work_order: 'work_order' } as Record<string, string>)[doc.document_type ?? '']}`}
                className="print:hidden rounded-xl border border-line bg-card px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.03]">{tr('Diseñar en Document Studio', 'Design in Document Studio')}</Link>
            )}
          </div>
        </div>

        {query?.done && DONE_MESSAGE[query.done] && (
          <div role="status" className="alert-success mb-5 p-4">
            {DONE_MESSAGE[query.done]}
            {query.receiptError && ` ${tr('El recibo no se pudo crear:', 'The receipt could not be created:')} ${ACTION_ERROR[query.receiptError] ?? billingText(query.receiptError) ?? tr('inténtalo desde la lista de pagos.', 'try again from the payment list.')}`}
          </div>
        )}

        {errorText && (
          <div role="alert" className="alert-danger mb-5 p-4">{errorText}</div>
        )}

        {shownStatus === 'cancelled' && (
          <div role="status" className="alert-warning mb-5 p-4">
            {tr('Documento anulado', 'Document voided')}{voidInfo?.voided_at ? ` ${tr('el', 'on')} ${formatTimestamp(voidInfo.voided_at, locale)}` : ''}.
            {voidInfo?.reason ? ` ${tr('Motivo', 'Reason')}: ${voidInfo.reason}` : ''} {tr('Se conserva en el historial y no se puede reabrir.', 'It is kept in the history and cannot be reopened.')}
          </div>
        )}

        {/* Actions: only what this document and this role allow (re-checked on the server). */}
        {(actions.send || actions.accept || actions.reject || actions.void || actions.delete) && (
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-start">
            {actions.send && (
              <form action={setDocumentStatus}>
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="status" value="sent" />
                <button type="submit" className="btn-accent btn-sm w-full sm:w-auto">
                  {isQuote ? tr('Marcar cotización como enviada', 'Mark quote as sent') : tr('Marcar como enviada', 'Mark as sent')}
                </button>
              </form>
            )}
            {actions.accept && (
              <form action={setDocumentStatus}>
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="status" value="accepted" />
                <button type="submit" className="btn-primary btn-sm w-full sm:w-auto">{tr('Cliente la aceptó', 'Client accepted')}</button>
              </form>
            )}
            {actions.reject && (
              <form action={setDocumentStatus}>
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="status" value="rejected" />
                <button type="submit" className="btn-secondary btn-sm w-full sm:w-auto">{tr('Cliente la rechazó', 'Client rejected')}</button>
              </form>
            )}
            {actions.void && (
              <details className="card w-full p-4 lg:max-w-md">
                <summary className="cursor-pointer text-sm font-semibold text-fg">{tr('Anular documento', 'Void document')}</summary>
                <form action={voidDocument} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={doc.id} />
                  <p className="text-xs text-muted">
                    {tr('El documento queda anulado y se conserva en el historial con su número. No se puede reabrir.', 'The document is voided and kept in the history with its number. It cannot be reopened.')}
                  </p>
                  <label className="field-label">{tr('Motivo *', 'Reason *')}
                    <input name="reason" required minLength={3} maxLength={300} className="field mt-2" placeholder={tr('Ej. Emitida con datos incorrectos', 'e.g. Issued with wrong details')} />
                  </label>
                  <button type="submit" className="btn-danger btn-sm w-full sm:w-auto">{tr('Anular', 'Void')}</button>
                </form>
              </details>
            )}
            {actions.delete && (
              <form action={deleteDraft} className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/40 bg-card px-3 py-2">
                <input type="hidden" name="id" value={doc.id} />
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" name="confirm_delete" value="yes" required className="h-4 w-4 accent-red-600" />
                  {tr('Confirmo eliminar este borrador', 'I confirm deleting this draft')}
                </label>
                <button type="submit" className="btn-danger btn-sm">{tr('Eliminar borrador', 'Delete draft')}</button>
              </form>
            )}
          </div>
        )}

        {/* Invoice: balance, payment form and payment history (not printed). */}
        {isInvoice && (
          <section className="card mb-6 p-5 sm:p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">Total</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-fg">{money(total)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">{tr('Pagado', 'Paid')}</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-success">{money(paid)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">{tr('Balance pendiente', 'Open balance')}</p>
                <p className={`mt-1 text-xl font-bold tabular-nums ${balance > 0 ? 'text-warning' : 'text-fg'}`}>{money(balance)}</p>
              </div>
            </div>

            {actions.recordPayment && (
              <form action={registerPayment} className="mt-6 space-y-4 border-t border-line pt-5">
                <input type="hidden" name="document_id" value={doc.id} />
                <input type="hidden" name="idempotency_key" value={newIdempotencyKey()} />
                <h2 className="font-display text-lg font-semibold text-fg">{tr('Registrar pago', 'Record payment')}</h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="field-label">{tr('Cantidad *', 'Amount *')}
                    <input name="amount" required inputMode="decimal" defaultValue={balance.toFixed(2)} className="field mt-2" />
                  </label>
                  <label className="field-label">{tr('Método *', 'Method *')}
                    <select name="method" required defaultValue="" className="field mt-2">
                      <option value="" disabled>{tr('Seleccionar', 'Select')}</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m, locale)}</option>)}
                    </select>
                  </label>
                  <label className="field-label">{tr('Fecha *', 'Date *')}
                    <input name="date" type="date" required defaultValue={today} max={today} min={doc.issue_date ?? undefined} className="field mt-2" />
                  </label>
                  <label className="field-label">{tr('Referencia', 'Reference')}
                    <input name="reference" maxLength={120} className="field mt-2" placeholder={tr('Nº de cheque, confirmación…', 'Check no., confirmation…')} />
                  </label>
                  <DepositAccountField supabase={supabase} companyId={companyId} tr={tr} />
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" name="create_receipt" defaultChecked className="h-4 w-4 accent-blue-600" />
                    {tr('Crear el recibo de este pago', 'Create the receipt for this payment')}
                  </label>
                  <SubmitButton pendingLabel={tr('Registrando…', 'Recording…')} className="w-full sm:w-auto">{tr('Registrar pago', 'Record payment')}</SubmitButton>
                </div>
                <p className="text-xs text-muted">{tr('Pagos parciales permitidos hasta el balance pendiente. Los pagos registrados no se editan ni se borran.', 'Partial payments are allowed up to the open balance. Recorded payments are never edited or deleted.')}</p>
              </form>
            )}

            <div className="mt-6 border-t border-line pt-5">
              <h2 className="font-display text-lg font-semibold text-fg">{tr('Historial de pagos', 'Payment history')}</h2>
              {payments.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{tr('Todavía no hay pagos registrados.', 'No payments recorded yet.')}</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {payments.map((p) => {
                    const receipt = receiptByPayment.get(p.id)
                    if (p.voided_at) return (
                      <li key={p.id} className="py-3 opacity-70">
                        <p className="font-semibold tabular-nums text-muted line-through">{money(p.amount)} · {paymentMethodLabel(p.payment_method, locale)}</p>
                        <p className="text-xs text-red-300">{tr('Pago anulado', 'Payment voided')} · {formatTimestamp(p.voided_at, locale)}{p.void_reason ? ` · ${p.void_reason}` : ''}</p>
                      </li>
                    )
                    return (
                      <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-semibold tabular-nums text-fg">{money(p.amount)} · {paymentMethodLabel(p.payment_method, locale)}</p>
                          <p className="truncate text-xs text-muted">
                            {formatTimestamp(p.paid_at, locale)}{p.reference ? ` · Ref. ${p.reference}` : ''}
                          </p>
                        </div>
                        {receipt ? (
                          <Link href={`/documents/${receipt.id}`} className="btn-secondary btn-sm">{tr('Ver recibo', 'View receipt')} {receipt.number ?? ''}</Link>
                        ) : (
                          <form action={createReceipt}>
                            <input type="hidden" name="payment_id" value={p.id} />
                            <SubmitButton variant="primary" pendingLabel={tr('Creando…', 'Creating…')} className="w-full sm:w-auto">{tr('Crear recibo', 'Create receipt')}</SubmitButton>
                          </form>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>
        )}

        {isReceipt && receiptInvoiceId && (
          <div className="mb-5">
            <Link href={`/documents/${receiptInvoiceId}`} className="btn-secondary btn-sm">{tr('Ver la factura de este pago', 'View the invoice of this payment')}</Link>
          </div>
        )}

        <article className="overflow-hidden rounded-3xl bg-white text-slate-900 shadow-lift ring-1 ring-slate-200">
          <header className="px-6 py-8 text-white sm:px-10" style={{ backgroundColor: primaryColor }}>
            <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
              <div>
                {companyData?.logo_url ? (
                  <img src={companyData.logo_url} alt={dt('Logo de la empresa', 'Company logo')} className="mb-5 h-16 max-w-[220px] object-contain object-left" />
                ) : (
                  <div className="mb-5 inline-flex h-12 items-center rounded-xl bg-white/10 px-4 text-sm font-bold tracking-wide">BUSINESSAI</div>
                )}
                <h2 className="text-2xl font-bold">{companyData?.display_name || companyData?.legal_name || dt('Tu empresa', 'Your company')}</h2>
                {companyData?.legal_name && companyData.display_name !== companyData.legal_name && (
                  <p className="mt-1 text-sm text-white/70">{companyData.legal_name}</p>
                )}
                <div className="mt-4 space-y-1 text-sm text-white/75">
                  {companyData?.address && <p>{companyData.address}</p>}
                  {(companyData?.city || companyData?.state || companyData?.postal_code) && (
                    <p>{[companyData.city, companyData.state, companyData.postal_code].filter(Boolean).join(', ')}</p>
                  )}
                  {companyData?.phone && <p>{companyData.phone}</p>}
                  {companyData?.email && <p>{companyData.email}</p>}
                </div>
              </div>

              <div className="sm:text-right">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">{documentType(doc.document_type, tr)}</p>
                <p className="mt-2 text-2xl font-bold">{doc.document_number || dt('Documento', 'Document')}</p>
                {shownStatus === 'cancelled' && (
                  <p className="mt-2 inline-block rounded-md border border-white/60 px-2 py-0.5 text-xs font-bold uppercase tracking-widest">{dt('Anulado', 'Voided')}</p>
                )}
                <div className="mt-5 space-y-1 text-sm text-white/75">
                  <p>{dt('Fecha', 'Date')}: <span className="font-semibold text-white">{formatDate(doc.issue_date, docLocale)}</span></p>
                  {doc.due_date && (
                    <p>
                      {isQuote ? dt('Válida hasta', 'Valid until') : dt('Vencimiento', 'Due')}:{' '}
                      <span className="font-semibold text-white">{formatDate(doc.due_date, docLocale)}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </header>

          {isLetter ? (
            <section className="px-6 py-10 sm:px-10">
              <h3 className="text-2xl font-bold text-slate-900">{doc.title || dt('Carta comercial', 'Business letter')}</h3>
              <p className="mt-2 text-sm text-slate-500">{dt('Fecha', 'Date')}: {formatDate(doc.issue_date, docLocale)}</p>
              <p className="mt-6 text-sm text-slate-700">{dt('Para', 'To')}: {clientData?.business_name || clientData?.name || dt('Destinatario', 'Recipient')}</p>
              <div className="mt-8 whitespace-pre-wrap text-base leading-8 text-slate-700">{doc.notes || dt('Contenido de la carta no especificado.', 'No letter content.')}</div>
            </section>
          ) : isWorkOrder ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">{dt('Detalles de la orden de trabajo', 'Work order details')}</h3>
              <p className="mt-4 text-sm text-slate-500">{dt('Cliente', 'Client')}</p>
              <p className="font-semibold text-slate-900">{clientData?.business_name || clientData?.name || dt('Cliente no especificado', 'No client')}</p>
              {clientData?.email && <p className="mt-1 text-sm text-slate-600">{clientData.email}</p>}
              {clientData?.phone && <p className="mt-1 text-sm text-slate-600">{clientData.phone}</p>}
              <p className="mt-5 text-sm text-slate-500">{dt('Trabajo solicitado', 'Requested work')}</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{doc.title || dt('Trabajo no especificado', 'No work specified')}</p>
              {doc.due_date && <p className="mt-4 text-sm text-slate-600">{dt('Fecha límite', 'Deadline')}: {formatDate(doc.due_date, docLocale)}</p>}
            </section>
          ) : isReminder ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">{dt('Recordatorio de pago', 'Payment reminder')}</h3>
              <p className="mt-4 text-slate-700">{dt('Estimado/a', 'Dear')} {clientData?.name || clientData?.business_name || dt('cliente', 'customer')},</p>
              <p className="mt-3 leading-7 text-slate-600">
                {dt('Le recordamos que tiene un balance pendiente de pago. Le agradecemos realizar el pago correspondiente o comunicarse con nosotros si ya realizó el pago.',
                  'This is a reminder that you have an open balance. Please make the payment or contact us if you have already paid.')}
              </p>
              <div className="mt-6 rounded-2xl bg-blue-50 p-5">
                <p className="text-sm text-blue-800">{dt('Balance pendiente', 'Open balance')}</p>
                <p className="mt-1 text-3xl font-bold text-blue-950">{money(total)}</p>
                {doc.due_date && <p className="mt-2 text-sm text-blue-800">{dt('Fecha de vencimiento', 'Due date')}: {formatDate(doc.due_date, docLocale)}</p>}
              </div>
            </section>
          ) : isReceipt ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">{dt('Recibo de pago', 'Payment receipt')}</h3>
              <p className="mt-4 leading-7 text-slate-700">
                {dt('Recibimos de', 'We received from')} <span className="font-semibold">{clientData?.business_name || clientData?.name || dt('el cliente', 'the customer')}</span>{' '}
                {dt('la cantidad de', 'the amount of')} <span className="font-semibold">{money(total)}</span>
                {typeof meta.invoice_number === 'string' && meta.invoice_number ? (
                  <> {dt('como pago de la factura', 'as payment of invoice')} <span className="font-semibold">{meta.invoice_number}</span></>
                ) : null}
                .
              </p>
              <dl className="mt-6 grid gap-4 rounded-2xl bg-slate-50 p-5 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{dt('Fecha del pago', 'Payment date')}</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{formatTimestamp(typeof meta.paid_at === 'string' ? meta.paid_at : doc.issue_date, docLocale)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{dt('Método', 'Method')}</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{paymentMethodLabel(typeof meta.payment_method === 'string' ? meta.payment_method : null, docLocale)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{dt('Referencia', 'Reference')}</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{typeof meta.reference === 'string' && meta.reference ? meta.reference : '—'}</dd>
                </div>
              </dl>
              <div className="mt-6 flex items-end justify-between border-t border-slate-200 pt-4">
                <span className="text-base font-bold text-slate-900">{dt('Total recibido', 'Total received')}</span>
                <span className="text-3xl font-bold" style={{ color: primaryColor }}>{money(total)}</span>
              </div>
            </section>
          ) : (
            <>
              <section className="grid gap-6 border-b border-slate-200 px-6 py-7 sm:grid-cols-2 sm:px-10">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{isQuote ? dt('Preparado para', 'Prepared for') : dt('Facturado a', 'Bill to')}</p>
                  <h3 className="mt-2 text-lg font-bold text-slate-900">{clientData?.business_name || clientData?.name || dt('Cliente no especificado', 'No client')}</h3>
                  {clientData?.business_name && clientData?.name && <p className="mt-1 text-sm text-slate-600">{clientData.name}</p>}
                  <div className="mt-3 space-y-1 text-sm text-slate-500">
                    {clientData?.email && <p>{clientData.email}</p>}
                    {clientData?.phone && <p>{clientData.phone}</p>}
                    {clientData?.address && <p>{clientData.address}</p>}
                    {(clientData?.city || clientData?.state || clientData?.postal_code) && (
                      <p>{[clientData.city, clientData.state, clientData.postal_code].filter(Boolean).join(', ')}</p>
                    )}
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-5 sm:text-right">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{dt('Resumen', 'Summary')}</p>
                  <p className="mt-2 text-3xl font-bold text-slate-950">{money(total)}</p>
                  <p className="mt-1 text-sm text-slate-500">{dt('Total del documento', 'Document total')}</p>
                </div>
              </section>

              <section className="px-6 py-8 sm:px-10">
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <div className="grid grid-cols-[minmax(100px,1fr)_42px_72px_78px] gap-1 bg-slate-50 px-2 py-3 text-[9px] font-bold uppercase tracking-wide text-slate-500 sm:grid-cols-[minmax(0,1fr)_90px_130px_130px] sm:gap-3 sm:px-5 sm:text-xs">
                    <span>{dt('Descripción', 'Description')}</span>
                    <span className="text-right">{dt('Cant.', 'Qty')}</span>
                    <span className="text-right">{dt('Precio unit.', 'Unit price')}</span>
                    <span className="text-right">{dt('Importe', 'Amount')}</span>
                  </div>
                  {lines.items.length > 0 ? (
                    lines.items.map((item, index) => (
                      <div
                        key={`${item.description}-${index}`}
                        className="grid grid-cols-[minmax(100px,1fr)_42px_72px_78px] gap-1 border-t border-slate-100 px-2 py-4 text-xs text-slate-700 sm:grid-cols-[minmax(0,1fr)_90px_130px_130px] sm:gap-3 sm:px-5 sm:text-sm"
                      >
                        <span className="break-words font-medium text-slate-900">{item.description}</span>
                        <span className="text-right">{item.quantity}</span>
                        <span className="text-right">{money(item.unit_price)}</span>
                        <span className="text-right font-semibold">{money(item.amount)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="border-t border-slate-100 px-5 py-6">
                      <p className="font-semibold text-slate-900">{doc.title || documentType(doc.document_type, tr)}</p>
                      <p className="mt-1 text-sm text-slate-500">{dt('Este documento no tiene partidas detalladas.', 'This document has no itemized lines.')}</p>
                    </div>
                  )}
                </div>

                <div className="mt-6 flex justify-end">
                  <div className="w-full max-w-sm space-y-3">
                    <div className="flex justify-between text-sm text-slate-500">
                      <span>Subtotal</span>
                      <span className="font-medium text-slate-800">{money(subtotal)}</span>
                    </div>
                    {lines.discount > 0 && (
                      <div className="flex justify-between text-sm text-slate-500">
                        <span>{dt('Descuento', 'Discount')}</span>
                        <span className="font-medium text-slate-800">−{money(lines.discount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm text-slate-500">
                      <span>{dt('Impuesto', 'Tax')}{lines.taxRate !== null ? ` (${lines.taxRate}%)` : ''}</span>
                      <span className="font-medium text-slate-800">{money(tax)}</span>
                    </div>
                    <div className="border-t border-slate-200 pt-4">
                      <div className="flex items-end justify-between">
                        <span className="text-base font-bold text-slate-900">Total</span>
                        <span className="text-3xl font-bold" style={{ color: primaryColor }}>{money(total)}</span>
                      </div>
                    </div>
                    {isInvoice && paid > 0 && (
                      <>
                        <div className="flex justify-between text-sm text-slate-500">
                          <span>{dt('Pagado', 'Paid')}</span>
                          <span className="font-medium text-slate-800">−{money(paid)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-bold text-slate-900">
                          <span>{dt('Balance pendiente', 'Open balance')}</span>
                          <span>{money(balance)}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}

          {(isInvoice || isQuote ? lines.notes : isLetter || isReceipt ? '' : doc.notes) && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
                {isWorkOrder ? dt('Descripción del trabajo y notas', 'Work description and notes') : dt('Notas y condiciones', 'Notes and conditions')}
              </h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {isInvoice || isQuote ? lines.notes : doc.notes}
              </p>
            </section>
          )}

          {companyData?.payment_info && (isInvoice || isQuote) && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">{dt('Información de pago', 'Payment information')}</h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{companyData.payment_info}</p>
            </section>
          )}

          {signature && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <div className="flex justify-end">
                <div className="w-full max-w-xs text-center">
                  <img src={signature.url} alt={dt('Firma autorizada', 'Authorized signature')} className="mx-auto h-20 max-w-[240px] object-contain" />
                  <div className="mt-2 border-t border-slate-300 pt-2 text-xs text-slate-500">
                    {dt('Firma autorizada', 'Authorized signature')}
                    {companyData?.display_name || companyData?.legal_name ? ` · ${companyData.display_name || companyData.legal_name}` : ''}
                  </div>
                </div>
              </div>
            </section>
          )}

          <footer className="border-t border-slate-200 bg-slate-50 px-6 py-6 text-center sm:px-10">
            <p className="text-xs text-slate-400">{dt('Documento generado con BusinessAI', 'Document created with BusinessAI')}</p>
            <p className="mt-1 text-xs text-slate-400">{companyData?.display_name || companyData?.legal_name || 'BusinessAI'}</p>
          </footer>
        </article>

        <div className="mt-6 flex justify-center">
          <Link href="/documents" className="btn-primary">{tr('← Volver a Documentos', '← Back to Documents')}</Link>
        </div>
      </div>
    </div>
  )
}

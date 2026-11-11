import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PrintButton from '@/components/PrintButton'
import { StatusBadge } from '@/components/ui/status'
import { getSignatureDisplayUrl } from '@/lib/branding-assets'
import { documentItems } from '@/lib/documents/items'
import { balanceOf, documentActions, effectiveStatus, todayIn, type Role } from '@/lib/documents/lifecycle'
import { PAYMENT_ERROR_MESSAGE, PAYMENT_METHODS, paymentMethodLabel } from '@/lib/documents/payments'
import { BILLING_ERROR_MESSAGE } from '@/lib/billing/state'
import { createReceipt, deleteDraft, registerPayment, setDocumentStatus, voidDocument } from '@/app/actions/documents'
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
}

function money(value: number | string | null | undefined) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value ?? 0))
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-PR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-PR', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Puerto_Rico' }).format(date)
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
    payment_reminder: 'Recordatorio de pago',
    contract: 'Contrato / plantilla',
    report: 'Reporte',
  }
  return types[value ?? ''] ?? value ?? 'Documento'
}

const DONE_MESSAGE: Record<string, string> = {
  sent: 'Documento marcado como enviado.',
  accepted: 'Cotización marcada como aceptada.',
  rejected: 'Cotización marcada como rechazada.',
  cancelled: 'Documento anulado. Se conserva en el historial con el motivo.',
  payment: 'Pago registrado.',
  receipt: 'Recibo creado.',
}

const ACTION_ERROR: Record<string, string> = {
  transition: 'Esa acción no está disponible para este documento.',
  changed: 'El documento cambió mientras tanto. Revisa su estado e inténtalo de nuevo.',
  forbidden: 'Solo el propietario o un administrador de la empresa puede hacer esto.',
  confirm: 'Marca la casilla de confirmación para eliminar el borrador.',
  issued: 'Un documento emitido no se elimina: anúlalo para conservar la trazabilidad.',
  document_issued: 'Un documento emitido no se elimina: anúlalo para conservar la trazabilidad.',
  document_cancelled: 'Un documento anulado no se puede reabrir.',
  document_void_forbidden: 'Solo el propietario o un administrador puede anular documentos.',
  void_reason: 'Escribe el motivo de la anulación (entre 3 y 300 caracteres).',
  void_has_payments: 'Esta factura tiene pagos registrados: no se puede anular. Los pagos se conservan como historial.',
  document_has_payments: 'Esta factura tiene pagos registrados: no se puede anular. Los pagos se conservan como historial.',
  void_reason_required: 'Escribe el motivo de la anulación (entre 3 y 300 caracteres).',
  document_transition: 'Ese cambio de estado no está permitido para este tipo de documento.',
  document_not_paid: 'La factura solo pasa a pagada cuando los pagos cubren el total.',
  document_field_locked: 'El número y el tipo de un documento no se cambian.',
  company_immutable: 'Un documento no se puede mover a otra empresa.',
  receipt_client_mismatch: 'El recibo debe ser para el cliente de la factura.',
  receipt_exists: 'Ese pago ya tiene un recibo vigente.',
  audit: 'No se pudo registrar el historial del borrador; no se eliminó nada. Inténtalo nuevamente.',
  save: 'No se pudo completar la acción. Inténtalo nuevamente.',
  ...BILLING_ERROR_MESSAGE,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function DocumentUnavailable({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <div className="rounded-3xl border border-danger/40 bg-danger/10 p-8 text-center">
        <div className="text-4xl">⚠️</div>
        <h1 className="mt-4 text-2xl font-bold text-fg">{title}</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/documents" className="btn-primary">← Volver a Documentos</Link>
          <Link href="/payments" className="btn-secondary">Ir a Pagos</Link>
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

  // Broken links (e.g. /documents/null from a payment without document) are
  // detected before querying, so they are not mistaken for a database error.
  if (!UUID_RE.test(id)) {
    console.warn('DOCUMENT_LOOKUP_INVALID_ID', { id })
    return (
      <DocumentUnavailable
        title="Documento no encontrado"
        message="El enlace no corresponde a un documento válido. Es posible que el pago no esté vinculado a ningún documento."
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
        title="No se pudo cargar el documento"
        message="Ocurrió un error al consultar el documento. Inténtalo nuevamente en unos minutos."
      />
    )
  }

  if (!document) {
    return (
      <DocumentUnavailable
        title="Documento no encontrado"
        message="No pudimos encontrar este documento o no tienes acceso a él. Puede que haya sido eliminado."
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
      <DocumentUnavailable title="Documento no encontrado" message="No pudimos encontrar este documento o no tienes acceso a él." />
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
      ? supabase.from('payments').select('id, amount, payment_method, reference, paid_at')
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
      .eq('company_id', companyId).eq('document_type', 'receipt')
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
  const paid = Math.round(payments.reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100
  const lifecycle = { document_type: doc.document_type ?? null, status: doc.status ?? null, total: doc.total ?? 0, due_date: doc.due_date ?? null }
  const shownStatus = effectiveStatus(lifecycle, paid, today)
  const actions = documentActions(lifecycle, paid, today, role, await lifecycleAvailable())
  const balance = balanceOf(lifecycle, paid)
  const voidInfo = (meta.void ?? null) as { reason?: string; voided_at?: string } | null

  const subtotal = Number(doc.subtotal ?? 0)
  const tax = Number(doc.tax ?? 0)
  const total = doc.total !== null && doc.total !== undefined ? Number(doc.total) : subtotal + tax
  const primaryColor = companyData?.primary_color || '#0f172a'
  const lines = documentItems({ items: doc.items, metadata: doc.metadata, notes: doc.notes })

  const errorText =
    (query?.actionError && (ACTION_ERROR[query.actionError] ?? ACTION_ERROR.save)) ||
    (query?.paymentError && (PAYMENT_ERROR_MESSAGE[query.paymentError] ?? (BILLING_ERROR_MESSAGE as Record<string, string>)[query.paymentError] ?? PAYMENT_ERROR_MESSAGE.save)) ||
    null

  return (
    <div>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/documents" className="text-sm font-semibold text-muted transition hover:text-fg">
              ← Volver a Documentos
            </Link>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-fg">
              {documentType(doc.document_type)} {doc.document_number ? <span className="text-muted">· {doc.document_number}</span> : null}
            </h1>
            <p className="mt-1 text-sm text-muted">Revisa la información antes de enviarla al cliente.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={shownStatus} />
            <PrintButton />
          </div>
        </div>

        {query?.done && DONE_MESSAGE[query.done] && (
          <div role="status" className="alert-success mb-5 p-4">
            {DONE_MESSAGE[query.done]}
            {query.receiptError && ` El recibo no se pudo crear: ${ACTION_ERROR[query.receiptError] ?? 'inténtalo desde la lista de pagos.'}`}
          </div>
        )}

        {errorText && (
          <div role="alert" className="alert-danger mb-5 p-4">{errorText}</div>
        )}

        {shownStatus === 'cancelled' && (
          <div role="status" className="alert-warning mb-5 p-4">
            Documento anulado{voidInfo?.voided_at ? ` el ${formatTimestamp(voidInfo.voided_at)}` : ''}.
            {voidInfo?.reason ? ` Motivo: ${voidInfo.reason}` : ''} Se conserva en el historial y no se puede reabrir.
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
                  {isQuote ? 'Marcar cotización como enviada' : 'Marcar como enviada'}
                </button>
              </form>
            )}
            {actions.accept && (
              <form action={setDocumentStatus}>
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="status" value="accepted" />
                <button type="submit" className="btn-primary btn-sm w-full sm:w-auto">Cliente la aceptó</button>
              </form>
            )}
            {actions.reject && (
              <form action={setDocumentStatus}>
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="status" value="rejected" />
                <button type="submit" className="btn-secondary btn-sm w-full sm:w-auto">Cliente la rechazó</button>
              </form>
            )}
            {actions.void && (
              <details className="card w-full p-4 lg:max-w-md">
                <summary className="cursor-pointer text-sm font-semibold text-fg">Anular documento</summary>
                <form action={voidDocument} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={doc.id} />
                  <p className="text-xs text-muted">
                    El documento queda anulado y se conserva en el historial con su número. No se puede reabrir.
                  </p>
                  <label className="field-label">Motivo *
                    <input name="reason" required minLength={3} maxLength={300} className="field mt-2" placeholder="Ej. Emitida con datos incorrectos" />
                  </label>
                  <button type="submit" className="btn-danger btn-sm w-full sm:w-auto">Anular</button>
                </form>
              </details>
            )}
            {actions.delete && (
              <form action={deleteDraft} className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/40 bg-card px-3 py-2">
                <input type="hidden" name="id" value={doc.id} />
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" name="confirm_delete" value="yes" required className="h-4 w-4 accent-red-600" />
                  Confirmo eliminar este borrador
                </label>
                <button type="submit" className="btn-danger btn-sm">Eliminar borrador</button>
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
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">Pagado</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-success">{money(paid)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">Balance pendiente</p>
                <p className={`mt-1 text-xl font-bold tabular-nums ${balance > 0 ? 'text-warning' : 'text-fg'}`}>{money(balance)}</p>
              </div>
            </div>

            {actions.recordPayment && (
              <form action={registerPayment} className="mt-6 space-y-4 border-t border-line pt-5">
                <input type="hidden" name="document_id" value={doc.id} />
                <input type="hidden" name="idempotency_key" value={newIdempotencyKey()} />
                <h2 className="font-display text-lg font-semibold text-fg">Registrar pago</h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="field-label">Cantidad *
                    <input name="amount" required inputMode="decimal" defaultValue={balance.toFixed(2)} className="field mt-2" />
                  </label>
                  <label className="field-label">Método *
                    <select name="method" required defaultValue="" className="field mt-2">
                      <option value="" disabled>Seleccionar</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}
                    </select>
                  </label>
                  <label className="field-label">Fecha *
                    <input name="date" type="date" required defaultValue={today} max={today} min={doc.issue_date ?? undefined} className="field mt-2" />
                  </label>
                  <label className="field-label">Referencia
                    <input name="reference" maxLength={120} className="field mt-2" placeholder="Nº de cheque, confirmación…" />
                  </label>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" name="create_receipt" defaultChecked className="h-4 w-4 accent-blue-600" />
                    Crear el recibo de este pago
                  </label>
                  <SubmitButton pendingLabel="Registrando…" className="w-full sm:w-auto">Registrar pago</SubmitButton>
                </div>
                <p className="text-xs text-muted">Pagos parciales permitidos hasta el balance pendiente. Los pagos registrados no se editan ni se borran.</p>
              </form>
            )}

            <div className="mt-6 border-t border-line pt-5">
              <h2 className="font-display text-lg font-semibold text-fg">Historial de pagos</h2>
              {payments.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Todavía no hay pagos registrados.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {payments.map((p) => {
                    const receipt = receiptByPayment.get(p.id)
                    return (
                      <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-semibold tabular-nums text-fg">{money(p.amount)} · {paymentMethodLabel(p.payment_method)}</p>
                          <p className="truncate text-xs text-muted">
                            {formatTimestamp(p.paid_at)}{p.reference ? ` · Ref. ${p.reference}` : ''}
                          </p>
                        </div>
                        {receipt ? (
                          <Link href={`/documents/${receipt.id}`} className="btn-secondary btn-sm">Ver recibo {receipt.number ?? ''}</Link>
                        ) : (
                          <form action={createReceipt}>
                            <input type="hidden" name="payment_id" value={p.id} />
                            <button type="submit" className="btn-secondary btn-sm w-full sm:w-auto">Crear recibo</button>
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
            <Link href={`/documents/${receiptInvoiceId}`} className="btn-secondary btn-sm">Ver la factura de este pago</Link>
          </div>
        )}

        <article className="overflow-hidden rounded-3xl bg-white text-slate-900 shadow-lift ring-1 ring-slate-200">
          <header className="px-6 py-8 text-white sm:px-10" style={{ backgroundColor: primaryColor }}>
            <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
              <div>
                {companyData?.logo_url ? (
                  <img src={companyData.logo_url} alt="Logo de la empresa" className="mb-5 h-16 max-w-[220px] object-contain object-left" />
                ) : (
                  <div className="mb-5 inline-flex h-12 items-center rounded-xl bg-white/10 px-4 text-sm font-bold tracking-wide">BUSINESSAI</div>
                )}
                <h2 className="text-2xl font-bold">{companyData?.display_name || companyData?.legal_name || 'Tu empresa'}</h2>
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
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">{documentType(doc.document_type)}</p>
                <p className="mt-2 text-2xl font-bold">{doc.document_number || 'Documento'}</p>
                {shownStatus === 'cancelled' && (
                  <p className="mt-2 inline-block rounded-md border border-white/60 px-2 py-0.5 text-xs font-bold uppercase tracking-widest">Anulado</p>
                )}
                <div className="mt-5 space-y-1 text-sm text-white/75">
                  <p>Fecha: <span className="font-semibold text-white">{formatDate(doc.issue_date)}</span></p>
                  {doc.due_date && (
                    <p>
                      {isQuote ? 'Válida hasta' : 'Vencimiento'}:{' '}
                      <span className="font-semibold text-white">{formatDate(doc.due_date)}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </header>

          {isLetter ? (
            <section className="px-6 py-10 sm:px-10">
              <h3 className="text-2xl font-bold text-slate-900">{doc.title || 'Carta comercial'}</h3>
              <p className="mt-2 text-sm text-slate-500">Fecha: {formatDate(doc.issue_date)}</p>
              <p className="mt-6 text-sm text-slate-700">Para: {clientData?.business_name || clientData?.name || 'Destinatario'}</p>
              <div className="mt-8 whitespace-pre-wrap text-base leading-8 text-slate-700">{doc.notes || 'Contenido de la carta no especificado.'}</div>
            </section>
          ) : isWorkOrder ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">Detalles de la orden de trabajo</h3>
              <p className="mt-4 text-sm text-slate-500">Cliente</p>
              <p className="font-semibold text-slate-900">{clientData?.business_name || clientData?.name || 'Cliente no especificado'}</p>
              {clientData?.email && <p className="mt-1 text-sm text-slate-600">{clientData.email}</p>}
              {clientData?.phone && <p className="mt-1 text-sm text-slate-600">{clientData.phone}</p>}
              <p className="mt-5 text-sm text-slate-500">Trabajo solicitado</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{doc.title || 'Trabajo no especificado'}</p>
              {doc.due_date && <p className="mt-4 text-sm text-slate-600">Fecha límite: {formatDate(doc.due_date)}</p>}
            </section>
          ) : isReminder ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">Recordatorio de pago</h3>
              <p className="mt-4 text-slate-700">Estimado/a {clientData?.name || clientData?.business_name || 'cliente'},</p>
              <p className="mt-3 leading-7 text-slate-600">
                Le recordamos que tiene un balance pendiente de pago. Le agradecemos realizar el pago correspondiente o
                comunicarse con nosotros si ya realizó el pago.
              </p>
              <div className="mt-6 rounded-2xl bg-blue-50 p-5">
                <p className="text-sm text-blue-800">Balance pendiente</p>
                <p className="mt-1 text-3xl font-bold text-blue-950">{money(total)}</p>
                {doc.due_date && <p className="mt-2 text-sm text-blue-800">Fecha de vencimiento: {formatDate(doc.due_date)}</p>}
              </div>
            </section>
          ) : isReceipt ? (
            <section className="px-6 py-8 sm:px-10">
              <h3 className="text-xl font-bold text-slate-900">Recibo de pago</h3>
              <p className="mt-4 leading-7 text-slate-700">
                Recibimos de <span className="font-semibold">{clientData?.business_name || clientData?.name || 'el cliente'}</span> la
                cantidad de <span className="font-semibold">{money(total)}</span>
                {typeof meta.invoice_number === 'string' && meta.invoice_number ? (
                  <> como pago de la factura <span className="font-semibold">{meta.invoice_number}</span></>
                ) : null}
                .
              </p>
              <dl className="mt-6 grid gap-4 rounded-2xl bg-slate-50 p-5 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">Fecha del pago</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{formatTimestamp(typeof meta.paid_at === 'string' ? meta.paid_at : doc.issue_date)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">Método</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{paymentMethodLabel(typeof meta.payment_method === 'string' ? meta.payment_method : null)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">Referencia</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{typeof meta.reference === 'string' && meta.reference ? meta.reference : '—'}</dd>
                </div>
              </dl>
              <div className="mt-6 flex items-end justify-between border-t border-slate-200 pt-4">
                <span className="text-base font-bold text-slate-900">Total recibido</span>
                <span className="text-3xl font-bold" style={{ color: primaryColor }}>{money(total)}</span>
              </div>
            </section>
          ) : (
            <>
              <section className="grid gap-6 border-b border-slate-200 px-6 py-7 sm:grid-cols-2 sm:px-10">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{isQuote ? 'Preparado para' : 'Facturado a'}</p>
                  <h3 className="mt-2 text-lg font-bold text-slate-900">{clientData?.business_name || clientData?.name || 'Cliente no especificado'}</h3>
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
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Resumen</p>
                  <p className="mt-2 text-3xl font-bold text-slate-950">{money(total)}</p>
                  <p className="mt-1 text-sm text-slate-500">Total del documento</p>
                </div>
              </section>

              <section className="px-6 py-8 sm:px-10">
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <div className="grid grid-cols-[minmax(100px,1fr)_42px_72px_78px] gap-1 bg-slate-50 px-2 py-3 text-[9px] font-bold uppercase tracking-wide text-slate-500 sm:grid-cols-[minmax(0,1fr)_90px_130px_130px] sm:gap-3 sm:px-5 sm:text-xs">
                    <span>Descripción</span>
                    <span className="text-right">Cant.</span>
                    <span className="text-right">Precio unit.</span>
                    <span className="text-right">Importe</span>
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
                      <p className="font-semibold text-slate-900">{doc.title || documentType(doc.document_type)}</p>
                      <p className="mt-1 text-sm text-slate-500">Este documento no tiene partidas detalladas.</p>
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
                        <span>Descuento</span>
                        <span className="font-medium text-slate-800">−{money(lines.discount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm text-slate-500">
                      <span>Impuesto{lines.taxRate !== null ? ` (${lines.taxRate}%)` : ''}</span>
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
                          <span>Pagado</span>
                          <span className="font-medium text-slate-800">−{money(paid)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-bold text-slate-900">
                          <span>Balance pendiente</span>
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
                {isWorkOrder ? 'Descripción del trabajo y notas' : 'Notas y condiciones'}
              </h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                {isInvoice || isQuote ? lines.notes : doc.notes}
              </p>
            </section>
          )}

          {companyData?.payment_info && (isInvoice || isQuote) && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Información de pago</h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{companyData.payment_info}</p>
            </section>
          )}

          {signature && (
            <section className="border-t border-slate-200 px-6 py-7 sm:px-10">
              <div className="flex justify-end">
                <div className="w-full max-w-xs text-center">
                  <img src={signature.url} alt="Firma autorizada" className="mx-auto h-20 max-w-[240px] object-contain" />
                  <div className="mt-2 border-t border-slate-300 pt-2 text-xs text-slate-500">
                    Firma autorizada
                    {companyData?.display_name || companyData?.legal_name ? ` · ${companyData.display_name || companyData.legal_name}` : ''}
                  </div>
                </div>
              </div>
            </section>
          )}

          <footer className="border-t border-slate-200 bg-slate-50 px-6 py-6 text-center sm:px-10">
            <p className="text-xs text-slate-400">Documento generado con BusinessAI</p>
            <p className="mt-1 text-xs text-slate-400">{companyData?.display_name || companyData?.legal_name || 'BusinessAI'}</p>
          </footer>
        </article>

        <div className="mt-6 flex justify-center">
          <Link href="/documents" className="btn-primary">← Volver a Documentos</Link>
        </div>
      </div>
    </div>
  )
}

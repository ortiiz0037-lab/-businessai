'use server'
/**
 * Document lifecycle actions: send, accept / reject a quote, void, delete a
 * draft, record a payment and create the receipt of a payment.
 *
 * Every action re-reads the document through RLS, checks the user's role in
 * the document's company and the transition with lib/documents/lifecycle,
 * then writes with the user's own session: RLS and the 0015 triggers are the
 * final guard (a hidden button is never the only protection).
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { billingErrorCode } from '@/lib/billing/state'
import { balanceOf, canTransition, documentActions, lifecycleErrorCode, todayIn, type Role } from '@/lib/documents/lifecycle'
import { parsePaymentInput } from '@/lib/documents/payments'
import { insertDocument } from '@/lib/documents/numbering'
import { IDEMPOTENCY_KEY, lifecycleAvailable } from '@/lib/documents/capabilities'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Doc = {
  id: string; company_id: string; client_id: string | null; document_type: string; document_number: string | null
  title: string | null; status: string; total: number | string | null; due_date: string | null; issue_date: string | null
  metadata: Record<string, unknown> | null
}

function text(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim()
}

function withParams(path: string, params: Record<string, string>) {
  const [base, query = ''] = path.split('?')
  const q = new URLSearchParams(query)
  for (const [k, v] of Object.entries(params)) q.set(k, v)
  return `${base}?${q.toString()}`
}

async function session(): Promise<{ supabase: SupabaseClient; user: User }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return { supabase, user }
}

/** The document (RLS), the user's role in ITS company and what was paid on it. */
async function loadContext(supabase: SupabaseClient, user: User, id: string) {
  if (!UUID.test(id)) return null
  const { data: doc } = await supabase
    .from('documents')
    .select('id, company_id, client_id, document_type, document_number, title, status, total, due_date, issue_date, metadata')
    .eq('id', id)
    .maybeSingle()
  if (!doc) return null
  const { data: member } = await supabase
    .from('memberships').select('role').eq('user_id', user.id).eq('company_id', doc.company_id).maybeSingle()
  if (!member) return null
  const { data: payments } = await supabase.from('payments').select('amount').eq('document_id', id)
  const paid = Math.round((payments ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100
  return { doc: doc as Doc, role: member.role as Role, paid }
}

function errorCode(error: { code?: string; message?: string } | null): string {
  if (!error) return 'save'
  if (error.code === '42501') return 'forbidden'
  return lifecycleErrorCode(error) ?? billingErrorCode(error) ?? 'save'
}

function refresh(id: string) {
  revalidatePath(`/documents/${id}`)
  revalidatePath('/documents')
  revalidatePath('/payments')
  revalidatePath('/dashboard')
}

/** draft → sent (invoices, quotes); sent quote → accepted / rejected. */
export async function setDocumentStatus(formData: FormData) {
  const id = text(formData, 'id')
  const target = text(formData, 'status')
  const { supabase, user } = await session()
  const ctx = await loadContext(supabase, user, id)
  if (!ctx) redirect('/documents?error=not_found')
  const lifecycle = await lifecycleAvailable()
  if (!['sent', 'accepted', 'rejected'].includes(target) || !canTransition(ctx.doc, ctx.paid, todayIn(), ctx.role, target, lifecycle)) {
    redirect(`/documents/${id}?actionError=transition`)
  }
  const { data, error } = await supabase
    .from('documents').update({ status: target }).eq('id', id).eq('status', ctx.doc.status).select('id')
  if (error || !data?.length) redirect(`/documents/${id}?actionError=${error ? errorCode(error) : 'changed'}`)
  refresh(id)
  redirect(`/documents/${id}?done=${target}`)
}

/** Voids an issued document (owner/admin): it stays in the history with the reason. */
export async function voidDocument(formData: FormData) {
  const id = text(formData, 'id')
  const reason = text(formData, 'reason')
  const { supabase, user } = await session()
  const ctx = await loadContext(supabase, user, id)
  if (!ctx) redirect('/documents?error=not_found')
  if (reason.length < 3 || reason.length > 300) redirect(`/documents/${id}?actionError=void_reason`)
  if (!canTransition(ctx.doc, ctx.paid, todayIn(), ctx.role, 'cancelled')) {
    redirect(`/documents/${id}?actionError=${ctx.paid > 0 ? 'void_has_payments' : 'forbidden'}`)
  }
  // With 0015 the database rewrites who / when / previous status itself;
  // only the reason comes from here.
  const metadata = {
    ...(ctx.doc.metadata ?? {}),
    void: { reason, voided_at: new Date().toISOString(), voided_by: user.id, previous_status: ctx.doc.status },
  }
  const { data, error } = await supabase
    .from('documents').update({ status: 'cancelled', metadata }).eq('id', id).eq('status', ctx.doc.status).select('id')
  if (error || !data?.length) redirect(`/documents/${id}?actionError=${error ? errorCode(error) : 'changed'}`)
  refresh(id)
  redirect(`/documents/${id}?done=cancelled`)
}

/** Deletes a DRAFT (owner/admin). Issued documents are voided instead. */
export async function deleteDraft(formData: FormData) {
  const id = text(formData, 'id')
  const { supabase, user } = await session()
  const ctx = await loadContext(supabase, user, id)
  if (!ctx) redirect('/documents?error=not_found')
  if (formData.get('confirm_delete') !== 'yes') redirect(`/documents/${id}?actionError=confirm`)
  if (!documentActions(ctx.doc, ctx.paid, todayIn(), ctx.role).delete) {
    redirect(`/documents/${id}?actionError=${ctx.doc.status === 'draft' ? 'forbidden' : 'issued'}`)
  }
  // Trace first (review finding M4): without the audit row nothing is
  // deleted. With 0015 the database also records the deletion itself
  // (document_events), in the same transaction as the delete.
  const { error: auditError } = await supabase.from('document_deletion_audit').insert({
    company_id: ctx.doc.company_id, document_id: id, document_number: ctx.doc.document_number,
    document_type: ctx.doc.document_type, title: ctx.doc.title, previous_status: ctx.doc.status,
    total: Number(ctx.doc.total ?? 0), reason: 'Borrador eliminado', deleted_by: user.id,
  })
  if (auditError) {
    console.error('DOCUMENT_DELETION_AUDIT_ERROR', { code: auditError.code, message: auditError.message })
    redirect(`/documents/${id}?actionError=audit`)
  }
  const { data, error } = await supabase
    .from('documents').delete().eq('id', id).eq('status', 'draft').select('id')
  if (error || !data?.length) {
    console.error('DOCUMENT_DELETE_AFTER_AUDIT_FAILED', { document_id: id, code: error?.code ?? 'no_rows' })
    redirect(`/documents/${id}?actionError=${error ? errorCode(error) : 'forbidden'}`)
  }
  revalidatePath('/documents')
  revalidatePath('/dashboard')
  redirect('/documents?done=deleted')
}

type PaymentRow = {
  id: string; company_id: string; document_id: string; amount: number | string
  payment_method: string | null; reference: string | null; paid_at: string | null
}

/** Creates the receipt of a payment; returns its id or an error code. */
async function receiptFor(supabase: SupabaseClient, user: User, payment: PaymentRow, invoice: Doc) {
  // A voided receipt does not count: the payment can get a new one (I7).
  const { data: existing } = await supabase
    .from('documents').select('id').eq('company_id', payment.company_id).eq('document_type', 'receipt')
    .neq('status', 'cancelled').eq('metadata->>payment_id', payment.id).limit(1).maybeSingle()
  if (existing) return { id: existing.id as string, error: null }
  const amount = Number(payment.amount)
  const paidDay = (payment.paid_at ?? new Date().toISOString()).slice(0, 10)
  const { data, error } = await insertDocument(supabase, {
    company_id: payment.company_id,
    client_id: invoice.client_id,
    created_by: user.id,
    document_type: 'receipt',
    status: 'paid',
    title: `Recibo de pago · ${invoice.document_number ?? invoice.title ?? 'factura'}`,
    issue_date: paidDay,
    subtotal: amount,
    tax: 0,
    total: amount,
    items: [],
    metadata: {
      payment_id: payment.id, invoice_id: invoice.id, invoice_number: invoice.document_number,
      payment_method: payment.payment_method, reference: payment.reference, paid_at: payment.paid_at,
    },
  })
  if (error || !data) return { id: null, error: errorCode(error) }
  return { id: data.id, error: null }
}

/**
 * Records a payment (full or partial) on an issued invoice, then optionally
 * its receipt. Amount, method, date and reference are validated here and the
 * database refuses any payment above the balance (0015).
 */
export async function registerPayment(formData: FormData) {
  const id = text(formData, 'document_id')
  const back = text(formData, 'return_to') === 'payments' ? `/payments/new?document=${encodeURIComponent(id)}` : `/documents/${id}`
  const { supabase, user } = await session()
  const ctx = await loadContext(supabase, user, id)
  if (!ctx) redirect(withParams(back, { paymentError: 'not_found' }))
  const today = todayIn()
  if (!documentActions(ctx.doc, ctx.paid, today, ctx.role).recordPayment) redirect(withParams(back, { paymentError: 'payment_not_allowed' }))
  const balance = balanceOf(ctx.doc, ctx.paid)
  const input = parsePaymentInput(
    { amount: text(formData, 'amount'), method: text(formData, 'method'), date: text(formData, 'date'), reference: text(formData, 'reference') },
    balance, today, ctx.doc.issue_date,
  )
  if (!input.ok) redirect(withParams(back, { paymentError: input.error }))

  // Double submission (review finding I5): the form carries a key generated
  // when it was shown; the database stores one payment per key and company.
  const lifecycle = await lifecycleAvailable()
  const key = text(formData, 'idempotency_key')
  const idempotencyKey = lifecycle && IDEMPOTENCY_KEY.test(key) ? key : null
  const columns = 'id, company_id, document_id, amount, payment_method, reference, paid_at'
  const inserted = await supabase
    .from('payments')
    .insert({
      company_id: ctx.doc.company_id, document_id: id, amount: input.amount, payment_method: input.method,
      reference: input.reference, paid_at: input.paidAt, created_by: user.id,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    })
    .select(columns)
    .single()
  let payment = inserted.data
  const error = inserted.error
  if (error && idempotencyKey && errorCode(error) === 'payment_duplicate') {
    // Already recorded by the first submission: show that payment.
    const { data: first } = await supabase.from('payments').select(columns)
      .eq('company_id', ctx.doc.company_id).eq('idempotency_key', idempotencyKey).maybeSingle()
    if (!first) redirect(withParams(back, { paymentError: 'save' }))
    refresh(id)
    redirect(`/documents/${id}?done=payment`)
  }
  if (error || !payment) redirect(withParams(back, { paymentError: errorCode(error) }))
  payment = payment!

  // With 0015 the database already settled the invoice; without it, do it here.
  if (ctx.paid + input.amount >= Number(ctx.doc.total ?? 0)) {
    await supabase.from('documents').update({ status: 'paid' }).eq('id', id).in('status', ['sent', 'overdue'])
  }
  refresh(id)

  if (formData.get('create_receipt') === 'on') {
    const receipt = await receiptFor(supabase, user, payment as PaymentRow, ctx.doc)
    if (receipt.id) redirect(`/documents/${receipt.id}?done=receipt`)
    redirect(`/documents/${id}?done=payment&receiptError=${receipt.error}`)
  }
  redirect(`/documents/${id}?done=payment`)
}

/** Receipt of an existing payment (from the payment list or "Nuevo recibo"). */
export async function createReceipt(formData: FormData) {
  const paymentId = text(formData, 'payment_id')
  const { supabase, user } = await session()
  if (!UUID.test(paymentId)) redirect('/documents/new?type=receipt&error=payment')
  const { data: payment } = await supabase
    .from('payments').select('id, company_id, document_id, amount, payment_method, reference, paid_at').eq('id', paymentId).maybeSingle()
  if (!payment) redirect('/documents/new?type=receipt&error=payment')
  const ctx = await loadContext(supabase, user, payment.document_id)
  if (!ctx) redirect('/documents/new?type=receipt&error=payment')
  const receipt = await receiptFor(supabase, user, payment as PaymentRow, ctx.doc)
  if (!receipt.id) redirect(`/documents/new?type=receipt&error=${receipt.error}`)
  refresh(ctx.doc.id)
  redirect(`/documents/${receipt.id}?done=receipt`)
}

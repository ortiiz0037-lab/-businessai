/**
 * Document lifecycle: the status shown to the user and the actions allowed.
 *
 * The database stores draft / sent / paid / overdue / cancelled / accepted /
 * rejected. What the user sees for an invoice is derived from its payments
 * and due date, with the same rules as the dashboard (lib/dashboard/metrics):
 * a balance past its due date is overdue, part-paid is "partial", fully
 * paid is paid. Nothing is written to compute it.
 *
 * The allowed actions are decided here for the interface AND re-checked by
 * the server actions; the database enforces the same rules (0015).
 */

export type EffectiveStatus = 'draft' | 'sent' | 'partial' | 'overdue' | 'paid' | 'cancelled' | 'accepted' | 'rejected'
export type Role = 'owner' | 'admin' | 'member'

export const DOCUMENT_TYPES = ['invoice', 'quote', 'receipt', 'work_order', 'letter', 'payment_reminder'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]
export const isDocumentType = (v: string): v is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(v)

export type LifecycleDoc = {
  document_type: string | null
  status: string | null
  total: number | string | null
  due_date: string | null
}

const cents = (n: number) => Math.round(n * 100) / 100

export function balanceOf(doc: Pick<LifecycleDoc, 'total'>, paid: number): number {
  return cents(Math.max(Number(doc.total ?? 0) - paid, 0))
}

/** today: 'YYYY-MM-DD' in the company's time zone. */
export function effectiveStatus(doc: LifecycleDoc, paid: number, today: string): EffectiveStatus {
  const status = doc.status ?? 'draft'
  if (status === 'cancelled' || status === 'accepted' || status === 'rejected' || status === 'draft') return status
  if (doc.document_type !== 'invoice') return status === 'paid' ? 'paid' : 'sent'
  const total = Number(doc.total ?? 0)
  if (status === 'paid' || (total > 0 && paid >= total)) return 'paid'
  if (status === 'overdue' || (doc.due_date !== null && doc.due_date < today)) return 'overdue'
  return paid > 0 ? 'partial' : 'sent'
}

export type DocumentActions = {
  send: boolean
  accept: boolean
  reject: boolean
  recordPayment: boolean
  void: boolean
  delete: boolean
}

/**
 * - drafts: send (invoices, quotes); delete (owner/admin) — nothing was issued yet;
 * - quotes sent: accept or reject;
 * - invoices sent / partial / overdue: record payments;
 * - void (owner/admin): any issued document that is not voided, except an
 *   invoice that already has payments (that needs a credit note);
 * - issued documents are never deleted.
 */
export function documentActions(doc: LifecycleDoc, paid: number, today: string, role: Role | null): DocumentActions {
  const s = effectiveStatus(doc, paid, today)
  const manager = role === 'owner' || role === 'admin'
  const isInvoice = doc.document_type === 'invoice'
  const isQuote = doc.document_type === 'quote'
  return {
    send: s === 'draft' && (isInvoice || isQuote),
    accept: isQuote && s === 'sent',
    reject: isQuote && s === 'sent',
    recordPayment: isInvoice && (s === 'sent' || s === 'partial' || s === 'overdue') && balanceOf(doc, paid) > 0,
    void: manager && s !== 'draft' && s !== 'cancelled' && !(isInvoice && paid > 0),
    delete: manager && s === 'draft',
  }
}

/** Status transitions a user may request from the document page. */
export function canTransition(doc: LifecycleDoc, paid: number, today: string, role: Role | null, target: string): boolean {
  const a = documentActions(doc, paid, today, role)
  if (target === 'sent') return a.send
  if (target === 'accepted') return a.accept
  if (target === 'rejected') return a.reject
  if (target === 'cancelled') return a.void
  return false
}

/** 'YYYY-MM-DD' of `now` in `timeZone`. */
export function todayIn(timeZone = 'America/Puerto_Rico', now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Database errors of 0015 → a code for the interface. */
export function lifecycleErrorCode(error: { message?: string | null } | null): string | null {
  const m = error?.message ?? ''
  for (const code of ['DOCUMENT_ISSUED', 'DOCUMENT_CANCELLED', 'DOCUMENT_VOID_FORBIDDEN', 'PAYMENT_NOT_ALLOWED',
    'PAYMENT_EXCEEDS_BALANCE', 'RECEIPT_PAYMENT_REQUIRED', 'RECEIPT_AMOUNT_MISMATCH']) {
    if (m.includes(code)) return code.toLowerCase()
  }
  if (m.includes('documents_receipt_payment_uidx')) return 'receipt_exists'
  return null
}

/**
 * Payables (migration 0024): labels, error messages, form parsing and the
 * attachment rules shared by the browser uploader and the server action.
 * PostgreSQL decides every rule; every money effect is a ledger entry (0023).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { parseCents } from '@/lib/finance/money'

export const BILL_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'partially_paid', 'paid', 'voided'] as const
export type BillStatus = (typeof BILL_STATUSES)[number]
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
export const PAY_METHODS = ['cash', 'check', 'transfer', 'card', 'ach', 'other'] as const

export const ATTACHMENT_BUCKET = 'Finance-attachments'
export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export type Bill = {
  id: string; company_id: string; vendor_id: string; vendor_invoice_number: string | null; bill_date: string; due_date: string | null
  description: string; notes: string | null; currency: string; total_cents: number; paid_cents: number; status: BillStatus
  scheduled_for: string | null; submitted_by: string | null; submitted_at: string | null; approved_by: string | null; approved_at: string | null
  rejected_by: string | null; rejected_at: string | null; rejection_reason: string | null; voided_by: string | null; voided_at: string | null
  void_reason: string | null; recurring_id: string | null; recurring_period: string | null; created_by: string | null; created_at: string
}
export type Vendor = { id: string; name: string; tax_id: string | null; email: string | null; phone: string | null; address: string | null; notes: string | null; status: 'active' | 'archived' }
export type Category = { id: string; name: string; name_en: string | null; account_id: string; status: 'active' | 'archived' }

export type PayablesAccess = {
  view: boolean; create: boolean; approve: boolean; pay: boolean; manage: boolean; settings: boolean
  /** Largest amount the user may approve: null = unlimited, -1 = none. */
  approvalLimit: number | null
  available: boolean; initialized: boolean
}

export async function payablesAccess(supabase: SupabaseClient, companyId: string): Promise<PayablesAccess> {
  const keys = ['view', 'create', 'approve', 'pay', 'manage', 'settings'] as const
  const [answers, limit, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: `payables.${k}` }))),
    supabase.rpc('payables_approval_limit', { target: companyId }),
    supabase.from('payables_settings').select('company_id').eq('company_id', companyId).maybeSingle(),
  ])
  const [view, create, approve, pay, manage, settings] = answers.map((a) => !a.error && a.data === true)
  const available = !probe.error
  const lim = limit.error ? -1 : (limit.data as number | null)
  return { view, create, approve, pay, manage, settings, approvalLimit: lim === null ? null : Number(lim), available, initialized: available && !!probe.data }
}

export function canApproveAmount(access: PayablesAccess, cents: number | bigint): boolean {
  if (access.approvalLimit === -1) return false
  return access.approvalLimit === null || BigInt(cents) <= BigInt(access.approvalLimit)
}

export function statusLabel(s: string, locale: Locale): string {
  const es: Record<string, string> = { draft: 'Borrador', pending_approval: 'Pendiente de aprobación', approved: 'Aprobado', scheduled: 'Programado',
    partially_paid: 'Parcialmente pagado', paid: 'Pagado', voided: 'Anulado' }
  const en: Record<string, string> = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', scheduled: 'Scheduled',
    partially_paid: 'Partially paid', paid: 'Paid', voided: 'Voided' }
  return (locale === 'en' ? en : es)[s] ?? s
}
export function statusTone(s: string): string {
  return ({ draft: 'badge-neutral', pending_approval: 'badge-warning', approved: 'badge-accent', scheduled: 'badge-accent',
    partially_paid: 'badge-warning', paid: 'badge-success', voided: 'badge-danger' } as Record<string, string>)[s] ?? 'badge-neutral'
}
export function frequencyLabel(f: string, locale: Locale): string {
  const es: Record<string, string> = { weekly: 'Semanal', monthly: 'Mensual', quarterly: 'Trimestral', yearly: 'Anual' }
  const en: Record<string, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }
  return (locale === 'en' ? en : es)[f] ?? f
}
export function methodLabel(m: string | null, locale: Locale): string {
  if (!m) return '—'
  const es: Record<string, string> = { cash: 'Efectivo', check: 'Cheque', transfer: 'Transferencia', card: 'Tarjeta', ach: 'ACH', other: 'Otro' }
  const en: Record<string, string> = { cash: 'Cash', check: 'Check', transfer: 'Transfer', card: 'Card', ach: 'ACH', other: 'Other' }
  return (locale === 'en' ? en : es)[m] ?? m
}
export function categoryName(c: Pick<Category, 'name' | 'name_en'>, locale: Locale): string {
  return locale === 'en' && c.name_en ? c.name_en : c.name
}
export function eventLabel(action: string, locale: Locale): string {
  const es: Record<string, string> = { created: 'Creado', submitted: 'Enviado a aprobación', approved: 'Aprobado (asiento publicado)', rejected: 'Devuelto a borrador',
    scheduled: 'Pago programado', paid: 'Pago registrado', payment_voided: 'Pago anulado (reversión)', voided: 'Anulado', deleted: 'Borrador eliminado',
    attachment_added: 'Adjunto añadido', attachment_removed: 'Adjunto quitado', updated: 'Modificado', generated: 'Recurrentes generados', initialized: 'Módulo activado' }
  const en: Record<string, string> = { created: 'Created', submitted: 'Submitted for approval', approved: 'Approved (entry posted)', rejected: 'Returned to draft',
    scheduled: 'Payment scheduled', paid: 'Payment recorded', payment_voided: 'Payment voided (reversal)', voided: 'Voided', deleted: 'Draft deleted',
    attachment_added: 'Attachment added', attachment_removed: 'Attachment removed', updated: 'Changed', generated: 'Recurring generated', initialized: 'Module activated' }
  return (locale === 'en' ? en : es)[action] ?? action
}

const CODES = [
  'BILL_NOT_FOUND', 'BILL_TRANSITION', 'BILL_EMPTY', 'BILL_LOCKED', 'BILL_FIELD_LOCKED', 'BILL_NOT_DRAFT', 'BILL_VOIDED', 'BILL_HAS_PAYMENTS',
  'BILL_NOT_PAYABLE', 'BILL_ALREADY_POSTED', 'APPROVAL_FORBIDDEN', 'APPROVAL_LIMIT_EXCEEDED', 'SELF_APPROVAL_FORBIDDEN', 'REASON_REQUIRED',
  'PAYMENT_EXCEEDS_BALANCE', 'PAYMENT_ACCOUNT_INVALID', 'PAYMENT_NOT_FOUND', 'PAYMENT_ALREADY_VOIDED', 'PAYMENT_IMMUTABLE', 'AMOUNT_INVALID', 'DATE_INVALID',
  'VENDOR_IN_USE', 'CATEGORY_IN_USE', 'CATEGORY_ACCOUNT_INVALID', 'CATEGORY_ARCHIVED', 'RECURRING_IN_USE', 'RECURRING_FIELD_LOCKED',
  'ATTACHMENT_FILE_MISSING', 'ATTACHMENT_LOCKED', 'VENDOR_INVALID', 'CATEGORY_INVALID', 'PERIOD_CLOSED', 'ACCOUNT_ARCHIVED', 'FORBIDDEN',
] as const

export function payablesErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/bills_vendor_invoice_uidx/.test(m)) return 'vendor_invoice_taken'
  if (/vendors_name_uidx/.test(m)) return 'vendor_exists'
  if (/expense_categories_name_uidx/.test(m)) return 'category_exists'
  if (/bills_idem_uidx/.test(m)) return 'duplicate_submission'
  if (error?.code === '23514') return 'invalid'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === '40001' || /could not serialize/.test(m)) return 'retry'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    bill_not_found: 'No se encontró el gasto o no tienes acceso.', bill_transition: 'Ese cambio de estado no es posible ahora.',
    bill_empty: 'Añade al menos una línea con importe antes de enviar.', bill_locked: 'Un gasto enviado no se edita: devuélvelo a borrador o anúlalo.',
    bill_field_locked: 'Ese dato no se puede cambiar.', bill_not_draft: 'Solo los borradores se eliminan; los demás se anulan.',
    bill_voided: 'El gasto está anulado.', bill_has_payments: 'Tiene pagos: anúlalos primero.', bill_not_payable: 'Este gasto no admite pagos (debe estar aprobado y con saldo).',
    bill_already_posted: 'Este gasto ya está en el libro mayor.', approval_forbidden: 'Tu rol no puede aprobar gastos.',
    approval_limit_exceeded: 'El importe supera tu límite de aprobación.', self_approval_forbidden: 'No puedes aprobar un gasto que tú registraste o enviaste.',
    reason_required: 'Escribe un motivo (3 a 300 caracteres).', payment_exceeds_balance: 'El pago supera el saldo pendiente.',
    payment_account_invalid: 'Elige una cuenta de efectivo o banco.', payment_not_found: 'No se encontró el pago.', payment_already_voided: 'Ese pago ya fue anulado.',
    payment_immutable: 'Los pagos no se modifican; se anulan.', amount_invalid: 'Importe no válido.', date_invalid: 'Fecha no válida.',
    vendor_invalid: 'Elige un proveedor activo de la empresa.', category_invalid: 'Categoría no válida para esta empresa.', vendor_in_use: 'El proveedor tiene gastos: archívalo en lugar de borrarlo.', category_in_use: 'La categoría está en uso: archívala.',
    category_account_invalid: 'La categoría debe usar una cuenta activa de gasto o de activo.', category_archived: 'Esa categoría está archivada.',
    recurring_in_use: 'La plantilla ya generó gastos: pausala en lugar de borrarla.', recurring_field_locked: 'Ese dato de la plantilla no cambia.',
    attachment_file_missing: 'No se encontró el archivo subido.', attachment_locked: 'Los adjuntos de un gasto enviado se conservan como evidencia.',
    period_closed: 'Ese mes está cerrado en la contabilidad.', account_archived: 'La cuenta contable está archivada.',
    vendor_invoice_taken: 'Ya existe un gasto con ese número de factura del proveedor.', vendor_exists: 'Ya existe un proveedor con ese nombre.',
    category_exists: 'Ya existe una categoría con ese nombre.', duplicate_submission: 'Ese formulario ya se envió.',
    attachment_type: 'Solo PDF o imágenes (JPG, PNG, WEBP, HEIC).', attachment_size: 'El archivo supera 10 MB.',
    forbidden: 'No tienes permiso para esta acción.', invalid: 'Revisa los datos del formulario.', retry: 'Otra operación terminó al mismo tiempo. Inténtalo de nuevo.',
    unavailable: 'El módulo de gastos todavía no está activado en esta base de datos.', save: 'No se pudo guardar. Inténtalo de nuevo.',
  },
  en: {
    bill_not_found: 'Expense not found or you have no access.', bill_transition: 'That status change is not possible now.',
    bill_empty: 'Add at least one line with an amount before submitting.', bill_locked: 'A submitted expense is not edited: return it to draft or void it.',
    bill_field_locked: 'That field cannot change.', bill_not_draft: 'Only drafts are deleted; others are voided.',
    bill_voided: 'The expense is voided.', bill_has_payments: 'It has payments: void them first.', bill_not_payable: 'This expense takes no payments (it must be approved with a balance).',
    bill_already_posted: 'This expense is already in the ledger.', approval_forbidden: 'Your role cannot approve expenses.',
    approval_limit_exceeded: 'The amount is above your approval limit.', self_approval_forbidden: 'You cannot approve an expense you recorded or submitted.',
    reason_required: 'Enter a reason (3 to 300 characters).', payment_exceeds_balance: 'The payment is above the open balance.',
    payment_account_invalid: 'Choose a cash or bank account.', payment_not_found: 'Payment not found.', payment_already_voided: 'That payment was already voided.',
    payment_immutable: 'Payments are not modified; they are voided.', amount_invalid: 'Invalid amount.', date_invalid: 'Invalid date.',
    vendor_invalid: 'Choose an active vendor of the company.', category_invalid: 'Invalid category for this company.', vendor_in_use: 'The vendor has expenses: archive it instead of deleting it.', category_in_use: 'The category is in use: archive it.',
    category_account_invalid: 'The category must use an active expense or asset account.', category_archived: 'That category is archived.',
    recurring_in_use: 'The template already generated expenses: pause it instead of deleting it.', recurring_field_locked: 'That template field does not change.',
    attachment_file_missing: 'The uploaded file was not found.', attachment_locked: 'Attachments of a submitted expense are kept as evidence.',
    period_closed: 'That month is closed in accounting.', account_archived: 'The ledger account is archived.',
    vendor_invoice_taken: 'An expense with that vendor invoice number already exists.', vendor_exists: 'A vendor with that name already exists.',
    category_exists: 'A category with that name already exists.', duplicate_submission: 'That form was already submitted.',
    attachment_type: 'Only PDF or images (JPG, PNG, WEBP, HEIC).', attachment_size: 'The file is above 10 MB.',
    forbidden: 'You do not have permission for this action.', invalid: 'Check the form data.', retry: 'Another operation finished at the same time. Try again.',
    unavailable: 'The expenses module is not enabled in this database yet.', save: 'Could not save. Try again.',
  },
}
export function payablesMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type BillLineInput = { category_id: string; description: string | null; amount_cents: string }

/** Lines of the expense form (category_N, amount_N, line_description_N); empty rows skipped. */
export function parseBillLines(f: FormData, rows = 10): { lines: BillLineInput[]; total: bigint } | { error: string } {
  const lines: BillLineInput[] = []
  let total = 0n
  for (let i = 0; i < rows; i++) {
    const category = String(f.get(`category_${i}`) ?? '').trim()
    const amount = String(f.get(`amount_${i}`) ?? '').trim()
    const description = String(f.get(`line_description_${i}`) ?? '').trim().slice(0, 300) || null
    if (!category && !amount && !description) continue
    if (!UUID.test(category)) return { error: 'invalid' }
    const cents = parseCents(amount)
    if (cents === null || cents <= 0n) return { error: 'amount_invalid' }
    total += cents
    lines.push({ category_id: category, description, amount_cents: cents.toString() })
  }
  if (lines.length === 0) return { error: 'bill_empty' }
  return { lines, total }
}

/** File checks shared by the browser uploader and the server. */
export function validateAttachment(file: { type: string; size: number }): 'attachment_type' | 'attachment_size' | null {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'attachment_type'
  if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) return 'attachment_size'
  return null
}

/** Storage path <company>/<bill>/<uuid>-<safe name> (the database checks company and bill). */
export function attachmentPath(companyId: string, billId: string, uuid: string, fileName: string): string {
  const safe = fileName.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'archivo'
  return `${companyId}/${billId}/${uuid}-${safe}`
}

/** Days until (negative: since) a due date, from today ('YYYY-MM-DD'). */
export function daysUntil(due: string | null, today: string): number | null {
  if (!due) return null
  return Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
}

/**
 * Accounts receivable (migration 0025): labels, error messages, reminder
 * text. Balances come from the database (invoices + payments, reconciled
 * with the ledger); nothing here keeps amounts of its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { formatCents } from '@/lib/finance/money'

export const BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const
export const AR_STATUSES = ['issued', 'partially_paid', 'overdue', 'paid'] as const
export const COLLECTION_STATUSES = ['open', 'contacted', 'promised', 'disputed', 'escalated', 'on_hold'] as const

export type InvoiceBalance = {
  document_id: string; client_id: string | null; document_number: string; issue_date: string; due_date: string | null
  total_cents: number; paid_cents: number; balance_cents: number; days_past_due: number; bucket: string | null; ar_status: string; collection_status: string
}
export type AgingRow = {
  client_id: string | null; client_name: string; b0_30: number; b31_60: number; b61_90: number; b90_plus: number
  total_cents: number; overdue_cents: number; not_due_cents: number; invoices: number; oldest_days: number
}
export type Reminder = {
  id: string; document_id: string; client_id: string; offset_days: number; scheduled_for: string; to_email: string | null; language: 'es' | 'en'
  status: string; attempts: number; last_error: string | null; sent_at: string | null; created_at: string
}
export type Promise_ = {
  id: string; document_id: string; client_id: string; promised_date: string; amount_cents: number; note: string | null; status: string
  created_by: string | null; created_at: string; resolved_at: string | null; cancel_reason: string | null
}

export type ReceivablesAccess = { view: boolean; manage: boolean; voidPayments: boolean; available: boolean }

export async function receivablesAccess(supabase: SupabaseClient, companyId: string): Promise<ReceivablesAccess> {
  const [v, m, p, probe] = await Promise.all([
    supabase.rpc('has_permission', { target: companyId, permission: 'receivables.view' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'receivables.manage' }),
    supabase.rpc('has_permission', { target: companyId, permission: 'payments.void' }),
    supabase.from('collection_settings').select('company_id').eq('company_id', companyId).maybeSingle(),
  ])
  const ok = (r: { error: unknown; data: unknown }) => !r.error && r.data === true
  return { view: ok(v), manage: ok(m), voidPayments: ok(p), available: !probe.error }
}

const L = (locale: Locale, es: Record<string, string>, en: Record<string, string>, k: string) => (locale === 'en' ? en : es)[k] ?? k

export const bucketLabel = (b: string, locale: Locale) =>
  L(locale, { '0_30': '0–30 días', '31_60': '31–60 días', '61_90': '61–90 días', '90_plus': 'Más de 90 días' },
    { '0_30': '0–30 days', '31_60': '31–60 days', '61_90': '61–90 days', '90_plus': 'Over 90 days' }, b)
export const arStatusLabel = (s: string, locale: Locale) =>
  L(locale, { issued: 'Emitida', partially_paid: 'Parcialmente pagada', overdue: 'Vencida', paid: 'Pagada' },
    { issued: 'Issued', partially_paid: 'Partially paid', overdue: 'Overdue', paid: 'Paid' }, s)
export const arStatusTone = (s: string) => ({ issued: 'badge-accent', partially_paid: 'badge-warning', overdue: 'badge-danger', paid: 'badge-success' } as Record<string, string>)[s] ?? 'badge-neutral'
export const collectionLabel = (s: string, locale: Locale) =>
  L(locale, { open: 'Sin gestión', contacted: 'Contactado', promised: 'Promesa de pago', disputed: 'En disputa', escalated: 'Escalado', on_hold: 'En pausa' },
    { open: 'No follow-up', contacted: 'Contacted', promised: 'Payment promised', disputed: 'Disputed', escalated: 'Escalated', on_hold: 'On hold' }, s)
export const promiseLabel = (s: string, locale: Locale) =>
  L(locale, { pending: 'Pendiente', kept: 'Cumplida', broken: 'Incumplida', cancelled: 'Cancelada' }, { pending: 'Pending', kept: 'Kept', broken: 'Broken', cancelled: 'Cancelled' }, s)
export const reminderLabel = (s: string, locale: Locale) =>
  L(locale, { pending: 'Preparado', sent: 'Enviado por email', sent_manual: 'Contactado por otro medio', failed: 'Falló', cancelled: 'Cancelado', no_email: 'Cliente sin email' },
    { pending: 'Ready', sent: 'Sent by email', sent_manual: 'Contacted another way', failed: 'Failed', cancelled: 'Cancelled', no_email: 'Client without email' }, s)
export const eventLabelAR = (a: string, locale: Locale) =>
  L(locale, { payment_voided: 'Pago anulado (reversión)', status: 'Estado de cobro', note: 'Nota interna', promise: 'Promesa de pago', promise_kept: 'Promesa cumplida',
    promise_broken: 'Promesa incumplida', promise_cancelled: 'Promesa cancelada', reminder_queued: 'Recordatorio preparado', reminder_sent: 'Recordatorio enviado',
    reminder_sent_manual: 'Contactado por otro medio', reminder_failed: 'Envío fallido', reminder_cancelled: 'Recordatorio cancelado', updated: 'Configuración' },
    { payment_voided: 'Payment voided (reversal)', status: 'Collection status', note: 'Internal note', promise: 'Payment promise', promise_kept: 'Promise kept',
    promise_broken: 'Promise broken', promise_cancelled: 'Promise cancelled', reminder_queued: 'Reminder prepared', reminder_sent: 'Reminder sent',
    reminder_sent_manual: 'Contacted another way', reminder_failed: 'Sending failed', reminder_cancelled: 'Reminder cancelled', updated: 'Settings' }, a)

/** "3 días antes del vencimiento" / "on the due date" / "7 days after due". */
export function offsetLabel(days: number, locale: Locale): string {
  if (days === 0) return locale === 'en' ? 'on the due date' : 'el día del vencimiento'
  const n = Math.abs(days)
  if (days < 0) return locale === 'en' ? `${n} day${n === 1 ? '' : 's'} before due` : `${n} día${n === 1 ? '' : 's'} antes del vencimiento`
  return locale === 'en' ? `${n} day${n === 1 ? '' : 's'} after due` : `${n} día${n === 1 ? '' : 's'} después del vencimiento`
}

/** '-3, 0, 7, 30' → [-3, 0, 7, 30] (unique, sorted, -60…365, at most 10) or null. */
export function parseOffsets(v: string): number[] | null {
  const parts = v.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 10 || parts.some((x) => !/^-?\d{1,3}$/.test(x))) return null
  const nums = [...new Set(parts.map(Number))].sort((a, b) => a - b)
  return nums.every((n) => n >= -60 && n <= 365) ? nums : null
}

export const DEFAULT_MESSAGE: Record<Locale, string> = {
  es: 'Hola {cliente}:\n\nLe recordamos que la factura {factura} tiene un balance pendiente de {balance}, con vencimiento el {vence}.\n\nSi ya realizó el pago, por favor ignore este mensaje. Para cualquier pregunta, responda a este correo.\n\nGracias,\n{empresa}',
  en: 'Hello {client}:\n\nThis is a reminder that invoice {invoice} has an open balance of {balance}, due on {due}.\n\nIf you have already paid, please disregard this message. For any question, reply to this email.\n\nThank you,\n{company}',
}

/** Reminder subject and body from the company template (placeholders in both languages). */
export function renderReminder(input: { locale: Locale; template?: string | null; client: string; invoice: string; balanceCents: number | string | bigint; due: string; company: string }) {
  const balance = formatCents(input.balanceCents, input.locale)
  const values: Record<string, string> = {
    cliente: input.client, client: input.client, factura: input.invoice, invoice: input.invoice,
    balance, vence: input.due, due: input.due, empresa: input.company, company: input.company,
  }
  const text = (input.template?.trim() || DEFAULT_MESSAGE[input.locale]).replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m)
  const subject = input.locale === 'en' ? `Payment reminder: invoice ${input.invoice} (${balance})` : `Recordatorio de pago: factura ${input.invoice} (${balance})`
  return { subject, text }
}

const CODES = ['PAYMENT_NOT_FOUND', 'PAYMENT_ALREADY_VOIDED', 'REASON_REQUIRED', 'INVOICE_NOT_FOUND', 'INVOICE_NOT_ISSUED', 'INVOICE_NOT_OPEN', 'STATUS_INVALID',
  'CLIENT_INVALID', 'NOTE_INVALID', 'AMOUNT_INVALID', 'DATE_INVALID', 'PROMISE_NOT_FOUND', 'PROMISE_RESOLVED', 'REMINDER_NOT_FOUND', 'REMINDER_CLOSED',
  'PERIOD_CLOSED', 'FORBIDDEN'] as const
export function arErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (error?.code === '23514') return 'invalid'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === '40001' || /could not serialize/.test(m)) return 'retry'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}
const MESSAGES: Record<Locale, Record<string, string>> = {
  es: { payment_not_found: 'No se encontró el pago o no tienes permiso.', payment_already_voided: 'Ese pago ya fue anulado.', reason_required: 'Escribe un motivo (3 a 300 caracteres).',
    invoice_not_found: 'No se encontró la factura o no tienes permiso.', invoice_not_issued: 'La factura todavía es un borrador.', invoice_not_open: 'La factura no tiene balance pendiente.',
    status_invalid: 'Estado no válido.', client_invalid: 'Cliente no válido para esta empresa.', note_invalid: 'Escribe la nota (1 a 2000 caracteres).',
    amount_invalid: 'Importe no válido (mayor que cero y no más que el balance).', date_invalid: 'Fecha no válida (de hoy en adelante).',
    promise_not_found: 'No se encontró la promesa.', promise_resolved: 'Esa promesa ya está resuelta.', reminder_not_found: 'No se encontró el recordatorio.',
    reminder_closed: 'Ese recordatorio ya no admite cambios.', period_closed: 'Ese mes está cerrado en la contabilidad.',
    email_not_configured: 'El envío de correo todavía no está configurado (Resend). El recordatorio queda preparado; puedes registrarlo como contactado por otro medio.',
    email_invalid: 'El cliente no tiene un correo válido.', email_failed: 'El proveedor de correo rechazó el envío; quedó registrado como fallido.',
    forbidden: 'No tienes permiso para esta acción.', invalid: 'Revisa los datos del formulario.', retry: 'Otra operación terminó al mismo tiempo. Inténtalo de nuevo.',
    unavailable: 'Cuentas por cobrar todavía no está activado en esta base de datos.', save: 'No se pudo guardar. Inténtalo de nuevo.' },
  en: { payment_not_found: 'Payment not found or you have no permission.', payment_already_voided: 'That payment was already voided.', reason_required: 'Enter a reason (3 to 300 characters).',
    invoice_not_found: 'Invoice not found or you have no permission.', invoice_not_issued: 'The invoice is still a draft.', invoice_not_open: 'The invoice has no open balance.',
    status_invalid: 'Invalid status.', client_invalid: 'Invalid client for this company.', note_invalid: 'Write the note (1 to 2000 characters).',
    amount_invalid: 'Invalid amount (above zero and not above the balance).', date_invalid: 'Invalid date (today or later).',
    promise_not_found: 'Promise not found.', promise_resolved: 'That promise is already resolved.', reminder_not_found: 'Reminder not found.',
    reminder_closed: 'That reminder can no longer change.', period_closed: 'That month is closed in accounting.',
    email_not_configured: 'Email sending is not configured yet (Resend). The reminder stays ready; you can record it as contacted another way.',
    email_invalid: 'The client has no valid email.', email_failed: 'The email provider refused the message; it was recorded as failed.',
    forbidden: 'You do not have permission for this action.', invalid: 'Check the form data.', retry: 'Another operation finished at the same time. Try again.',
    unavailable: 'Receivables is not enabled in this database yet.', save: 'Could not save. Try again.' },
}
export function arMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

/**
 * General ledger (migration 0023): labels, error messages and form parsing.
 * PostgreSQL decides every rule (balance, immutability, periods, roles);
 * this module only prepares input and words the answers.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { parseCents } from '@/lib/finance/money'

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export type LedgerAccount = {
  id: string; code: string; name: string; name_en: string | null; type: AccountType; description: string | null
  status: 'active' | 'archived'; system_key: string | null
}
export type EntryRow = {
  id: string; entry_number: number; entry_date: string; description: string; reference: string | null; source: string
  source_id: string | null; currency: string; total_cents: number; reverses_entry_id: string | null; reversal_reason: string | null
  created_by: string | null; created_at: string
}
export type LineRow = {
  entry_id: string; line_no: number; account_id: string; debit_cents: number; credit_cents: number; memo: string | null
}

export type AccountingAccess = { view: boolean; manage: boolean; post: boolean; close: boolean; reopen: boolean; available: boolean; initialized: boolean }

/** What the signed-in user may do in the ledger of a company (the database enforces it). */
export async function accountingAccess(supabase: SupabaseClient, companyId: string): Promise<AccountingAccess> {
  const keys = ['view', 'manage', 'post', 'close', 'reopen'] as const
  const answers = await Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: `accounting.${k}` })))
  const [view, manage, post, close, reopen] = answers.map((a) => !a.error && a.data === true)
  const probe = await supabase.from('ledger_settings').select('company_id').eq('company_id', companyId).maybeSingle()
  const available = !probe.error
  return { view, manage, post, close, reopen, available, initialized: available && !!probe.data }
}

export function accountName(a: Pick<LedgerAccount, 'name' | 'name_en'>, locale: Locale): string {
  return locale === 'en' && a.name_en ? a.name_en : a.name
}

export function accountTypeLabel(t: string, locale: Locale): string {
  const es: Record<string, string> = { asset: 'Activo', liability: 'Pasivo', equity: 'Patrimonio', revenue: 'Ingreso', expense: 'Gasto' }
  const en: Record<string, string> = { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue', expense: 'Expense' }
  return (locale === 'en' ? en : es)[t] ?? t
}
export function accountTypePlural(t: string, locale: Locale): string {
  const es: Record<string, string> = { asset: 'Activos', liability: 'Pasivos', equity: 'Patrimonio', revenue: 'Ingresos', expense: 'Gastos' }
  const en: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' }
  return (locale === 'en' ? en : es)[t] ?? t
}

export function sourceLabel(s: string, locale: Locale): string {
  const es: Record<string, string> = { manual: 'Asiento manual', invoice: 'Factura emitida', invoice_void: 'Factura anulada', payment: 'Pago recibido', reversal: 'Reversión', opening: 'Saldo inicial',
    bill: 'Gasto aprobado', bill_void: 'Gasto anulado', bill_payment: 'Pago a proveedor', bill_payment_void: 'Pago a proveedor anulado', payment_void: 'Pago de cliente anulado', bank_adjustment: 'Movimiento bancario registrado', bank_reconciliation: 'Ajuste de conciliación' }
  const en: Record<string, string> = { manual: 'Manual entry', invoice: 'Invoice issued', invoice_void: 'Invoice voided', payment: 'Payment received', reversal: 'Reversal', opening: 'Opening balance',
    bill: 'Expense approved', bill_void: 'Expense voided', bill_payment: 'Vendor payment', bill_payment_void: 'Vendor payment voided', payment_void: 'Client payment voided', bank_adjustment: 'Bank item posted', bank_reconciliation: 'Reconciliation adjustment' }
  return (locale === 'en' ? en : es)[s] ?? s
}

const CODES = [
  'ENTRY_UNBALANCED', 'ENTRY_LINES_INVALID', 'ENTRY_LINE_INVALID', 'ENTRY_AMOUNT_INVALID', 'ENTRY_DESCRIPTION_REQUIRED', 'ENTRY_DATE_INVALID',
  'ENTRY_NOT_FOUND', 'ENTRY_ALREADY_REVERSED', 'ENTRY_FROM_DOCUMENT', 'REVERSAL_OF_REVERSAL', 'REVERSAL_REASON_REQUIRED',
  'ACCOUNT_INVALID', 'ACCOUNT_ARCHIVED', 'ACCOUNT_HAS_ENTRIES', 'ACCOUNT_LOCKED', 'ACCOUNT_SYSTEM', 'ACCOUNT_FIELD_LOCKED',
  'PERIOD_CLOSED', 'PERIOD_NOT_ENDED', 'PERIOD_ALREADY_CLOSED', 'PERIOD_NOT_CLOSED', 'REOPEN_REASON_REQUIRED',
  'LEDGER_NOT_INITIALIZED', 'LEDGER_IMMUTABLE', 'CURRENCY_NOT_SUPPORTED', 'LEDGER_DOCUMENT_INCONSISTENT', 'FORBIDDEN',
] as const

export function ledgerErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/ledger_accounts_company_id_code_key/.test(m)) return 'account_code_taken'
  if (error?.code === '23514') return 'invalid'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === '40001' || /could not serialize/.test(m)) return 'retry'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}

const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    entry_unbalanced: 'El asiento no cuadra: los débitos y los créditos deben sumar exactamente lo mismo.',
    entry_lines_invalid: 'Un asiento necesita al menos dos líneas.',
    entry_line_invalid: 'Cada línea lleva un débito o un crédito (no ambos, no ninguno).',
    entry_amount_invalid: 'Importe no válido: usa números positivos con hasta dos decimales.',
    entry_description_required: 'Escribe una descripción.',
    entry_date_invalid: 'Fecha contable no válida.',
    entry_not_found: 'No se encontró el asiento o no tienes permiso.',
    entry_already_reversed: 'Ese asiento ya fue revertido.',
    entry_from_document: 'Ese asiento viene de un documento: se corrige anulando el documento, no a mano.',
    reversal_of_reversal: 'Una reversión no se revierte: registra un asiento nuevo.',
    reversal_reason_required: 'Explica el motivo de la reversión (3 a 300 caracteres).',
    account_invalid: 'Cuenta no válida para esta empresa.',
    account_archived: 'La cuenta está archivada y no acepta movimientos nuevos.',
    account_has_entries: 'La cuenta tiene movimientos: no se borra; puedes archivarla.',
    account_locked: 'El código y el tipo de una cuenta con movimientos no cambian.',
    account_system: 'Las cuentas del sistema se pueden renombrar, pero no borrar, archivar ni cambiar de tipo.',
    account_field_locked: 'Ese dato de la cuenta no cambia.',
    account_code_taken: 'Ya existe una cuenta con ese código.',
    period_closed: 'Ese mes está cerrado: no admite asientos con esa fecha.',
    period_not_ended: 'Solo se cierran meses terminados.',
    period_already_closed: 'Ese mes ya está cerrado.',
    period_not_closed: 'Ese mes no está cerrado.',
    reopen_reason_required: 'Explica por qué reabres el mes (3 a 300 caracteres).',
    ledger_not_initialized: 'Activa primero la contabilidad (catálogo predeterminado).',
    ledger_immutable: 'Los registros contables publicados no se modifican; usa una reversión.',
    currency_not_supported: 'Por ahora solo se registra en la moneda base de la empresa (USD).',
    ledger_document_inconsistent: 'El documento tiene importes incoherentes (impuesto mayor que el total).',
    forbidden: 'No tienes permiso para esta acción.',
    invalid: 'Revisa los datos del formulario.',
    retry: 'Otra operación contable terminó al mismo tiempo. Vuelve a intentarlo.',
    unavailable: 'La contabilidad todavía no está activada en esta base de datos.',
    save: 'No se pudo guardar. Inténtalo de nuevo.',
  },
  en: {
    entry_unbalanced: 'The entry does not balance: debits and credits must add up to exactly the same amount.',
    entry_lines_invalid: 'An entry needs at least two lines.',
    entry_line_invalid: 'Each line is a debit or a credit (not both, not neither).',
    entry_amount_invalid: 'Invalid amount: use positive numbers with up to two decimals.',
    entry_description_required: 'Enter a description.',
    entry_date_invalid: 'Invalid accounting date.',
    entry_not_found: 'Entry not found or you have no permission.',
    entry_already_reversed: 'That entry was already reversed.',
    entry_from_document: 'That entry comes from a document: correct it by voiding the document, not by hand.',
    reversal_of_reversal: 'A reversal is not reversed: post a new entry.',
    reversal_reason_required: 'Explain the reason for the reversal (3 to 300 characters).',
    account_invalid: 'Invalid account for this company.',
    account_archived: 'The account is archived and takes no new movements.',
    account_has_entries: 'The account has movements: it is not deleted; you can archive it.',
    account_locked: 'The code and type of an account with movements do not change.',
    account_system: 'System accounts can be renamed, but not deleted, archived or retyped.',
    account_field_locked: 'That account field does not change.',
    account_code_taken: 'An account with that code already exists.',
    period_closed: 'That month is closed: it takes no entries dated in it.',
    period_not_ended: 'Only finished months can be closed.',
    period_already_closed: 'That month is already closed.',
    period_not_closed: 'That month is not closed.',
    reopen_reason_required: 'Explain why you reopen the month (3 to 300 characters).',
    ledger_not_initialized: 'Activate accounting first (default chart).',
    ledger_immutable: 'Posted accounting records are not modified; use a reversal.',
    currency_not_supported: 'For now only the company base currency (USD) is recorded.',
    ledger_document_inconsistent: 'The document has inconsistent amounts (tax above the total).',
    forbidden: 'You do not have permission for this action.',
    invalid: 'Check the form data.',
    retry: 'Another accounting operation finished at the same time. Try again.',
    unavailable: 'Accounting is not enabled in this database yet.',
    save: 'Could not save. Try again.',
  },
}

export function ledgerMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

export type EntryLineInput = { account: string; debit: string; credit: string; memo: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Lines of the manual-entry form (account_N, debit_N, credit_N, memo_N).
 * Empty rows are skipped. Amounts become integer cents as STRINGS (JSON
 * numbers above 2^53 would lose precision). Returns an error code when a
 * row is invalid or the entry does not balance — the database checks again.
 */
export function parseEntryLines(f: FormData, rows = 12): { lines: EntryLineInput[]; debit: bigint; credit: bigint } | { error: string } {
  const lines: EntryLineInput[] = []
  let debit = 0n
  let credit = 0n
  for (let i = 0; i < rows; i++) {
    const account = String(f.get(`account_${i}`) ?? '').trim()
    const d = String(f.get(`debit_${i}`) ?? '').trim()
    const c = String(f.get(`credit_${i}`) ?? '').trim()
    const memo = String(f.get(`memo_${i}`) ?? '').trim().slice(0, 200) || null
    if (!account && !d && !c) continue
    if (!UUID.test(account)) return { error: 'account_invalid' }
    const dc = d ? parseCents(d) : 0n
    const cc = c ? parseCents(c) : 0n
    if (dc === null || cc === null) return { error: 'entry_amount_invalid' }
    if ((dc > 0n) === (cc > 0n)) return { error: 'entry_line_invalid' }
    debit += dc
    credit += cc
    lines.push({ account, debit: dc.toString(), credit: cc.toString(), memo })
  }
  if (lines.length < 2) return { error: 'entry_lines_invalid' }
  if (debit !== credit) return { error: 'entry_unbalanced' }
  return { lines, debit, credit }
}

/** First day of the month of a 'YYYY-MM' or 'YYYY-MM-DD' value, or null. */
export function monthStart(v: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null
  return `${m[1]}-${m[2]}-01`
}

/** 'YYYY-MM-DD' or null. */
export function isoDay(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T12:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v
}

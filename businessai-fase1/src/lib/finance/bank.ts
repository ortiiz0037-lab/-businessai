/**
 * Bank reconciliation (migration 0026): labels, error messages and access.
 * Matching and reconciliation run in PostgreSQL against the ledger lines of
 * the linked account; nothing here keeps amounts of its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'

export type BankAccount = { id: string; name: string; bank_name: string | null; currency: string; last4: string | null; ledger_account_id: string; status: 'active' | 'archived'; created_at: string }
export type BankLine = { id: string; bank_account_id: string; import_id: string; line_no: number; txn_date: string; description: string; reference: string | null
  amount_cents: number; balance_cents: number | null; bank_txn_id: string | null; status: 'unmatched' | 'matched' | 'excluded'; reconciliation_id: string | null; raw: Record<string, string> }
export type Suggestion = { bank_line_id: string; journal_line_ids: number[]; confidence: number; reason: string; ambiguous: boolean }
export type OpenJournalLine = { journal_line_id: number; entry_id: string; entry_number: number; entry_date: string; source: string; source_id: string | null
  description: string; reference: string | null; memo: string | null; amount_cents: number }
export type Reconciliation = { id: string; bank_account_id: string; period_start: string; period_end: string; statement_opening_cents: number; statement_closing_cents: number
  status: 'open' | 'closed'; adjustment_entry_id: string | null; adjustment_reason: string | null; closed_at: string | null; closed_by: string | null
  reopened_at: string | null; reopened_by: string | null; reopen_reason: string | null; note: string | null; created_at: string }
export type RecSummary = { statement_opening_cents: number; statement_closing_cents: number; statement_lines_cents: number; statement_difference_cents: number
  ledger_balance_cents: number; uncleared_book_cents: number; uncleared_book_count: number; bank_booked_later_cents: number; adjusted_bank_cents: number
  difference_cents: number; unmatched_bank_count: number; unmatched_bank_cents: number; matched_bank_count: number; previous_closing_cents: number | null; continuity_ok: boolean }

export type BankAccess = { view: boolean; manage: boolean; reconcile: boolean; adjust: boolean; reopen: boolean; post: boolean; available: boolean }

export async function bankAccess(supabase: SupabaseClient, companyId: string): Promise<BankAccess> {
  const keys = ['bank.view', 'bank.manage', 'bank.reconcile', 'bank.adjust', 'bank.reopen', 'accounting.post']
  const [answers, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    supabase.from('bank_accounts').select('id').eq('company_id', companyId).limit(1),
  ])
  const [view, manage, reconcile, adjust, reopen, post] = answers.map((a) => !a.error && a.data === true)
  return { view, manage, reconcile, adjust, reopen, post, available: !probe.error }
}

const L = (locale: Locale, es: Record<string, string>, en: Record<string, string>, k: string) => (locale === 'en' ? en : es)[k] ?? k

export const lineStatusLabel = (s: string, locale: Locale) =>
  L(locale, { unmatched: 'Pendiente', matched: 'Emparejado', excluded: 'Excluido', reconciled: 'Conciliado' },
    { unmatched: 'Pending', matched: 'Matched', excluded: 'Excluded', reconciled: 'Reconciled' }, s)
export const lineStatusTone = (s: string) => ({ unmatched: 'badge-warning', matched: 'badge-accent', excluded: 'badge-neutral', reconciled: 'badge-success' } as Record<string, string>)[s] ?? 'badge-neutral'
export const reasonLabel = (s: string, locale: Locale) =>
  L(locale, { amount_reference_date: 'Importe, fecha y referencia', amount_date: 'Importe y fecha', amount_near_date: 'Importe y fecha cercana',
    group_same_date: 'Varias partidas del mismo día suman el importe', bank_fee_or_unknown: 'Parece comisión bancaria o movimiento desconocido' },
    { amount_reference_date: 'Amount, date and reference', amount_date: 'Amount and date', amount_near_date: 'Amount and nearby date',
      group_same_date: 'Several same-day items add up to the amount', bank_fee_or_unknown: 'Looks like a bank fee or unknown item' }, s)
export const bankEventLabel = (a: string, locale: Locale) =>
  L(locale, { created: 'Creado', updated: 'Modificado', active: 'Reactivada', archived: 'Archivada', imported: 'Estado importado', reverted: 'Importación revertida',
    matched: 'Emparejado', unmatched: 'Emparejamiento deshecho', auto_matched: 'Emparejamiento automático', posted: 'Asiento registrado', adjusted: 'Ajuste autorizado',
    closed: 'Conciliación cerrada', reopened: 'Conciliación reabierta' },
    { created: 'Created', updated: 'Changed', active: 'Restored', archived: 'Archived', imported: 'Statement imported', reverted: 'Import reverted', matched: 'Matched',
      unmatched: 'Match undone', auto_matched: 'Auto-match', posted: 'Entry posted', adjusted: 'Adjustment authorised', closed: 'Reconciliation closed', reopened: 'Reconciliation reopened' }, a)

const CODES = ['BANK_ACCOUNT_NOT_FOUND', 'BANK_ACCOUNT_ARCHIVED', 'BANK_ACCOUNT_HAS_OPEN_RECONCILIATION', 'BANK_LEDGER_ACCOUNT_INVALID', 'BANK_LEDGER_ACCOUNT_LOCKED',
  'LAST4_INVALID', 'CURRENCY_NOT_SUPPORTED', 'IMPORT_INVALID', 'IMPORT_ROW_INVALID', 'IMPORT_NOT_FOUND', 'IMPORT_ALREADY_REVERTED', 'IMPORT_HAS_MATCHES',
  'MATCH_INVALID', 'MATCH_AMOUNT_MISMATCH', 'MATCH_NOT_FOUND', 'MATCH_ALREADY_VOIDED', 'BANK_LINE_NOT_FOUND', 'BANK_LINE_NOT_AVAILABLE', 'JOURNAL_LINE_NOT_AVAILABLE',
  'BANK_LINE_ALREADY_POSTED', 'BANK_LINE_RECONCILED', 'RECONCILIATION_NOT_FOUND', 'RECONCILIATION_OVERLAP', 'RECONCILIATION_CLOSED', 'RECONCILIATION_NOT_CLOSED',
  'RECONCILIATION_NOT_LATEST', 'RECONCILIATION_NOT_BALANCED', 'RECONCILIATION_INCOMPLETE', 'RECONCILIATION_ALREADY_ADJUSTED', 'NOTHING_TO_ADJUST',
  'ADJUSTMENT_REASON_REQUIRED', 'STATEMENT_GAP', 'STATEMENT_INCOMPLETE', 'UNMATCHED_LINES', 'REASON_REQUIRED', 'ACCOUNT_INVALID', 'DATE_INVALID',
  'AMOUNT_INVALID', 'PERIOD_CLOSED', 'PAYMENT_ACCOUNT_INVALID', 'FORBIDDEN'] as const
export function bankErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/bank_accounts_ledger_uidx/.test(m)) return 'bank_ledger_taken'
  if (/bank_accounts_name_uidx/.test(m)) return 'bank_name_taken'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === '40001' || /could not serialize/.test(m)) return 'retry'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}
const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    bank_account_not_found: 'No se encontró la cuenta bancaria o no tienes permiso.', bank_account_archived: 'La cuenta bancaria está archivada.',
    bank_account_has_open_reconciliation: 'Cierra o termina la conciliación abierta antes de archivar.', bank_ledger_account_invalid: 'Elige una cuenta de activo activa (Efectivo, Banco…).',
    bank_ledger_account_locked: 'La cuenta contable no cambia una vez hay movimientos emparejados.', bank_ledger_taken: 'Esa cuenta contable ya está vinculada a otra cuenta bancaria.',
    bank_name_taken: 'Ya existe una cuenta bancaria con ese nombre.', last4_invalid: 'Escribe exactamente los últimos 4 dígitos.', currency_not_supported: 'Por ahora solo la moneda base (USD).',
    import_invalid: 'El archivo no tiene filas válidas.', import_row_invalid: 'Una fila no es válida; revisa el mapeo de columnas.', import_not_found: 'No se encontró la importación.',
    import_already_reverted: 'Esa importación ya fue revertida.', import_has_matches: 'Deshaz los emparejamientos de esa importación antes de revertirla.',
    match_invalid: 'Selecciona al menos un movimiento bancario y una partida contable.', match_amount_mismatch: 'Las sumas no coinciden exactamente.',
    match_not_found: 'No se encontró el emparejamiento.', match_already_voided: 'Ese emparejamiento ya fue deshecho.', bank_line_not_found: 'No se encontró el movimiento.',
    bank_line_not_available: 'El movimiento ya está emparejado, excluido o es de otra cuenta.', journal_line_not_available: 'La partida ya está emparejada o no es de esta cuenta contable.',
    bank_line_already_posted: 'Ese movimiento ya tiene un asiento; emparéjalo con él.', bank_line_reconciled: 'Está en una conciliación cerrada: reábrela primero.',
    reconciliation_not_found: 'No se encontró la conciliación.', reconciliation_overlap: 'Ese periodo se solapa con otra conciliación de la cuenta.',
    reconciliation_closed: 'La conciliación está cerrada.', reconciliation_not_closed: 'La conciliación no está cerrada.', reconciliation_not_latest: 'Reabre primero las conciliaciones posteriores.',
    reconciliation_not_balanced: 'La diferencia no es cero: empareja, registra los movimientos faltantes o pide un ajuste autorizado.',
    reconciliation_incomplete: 'Primero importa y empareja todos los movimientos del periodo.', reconciliation_already_adjusted: 'Esta conciliación ya tiene un ajuste.',
    nothing_to_adjust: 'No hay diferencia que ajustar.', adjustment_reason_required: 'Documenta el ajuste (al menos 10 caracteres).',
    statement_gap: 'El saldo inicial no coincide con el saldo final de la conciliación anterior.', statement_incomplete: 'Saldo inicial + movimientos ≠ saldo final: faltan o sobran movimientos.',
    unmatched_lines: 'Quedan movimientos bancarios sin emparejar en el periodo.', reason_required: 'Escribe un motivo (3 a 300 caracteres).', account_invalid: 'Cuenta contable no válida.',
    date_invalid: 'Fechas no válidas.', amount_invalid: 'Importe no válido.', period_closed: 'Ese mes está cerrado en la contabilidad.', payment_account_invalid: 'Cuenta de depósito no válida.',
    file_missing: 'Elige un archivo CSV.', file_too_large: 'El archivo supera 2 MB.', file_rows_invalid: 'Hay filas con errores; corrige el mapeo o el archivo.',
    mapping_date: 'Indica la columna de fecha.', mapping_description: 'Indica la columna de descripción.', mapping_amount: 'Indica una columna de importe o bien débito y crédito.',
    mapping_column: 'Una columna indicada no existe.', mapping_format: 'Formato de fecha o decimal no válido.',
    forbidden: 'No tienes permiso para esta acción.', retry: 'Otra operación terminó al mismo tiempo. Inténtalo de nuevo.', unavailable: 'La conciliación bancaria todavía no está activada en esta base de datos.',
    save: 'No se pudo guardar. Inténtalo de nuevo.',
  },
  en: {
    bank_account_not_found: 'Bank account not found or you have no permission.', bank_account_archived: 'The bank account is archived.',
    bank_account_has_open_reconciliation: 'Close or finish the open reconciliation before archiving.', bank_ledger_account_invalid: 'Choose an active asset account (Cash, Bank…).',
    bank_ledger_account_locked: 'The ledger account does not change once lines are matched.', bank_ledger_taken: 'That ledger account is already linked to another bank account.',
    bank_name_taken: 'A bank account with that name already exists.', last4_invalid: 'Enter exactly the last 4 digits.', currency_not_supported: 'Only the base currency (USD) for now.',
    import_invalid: 'The file has no valid rows.', import_row_invalid: 'A row is invalid; check the column mapping.', import_not_found: 'Import not found.',
    import_already_reverted: 'That import was already reverted.', import_has_matches: 'Undo the matches of that import before reverting it.',
    match_invalid: 'Select at least one bank line and one ledger item.', match_amount_mismatch: 'The sums do not match exactly.',
    match_not_found: 'Match not found.', match_already_voided: 'That match was already undone.', bank_line_not_found: 'Line not found.',
    bank_line_not_available: 'The line is already matched, excluded or belongs to another account.', journal_line_not_available: 'The ledger item is already matched or not on this ledger account.',
    bank_line_already_posted: 'That line already has an entry; match it with it.', bank_line_reconciled: 'It belongs to a closed reconciliation: reopen it first.',
    reconciliation_not_found: 'Reconciliation not found.', reconciliation_overlap: 'That period overlaps another reconciliation of the account.',
    reconciliation_closed: 'The reconciliation is closed.', reconciliation_not_closed: 'The reconciliation is not closed.', reconciliation_not_latest: 'Reopen the later reconciliations first.',
    reconciliation_not_balanced: 'The difference is not zero: match, record the missing items or ask for an authorised adjustment.',
    reconciliation_incomplete: 'First import and match every line of the period.', reconciliation_already_adjusted: 'This reconciliation already has an adjustment.',
    nothing_to_adjust: 'There is no difference to adjust.', adjustment_reason_required: 'Document the adjustment (at least 10 characters).',
    statement_gap: 'The opening balance does not equal the closing balance of the previous reconciliation.', statement_incomplete: 'Opening + lines ≠ closing: lines are missing or extra.',
    unmatched_lines: 'Bank lines of the period are still unmatched.', reason_required: 'Enter a reason (3 to 300 characters).', account_invalid: 'Invalid ledger account.',
    date_invalid: 'Invalid dates.', amount_invalid: 'Invalid amount.', period_closed: 'That month is closed in accounting.', payment_account_invalid: 'Invalid deposit account.',
    file_missing: 'Choose a CSV file.', file_too_large: 'The file is above 2 MB.', file_rows_invalid: 'Some rows have errors; fix the mapping or the file.',
    mapping_date: 'Choose the date column.', mapping_description: 'Choose the description column.', mapping_amount: 'Choose an amount column, or debit and credit.',
    mapping_column: 'A chosen column does not exist.', mapping_format: 'Invalid date or decimal format.',
    forbidden: 'You do not have permission for this action.', retry: 'Another operation finished at the same time. Try again.', unavailable: 'Bank reconciliation is not enabled in this database yet.',
    save: 'Could not save. Try again.',
  },
}
export function bankMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return MESSAGES[locale][code] ?? MESSAGES[locale].save
}

/** CSV cell escaping for exports (formula injection guarded). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

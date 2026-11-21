/** Banking (S6): error codes from the database / provider and their messages, ES / EN. */
import type { Locale } from '@/lib/i18n/app'

const CODES = ['FORBIDDEN', 'BANK_SERVER_AUTH', 'BANK_CONNECTION_INVALID', 'BANK_CONNECTION_NOT_FOUND', 'BANK_ACCOUNT_NOT_FOUND', 'BANK_SYNC_INVALID', 'BRANCH_INVALID',
  'BANK_LINE_NOT_FOUND', 'BANK_LINE_NOT_AVAILABLE', 'BANK_LINE_NOT_DEPOSIT', 'BANK_LINE_RECONCILED', 'DEPOSIT_INVALID', 'DEPOSIT_OVER_APPLIED', 'BANK_PAYMENT_NOT_IN_BANK',
  'PAYMENT_NOT_FOUND', 'PAYMENT_ALREADY_LINKED', 'ALLOCATION_NOT_FOUND', 'REASON_REQUIRED', 'RECEIPT_INVALID', 'RECEIPT_NOT_FOUND', 'RECEIPT_LOCKED', 'RECEIPT_LINK_INVALID',
  'PAYMENT_EXCEEDS_BALANCE', 'PAYMENT_NOT_ALLOWED', 'PERIOD_CLOSED']

export function bankingErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (/bank_provider_accounts_bank_uidx/.test(m)) return 'provider_account_taken'
  if (/exceeds|balance/i.test(m) && /payment/i.test(m)) return 'payment_exceeds_balance'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}

const ES: Record<string, string> = {
  forbidden: 'Tu rol no permite esta acción.', bank_server_auth: 'La firma del servidor no es válida (revise BANK_SERVER_KEYS). No se guardó nada.',
  bank_connection_invalid: 'La conexión no es válida o pertenece a otra empresa.', bank_connection_not_found: 'No se encontró la conexión bancaria.',
  bank_account_not_found: 'No se encontró la cuenta bancaria o no tienes permiso.', bank_sync_invalid: 'El proveedor envió datos no válidos; no se guardó nada.',
  branch_invalid: 'La sucursal no es válida o está archivada.', bank_line_not_found: 'No se encontró el movimiento.',
  bank_line_not_available: 'El movimiento ya está emparejado o excluido.', bank_line_not_deposit: 'Solo los depósitos (entradas de dinero) se aplican a facturas.',
  bank_line_reconciled: 'Está en una conciliación cerrada: reábrela primero.', deposit_invalid: 'Revisa las facturas y los importes elegidos.',
  deposit_over_applied: 'La suma aplicada supera el depósito.', bank_payment_not_in_bank: 'Ese pago no se registró como depositado en esta cuenta bancaria.',
  payment_not_found: 'No se encontró el pago.', payment_already_linked: 'Ese pago ya está vinculado a otro depósito.',
  allocation_not_found: 'No se encontró la aplicación o ya fue deshecha.', reason_required: 'Escribe el motivo (3 a 300 caracteres).',
  receipt_invalid: 'El archivo o los datos del recibo no son válidos.', receipt_not_found: 'No se encontró el recibo.', receipt_locked: 'El recibo ya fue confirmado o descartado.',
  receipt_link_invalid: 'El gasto o pago elegido no es válido.', payment_exceeds_balance: 'El importe supera el balance pendiente de la factura.',
  payment_not_allowed: 'Esa factura no admite pagos.', period_closed: 'El periodo contable está cerrado.', provider_account_taken: 'Esa cuenta ya está vinculada a otra cuenta del proveedor.',
  unavailable: 'La banca conectada todavía no está activada en esta base de datos (migración 0042).', not_configured: 'La conexión bancaria no está configurada en el servidor.',
  provider_error: 'El proveedor bancario respondió con un error.', no_linked_accounts: 'Vincula al menos una cuenta antes de sincronizar.',
  disconnected: 'La conexión está desconectada.', confirm_required: 'Marca la casilla para confirmar.', file: 'Sube una foto (JPG, PNG, WebP) o un PDF de hasta 10 MB.',
  date: 'Escribe la fecha como AAAA-MM-DD.', total: 'Escribe el total (mayor que cero).', tax: 'El impuesto no es válido o supera el total.', currency: 'Escribe la moneda (por ejemplo USD).',
  save: 'No se pudo guardar. Inténtalo nuevamente.',
}
const EN: Record<string, string> = {
  forbidden: 'Your role cannot do this.', bank_server_auth: 'The server signature is not valid (check BANK_SERVER_KEYS). Nothing was saved.',
  bank_connection_invalid: 'The connection is not valid or belongs to another company.', bank_connection_not_found: 'The bank connection was not found.',
  bank_account_not_found: 'The bank account was not found or you lack permission.', bank_sync_invalid: 'The provider sent invalid data; nothing was saved.',
  branch_invalid: 'The branch is not valid or is archived.', bank_line_not_found: 'The bank line was not found.',
  bank_line_not_available: 'The line is already matched or excluded.', bank_line_not_deposit: 'Only deposits (money in) are applied to invoices.',
  bank_line_reconciled: 'It is in a closed reconciliation: reopen it first.', deposit_invalid: 'Check the chosen invoices and amounts.',
  deposit_over_applied: 'The applied total is more than the deposit.', bank_payment_not_in_bank: 'That payment was not recorded as deposited into this bank account.',
  payment_not_found: 'The payment was not found.', payment_already_linked: 'That payment is already linked to another deposit.',
  allocation_not_found: 'The application was not found or was already undone.', reason_required: 'Write the reason (3 to 300 characters).',
  receipt_invalid: 'The receipt file or data is not valid.', receipt_not_found: 'The receipt was not found.', receipt_locked: 'The receipt was already confirmed or discarded.',
  receipt_link_invalid: 'The chosen expense or payment is not valid.', payment_exceeds_balance: 'The amount is more than the invoice\'s open balance.',
  payment_not_allowed: 'That invoice does not accept payments.', period_closed: 'The accounting period is closed.', provider_account_taken: 'That account is already linked to another provider account.',
  unavailable: 'Connected banking is not enabled in this database yet (migration 0042).', not_configured: 'Bank connections are not configured on the server.',
  provider_error: 'The bank data provider answered with an error.', no_linked_accounts: 'Link at least one account before syncing.',
  disconnected: 'The connection is disconnected.', confirm_required: 'Tick the box to confirm.', file: 'Upload a photo (JPG, PNG, WebP) or a PDF up to 10 MB.',
  date: 'Write the date as YYYY-MM-DD.', total: 'Write the total (greater than zero).', tax: 'The tax is not valid or is more than the total.', currency: 'Write the currency (for example USD).',
  save: 'It could not be saved. Please try again.',
}
export function bankingMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  const t = locale === 'en' ? EN : ES
  return t[code] ?? t.save
}

export const CONNECTION_STATUS: Record<string, { es: string; en: string; tone: 'ok' | 'pending' | 'issue' }> = {
  active: { es: 'Conectada', en: 'Connected', tone: 'ok' },
  login_required: { es: 'Requiere reconectar', en: 'Reconnect needed', tone: 'issue' },
  pending_disconnect: { es: 'Caducará pronto: reconecte', en: 'Expiring soon: reconnect', tone: 'pending' },
  revoked: { es: 'Permiso revocado por el cliente', en: 'Permission revoked by the customer', tone: 'issue' },
  error: { es: 'Error del proveedor', en: 'Provider error', tone: 'issue' },
  disconnected: { es: 'Desconectada', en: 'Disconnected', tone: 'pending' },
}
export const ENVIRONMENT_LABEL: Record<string, { es: string; en: string }> = {
  production: { es: 'Producción', en: 'Production' },
  sandbox: { es: 'Sandbox del proveedor (datos de prueba, no reales)', en: 'Provider sandbox (test data, not real)' },
  test_double: { es: 'DOBLE DE PRUEBA local (no es un banco real)', en: 'Local TEST DOUBLE (not a real bank)' },
}

export const RECEIPT_FIELDS = ['date', 'merchant', 'receipt_number', 'total_cents', 'tax_cents', 'payment_method', 'reference', 'currency'] as const
export const RECEIPT_FIELD_LABEL: Record<(typeof RECEIPT_FIELDS)[number], { es: string; en: string }> = {
  date: { es: 'Fecha', en: 'Date' }, merchant: { es: 'Comercio', en: 'Merchant' }, receipt_number: { es: 'Nº de recibo', en: 'Receipt no.' },
  total_cents: { es: 'Total', en: 'Total' }, tax_cents: { es: 'Impuestos', en: 'Taxes' }, payment_method: { es: 'Método de pago', en: 'Payment method' },
  reference: { es: 'Referencia', en: 'Reference' }, currency: { es: 'Moneda', en: 'Currency' },
}

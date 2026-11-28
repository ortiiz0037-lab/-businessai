/** Point of sale (S8): labels, error codes and messages, ES / EN. */
import type { Locale } from '@/lib/i18n/app'

type L = { es: string; en: string }
const pick = (m: Record<string, L>, k: string, locale: Locale) => m[k]?.[locale] ?? k

const METHOD: Record<string, L> = {
  cash: { es: 'Efectivo', en: 'Cash' }, check: { es: 'Cheque', en: 'Check' }, ath_movil: { es: 'ATH Móvil', en: 'ATH Móvil' },
  transfer: { es: 'Transferencia', en: 'Transfer' }, card: { es: 'Tarjeta (integrada)', en: 'Card (integrated)' },
  card_external: { es: 'Tarjeta (terminal externa)', en: 'Card (stand-alone terminal)' }, gift_card: { es: 'Tarjeta de regalo', en: 'Gift card' },
  store_credit: { es: 'Crédito de tienda', en: 'Store credit' }, other: { es: 'Otro', en: 'Other' },
}
export const methodLabel = (m: string, locale: Locale) => pick(METHOD, m, locale)

const SALE_STATUS: Record<string, L> = {
  completed: { es: 'Completada', en: 'Completed' }, partially_refunded: { es: 'Devuelta en parte', en: 'Partly refunded' }, refunded: { es: 'Devuelta', en: 'Refunded' },
  voided: { es: 'Anulada', en: 'Voided' }, open: { es: 'Abierto', en: 'Open' }, closed: { es: 'Cerrado', en: 'Closed' }, pending_review: { es: 'Diferencia por revisar', en: 'Difference to review' },
  reviewed: { es: 'Revisado', en: 'Reviewed' }, posted: { es: 'Inventario aplicado', en: 'Stock posted' }, not_required: { es: 'Sin inventario', en: 'No stock' },
  blocked: { es: 'Inventario bloqueado', en: 'Stock blocked' }, received: { es: 'Recibido', en: 'Received' }, applied: { es: 'Aplicado', en: 'Applied' },
  duplicate: { es: 'Duplicado', en: 'Duplicate' }, stale: { es: 'Versión antigua', en: 'Older version' }, ignored: { es: 'Ignorado', en: 'Ignored' },
  needs_review: { es: 'Por revisar', en: 'Needs review' }, failed: { es: 'Falló (se reintentará)', en: 'Failed (will retry)' }, dead: { es: 'Sin más reintentos', en: 'No more retries' },
  active: { es: 'Activa', en: 'Active' }, error: { es: 'Con error', en: 'Error' }, login_required: { es: 'Reconectar', en: 'Reconnect' }, disconnected: { es: 'Desconectada', en: 'Disconnected' },
  succeeded: { es: 'Correcta', en: 'Succeeded' }, partial: { es: 'Parcial', en: 'Partial' }, paid: { es: 'Depositada', en: 'Paid' }, in_transit: { es: 'En tránsito', en: 'In transit' },
  pending: { es: 'Pendiente', en: 'Pending' },
}
export const posStatus = (s: string, locale: Locale) => pick(SALE_STATUS, s, locale)
export const posTone = (s: string): 'ok' | 'pending' | 'issue' =>
  ['completed', 'closed', 'reviewed', 'posted', 'applied', 'active', 'succeeded', 'paid', 'not_required', 'duplicate'].includes(s) ? 'ok'
    : ['voided', 'blocked', 'failed', 'dead', 'error', 'needs_review', 'disconnected'].includes(s) ? 'issue' : 'pending'

const REVIEW: Record<string, L> = {
  item_unmapped: { es: 'Producto del proveedor sin asignar al catálogo', en: 'Provider product not mapped to the catalog' },
  location_unmapped: { es: 'Ubicación sin sucursal asignada', en: 'Location without a branch' },
  totals_mismatch: { es: 'Los importes no cuadran con el total (propinas, cargos o impuesto incluido)', en: 'Amounts do not add up to the total (tips, charges or inclusive tax)' },
  payments_mismatch: { es: 'Los pagos no suman el total', en: 'Payments do not add up to the total' },
  payment_duplicate: { es: 'El pago del proveedor ya está en otra venta', en: 'The provider payment is already on another sale' },
  variant_required: { es: 'Falta la variante del producto', en: 'The product variant is missing' }, currency: { es: 'Moneda distinta de USD', en: 'Currency other than USD' },
  occurred_at: { es: 'Fecha no válida', en: 'Invalid date' }, line_invalid: { es: 'Línea no válida', en: 'Invalid line' }, lines: { es: 'Sin líneas', en: 'No lines' },
  void_after_refund: { es: 'Anulada en el proveedor después de una devolución', en: 'Voided at the provider after a refund' },
  refund_line_unknown: { es: 'Devolución de una línea desconocida', en: 'Refund of an unknown line' }, unknown_account: { es: 'Cuenta del proveedor no conectada', en: 'Provider account not connected' },
}
export const reviewReason = (code: string | null | undefined, locale: Locale) => (code ? pick(REVIEW, code, locale) : '—')

const CODES = ['FORBIDDEN', 'BRANCH_FORBIDDEN', 'POS_SHIFT_REQUIRED', 'POS_SHIFT_NOT_OPEN', 'POS_SHIFT_ALREADY_OPEN', 'POS_SHIFT_NOT_PENDING', 'POS_NOT_YOUR_SHIFT',
  'POS_REGISTER_INVALID', 'POS_REGISTER_NOT_ASSIGNED', 'POS_PAYMENTS_MISMATCH', 'POS_PAYMENTS_INVALID', 'POS_PAYMENT_METHOD_INVALID', 'POS_PAYMENT_REFERENCE_REQUIRED',
  'POS_STOCK_UNAVAILABLE', 'POS_LINES_INVALID', 'POS_ITEM_INVALID', 'POS_QTY_INVALID', 'POS_DISCOUNT_INVALID', 'POS_CLIENT_INVALID', 'POS_APPROVAL_REQUIRED',
  'POS_VOID_NOT_ALLOWED', 'POS_REFUND_NOT_ALLOWED', 'POS_REFUND_EXCEEDS', 'POS_REFUND_ZERO', 'POS_CASH_INSUFFICIENT', 'POS_SELF_APPROVAL', 'POS_EXTERNAL_SALE',
  'POS_IMPORT_INVALID', 'POS_INTEGRATION_TAKEN', 'POS_INTEGRATION_INVALID', 'POS_SETTLEMENT_AMOUNT', 'POS_SYNC_NOT_RETRYABLE', 'POS_NOT_FOUND', 'POS_INVALID',
  'INVENTORY_VARIANT_REQUIRED', 'REASON_REQUIRED', 'BANK_LINE_NOT_AVAILABLE', 'PERIOD_CLOSED']

export function posErrorCode(e: { message?: string | null; code?: string | null } | null | undefined): string {
  const m = e?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (e?.code === '42501' || /permission denied|row-level security/.test(m)) return 'forbidden'
  if (e?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  if (/_check|violates check/.test(m)) return 'pos_invalid'
  return 'save'
}

const MSG: Record<string, L> = {
  forbidden: { es: 'Tu rol no permite esta acción.', en: 'Your role cannot do this.' },
  branch_forbidden: { es: 'No tienes acceso a esa sucursal.', en: 'You do not have access to that branch.' },
  pos_shift_required: { es: 'Abre tu turno de caja antes de vender o cobrar en efectivo.', en: 'Open your cash shift before selling or taking cash.' },
  pos_shift_not_open: { es: 'El turno no está abierto o es de otro cajero.', en: 'The shift is not open or belongs to another cashier.' },
  pos_shift_already_open: { es: 'Ya hay un turno abierto en esa caja o para ti.', en: 'There is already an open shift on that register or for you.' },
  pos_shift_not_pending: { es: 'Ese cierre no tiene diferencias por revisar.', en: 'That closing has no difference to review.' },
  pos_not_your_shift: { es: 'Ese turno es de otro cajero.', en: 'That shift belongs to another cashier.' },
  pos_register_invalid: { es: 'La caja no es válida para esta sucursal.', en: 'The register is not valid for this branch.' },
  pos_register_not_assigned: { es: 'Esta caja está asignada a otros cajeros.', en: 'This register is assigned to other cashiers.' },
  pos_payments_mismatch: { es: 'Los pagos deben sumar exactamente el total.', en: 'Payments must add up exactly to the total.' },
  pos_payments_invalid: { es: 'Revisa los pagos.', en: 'Check the payments.' },
  pos_payment_method_invalid: { es: 'Método de pago no disponible. Las tarjetas integradas requieren un procesador y una terminal compatibles.', en: 'Payment method not available. Integrated cards need a compatible processor and terminal.' },
  pos_payment_reference_required: { es: 'Escribe la referencia del pago (ATH Móvil, cheque, transferencia o terminal).', en: 'Type the payment reference (ATH Móvil, check, transfer or terminal).' },
  pos_stock_unavailable: { es: 'No hay existencias disponibles (descontando lo reservado).', en: 'Not enough available stock (reserved stock excluded).' },
  pos_lines_invalid: { es: 'Revisa los productos del carrito.', en: 'Check the cart items.' },
  pos_item_invalid: { es: 'Un producto no está activo en el catálogo.', en: 'A product is not active in the catalog.' },
  pos_qty_invalid: { es: 'Cantidad no válida (las unidades se venden enteras).', en: 'Invalid quantity (units are sold whole).' },
  pos_discount_invalid: { es: 'El descuento no es válido.', en: 'The discount is not valid.' },
  pos_client_invalid: { es: 'El cliente no es válido.', en: 'The client is not valid.' },
  pos_approval_required: { es: 'Necesita autorización: un supervisor debe aprobar o darte un código.', en: 'Needs authorisation: a supervisor must approve or give you a code.' },
  pos_void_not_allowed: { es: 'Solo se anula durante el turno abierto y sin devoluciones; después, haz una devolución.', en: 'Voids only during the open shift and without refunds; afterwards, refund.' },
  pos_refund_not_allowed: { es: 'Esta venta no admite devoluciones.', en: 'This sale cannot be refunded.' },
  pos_refund_exceeds: { es: 'No se puede devolver más de lo vendido.', en: 'You cannot refund more than was sold.' },
  pos_refund_zero: { es: 'La devolución no tiene importe.', en: 'The refund has no amount.' },
  pos_cash_insufficient: { es: 'La caja no tiene suficiente efectivo.', en: 'The drawer does not hold enough cash.' },
  pos_self_approval: { es: 'Otra persona debe revisar tu diferencia de caja.', en: 'Someone else must review your cash difference.' },
  pos_external_sale: { es: 'Las ventas de otro sistema se anulan en ese sistema.', en: 'Sales from another system are voided in that system.' },
  pos_import_invalid: { es: 'El archivo no es válido.', en: 'The file is not valid.' },
  pos_integration_taken: { es: 'Esa cuenta ya está conectada a otra empresa.', en: 'That account is already connected to another company.' },
  pos_integration_invalid: { es: 'La integración no es válida.', en: 'The integration is not valid.' },
  pos_settlement_amount: { es: 'El depósito no coincide con el neto de la liquidación.', en: 'The deposit does not match the payout net.' },
  pos_sync_not_retryable: { es: 'Ese evento no necesita reintento.', en: 'That event does not need a retry.' },
  pos_not_found: { es: 'No se encontró el registro.', en: 'The record was not found.' },
  pos_invalid: { es: 'Revisa los datos.', en: 'Check the data.' },
  inventory_variant_required: { es: 'Este producto tiene variantes: elige la variante.', en: 'This product has variants: choose the variant.' },
  reason_required: { es: 'Escribe el motivo.', en: 'Type the reason.' },
  bank_line_not_available: { es: 'Ese movimiento bancario ya está conciliado.', en: 'That bank line is already reconciled.' },
  period_closed: { es: 'El periodo contable está cerrado.', en: 'The accounting period is closed.' },
  unavailable: { es: 'El punto de venta no está activado en esta base de datos (migración 0044).', en: 'The point of sale is not enabled in this database (migration 0044).' },
  save: { es: 'No se pudo guardar. Inténtalo de nuevo.', en: 'Could not save. Try again.' },
  not_configured: { es: 'La integración no está configurada en el servidor (credenciales pendientes).', en: 'The integration is not configured on the server (credentials pending).' },
}
export const posMessage = (k: string | null | undefined, locale: Locale) => (k ? MSG[k]?.[locale] ?? MSG.save[locale] : null)

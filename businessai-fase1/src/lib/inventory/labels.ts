/** Inventory (S7): labels, error codes and messages, ES / EN. */
import type { Locale } from '@/lib/i18n/app'

type L = { es: string; en: string }
const pick = (m: Record<string, L>, k: string, locale: Locale) => m[k]?.[locale] ?? k

export const MOVEMENT_KINDS: Record<string, L> = {
  opening: { es: 'Inventario inicial', en: 'Opening stock' }, receipt: { es: 'Recepción de compra', en: 'Purchase receipt' },
  sale: { es: 'Venta / salida', en: 'Sale / issue' }, customer_return: { es: 'Devolución de cliente', en: 'Customer return' },
  vendor_return: { es: 'Devolución a proveedor', en: 'Return to vendor' }, transfer_out: { es: 'Transferencia (salida)', en: 'Transfer (out)' },
  transfer_in: { es: 'Transferencia (entrada)', en: 'Transfer (in)' }, adjustment_in: { es: 'Ajuste positivo', en: 'Positive adjustment' },
  adjustment_out: { es: 'Ajuste negativo', en: 'Negative adjustment' }, damaged: { es: 'Dañado', en: 'Damaged' }, lost: { es: 'Perdido', en: 'Lost' },
  unsellable: { es: 'No vendible', en: 'Unsellable' }, count: { es: 'Conteo físico', en: 'Physical count' }, correction: { es: 'Corrección', en: 'Correction' },
  revaluation: { es: 'Revaluación de costo', en: 'Cost revaluation' },
}
export const movementKind = (k: string, locale: Locale) => pick(MOVEMENT_KINDS, k, locale)
export const ADJUSTMENT_KINDS = ['opening', 'adjustment_in', 'adjustment_out', 'damaged', 'lost', 'unsellable', 'vendor_return', 'customer_return'] as const

const STATUS: Record<string, L> = {
  draft: { es: 'Borrador', en: 'Draft' }, pending_approval: { es: 'Por aprobar', en: 'Pending approval' }, approved: { es: 'Aprobada', en: 'Approved' },
  partially_received: { es: 'Recibida parcialmente', en: 'Partially received' }, received: { es: 'Recibida', en: 'Received' }, closed: { es: 'Cerrada', en: 'Closed' },
  cancelled: { es: 'Cancelada', en: 'Cancelled' }, requested: { es: 'Solicitada', en: 'Requested' }, prepared: { es: 'Preparada', en: 'Prepared' },
  in_transit: { es: 'En tránsito', en: 'In transit' }, open: { es: 'Abierto', en: 'Open' }, submitted: { es: 'Enviado', en: 'Submitted' },
  pending: { es: 'Pendiente', en: 'Pending' }, rejected: { es: 'Rechazado', en: 'Rejected' },
}
export const statusLabel = (s: string, locale: Locale) => pick(STATUS, s, locale)
export const statusTone = (s: string): 'ok' | 'pending' | 'issue' =>
  ['received', 'approved', 'closed'].includes(s) ? 'ok' : ['cancelled', 'rejected'].includes(s) ? 'issue' : 'pending'

export const SYMBOLOGY_LABEL: Record<string, string> = { ean13: 'EAN-13', upca: 'UPC-A', ean8: 'EAN-8', upce: 'UPC-E', gtin14: 'GTIN-14', code128: 'Code 128', code39: 'Code 39', qr: 'QR', other: 'Otro / Other' }

const CODES = ['FORBIDDEN', 'BRANCH_FORBIDDEN', 'BRANCH_INVALID', 'INVENTORY_INSUFFICIENT', 'INVENTORY_ITEM_INVALID', 'INVENTORY_VARIANT_REQUIRED', 'INVENTORY_LOCATION_INVALID',
  'INVENTORY_LOCATION_NOT_EMPTY', 'INVENTORY_QTY_INVALID', 'INVENTORY_COST_INVALID', 'INVENTORY_LINES_INVALID', 'INVENTORY_KIND_NOT_DIRECT', 'INVENTORY_NOT_FOUND',
  'INVENTORY_ALREADY_DECIDED', 'INVENTORY_ALREADY_CORRECTED', 'INVENTORY_NOT_CORRECTABLE', 'INVENTORY_CONFLICT', 'INVENTORY_DOCUMENT_INVALID',
  'INVENTORY_DOCUMENT_ALREADY_ISSUED', 'INVENTORY_DOCUMENT_NO_ITEMS', 'REASON_REQUIRED', 'PO_NOT_EDITABLE', 'PO_TRANSITION_INVALID', 'PO_NOT_RECEIVABLE',
  'PO_OVER_RECEIPT', 'PO_BILL_INVALID', 'PO_BILL_ALREADY_LINKED', 'TRANSFER_TRANSITION_INVALID', 'TRANSFER_OVER_RECEIPT', 'TRANSFER_DIFFERENCE_NOTE_REQUIRED',
  'COUNT_NOT_OPEN', 'COUNT_NOT_SUBMITTED', 'BARCODE_INVALID', 'BARCODE_TAKEN', 'CATALOG_CODE_TAKEN', 'CATALOG_NOT_FOUND', 'CATALOG_INVALID', 'INVENTORY_INVALID']

export function inventoryErrorCode(e: { message?: string | null; code?: string | null } | null | undefined): string {
  const m = e?.message ?? ''
  for (const c of CODES) if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  if (e?.code === '42501' || /permission denied|row-level security/.test(m)) return 'forbidden'
  if (e?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  if (/_check|violates check/.test(m)) return 'inventory_invalid'
  return 'save'
}

const MSG: Record<string, L> = {
  forbidden: { es: 'Tu rol no permite esta acción.', en: 'Your role cannot do this.' },
  branch_forbidden: { es: 'No tienes acceso a esa sucursal.', en: 'You do not have access to that branch.' },
  branch_invalid: { es: 'La sucursal no es válida.', en: 'The branch is not valid.' },
  inventory_insufficient: { es: 'No hay existencias suficientes (nunca se deja el inventario en negativo).', en: 'Not enough stock (stock is never taken below zero).' },
  inventory_item_invalid: { es: 'El producto no controla inventario o no es de esta empresa.', en: 'The product does not track stock or is not from this company.' },
  inventory_variant_required: { es: 'Este producto tiene variantes: elige la variante.', en: 'This product has variants: choose the variant.' },
  inventory_location_invalid: { es: 'La ubicación no es válida.', en: 'The location is not valid.' },
  inventory_location_not_empty: { es: 'La ubicación todavía tiene existencias.', en: 'The location still holds stock.' },
  inventory_qty_invalid: { es: 'La cantidad no es válida.', en: 'The quantity is not valid.' },
  inventory_cost_invalid: { es: 'El costo no es válido.', en: 'The cost is not valid.' },
  inventory_lines_invalid: { es: 'Revisa las líneas (producto y cantidad).', en: 'Check the lines (product and quantity).' },
  inventory_not_found: { es: 'No se encontró el registro.', en: 'The record was not found.' },
  inventory_already_decided: { es: 'Ya fue decidido.', en: 'It was already decided.' },
  inventory_already_corrected: { es: 'Ese movimiento ya fue corregido.', en: 'That movement was already corrected.' },
  inventory_not_correctable: { es: 'Ese movimiento se corrige desde su origen (transferencia o revaluación).', en: 'That movement is corrected from its source (transfer or revaluation).' },
  inventory_conflict: { es: 'Otra persona cambió este registro. Recarga e inténtalo de nuevo.', en: 'Someone else changed this record. Reload and try again.' },
  inventory_document_invalid: { es: 'Solo facturas emitidas de esta empresa.', en: 'Only issued invoices of this company.' },
  inventory_document_already_issued: { es: 'La mercancía de esa factura ya salió del inventario.', en: "That invoice's goods already left stock." },
  inventory_document_no_items: { es: 'La factura no tiene productos del catálogo que controlen inventario.', en: 'The invoice has no catalog products that track stock.' },
  reason_required: { es: 'Escribe el motivo (3 a 300 caracteres).', en: 'Write the reason (3 to 300 characters).' },
  po_not_editable: { es: 'Solo se editan órdenes en borrador.', en: 'Only draft orders can be edited.' },
  po_transition_invalid: { es: 'La orden no admite ese cambio en su estado actual.', en: 'The order does not allow that change in its current status.' },
  po_not_receivable: { es: 'Solo se recibe mercancía de órdenes aprobadas.', en: 'Goods are received only on approved orders.' },
  po_over_receipt: { es: 'No se puede recibir más de lo pedido.', en: 'You cannot receive more than ordered.' },
  po_bill_invalid: { es: 'La factura del proveedor no es válida (otro proveedor o anulada).', en: 'The vendor bill is not valid (another vendor or voided).' },
  po_bill_already_linked: { es: 'Esa factura ya está vinculada a una orden.', en: 'That bill is already linked to an order.' },
  transfer_transition_invalid: { es: 'La transferencia no admite ese paso ahora.', en: 'The transfer does not allow that step now.' },
  transfer_over_receipt: { es: 'No se puede recibir más de lo despachado.', en: 'You cannot receive more than dispatched.' },
  transfer_difference_note_required: { es: 'Hay diferencias: explica qué pasó.', en: 'There are differences: explain what happened.' },
  count_not_open: { es: 'El conteo no está abierto.', en: 'The count is not open.' },
  count_not_submitted: { es: 'El conteo no está enviado.', en: 'The count is not submitted.' },
  barcode_invalid: { es: 'El código no es válido para ese formato (revisa el dígito de control).', en: 'The code is not valid for that format (check the check digit).' },
  barcode_taken: { es: 'Ese código ya identifica otro producto de la empresa.', en: 'That code already identifies another product of the company.' },
  catalog_code_taken: { es: 'Ese código o SKU ya existe en la empresa.', en: 'That code or SKU already exists in the company.' },
  catalog_not_found: { es: 'No se encontró el producto o no tienes permiso.', en: 'The product was not found or you lack permission.' },
  catalog_invalid: { es: 'Revisa los datos del producto o la variante.', en: 'Check the product or variant data.' },
  inventory_invalid: { es: 'Revisa los datos.', en: 'Check the data.' },
  unknown_code: { es: 'Código desconocido: no corresponde a ningún producto.', en: 'Unknown code: it matches no product.' },
  unavailable: { es: 'El inventario todavía no está activado en esta base de datos (migración 0043).', en: 'Inventory is not enabled in this database yet (migration 0043).' },
  save: { es: 'No se pudo guardar. Inténtalo nuevamente.', en: 'It could not be saved. Please try again.' },
}
export function inventoryMessage(code: string | null | undefined, locale: Locale): string | null {
  if (!code) return null
  return (MSG[code] ?? MSG.save)[locale]
}

/** "12" / "1.5" / "2,5" → number with up to 3 decimals; null when not valid or not positive. */
export function parseQty(raw: string | null | undefined): number | null {
  const t = String(raw ?? '').trim().replace(',', '.')
  if (!/^\d{1,10}(\.\d{1,3})?$/.test(t)) return null
  const v = Number(t)
  return v > 0 ? v : null
}
export const qtyText = (q: number | string | null | undefined) => {
  const v = Number(q ?? 0)
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '')
}
export const ZERO_KEY = '00000000-0000-0000-0000-000000000000'
export const variantLabel = (attrs: Record<string, string> | null | undefined) => Object.values(attrs ?? {}).join(' · ')

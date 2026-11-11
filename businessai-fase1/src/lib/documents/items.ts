/**
 * Line items of invoices and quotes.
 *
 * New documents store their items in `documents.items` (jsonb) and the
 * discount / tax rate in `documents.metadata`; `notes` keeps only the
 * user's notes. Documents created before this change stored the items as
 * text inside `notes` ("FACTURA — PARTIDAS" / "COTIZACIÓN — PARTIDAS"
 * blocks). They are NOT rewritten: they are read here, so history stays
 * exactly as it was.
 */

export type LineItem = { description: string; quantity: number; unit_price: number; amount: number }

export const MAX_ITEMS = 30

const cents = (n: number) => Math.round(n * 100) / 100

export type ItemsInput = { items: LineItem[]; subtotal: number; error: null } | { items: []; subtotal: 0; error: 'required' | 'price' }

/** Reads item_description_N / item_quantity_N / item_price_N (N = 1…30). Empty rows are skipped. */
export function parseItemsInput(get: (key: string) => string): ItemsInput {
  const items: LineItem[] = []
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const description = get(`item_description_${i}`).trim()
    const quantityRaw = get(`item_quantity_${i}`).trim()
    const priceRaw = get(`item_price_${i}`).trim()
    if (!description && !quantityRaw && !priceRaw) continue
    if (!description) return { items: [], subtotal: 0, error: 'required' }
    const quantity = Number(quantityRaw || 1)
    const unitPrice = Number(priceRaw || 0)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return { items: [], subtotal: 0, error: 'price' }
    }
    items.push({ description: description.slice(0, 500), quantity, unit_price: cents(unitPrice), amount: cents(quantity * unitPrice) })
  }
  return { items, subtotal: cents(items.reduce((s, i) => s + i.amount, 0)), error: null }
}

/** Discount (≤ subtotal) and tax rate (%) → tax and total, rounded to cents. */
export function computeTotals(subtotal: number, discount: number, taxRate: number) {
  const taxable = cents(subtotal - discount)
  const tax = cents((taxable * taxRate) / 100)
  return { tax, total: cents(taxable + tax) }
}

const LEGACY_ITEM = /^\s*\d+\.\s*(.*?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario:\s*\$([\d,.]+)\s*\|\s*Importe:\s*\$([\d,.]+)\s*$/i
const LEGACY_SUMMARY = /^\s*((FACTURA|COTIZACIÓN)\s*[—-]\s*PARTIDAS|\d+\.\s.*\|\s*Cantidad:|Subtotal:|Descuento:|Impuesto\s*\(|TOTAL:)/i
const num = (v: string) => Number(v.replace(/,/g, '')) || 0

function isLineItem(v: unknown): v is LineItem {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.description === 'string' && typeof o.quantity === 'number' && typeof o.unit_price === 'number' && typeof o.amount === 'number'
}

/**
 * Items, discount and notes of a document, whatever the format it was
 * saved in. `legacy` tells which one was used.
 */
export function documentItems(doc: { items?: unknown; metadata?: unknown; notes?: string | null }): {
  items: LineItem[]; discount: number; taxRate: number | null; notes: string; legacy: boolean
} {
  const meta = (doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}) as Record<string, unknown>
  if (Array.isArray(doc.items) && doc.items.length > 0 && doc.items.every(isLineItem)) {
    return {
      items: doc.items as LineItem[],
      discount: typeof meta.discount === 'number' ? meta.discount : 0,
      taxRate: typeof meta.tax_rate === 'number' ? meta.tax_rate : null,
      notes: (doc.notes ?? '').trim(),
      legacy: false,
    }
  }
  const text = doc.notes ?? ''
  const items: LineItem[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LEGACY_ITEM)
    if (m) items.push({ description: m[1], quantity: num(m[2]), unit_price: num(m[3]), amount: num(m[4]) })
  }
  const discount = num(text.match(/Descuento:\s*\$([\d,.]+)/i)?.[1] ?? '0')
  const rate = text.match(/Impuesto\s*\(([\d.]+)%\)/i)
  const notes = text
    .split(/\r?\n/)
    .filter((line) => !LEGACY_SUMMARY.test(line))
    .map((line) => line.replace(/^\s*Notas y condiciones:\s*/i, ''))
    .join('\n')
    .trim()
  return { items, discount, taxRate: rate ? num(rate[1]) : null, notes, legacy: items.length > 0 }
}

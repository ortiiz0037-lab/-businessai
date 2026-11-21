/**
 * Files from traditional registers (Z reports / electronic journal exports, CSV): one row per sold
 * line, grouped into sales by the receipt number. The expected columns (Spanish or English names,
 * any order, comma or semicolon separated):
 *   receipt | recibo          receipt / ticket number (the sale's external id) — required
 *   date | fecha              YYYY-MM-DD[ HH:MM[:SS]] (Puerto Rico time) or ISO — required
 *   location | ubicacion      register / store id (mapped to a branch) — required
 *   sku | codigo              barcode, SKU or catalog code (optional: empty = department sale)
 *   name | descripcion        line description — required
 *   qty | cantidad            quantity — required
 *   price | precio            unit price (decimal) — required
 *   discount | descuento      line discount (decimal, optional)
 *   tax | impuesto            line tax (decimal, optional)
 *   payment | pago            tender of the receipt (cash, card, ath, check …; the first line of the receipt)
 *   register | caja, cashier | cajero  (optional)
 * Nothing is guessed: a row that cannot be read is reported with its line number and the file is
 * not imported until it is fixed. The server parses; the database validates again.
 */
import { methodFromLabel } from '@/lib/pos/adapters/common'
import { decimalToCents, qtyText } from '@/lib/pos/money'
import type { NormalizedSale } from '@/lib/pos/types'

const ALIASES: Record<string, string[]> = {
  receipt: ['receipt', 'recibo', 'ticket', 'factura', 'receipt_no', 'numero'], date: ['date', 'fecha', 'datetime'], location: ['location', 'ubicacion', 'ubicación', 'tienda', 'store'],
  sku: ['sku', 'codigo', 'código', 'barcode', 'upc', 'plu'], name: ['name', 'descripcion', 'descripción', 'description', 'articulo', 'artículo'], qty: ['qty', 'cantidad', 'quantity'],
  price: ['price', 'precio', 'unit_price'], discount: ['discount', 'descuento'], tax: ['tax', 'impuesto', 'ivu'], payment: ['payment', 'pago', 'tender', 'forma_pago'],
  register: ['register', 'caja', 'terminal'], cashier: ['cashier', 'cajero', 'cajera', 'operator'],
}
const REQUIRED = ['receipt', 'date', 'location', 'name', 'qty', 'price']

export type CsvIssue = { line: number; problem: string }
export type CsvResult = { sales: NormalizedSale[]; issues: CsvIssue[]; rows: number }

/** RFC 4180 fields (quotes, doubled quotes, CRLF), comma or semicolon. */
export function parseCsvRows(text: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const first = t.split(/\r?\n/, 1)[0] ?? ''
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], f = '', q = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch
    } else if (ch === '"') q = true
    else if (ch === sep) { row.push(f); f = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = '' }
    else f += ch
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

/** "2026-11-16 14:05" (Puerto Rico, UTC−4 all year) or ISO → ISO UTC */
export function prDateToIso(v: string): string | null {
  const s = v.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (m) {
    const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return null
    const h = +(m[4] ?? 12), mi = +(m[5] ?? 0), se = +(m[6] ?? 0)
    if (h > 23 || mi > 59 || se > 59) return null
    return new Date(day.getTime() + ((h + 4) * 3600 + mi * 60 + se) * 1000).toISOString()   // Atlantic Standard Time, no daylight saving
  }
  const t = Date.parse(s)
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(t) ? new Date(t).toISOString() : null
}

export function parseRegisterCsv(text: string, maxRows = 20000): CsvResult {
  const rows = parseCsvRows(text)
  const issues: CsvIssue[] = []
  if (rows.length < 2) return { sales: [], issues: [{ line: 1, problem: 'empty' }], rows: 0 }
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const col: Record<string, number> = {}
  for (const [k, names] of Object.entries(ALIASES)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i }
  const missing = REQUIRED.filter((k) => col[k] === undefined)
  if (missing.length) return { sales: [], issues: [{ line: 1, problem: `missing_columns:${missing.join(',')}` }], rows: rows.length - 1 }
  if (rows.length - 1 > maxRows) return { sales: [], issues: [{ line: 1, problem: 'too_many_rows' }], rows: rows.length - 1 }
  const bySale = new Map<string, NormalizedSale & { _pay?: string }>()
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2
    const get = (k: string) => (col[k] === undefined ? '' : (r[col[k]] ?? '').trim())
    const receipt = get('receipt'), loc = get('location'), name = get('name')
    const iso = prDateToIso(get('date')), qty = qtyText(get('qty')), price = decimalToCents(get('price').replace(/^\$/, ''))
    const disc = get('discount') ? decimalToCents(get('discount').replace(/^\$/, '')) : 0n, tax = get('tax') ? decimalToCents(get('tax').replace(/^\$/, '')) : 0n
    if (!receipt || receipt.length > 120) return issues.push({ line, problem: 'receipt' })
    if (!iso) return issues.push({ line, problem: 'date' })
    if (!loc) return issues.push({ line, problem: 'location' })
    if (!name) return issues.push({ line, problem: 'name' })
    if (!qty || Number(qty) <= 0) return issues.push({ line, problem: 'qty' })
    if (price === null || price < 0n) return issues.push({ line, problem: 'price' })
    if (disc === null || disc < 0n || tax === null || tax < 0n) return issues.push({ line, problem: 'amount' })
    const key = `${loc}::${receipt}`
    let s = bySale.get(key)
    if (!s) {
      s = { external_id: `${loc}:${receipt}`.slice(0, 200), version: '1', state: 'completed', occurred_at: iso, location_id: loc, register_ref: get('register') || null,
        cashier_ref: get('cashier') || null, currency: 'USD', lines: [], payments: [], _pay: get('payment') }
      bySale.set(key, s)
    }
    const sku = get('sku')
    s.lines.push({ external_line_id: String(s.lines.length + 1), sku: sku || null, name: name.slice(0, 200), qty, unit_price_cents: price.toString(),
      discount_cents: disc.toString(), tax_cents: tax.toString(), catalog_required: !!sku })
  })
  const sales: NormalizedSale[] = []
  for (const s of bySale.values()) {
    const total = s.lines.reduce((a, l) => {
      const [i, d = ''] = l.qty.split('.')
      const gross = (BigInt(i) * 1000n + BigInt(d.padEnd(3, '0') || '0')) * BigInt(l.unit_price_cents)
      return a + (gross + 500n) / 1000n - BigInt(l.discount_cents ?? '0') + BigInt(l.tax_cents ?? '0')
    }, 0n)
    const { _pay, ...sale } = s
    sale.payments = total > 0n ? [{ method: methodFromLabel(_pay || 'cash'), amount_cents: total.toString(), status: 'captured' }] : []
    sale.total_cents = total.toString()
    sales.push(sale)
  }
  return { sales, issues, rows: rows.length - 1 }
}

/** the template offered for download */
export const CSV_TEMPLATE = 'recibo,fecha,ubicacion,caja,cajero,codigo,descripcion,cantidad,precio,descuento,impuesto,pago\n' +
  'Z-0001,2026-11-16 09:15,CAJA-1,1,Ana,4006381333931,Café molido,2,10.00,0.00,2.30,efectivo\n'

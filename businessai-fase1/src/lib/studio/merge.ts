/**
 * Merge fields: {{client.name}}, {{document.total}}… resolved from the data
 * the database returned for the document (studio_data or the issued
 * snapshot). A field without data is NEVER filled in: it is rendered as a
 * visible "[falta: …]" marker and reported, so the document cannot be
 * issued with invented information.
 */
import type { Locale } from '@/lib/i18n/app'
import type { LineItem } from '@/lib/documents/items'

export type StudioData = {
  company?: Record<string, string | null>
  client?: Record<string, string | null> | null
  document?: Record<string, string | number | null> | null
  payments?: { date: string; amount: number | string; method: string | null; reference: string | null }[]
  statement?: { number: string; issue_date: string; due_date: string | null; total_cents: number; paid_cents: number; balance_cents: number; days_past_due: number }[]
  employee?: Record<string, string | number | null> | null
  vendor?: Record<string, string | null> | null
  items?: LineItem[]
  doc?: { number?: string | null; title?: string; issued_on?: string | null }
}

type Field = { path: string; es: string; en: string; kind?: 'date' | 'money' }
export const FIELDS: { group: { es: string; en: string }; fields: Field[] }[] = [
  { group: { es: 'Empresa', en: 'Company' }, fields: [
    { path: 'company.legal_name', es: 'Razón social', en: 'Legal name' }, { path: 'company.display_name', es: 'Nombre comercial', en: 'Trade name' },
    { path: 'company.name', es: 'Nombre en BusinessAI', en: 'Name in BusinessAI' }, { path: 'company.address', es: 'Dirección', en: 'Address' },
    { path: 'company.city', es: 'Ciudad', en: 'City' }, { path: 'company.phone', es: 'Teléfono', en: 'Phone' }, { path: 'company.email', es: 'Correo', en: 'E-mail' },
    { path: 'company.payment_info', es: 'Datos de pago', en: 'Payment details' }] },
  { group: { es: 'Cliente', en: 'Client' }, fields: [
    { path: 'client.name', es: 'Nombre', en: 'Name' }, { path: 'client.business_name', es: 'Empresa del cliente', en: 'Client company' },
    { path: 'client.address', es: 'Dirección', en: 'Address' }, { path: 'client.city', es: 'Ciudad', en: 'City' }, { path: 'client.email', es: 'Correo', en: 'E-mail' },
    { path: 'client.phone', es: 'Teléfono', en: 'Phone' }] },
  { group: { es: 'Documento comercial', en: 'Business document' }, fields: [
    { path: 'document.number', es: 'Número', en: 'Number' }, { path: 'document.issue_date', es: 'Fecha', en: 'Date', kind: 'date' },
    { path: 'document.due_date', es: 'Vencimiento', en: 'Due date', kind: 'date' }, { path: 'document.subtotal', es: 'Subtotal', en: 'Subtotal', kind: 'money' },
    { path: 'document.tax', es: 'Impuesto', en: 'Tax', kind: 'money' }, { path: 'document.total', es: 'Total', en: 'Total', kind: 'money' },
    { path: 'document.paid', es: 'Pagado', en: 'Paid', kind: 'money' }, { path: 'document.balance', es: 'Balance', en: 'Balance', kind: 'money' }] },
  { group: { es: 'Empleado', en: 'Employee' }, fields: [
    { path: 'employee.full_name', es: 'Nombre completo', en: 'Full name' }, { path: 'employee.position', es: 'Puesto', en: 'Position' },
    { path: 'employee.department', es: 'Departamento', en: 'Department' }, { path: 'employee.hire_date', es: 'Fecha de ingreso', en: 'Hire date', kind: 'date' },
    { path: 'employee.employee_number', es: 'Número de empleado', en: 'Employee number' }] },
  { group: { es: 'Proveedor', en: 'Vendor' }, fields: [
    { path: 'vendor.name', es: 'Nombre', en: 'Name' }, { path: 'vendor.tax_id', es: 'Identificación fiscal', en: 'Tax ID' }, { path: 'vendor.address', es: 'Dirección', en: 'Address' },
    { path: 'vendor.email', es: 'Correo', en: 'E-mail' }] },
  { group: { es: 'Este documento', en: 'This document' }, fields: [
    { path: 'doc.number', es: 'Número (al emitir)', en: 'Number (when issued)' }, { path: 'doc.title', es: 'Título', en: 'Title' },
    { path: 'today', es: 'Fecha de hoy', en: "Today's date", kind: 'date' }] },
]
const KIND_OF = new Map(FIELDS.flatMap((g) => g.fields.map((f) => [f.path, f.kind] as const)))

export function fieldValue(data: StudioData, path: string): string | number | null {
  if (path === 'today') return data.doc?.issued_on ?? null
  const d = data.document ?? null
  if (path === 'document.paid' || path === 'document.balance') {
    if (!d) return null
    const paid = (data.payments ?? []).reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)
    return path === 'document.paid' ? paid / 100 : (Math.round(Number(d.total) * 100) - paid) / 100
  }
  const [root, key] = path.split('.')
  const obj = (data as Record<string, unknown>)[root] as Record<string, unknown> | null | undefined
  const v = obj && key ? obj[key] : undefined
  return v === undefined || v === null || v === '' ? null : (v as string | number)
}

export type Formatters = { date: (iso: string) => string; money: (amount: number) => string }
export function makeFormatters(locale: Locale, currency = 'USD'): Formatters {
  const tag = locale === 'en' ? 'en-US' : 'es-PR'
  const nf = new Intl.NumberFormat(tag, { style: 'currency', currency })
  const df = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return {
    date: (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? df.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : iso),
    money: (n) => nf.format(n),
  }
}

const TAG = /\{\{\s*([a-z_]+(?:\.[a-z_]+)?)\s*\}\}/g
/** Replaces merge fields; missing ones become a visible marker. */
export function mergeText(text: string, data: StudioData, fmt: Formatters, locale: Locale, missing?: Set<string>): string {
  return text.replace(TAG, (_, path: string) => {
    const v = KIND_OF.has(path) || path === 'today' ? fieldValue(data, path) : null
    // the number is assigned when the document is issued: not missing data
    if (v === null && path === 'doc.number') return locale === 'en' ? '[number on issue]' : '[nº al emitir]'
    if (v === null) { missing?.add(path); return `[${locale === 'en' ? 'missing' : 'falta'}: ${path}]` }
    const kind = KIND_OF.get(path)
    if (kind === 'date') return fmt.date(String(v))
    if (kind === 'money') return fmt.money(Number(v))
    return String(v)
  })
}

/** Every missing field of a document (blocks text + data blocks that need data). */
export function missingFields(blocks: { type: string; text?: string; rows?: unknown }[], data: StudioData, locale: Locale): string[] {
  const missing = new Set<string>()
  const fmt = makeFormatters(locale)
  for (const b of blocks) {
    if (typeof b.text === 'string') mergeText(b.text, data, fmt, locale, missing)
    if (Array.isArray(b.rows)) for (const r of b.rows as unknown[][]) for (const c of r) if (typeof c === 'string') mergeText(c, data, fmt, locale, missing)
    if ((b.type === 'items' || b.type === 'totals' || b.type === 'payments') && !data.document) missing.add('document')
    if (b.type === 'statement' && !data.statement) missing.add('statement')
  }
  return [...missing]
}

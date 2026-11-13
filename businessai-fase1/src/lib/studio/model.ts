/**
 * Document Studio block model (migration 0028). The same limits are checked
 * by PostgreSQL (studio_valid_content / studio_valid_page); this module lets
 * the editor and the server actions refuse bad input before the round trip.
 */
import type { Locale } from '@/lib/i18n/app'

export const KINDS = ['letter', 'quote', 'invoice', 'receipt', 'work_order', 'purchase_order', 'contract', 'report', 'account_statement', 'certificate'] as const
export type Kind = (typeof KINDS)[number]
export type Align = 'left' | 'center' | 'right' | 'justify'

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string; align?: Align }
  | { type: 'paragraph'; text: string; align?: Align; size?: number }
  | { type: 'table'; header: boolean; widths?: number[]; rows: string[][] }
  | { type: 'image'; asset: string; width: number; align?: Align }        // asset: 'logo' or a studio asset id
  | { type: 'signature'; label?: string; name?: string; title?: string; withImage?: boolean; align?: Align }
  | { type: 'stamp'; align?: Align }
  | { type: 'spacer'; size: number }                                        // mm
  | { type: 'divider' }
  | { type: 'pagebreak' }
  | { type: 'items' } | { type: 'totals' } | { type: 'payments' } | { type: 'statement' }
  | { type: 'fields'; rows: [string, string][] }                            // label / value (with merge fields)

export type DocContent = { v: 1; blocks: Block[] }
export type PageSettings = {
  size?: 'letter' | 'a4' | 'legal'; orientation?: 'portrait' | 'landscape'; font?: 'sans' | 'serif'
  fontSize?: number; lineHeight?: number; marginTop?: number; marginRight?: number; marginBottom?: number; marginLeft?: number
  accent?: string                                                          // #RRGGBB: overrides the identity accent for this document
}
export const PAGE_DEFAULTS: Required<Omit<PageSettings, 'accent'>> = { size: 'letter', orientation: 'portrait', font: 'sans', fontSize: 10.5, lineHeight: 1.35, marginTop: 20, marginRight: 20, marginBottom: 20, marginLeft: 20 }

export type Brand = {
  heading_font: 'sans' | 'serif'; body_font: 'sans' | 'serif'; accent_color: string | null; text_color: string
  header_text: string | null; footer_text: string | null; show_logo: boolean; show_page_numbers: boolean
  watermark_text: string | null; watermark_opacity: number; stamp_asset_id: string | null
  signature_name: string | null; signature_title: string | null; page: PageSettings; number_formats: Record<string, string>
}
export const BRAND_DEFAULTS: Brand = {
  heading_font: 'sans', body_font: 'sans', accent_color: null, text_color: '#111827', header_text: null, footer_text: null, show_logo: true,
  show_page_numbers: true, watermark_text: null, watermark_opacity: 8, stamp_asset_id: null, signature_name: null, signature_title: null, page: {}, number_formats: {},
}

/** The identity a document is drawn with: drafts and archived documents carry a watermark (PDF, editor and viewer alike). */
export function effectiveBrand(brand: Brand, status: string, locale: Locale): Brand {
  if (status === 'draft') return { ...brand, watermark_text: brand.watermark_text ?? (locale === 'en' ? 'DRAFT' : 'BORRADOR') }
  if (status === 'archived') return { ...brand, watermark_text: locale === 'en' ? 'ARCHIVED' : 'ARCHIVADO' }
  return brand
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Same rule as the database: no markup, no script URLs, no event handlers.
export const UNSAFE = /<\s*\/?\s*(script|iframe|object|embed|img|svg|style|link|a|form|input|meta|base)\b|javascript:|vbscript:|data:text\/html|\son[a-z]+\s*=/i
const MAX_TEXT = 20000
const str = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
const align = (v: unknown): Align | undefined => (v === 'left' || v === 'center' || v === 'right' || v === 'justify' ? v : undefined)

/** Normalises untrusted JSON into a block document, or returns why it is invalid. */
export function parseContent(input: unknown): { ok: true; content: DocContent } | { ok: false; error: string } {
  const c = input as { v?: unknown; blocks?: unknown }
  if (!c || typeof c !== 'object' || c.v !== 1 || !Array.isArray(c.blocks)) return { ok: false, error: 'format' }
  if (c.blocks.length > 500) return { ok: false, error: 'too_many_blocks' }
  const blocks: Block[] = []
  for (const raw of c.blocks as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'block' }
    if (UNSAFE.test(JSON.stringify(raw))) return { ok: false, error: 'unsafe' }
    switch (raw.type) {
      case 'heading': blocks.push({ type: 'heading', level: ([1, 2, 3].includes(Number(raw.level)) ? Number(raw.level) : 1) as 1 | 2 | 3, text: str(raw.text, 500), align: align(raw.align) }); break
      case 'paragraph': blocks.push({ type: 'paragraph', text: str(raw.text), align: align(raw.align), ...(raw.size ? { size: num(raw.size, 7, 24, 10.5) } : {}) }); break
      case 'table': {
        const rows = Array.isArray(raw.rows) ? (raw.rows as unknown[]).slice(0, 200).map((r) => (Array.isArray(r) ? r.slice(0, 8).map((x) => str(x, 2000)) : [])) : []
        const cols = Math.max(1, ...rows.map((r) => r.length))
        const widths = Array.isArray(raw.widths) ? (raw.widths as unknown[]).slice(0, cols).map((w) => num(w, 1, 100, 1)) : undefined
        blocks.push({ type: 'table', header: raw.header !== false, rows: rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? '')), ...(widths ? { widths } : {}) }); break
      }
      case 'image': {
        const asset = str(raw.asset, 40)
        if (asset !== 'logo' && !UUID.test(asset)) return { ok: false, error: 'image' }
        blocks.push({ type: 'image', asset, width: num(raw.width, 5, 100, 40), align: align(raw.align) }); break
      }
      case 'signature': blocks.push({ type: 'signature', label: str(raw.label, 120) || undefined, name: str(raw.name, 120) || undefined, title: str(raw.title, 120) || undefined, withImage: raw.withImage === true, align: align(raw.align) }); break
      case 'stamp': blocks.push({ type: 'stamp', align: align(raw.align) }); break
      case 'spacer': blocks.push({ type: 'spacer', size: num(raw.size, 1, 100, 6) }); break
      case 'divider': case 'pagebreak': case 'items': case 'totals': case 'payments': case 'statement': blocks.push({ type: raw.type } as Block); break
      case 'fields': blocks.push({ type: 'fields', rows: (Array.isArray(raw.rows) ? (raw.rows as unknown[]) : []).slice(0, 40).map((r) => (Array.isArray(r) ? [str(r[0], 120), str(r[1], 1000)] : ['', ''])) as [string, string][] }); break
      default: return { ok: false, error: 'block_type' }
    }
  }
  const content: DocContent = { v: 1, blocks }
  if (new TextEncoder().encode(JSON.stringify(content)).length > 400000) return { ok: false, error: 'too_large' }
  return { ok: true, content }
}

export function parsePage(input: unknown): PageSettings {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: PageSettings = {}
  if (p.size === 'letter' || p.size === 'a4' || p.size === 'legal') out.size = p.size
  if (p.orientation === 'portrait' || p.orientation === 'landscape') out.orientation = p.orientation
  if (p.font === 'sans' || p.font === 'serif') out.font = p.font
  if (p.fontSize !== undefined && p.fontSize !== '') out.fontSize = num(p.fontSize, 8, 16, 10.5)
  if (p.lineHeight !== undefined && p.lineHeight !== '') out.lineHeight = num(p.lineHeight, 1, 2.2, 1.35)
  for (const k of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const) if (p[k] !== undefined && p[k] !== '') out[k] = num(p[k], 8, 50, 20)
  if (typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent)) out.accent = p.accent
  return out
}

export const kindLabel = (k: string, locale: Locale) => (locale === 'en'
  ? { letter: 'Business letter', quote: 'Quote', invoice: 'Invoice', receipt: 'Receipt', work_order: 'Work order', purchase_order: 'Purchase order', contract: 'Contract', report: 'Business report', account_statement: 'Account statement', certificate: 'Certificate' }
  : { letter: 'Carta empresarial', quote: 'Cotización', invoice: 'Factura', receipt: 'Recibo', work_order: 'Orden de trabajo', purchase_order: 'Orden de compra', contract: 'Contrato', report: 'Informe empresarial', account_statement: 'Estado de cuenta', certificate: 'Certificado' })[k as Kind] ?? k

export const statusLabel = (s: string, locale: Locale) => (locale === 'en' ? { draft: 'Draft', final: 'Issued', archived: 'Archived' } : { draft: 'Borrador', final: 'Emitido', archived: 'Archivado' })[s as 'draft'] ?? s
export const statusTone = (s: string) => ({ draft: 'badge-neutral', final: 'badge-success', archived: 'badge-neutral' } as Record<string, string>)[s] ?? 'badge-neutral'

/** Which record a kind is built on (the editor offers these pickers). */
export const KIND_SOURCES: Record<Kind, { client?: boolean; document?: string[]; employee?: boolean; vendor?: boolean; required?: 'document' | 'client' | 'recipient' }> = {
  letter: { client: true }, quote: { document: ['quote'], required: 'document' }, invoice: { document: ['invoice'], required: 'document' },
  receipt: { document: ['receipt', 'invoice'], required: 'document' }, work_order: { client: true, document: ['work_order', 'quote', 'invoice'] },
  purchase_order: { vendor: true }, contract: { client: true }, report: { client: true }, account_statement: { client: true, required: 'client' },
  certificate: { client: true, employee: true, required: 'recipient' },
}

export function studioErrorCode(error: { message?: string | null; code?: string | null } | null): string {
  const m = error?.message ?? ''
  for (const c of ['STUDIO_CONFLICT', 'STUDIO_LOCKED', 'STUDIO_IMMUTABLE', 'STUDIO_NOT_FOUND', 'STUDIO_CONTENT_INVALID', 'STUDIO_REF_INVALID', 'STUDIO_ASSET_INVALID',
    'STUDIO_ITEMS_INVALID', 'STUDIO_SOURCE_REQUIRED', 'STUDIO_SOURCE_DRAFT', 'STUDIO_TRANSITION', 'STUDIO_ACTION_INVALID', 'REASON_REQUIRED', 'FORBIDDEN']) {
    if (new RegExp(`\\b${c}\\b`).test(m)) return c.toLowerCase()
  }
  if (/studio_templates_name_uidx/.test(m)) return 'template_name_taken'
  if (error?.code === '23514') return 'invalid'
  if (error?.code === '42501' || /row-level security|permission denied/.test(m)) return 'forbidden'
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(m)) return 'unavailable'
  return 'save'
}
const MESSAGES: Record<Locale, Record<string, string>> = {
  es: {
    studio_conflict: 'Otra persona guardó este documento mientras lo editabas. Recarga para ver la versión más reciente (tus cambios no se guardaron).',
    studio_locked: 'Un documento emitido o archivado no se modifica: duplícalo para crear uno nuevo.',
    studio_immutable: 'Los documentos no se borran: se archivan con un motivo.',
    studio_not_found: 'Documento no encontrado o sin permiso.',
    studio_content_invalid: 'El contenido no es válido (bloques desconocidos, demasiado largo o con código).',
    studio_ref_invalid: 'El cliente, documento, empleado o proveedor elegido no es válido para este tipo de documento.',
    studio_asset_invalid: 'La imagen no es válida o no pertenece a esta empresa.',
    studio_items_invalid: 'Las líneas no coinciden con el documento comercial: no se puede emitir con importes distintos.',
    studio_source_required: 'Para emitir este tipo de documento hay que vincular el registro correspondiente (factura, cotización, cliente o destinatario).',
    studio_source_draft: 'La factura vinculada sigue en borrador: emítela primero en Documentos.',
    studio_transition: 'Ese cambio de estado no está permitido.',
    studio_action_invalid: 'Acción no permitida.',
    missing_data: 'Faltan datos en el documento (marcados como [falta: …]). Complétalos o quítalos antes de emitir.',
    confirm_required: 'Confirma la emisión: un documento emitido no se puede modificar.',
    assistant_amounts: 'El asistente no escribe importes en este tipo de documento: se toman de la factura o del libro. Revise el borrador.',
    number_format: 'Formato de numeración no válido: letras, números, separadores y {YYYY}, {YY}, {####} (obligatorio).',
    reason_required: 'Indica un motivo (3 a 300 caracteres).',
    template_name_taken: 'Ya existe una plantilla con ese nombre.',
    file_invalid: 'Archivo no válido: solo imágenes PNG o JPG de hasta 2 MB y 6000 px.',
    forbidden: 'No tienes permiso para esta acción.',
    invalid: 'Revisa los datos del formulario.',
    unavailable: 'Document Studio todavía no está activado en esta base de datos.',
    save: 'No se pudo guardar. Inténtalo de nuevo.',
  },
  en: {
    studio_conflict: 'Someone else saved this document while you were editing. Reload to see the latest version (your changes were not saved).',
    studio_locked: 'An issued or archived document cannot change: duplicate it to create a new one.',
    studio_immutable: 'Documents are not deleted: they are archived with a reason.',
    studio_not_found: 'Document not found or no permission.',
    studio_content_invalid: 'The content is not valid (unknown blocks, too long or contains code).',
    studio_ref_invalid: 'The chosen client, document, employee or vendor is not valid for this kind of document.',
    studio_asset_invalid: 'The image is not valid or does not belong to this company.',
    studio_items_invalid: 'The lines do not match the business document: it cannot be issued with different amounts.',
    studio_source_required: 'To issue this kind of document, link its record (invoice, quote, client or recipient).',
    studio_source_draft: 'The linked invoice is still a draft: issue it first in Documents.',
    studio_transition: 'That status change is not allowed.',
    studio_action_invalid: 'Action not allowed.',
    missing_data: 'The document has missing data (marked [missing: …]). Fill or remove it before issuing.',
    confirm_required: 'Confirm the issue: an issued document cannot be changed.',
    assistant_amounts: 'The assistant does not type amounts in this kind of document: they come from the invoice or the books. Review the draft.',
    number_format: 'Invalid number format: letters, digits, separators and {YYYY}, {YY}, {####} (required).',
    reason_required: 'Give a reason (3 to 300 characters).',
    template_name_taken: 'A template with that name already exists.',
    file_invalid: 'Invalid file: only PNG or JPG images up to 2 MB and 6000 px.',
    forbidden: 'You do not have permission for this action.',
    invalid: 'Check the form data.',
    unavailable: 'Document Studio is not enabled in this database yet.',
    save: 'Could not save. Try again.',
  },
}
export const studioMessage = (code: string | null | undefined, locale: Locale) => (code ? MESSAGES[locale][code] ?? MESSAGES[locale].save : null)

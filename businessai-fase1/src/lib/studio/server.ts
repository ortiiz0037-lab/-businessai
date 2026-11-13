// Server only (node:fs, storage downloads with the user's session).
/**
 * Document Studio server helpers: fonts from public/studio/fonts, brand,
 * the document's data (live from the database or the issued snapshot) and
 * image bytes. Every read uses the user's own session (RLS decides).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseTtf } from '@/lib/studio/ttf'
import { FONT_FILES, type FontKey, type Fonts } from '@/lib/studio/layout'
import { BRAND_DEFAULTS, parseContent, parsePage, type Brand, type DocContent, type Kind, type PageSettings } from '@/lib/studio/model'
import type { StudioData } from '@/lib/studio/merge'
import { imageInfo } from '@/lib/studio/images'
import { documentItems, type LineItem } from '@/lib/documents/items'
import { LOGO_BUCKET, parseSignatureRef } from '@/lib/branding-assets'
import type { PdfImage } from '@/lib/studio/pdf'

let fontCache: Promise<Fonts> | null = null
/** The 8 font files, parsed once per server process. */
export function serverFonts(): Promise<Fonts> {
  fontCache ??= (async () => {
    const dir = path.join(process.cwd(), 'public', 'studio', 'fonts')
    const out: Fonts = {}
    await Promise.all(Object.entries(FONT_FILES).map(async ([k, f]) => { out[k as FontKey] = parseTtf(new Uint8Array(await readFile(path.join(dir, f)))) }))
    return out
  })()
  return fontCache
}

export type StudioDoc = {
  id: string; company_id: string; kind: Kind; title: string; folder: string | null; status: 'draft' | 'final' | 'archived'; number: string | null
  template_id: string | null; base_key: string | null; content: DocContent; page: PageSettings; client_id: string | null; source_document_id: string | null
  employee_id: string | null; vendor_id: string | null; origin: 'user' | 'assistant'; version: number
  snapshot: { data: StudioData; items: LineItem[]; issued_on: string; version: number } | null
  created_by: string | null; created_at: string; updated_at: string; updated_by: string | null; finalized_at: string | null; finalized_by: string | null
  archived_at: string | null; archive_reason: string | null
}

export async function loadDoc(supabase: SupabaseClient, companyId: string, id: string): Promise<StudioDoc | null> {
  const { data } = await supabase.from('studio_documents').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!data) return null
  const d = data as StudioDoc
  const parsed = parseContent(d.content)
  return { ...d, content: parsed.ok ? parsed.content : { v: 1, blocks: [] }, page: parsePage(d.page) }
}

export type BrandContext = { brand: Brand; accentFallback: string | null; logoUrl: string | null; signatureRef: string | null; companyName: string; currency: string }
export async function loadBrand(supabase: SupabaseClient, companyId: string): Promise<BrandContext> {
  const [b, p, c, s] = await Promise.all([
    supabase.from('studio_brand').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('company_profiles').select('primary_color, logo_url, signature_url, legal_name, display_name').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', companyId).maybeSingle(),
  ])
  const row = (b.data ?? {}) as Partial<Brand>
  const prof = (p.data ?? {}) as { primary_color?: string; logo_url?: string | null; signature_url?: string | null; legal_name?: string | null; display_name?: string | null }
  return {
    brand: { ...BRAND_DEFAULTS, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)), page: parsePage(row.page), number_formats: (row.number_formats ?? {}) as Record<string, string> } as Brand,
    accentFallback: prof.primary_color ?? null, logoUrl: prof.logo_url ?? null, signatureRef: prof.signature_url ?? null,
    companyName: prof.display_name || prof.legal_name || ((c.data as { name?: string } | null)?.name ?? ''),
    currency: (s.data as { base_currency?: string } | null)?.base_currency ?? 'USD',
  }
}

/** The data a document shows: the issued snapshot, or live from the database (studio_data) + the business document's lines. */
export async function loadData(supabase: SupabaseClient, doc: StudioDoc, today: string): Promise<{ data: StudioData; error: string | null }> {
  if (doc.status !== 'draft' && doc.snapshot) {
    return { data: { ...doc.snapshot.data, items: doc.snapshot.items ?? [], doc: { number: doc.number, title: doc.title, issued_on: doc.snapshot.issued_on } }, error: null }
  }
  const { data, error } = await supabase.rpc('studio_data', { doc: doc.id })
  if (error) return { data: { doc: { title: doc.title, issued_on: today } }, error: error.message }
  const d = (data ?? {}) as StudioData
  let items: LineItem[] = []
  if (doc.source_document_id) {
    const { data: src } = await supabase.from('documents').select('items, metadata, notes').eq('id', doc.source_document_id).maybeSingle()
    if (src) items = documentItems(src as { items: unknown; metadata: unknown; notes: string | null }).items
  }
  return { data: { ...d, items, doc: { number: null, title: doc.title, issued_on: today } }, error: null }
}

/** Only the company's own logo in its storage bucket is fetched (no arbitrary URLs: no SSRF). */
function logoPath(url: string | null, companyId: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !base) return null
  const prefix = `${base.replace(/\/$/, '')}/storage/v1/object/public/${LOGO_BUCKET}/${companyId}/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length).split('?')[0]
  return /^[\w.-]+$/.test(rest) ? `${companyId}/${rest}` : null
}

/** Bytes of an image for the PDF / preview: 'logo', 'signature', 'stamp' or a studio asset id. Validated by content. */
export async function loadImage(supabase: SupabaseClient, companyId: string, key: string, ctx: BrandContext): Promise<PdfImage | null> {
  let bytes: Uint8Array | null = null
  try {
    if (key === 'logo') {
      const p = logoPath(ctx.logoUrl, companyId)
      if (p) { const { data } = await supabase.storage.from(LOGO_BUCKET).download(p); if (data) bytes = new Uint8Array(await data.arrayBuffer()) }
    } else if (key === 'signature') {
      const ref = parseSignatureRef(ctx.signatureRef, companyId)
      if (ref?.kind === 'private') { const { data } = await supabase.storage.from(ref.bucket).download(ref.path); if (data) bytes = new Uint8Array(await data.arrayBuffer()) }
    } else {
      const id = key === 'stamp' ? ctx.brand.stamp_asset_id : key
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        const { data: a } = await supabase.from('studio_assets').select('storage_path').eq('id', id).eq('company_id', companyId).maybeSingle()
        if (a) { const { data } = await supabase.storage.from('Studio-assets').download((a as { storage_path: string }).storage_path); if (data) bytes = new Uint8Array(await data.arrayBuffer()) }
      }
    }
  } catch { bytes = null }
  const info = bytes ? imageInfo(bytes) : null
  return bytes && info ? { bytes, mime: info.mime } : null
}

/** Image keys a document needs (for the PDF and the preview). */
export function imageKeys(content: DocContent, brand: Brand): string[] {
  const keys = new Set<string>()
  if (brand.show_logo) keys.add('logo')
  for (const b of content.blocks) {
    if (b.type === 'image') keys.add(b.asset)
    if (b.type === 'signature' && b.withImage) keys.add('signature')
    if (b.type === 'stamp' && brand.stamp_asset_id) keys.add('stamp')
  }
  return [...keys]
}

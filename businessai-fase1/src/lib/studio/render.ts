import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { layout } from '@/lib/studio/layout'
import { buildPdf, type PdfImage } from '@/lib/studio/pdf'
import { imageKeys, loadBrand, loadData, loadImage, serverFonts, type StudioDoc } from '@/lib/studio/server'
import { imageInfo } from '@/lib/studio/images'
import { effectiveBrand, kindLabel } from '@/lib/studio/model'

/**
 * The document as a PDF (real text, embedded fonts), read with the caller's
 * session: the same pages as the preview. Used by the PDF route and by
 * «attach the PDF to the expense» (0038).
 */
export async function renderStudioPdf(supabase: SupabaseClient, companyId: string, doc: StudioDoc, locale: Locale) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [ctx, fonts, { data }] = await Promise.all([loadBrand(supabase, companyId), serverFonts(), loadData(supabase, doc, today)])
  const keys = imageKeys(doc.content, ctx.brand)
  const loaded = await Promise.all(keys.map(async (k) => [k, await loadImage(supabase, companyId, k, ctx)] as const))
  const images: Record<string, PdfImage | undefined> = {}
  const dims: Record<string, { width: number; height: number }> = {}
  for (const [k, img] of loaded) if (img) { images[k] = img; const i = imageInfo(img.bytes); if (i) dims[k] = { width: i.width, height: i.height } }
  const brand = effectiveBrand(ctx.brand, doc.status, locale)
  const r = layout({ content: doc.content, page: doc.page, brand, accentFallback: ctx.accentFallback, data, locale, currency: ctx.currency, images: dims, fonts, kind: doc.kind, title: doc.title })
  const title = `${kindLabel(doc.kind, locale)}${doc.number ? ` ${doc.number}` : ''} — ${doc.title}`
  const bytes = buildPdf(r.pages, fonts, images, { title, author: ctx.companyName, lang: locale === 'en' ? 'en-US' : 'es-PR' })
  const fileName = `${(doc.number ?? doc.title).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'documento'}.pdf`
  return { bytes, pages: r.pages.length, fileName }
}

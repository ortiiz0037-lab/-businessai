import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { layout } from '@/lib/studio/layout'
import { buildPdf, type PdfImage } from '@/lib/studio/pdf'
import { imageKeys, loadBrand, loadData, loadDoc, loadImage, serverFonts } from '@/lib/studio/server'
import { imageInfo } from '@/lib/studio/images'
import { effectiveBrand, kindLabel } from '@/lib/studio/model'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The document as a PDF (real text, embedded fonts), read with the user's session; each export is audited. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const doc = await loadDoc(supabase, member.companyId, id)
  if (!doc) return new NextResponse('Not found', { status: 404 })
  const locale = await getLocale()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [ctx, fonts, { data }] = await Promise.all([loadBrand(supabase, member.companyId), serverFonts(), loadData(supabase, doc, today)])
  const keys = imageKeys(doc.content, ctx.brand)
  const loaded = await Promise.all(keys.map(async (k) => [k, await loadImage(supabase, member.companyId, k, ctx)] as const))
  const images: Record<string, PdfImage | undefined> = {}
  const dims: Record<string, { width: number; height: number }> = {}
  for (const [k, img] of loaded) if (img) { images[k] = img; const i = imageInfo(img.bytes); if (i) dims[k] = { width: i.width, height: i.height } }
  const brand = effectiveBrand(ctx.brand, doc.status, locale)
  const r = layout({ content: doc.content, page: doc.page, brand, accentFallback: ctx.accentFallback, data, locale, currency: ctx.currency, images: dims, fonts, kind: doc.kind, title: doc.title })
  const title = `${kindLabel(doc.kind, locale)}${doc.number ? ` ${doc.number}` : ''} — ${doc.title}`
  const pdf = buildPdf(r.pages, fonts, images, { title, author: ctx.companyName, lang: locale === 'en' ? 'en-US' : 'es-PR' })
  const download = new URL(req.url).searchParams.get('download') === '1'
  await supabase.rpc('studio_record', { doc: id, act: 'exported_pdf', info: { pages: r.pages.length, download, status: doc.status } })
  const file = `${(doc.number ?? doc.title).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'documento'}.pdf`
  return new NextResponse(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${file}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
}

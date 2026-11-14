import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { StudioEditor } from '@/components/studio/editor'
import type { PreviewImages } from '@/components/studio/preview'
import { studioPage } from '@/lib/studio/page'
import { loadBrand, loadImage } from '@/lib/studio/server'
import { imageInfo } from '@/lib/studio/images'
import { kindLabel, parseContent, parsePage, studioMessage, type Kind } from '@/lib/studio/model'
import type { StudioData } from '@/lib/studio/merge'
import { saveTemplateState } from '@/app/actions/studio'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Editor of a company template. The preview uses only the company's own data (no client is bound to a template). */
export default async function StudioTemplateEditor({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  if (!UUID.test(id)) notFound()
  const { locale, tr, today, supabase, companyId, access } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  if (!access.templates) return <NoStudioAccess tr={tr} unavailable={false} />
  const { data: row } = await supabase.from('studio_templates').select('id, kind, name, content, page, status').eq('id', id).eq('company_id', companyId).maybeSingle()
  const t = row as { id: string; kind: Kind; name: string; content: unknown; page: unknown; status: string } | null
  if (!t || t.status !== 'active') notFound()
  const parsed = parseContent(t.content)
  const [ctx, { data: c }, { data: p }, { data: assetRows }] = await Promise.all([
    loadBrand(supabase, companyId), supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('company_profiles').select('legal_name, display_name, phone, email, address, city, state, postal_code, payment_info').eq('company_id', companyId).maybeSingle(),
    supabase.from('studio_assets').select('id, file_name, width, height').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200),
  ])
  const data: StudioData = { company: { name: (c as { name?: string } | null)?.name ?? null, ...((p ?? {}) as Record<string, string | null>) }, doc: { title: t.name, issued_on: today } }
  const assets = ((assetRows ?? []) as { id: string; file_name: string; width: number; height: number }[]).map((a) => ({ id: a.id, name: a.file_name, width: a.width, height: a.height }))
  const images: PreviewImages = Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height, url: `/studio/image?key=${a.id}` }]))
  for (const k of ['logo', 'signature', 'stamp']) { const img = await loadImage(supabase, companyId, k, ctx); const info = img ? imageInfo(img.bytes) : null; if (info) images[k] = { width: info.width, height: info.height, url: `/studio/image?key=${k}` } }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={`Document Studio · ${tr('Plantilla', 'Template')}`} title={t.name}
        description={tr(`${kindLabel(t.kind, locale)}. Los datos de clientes y documentos aparecen como [falta: …] porque una plantilla no tiene datos vinculados.`, `${kindLabel(t.kind, locale)}. Client and document data shows as [missing: …] because a template has no linked data.`)} />
      <StudioNav tr={tr} current="/studio/templates" />
      <Flash done={sp.done === 'template_created' ? tr('Copia de la plantilla creada para tu empresa.', 'Template copy created for your company.') : null} error={studioMessage(sp.error, locale)} />
      <StudioEditor mode="template" id={t.id} title={t.name} kind={t.kind} content={parsed.ok ? parsed.content : { v: 1, blocks: [] }} page={parsePage(t.page)}
        brand={ctx.brand} accentFallback={ctx.accentFallback} data={data} locale={locale} currency={ctx.currency} images={images} assets={assets} canUpload={access.edit} action={saveTemplateState} />
    </div>
  )
}

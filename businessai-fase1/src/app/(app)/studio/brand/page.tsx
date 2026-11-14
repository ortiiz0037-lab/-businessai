import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoStudioAccess, StudioNav } from '@/components/studio-nav'
import { AssetUploader } from '@/components/studio/asset-uploader'
import { studioPage } from '@/lib/studio/page'
import { loadBrand } from '@/lib/studio/server'
import { KINDS, PAGE_DEFAULTS, kindLabel, studioMessage } from '@/lib/studio/model'
import { saveBrand } from '@/app/actions/studio'

export const dynamic = 'force-dynamic'

/** Corporate identity of documents. Logo, signature and base colours stay in Company settings (not duplicated here). */
export default async function StudioBrand({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await studioPage()
  if (!access.view || !access.available) return <NoStudioAccess tr={tr} unavailable={!access.available} />
  const [ctx, { data: assetRows }] = await Promise.all([loadBrand(supabase, companyId), supabase.from('studio_assets').select('id, file_name').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200)])
  const b = ctx.brand
  const page = { ...PAGE_DEFAULTS, ...b.page }
  const assets = (assetRows ?? []) as { id: string; file_name: string }[]
  const ro = !access.brand
  const defaults: Record<string, string> = { letter: 'CAR-{YYYY}-{####}', work_order: 'OT-{YYYY}-{####}', purchase_order: 'OC-{YYYY}-{####}', contract: 'CON-{YYYY}-{####}', report: 'INF-{YYYY}-{####}', account_statement: 'EC-{YYYY}-{####}', certificate: 'CER-{YYYY}-{####}' }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Document Studio" title={tr('Identidad corporativa', 'Corporate identity')}
        description={tr('Tipografías, colores, encabezado, pie, marca de agua, sello, firma y numeración de todos los documentos.', 'Typefaces, colours, header, footer, watermark, stamp, signature and numbering of every document.')} />
      <StudioNav tr={tr} current="/studio/brand" />
      <Flash done={sp.done === 'brand_saved' ? tr('Identidad guardada.', 'Identity saved.') : null} error={studioMessage(sp.error, locale)} />
      <p className="card p-4 text-sm text-muted">{tr('El logo, la firma y el color principal se gestionan en ', 'The logo, signature and main colour are managed in ')}<Link href="/settings/company" className="text-accent">{tr('Mi empresa', 'My company')}</Link>
        {tr(' y se usan aquí sin copiarlos.', ' and used here without copying them.')} {ctx.logoUrl ? tr('Logo: configurado.', 'Logo: set.') : tr('Logo: sin configurar.', 'Logo: not set.')}</p>
      <form action={saveBrand} className="space-y-4">
        <fieldset disabled={ro} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('Tipografía y color', 'Type and colour')}</legend>
          <label className="text-sm"><span className="field-label">{tr('Títulos', 'Headings')}</span><select name="heading_font" defaultValue={b.heading_font} className="field"><option value="sans">Sans</option><option value="serif">Serif</option></select></label>
          <label className="text-sm"><span className="field-label">{tr('Texto', 'Body')}</span><select name="body_font" defaultValue={b.body_font} className="field"><option value="sans">Sans</option><option value="serif">Serif</option></select></label>
          <label className="text-sm"><span className="field-label">{tr('Color de acento', 'Accent colour')}</span><input type="color" name="accent_color" defaultValue={b.accent_color ?? ctx.accentFallback ?? '#1D4ED8'} className="field h-10 p-1" /></label>
          <label className="text-sm"><span className="field-label">{tr('Color del texto', 'Text colour')}</span><input type="color" name="text_color" defaultValue={b.text_color} className="field h-10 p-1" /></label>
          <label className="text-sm"><span className="field-label">{tr('Tamaño de página', 'Page size')}</span><select name="size" defaultValue={page.size} className="field"><option value="letter">Carta / Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></label>
          <label className="text-sm"><span className="field-label">{tr('Cuerpo (pt)', 'Body (pt)')}</span><input type="number" name="fontSize" min={8} max={16} step={0.5} defaultValue={page.fontSize} className="field" /></label>
          <label className="text-sm"><span className="field-label">{tr('Márgenes (mm)', 'Margins (mm)')}</span><input type="number" name="margin" min={8} max={50} defaultValue={page.marginTop} className="field" /></label>
        </fieldset>
        <fieldset disabled={ro} className="card grid gap-3 p-4 sm:grid-cols-2">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('Encabezado, pie y marca de agua', 'Header, footer and watermark')}</legend>
          <label className="text-sm"><span className="field-label">{tr('Texto del encabezado (admite {{campos}})', 'Header text (accepts {{fields}})')}</span><input name="header_text" maxLength={300} defaultValue={b.header_text ?? ''} className="field" placeholder="{{company.legal_name}} · {{company.phone}}" /></label>
          <label className="text-sm"><span className="field-label">{tr('Texto del pie', 'Footer text')}</span><input name="footer_text" maxLength={300} defaultValue={b.footer_text ?? ''} className="field" /></label>
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" name="show_logo" defaultChecked={b.show_logo} /> {tr('Logo en el encabezado', 'Logo in the header')}</label>
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" name="show_page_numbers" defaultChecked={b.show_page_numbers} /> {tr('Numeración de páginas', 'Page numbers')}</label>
          <label className="text-sm"><span className="field-label">{tr('Marca de agua (vacío = ninguna; los borradores muestran BORRADOR)', 'Watermark (empty = none; drafts show DRAFT)')}</span><input name="watermark_text" maxLength={40} defaultValue={b.watermark_text ?? ''} className="field" /></label>
          <label className="text-sm"><span className="field-label">{tr('Opacidad de la marca (%)', 'Watermark opacity (%)')}</span><input type="number" name="watermark_opacity" min={3} max={30} defaultValue={b.watermark_opacity} className="field" /></label>
        </fieldset>
        <fieldset disabled={ro} className="card grid gap-3 p-4 sm:grid-cols-2">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('Firma y sello', 'Signature and stamp')}</legend>
          <label className="text-sm"><span className="field-label">{tr('Nombre de quien firma', 'Signer name')}</span><input name="signature_name" maxLength={120} defaultValue={b.signature_name ?? ''} className="field" /></label>
          <label className="text-sm"><span className="field-label">{tr('Cargo', 'Title')}</span><input name="signature_title" maxLength={120} defaultValue={b.signature_title ?? ''} className="field" /></label>
          <label className="text-sm"><span className="field-label">{tr('Sello (imagen)', 'Stamp (image)')}</span><select name="stamp_asset_id" defaultValue={b.stamp_asset_id ?? ''} className="field"><option value="">{tr('Ninguno', 'None')}</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.file_name}</option>)}</select></label>
        </fieldset>
        <fieldset disabled={ro} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="px-1 font-display text-lg font-semibold text-fg">{tr('Numeración', 'Numbering')}</legend>
          <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{tr('Facturas, cotizaciones y recibos usan el número de su documento comercial. Para el resto: {YYYY} año, {YY} año corto, {####} consecutivo (obligatorio).',
            'Invoices, quotes and receipts use their business document number. For the rest: {YYYY} year, {YY} short year, {####} sequence (required).')}</p>
          {KINDS.filter((k) => !['invoice', 'quote', 'receipt'].includes(k)).map((k) => (
            <label key={k} className="text-sm"><span className="field-label">{kindLabel(k, locale)}</span><input name={`format_${k}`} maxLength={30} defaultValue={b.number_formats[k] ?? ''} placeholder={defaults[k]} className="field" /></label>))}
        </fieldset>
        {!ro && <SubmitButton className="w-full sm:w-auto">{tr('Guardar identidad', 'Save identity')}</SubmitButton>}
      </form>
      {access.edit && <div className="card space-y-2 p-4"><h2 className="font-display text-lg font-semibold text-fg">{tr('Imágenes', 'Images')}</h2>
        <p className="text-xs text-muted">{tr('PNG o JPG, hasta 2 MB. Se guardan en un almacenamiento privado de la empresa.', 'PNG or JPG, up to 2 MB. Stored in the company\'s private storage.')}</p>
        <AssetUploader label={tr('Subir imagen', 'Upload image')} busy={tr('Subiendo…', 'Uploading…')} done={tr('Imagen subida.', 'Image uploaded.')} failed={studioMessage('file_invalid', locale) ?? ''} />
        {assets.length > 0 && <ul className="text-sm text-slate-300">{assets.slice(0, 20).map((a) => <li key={a.id}>{a.file_name}</li>)}</ul>}</div>}
    </div>
  )
}

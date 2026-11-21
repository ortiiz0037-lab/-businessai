import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { documentTypeName } from '@/components/ui/status'
import { catalogPage } from '@/lib/catalog-page'
import { CATALOG_COLUMNS, catalogMessage, kindName, type CatalogItem } from '@/lib/catalog'
import { saveCatalogItem, setCatalogStatus } from '@/app/actions/catalog'
import { CatalogInventoryPanel } from '@/components/inventory/catalog-panel'
import { inventoryMessage } from '@/lib/inventory/labels'

export const dynamic = 'force-dynamic'

const cents2 = (c: number) => (c / 100).toFixed(2)

/** One catalog item: edit, archive / restore, where it was used and its history. */
export default async function CatalogItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, p] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access } = await catalogPage()
  if (!/^[0-9a-f-]{36}$/i.test(id) || !access.available || !access.view) notFound()
  const { data } = await supabase.from('catalog_items').select(CATALOG_COLUMNS).eq('id', id).eq('company_id', companyId).maybeSingle()
  const item = data as CatalogItem | null
  if (!item) notFound()
  const [{ data: used }, { data: ev }] = await Promise.all([
    // where it was used: lines copied from it (documents.items keeps catalog_item_id), read through the documents' own RLS
    supabase.from('documents').select('id, document_type, document_number, title, status, issue_date').eq('company_id', companyId)
      .contains('items', JSON.stringify([{ catalog_item_id: id }])).order('created_at', { ascending: false }).limit(50),
    access.manage ? supabase.from('catalog_events').select('id, action, changes, created_at').eq('item_id', id).order('id', { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
  ])
  const docs = (used ?? []) as { id: string; document_type: string; document_number: string | null; title: string | null; status: string; issue_date: string | null }[]
  const events = (ev ?? []) as { id: number; action: string; changes: Record<string, { from?: string; to?: string } | unknown>; created_at: string }[]
  const archived = item.status === 'archived'
  const done: Record<string, string> = {
    created: tr('Artículo creado.', 'Item created.'), saved: tr('Cambios guardados.', 'Changes saved.'),
    archived: tr('Artículo archivado: ya no se ofrece en documentos nuevos.', 'Item archived: no longer offered in new documents.'), restored: tr('Artículo restaurado.', 'Item restored.'),
    cost: tr('Costo guardado (queda en el historial).', 'Cost saved (kept in the history).'), variant: tr('Variantes actualizadas.', 'Variants updated.'),
    barcode: tr('Código añadido.', 'Code added.'), barcode_removed: tr('Código quitado.', 'Code removed.'),
  }
  const action: Record<string, string> = { created: tr('Creado', 'Created'), updated: tr('Editado', 'Edited'), archived: tr('Archivado', 'Archived'), restored: tr('Restaurado', 'Restored') }
  return (
    <div className="space-y-6">
      <Link href="/catalog" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Catálogo', '← Catalog')}</Link>
      <PageHeader eyebrow={`${kindName(item.kind, locale)} · ${item.code}`} title={item.name}
        description={archived ? tr('Archivado: los documentos que lo usaron conservan su copia.', 'Archived: documents that used it keep their copy.') : `${money(item.price_cents)} / ${item.unit}`} />
      <Flash done={p.done ? done[p.done] : null} error={/^(barcode_|inventory_)/.test(p.error ?? '') ? inventoryMessage(p.error, locale) : catalogMessage(p.error, locale)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {access.manage && !archived ? (
            <form action={saveCatalogItem} key={item.version} className="card grid gap-3 p-5 sm:grid-cols-2" data-testid="catalog-edit">
              <input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} />
              <label className="text-sm"><span className="field-label">{tr('Código', 'Code')}</span><input name="code" required maxLength={40} defaultValue={item.code} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={160} defaultValue={item.name} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span>
                <select name="kind" defaultValue={item.kind} className="field"><option value="product">{kindName('product', locale)}</option><option value="service">{kindName('service', locale)}</option></select></label>
              <label className="text-sm"><span className="field-label">{tr('Unidad', 'Unit')}</span><input name="unit" required maxLength={20} defaultValue={item.unit} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Precio ($)', 'Price ($)')}</span><input name="price" required inputMode="decimal" maxLength={16} defaultValue={cents2(item.price_cents)} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Impuesto propio (%)', 'Own tax (%)')}</span><input name="tax_rate" inputMode="decimal" maxLength={6} defaultValue={item.tax_rate ?? ''} className="field" placeholder={tr('el del documento', "the document's")} /></label>
              <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Descripción', 'Description')}</span><input name="description" maxLength={1000} defaultValue={item.description ?? ''} className="field" /></label>
              <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="track_inventory" defaultChecked={item.track_inventory} /> {tr('Controlará inventario (producto)', 'Will track stock (product)')}</label>
              <div className="sm:col-span-2"><SubmitButton>{tr('Guardar cambios', 'Save changes')}</SubmitButton></div>
            </form>
          ) : (
            <dl className="card grid gap-3 p-5 text-sm sm:grid-cols-2">
              <div><dt className="text-muted">{tr('Precio', 'Price')}</dt><dd className="font-semibold text-fg">{money(item.price_cents)} / {item.unit}</dd></div>
              <div><dt className="text-muted">{tr('Impuesto', 'Tax')}</dt><dd className="text-fg">{item.tax_rate !== null ? `${item.tax_rate}%` : tr('El del documento', "The document's")}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted">{tr('Descripción', 'Description')}</dt><dd className="text-fg">{item.description || '—'}</dd></div>
            </dl>
          )}
          <CatalogInventoryPanel supabase={supabase} itemId={item.id} kind={item.kind} tr={tr} manage={access.manage && !archived} money={money} locale={locale} />
          <section className="card space-y-3 p-5" aria-labelledby="used-title" data-testid="catalog-used">
            <h2 id="used-title" className="font-display text-lg font-semibold text-fg">{tr('Dónde se usó', 'Where it was used')}</h2>
            {docs.length === 0
              ? <p className="text-sm text-muted">{tr('Ningún documento lo usa todavía.', 'No document uses it yet.')}</p>
              : <ul className="divide-y divide-line/60 text-sm">{docs.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/documents/${d.id}`} className="text-accent">{documentTypeName(d.document_type, locale)} {d.document_number ?? ''}{d.title ? ` · ${d.title}` : ''}</Link>
                    <span className="text-xs text-muted">{d.issue_date ? f.date(d.issue_date) : ''}</span>
                  </li>))}</ul>}
          </section>
        </div>
        <aside className="min-w-0 space-y-6">
          {access.manage && (
            <form action={setCatalogStatus} className="card space-y-3 p-5">
              <input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} />
              <input type="hidden" name="status" value={archived ? 'active' : 'archived'} />
              <p className="text-sm text-muted">{archived
                ? tr('Restaurarlo lo vuelve a ofrecer en documentos nuevos.', 'Restoring it offers it again in new documents.')
                : tr('Archivarlo lo quita de los documentos nuevos. No se borra: los documentos conservan su copia y el código no se reutiliza.', 'Archiving removes it from new documents. It is not deleted: documents keep their copy and the code is not reused.')}</p>
              <SubmitButton>{archived ? tr('Restaurar', 'Restore') : tr('Archivar', 'Archive')}</SubmitButton>
            </form>
          )}
          {access.manage && (
            <section className="card space-y-2 p-5" aria-labelledby="hist-title" data-testid="catalog-history">
              <h2 id="hist-title" className="font-display text-lg font-semibold text-fg">{tr('Historial', 'History')}</h2>
              <ul className="space-y-2 text-sm">{events.map((e) => (
                <li key={e.id}><span className="font-semibold text-fg">{action[e.action] ?? e.action}</span> <span className="text-xs text-muted">{f.date(e.created_at.slice(0, 10))}</span>
                  {e.action === 'updated' && <span className="block text-xs text-muted">{Object.keys(e.changes).join(', ')}</span>}</li>))}</ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

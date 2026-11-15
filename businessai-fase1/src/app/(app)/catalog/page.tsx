import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { catalogPage } from '@/lib/catalog-page'
import { CATALOG_COLUMNS, catalogMessage, kindName, type CatalogItem } from '@/lib/catalog'
import { saveCatalogItem } from '@/app/actions/catalog'

export const dynamic = 'force-dynamic'

/** Catalog of products and services: search, filters and a new item. */
export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; status?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, money, supabase, companyId, access } = await catalogPage()
  if (!access.available || !access.view) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={tr('Catálogo', 'Catalog')} title={tr('Productos y servicios', 'Products and services')} />
        <div className="card"><EmptyState icon="archive" title={access.available ? tr('No tienes acceso al catálogo.', 'You have no access to the catalog.') : tr('El catálogo todavía no está activado en esta base de datos.', 'The catalog is not enabled in this database yet.')} /></div>
      </div>
    )
  }
  const q = (p.q ?? '').trim().slice(0, 80)
  const kind = p.kind === 'product' || p.kind === 'service' ? p.kind : ''
  const status = p.status === 'archived' || p.status === 'all' ? p.status : 'active'
  let query = supabase.from('catalog_items').select(CATALOG_COLUMNS).eq('company_id', companyId).order('name').limit(500)
  if (status !== 'all') query = query.eq('status', status)
  if (kind) query = query.eq('kind', kind)
  if (q) { const s = q.replace(/[%_,()]/g, ' '); query = query.or(`name.ilike.%${s}%,code.ilike.%${s}%`) }
  const { data } = await query
  const items = (data ?? []) as CatalogItem[]
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Catálogo', 'Catalog')} title={tr('Productos y servicios', 'Products and services')}
        description={tr('Precios y unidades para tus facturas, cotizaciones y documentos de Studio. Elegir un artículo copia sus datos en la línea: cambiarlo después no altera lo ya escrito.',
          'Prices and units for your invoices, quotes and Studio documents. Choosing an item copies its data into the line: changing it later never alters what was written.')} />
      <Flash error={catalogMessage(p.error, locale)} />
      {access.manage && (
        <details className="card p-5" open={items.length === 0 && !q && status === 'active'}>
          <summary className="cursor-pointer font-semibold text-accent">{tr('Nuevo artículo', 'New item')}</summary>
          <form action={saveCatalogItem} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="catalog-new">
            <label className="text-sm"><span className="field-label">{tr('Código', 'Code')}</span><input name="code" required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9._\/\-]{0,39}" className="field" placeholder="MAT-001" /></label>
            <label className="text-sm sm:col-span-1 lg:col-span-2"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={160} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span>
              <select name="kind" className="field" defaultValue="product"><option value="product">{kindName('product', locale)}</option><option value="service">{kindName('service', locale)}</option></select></label>
            <label className="text-sm"><span className="field-label">{tr('Unidad', 'Unit')}</span><input name="unit" required maxLength={20} defaultValue={tr('unidad', 'unit')} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Precio ($)', 'Price ($)')}</span><input name="price" required inputMode="decimal" maxLength={16} className="field" placeholder="0.00" /></label>
            <label className="text-sm"><span className="field-label">{tr('Impuesto propio (%)', 'Own tax (%)')}</span><input name="tax_rate" inputMode="decimal" maxLength={6} className="field" placeholder={tr('el del documento', "the document's")} /></label>
            <label className="flex items-end gap-2 pb-2 text-sm text-muted"><input type="checkbox" name="track_inventory" /> {tr('Controlará inventario (producto)', 'Will track stock (product)')}</label>
            <label className="text-sm sm:col-span-2 lg:col-span-4"><span className="field-label">{tr('Descripción (opcional)', 'Description (optional)')}</span><input name="description" maxLength={1000} className="field" /></label>
            <div><SubmitButton>{tr('Crear artículo', 'Create item')}</SubmitButton></div>
          </form>
        </details>
      )}
      <form className="card flex flex-wrap items-end gap-3 p-4" role="search">
        <label className="min-w-0 flex-1 text-sm"><span className="field-label">{tr('Buscar', 'Search')}</span><input name="q" defaultValue={q} maxLength={80} className="field" placeholder={tr('Código o nombre', 'Code or name')} /></label>
        <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span>
          <select name="kind" defaultValue={kind} className="field"><option value="">{tr('Todos', 'All')}</option><option value="product">{kindName('product', locale)}</option><option value="service">{kindName('service', locale)}</option></select></label>
        <label className="text-sm"><span className="field-label">{tr('Estado', 'Status')}</span>
          <select name="status" defaultValue={status} className="field"><option value="active">{tr('Activos', 'Active')}</option><option value="archived">{tr('Archivados', 'Archived')}</option><option value="all">{tr('Todos', 'All')}</option></select></label>
        <button className="btn-secondary" type="submit">{tr('Filtrar', 'Filter')}</button>
      </form>
      {items.length === 0
        ? <div className="card"><EmptyState icon="archive" title={q || kind || status !== 'active' ? tr('Ningún artículo coincide.', 'No item matches.') : tr('El catálogo está vacío.', 'The catalog is empty.')} /></div>
        : (
          <ul className="card divide-y divide-line/60 overflow-hidden" data-testid="catalog-list">
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`/catalog/${i.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 transition hover:bg-white/[0.03]">
                  <span className="min-w-0"><span className={`block font-semibold ${i.status === 'archived' ? 'text-muted line-through' : 'text-fg'}`}><span className="font-mono text-xs text-muted">{i.code}</span> {i.name}</span>
                    <span className="block text-xs text-muted">{kindName(i.kind, locale)} · {i.unit}{i.tax_rate !== null ? ` · ${tr('impuesto', 'tax')} ${i.tax_rate}%` : ''}{i.track_inventory ? ` · ${tr('inventario', 'stock')}` : ''}</span></span>
                  <span className="text-right text-sm tabular-nums text-fg">{money(i.price_cents)}<span className="block text-xs text-muted">/ {i.unit}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

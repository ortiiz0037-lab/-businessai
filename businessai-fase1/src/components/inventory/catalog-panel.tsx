import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import type { Tr } from '@/lib/i18n/t'
import { SubmitButton } from '@/components/submit-button'
import { SYMBOLOGIES } from '@/lib/inventory/codes'
import { SYMBOLOGY_LABEL } from '@/lib/inventory/labels'
import { addBarcode, removeBarcode, saveVariant, setItemCost, setVariantStatus } from '@/app/actions/inventory'

/**
 * S7 (0043) on the catalog item page: acquisition cost (with history), variants (size / color / model, own
 * SKU), barcodes (UPC / EAN checked by check digit, alternative codes). Hidden without 0043.
 */
export async function CatalogInventoryPanel({ supabase, itemId, kind, tr, manage, money, locale }: { supabase: SupabaseClient; itemId: string; kind: string; tr: Tr; manage: boolean; money: (c: number) => string; locale: Locale }) {
  const [{ data: item, error }, { data: vs }, { data: bc }, { data: hist }] = await Promise.all([
    supabase.from('catalog_items').select('cost_cents, track_inventory').eq('id', itemId).maybeSingle(),
    supabase.from('catalog_variants').select('id, sku, attributes, price_cents, cost_cents, status').eq('item_id', itemId).order('sku'),
    supabase.from('catalog_barcodes').select('id, code, symbology, is_primary, variant_id').eq('item_id', itemId).order('created_at'),
    manage ? supabase.from('inventory_cost_history').select('cost_cents, previous_cents, source, created_at').eq('item_id', itemId).order('id', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
  ])
  if (error || !item) return null
  const it = item as { cost_cents: number | null; track_inventory: boolean }
  const variants = (vs ?? []) as { id: string; sku: string; attributes: Record<string, string>; price_cents: number | null; cost_cents: number | null; status: string }[]
  const barcodes = (bc ?? []) as { id: string; code: string; symbology: string; is_primary: boolean; variant_id: string | null }[]
  const history = (hist ?? []) as { cost_cents: number; previous_cents: number | null; source: string; created_at: string }[]
  const back = `/catalog/${itemId}`
  const vlabel = (id: string | null) => { const v = variants.find((x) => x.id === id); return v ? `${Object.values(v.attributes).join(' / ') || v.sku}` : tr('Producto', 'Product') }
  const product = kind === 'product'
  return (
    <section className="card space-y-5 p-5" aria-labelledby="inv-title" data-testid="catalog-inventory">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="inv-title" className="font-display text-lg font-semibold text-fg">{tr('Inventario: códigos, variantes y costo', 'Inventory: codes, variants and cost')}</h2>
        {it.track_inventory && <Link href={`/inventory/items/${itemId}`} className="text-sm text-accent hover:underline">{tr('Ver existencias', 'See stock')}</Link>}
      </div>
      {!product && <p className="text-sm text-muted">{tr('Los servicios no tienen existencias ni variantes.', 'Services hold no stock or variants.')}</p>}
      {product && <>
        <div className="space-y-2">
          <p className="text-sm"><span className="text-muted">{tr('Costo de adquisición', 'Acquisition cost')}:</span> <strong className="text-fg">{it.cost_cents !== null ? money(it.cost_cents) : '—'}</strong>
            <span className="text-xs text-muted"> · {tr('distinto del precio de venta', 'separate from the sale price')}</span></p>
          {manage && (
            <form action={setItemCost} className="flex flex-col gap-2 sm:flex-row">
              <input type="hidden" name="item_id" value={itemId} /><input type="hidden" name="back" value={back} />
              <label className="sr-only" htmlFor="cost">{tr('Costo ($)', 'Cost ($)')}</label><input id="cost" name="cost" required inputMode="decimal" placeholder={tr('Costo ($)', 'Cost ($)')} className="field sm:w-32" />
              <label className="sr-only" htmlFor="cost-reason">{tr('Motivo', 'Reason')}</label><input id="cost-reason" name="reason" maxLength={300} placeholder={tr('Motivo (opcional)', 'Reason (optional)')} className="field min-w-0 flex-1" />
              <SubmitButton className="w-full sm:w-auto">{tr('Guardar costo', 'Save cost')}</SubmitButton>
            </form>)}
          {history.length > 0 && <ul className="text-xs text-muted">{history.map((h, i) => <li key={i}>{h.created_at.slice(0, 10)} · {h.source === 'manual' ? tr('manual', 'manual') : h.source === 'receipt' ? tr('recepción', 'receipt') : tr('revaluación', 'revaluation')}: {money(Math.round(h.cost_cents))}{h.previous_cents !== null ? ` (${tr('antes', 'before')} ${money(Math.round(h.previous_cents))})` : ''}</li>)}</ul>}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">{tr('Variantes', 'Variants')}</h3>
          {variants.length === 0 ? <p className="text-xs text-muted">{tr('Sin variantes: el producto se controla como una sola unidad de inventario.', 'No variants: the product is tracked as a single stock unit.')}</p> : (
            <ul className="divide-y divide-line/60 text-sm" data-testid="variants">{variants.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className={v.status === 'archived' ? 'text-muted line-through' : 'text-fg'}>{Object.values(v.attributes).join(' / ') || '—'}</span> <span className="text-xs text-muted">{v.sku}{v.price_cents !== null ? ` · ${money(v.price_cents)}` : ''}{v.cost_cents !== null ? ` · ${tr('costo', 'cost')} ${money(v.cost_cents)}` : ''}</span></span>
                {manage && <form action={setVariantStatus}><input type="hidden" name="variant_id" value={v.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value={v.status === 'active' ? 'archived' : 'active'} />
                  <button className="btn-secondary btn-sm">{v.status === 'active' ? tr('Archivar', 'Archive') : tr('Restaurar', 'Restore')}</button></form>}
              </li>))}</ul>)}
          {manage && (
            <form action={saveVariant} className="grid grid-cols-2 gap-2 sm:grid-cols-6" data-testid="variant-form">
              <input type="hidden" name="item_id" value={itemId} /><input type="hidden" name="back" value={back} />
              <input name="sku" required maxLength={40} placeholder="SKU" aria-label="SKU" className="field col-span-2 sm:col-span-1" />
              <input name="size" maxLength={60} placeholder={tr('Talla', 'Size')} aria-label={tr('Talla', 'Size')} className="field" />
              <input name="color" maxLength={60} placeholder={tr('Color', 'Color')} aria-label={tr('Color', 'Color')} className="field" />
              <input name="model" maxLength={60} placeholder={tr('Modelo', 'Model')} aria-label={tr('Modelo', 'Model')} className="field" />
              <input name="price" inputMode="decimal" placeholder={tr('Precio ($)', 'Price ($)')} aria-label={tr('Precio', 'Price')} className="field" />
              <input name="cost" inputMode="decimal" placeholder={tr('Costo ($)', 'Cost ($)')} aria-label={tr('Costo', 'Cost')} className="field" />
              <div className="col-span-2 sm:col-span-6"><SubmitButton className="w-full sm:w-auto">{tr('Añadir variante', 'Add variant')}</SubmitButton></div>
            </form>)}
        </div>
      </>}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{tr('Códigos de barras y alternativos', 'Barcodes and alternative codes')}</h3>
        <p className="text-xs text-muted">{tr('Un código identifica un solo producto (o variante) de la empresa. UPC y EAN se validan con su dígito de control.', 'A code identifies one product (or variant) of the company. UPC and EAN are checked by their check digit.')}</p>
        {barcodes.length > 0 && <ul className="divide-y divide-line/60 text-sm" data-testid="barcodes">{barcodes.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className="font-mono">{b.code}</span>
            <span className="text-xs text-muted">{SYMBOLOGY_LABEL[b.symbology] ?? b.symbology} · {vlabel(b.variant_id)}{b.is_primary ? ` · ${tr('principal', 'primary')}` : ''}</span>
            {manage && <form action={removeBarcode}><input type="hidden" name="barcode_id" value={b.id} /><input type="hidden" name="back" value={back} /><button className="btn-secondary btn-sm">{tr('Quitar', 'Remove')}</button></form>}</li>))}</ul>}
        {manage && (
          <form action={addBarcode} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_auto]" data-testid="barcode-form">
            <input type="hidden" name="item_id" value={itemId} /><input type="hidden" name="back" value={back} />
            <input name="code" required maxLength={64} placeholder={tr('Código (escanea o escribe)', 'Code (scan or type)')} aria-label={tr('Código', 'Code')} className="field font-mono" />
            <select name="symbology" defaultValue="ean13" aria-label={tr('Formato', 'Format')} className="field">{SYMBOLOGIES.map((s) => <option key={s} value={s}>{SYMBOLOGY_LABEL[s]}</option>)}</select>
            <select name="variant_id" defaultValue="" aria-label={tr('Variante', 'Variant')} className="field"><option value="">{tr('Producto (sin variante)', 'Product (no variant)')}</option>{variants.filter((v) => v.status === 'active').map((v) => <option key={v.id} value={v.id}>{vlabel(v.id)} · {v.sku}</option>)}</select>
            <SubmitButton className="w-full sm:w-auto">{tr('Añadir código', 'Add code')}</SubmitButton>
            <label className="flex items-center gap-2 text-xs text-muted sm:col-span-4"><input type="checkbox" name="primary" /> {tr('Código principal', 'Primary code')}</label>
          </form>)}
      </div>
      <span className="hidden">{locale}</span>
    </section>
  )
}

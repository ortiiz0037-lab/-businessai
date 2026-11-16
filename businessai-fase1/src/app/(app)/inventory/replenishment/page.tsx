import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, qtyText, ZERO_KEY } from '@/lib/inventory/labels'
import { normalizeRow, replenishmentReason, suggest } from '@/lib/inventory/replenishment'
import { ordersFromSuggestions } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'

/**
 * Smart replenishment: what reached its reorder point, how much to order and why. Based only on recorded
 * data (stock, reservations, transit, open orders, recorded sales, the vendor's lead time); without sales
 * history it says so and uses basic rules. Chosen lines become draft purchase orders per vendor.
 */
export default async function ReplenishmentPage({ searchParams }: { searchParams: Promise<{ branch?: string; all?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const branches = await myBranches(supabase, companyId)
  const branch = branches.find((b) => b.id === sp.branch)?.id ?? null
  const [products, { data }, { data: vendors }] = await Promise.all([
    trackedProducts(supabase, companyId), supabase.rpc('inventory_replenishment_data', { target: companyId, branch }),
    supabase.from('vendors').select('id, name').eq('company_id', companyId).eq('status', 'active').order('name'),
  ])
  const all = ((data ?? []) as Record<string, unknown>[]).map((r) => suggest(normalizeRow(r)))
  const rows = (sp.all === '1' ? all : all.filter((s) => s.needed)).sort((a, b) => Number(b.needed) - Number(a.needed))
  const vname = new Map(((vendors ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]))
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const key = (s: (typeof rows)[number]) => `${s.row.branch_id}_${s.row.item_id}_${s.row.variant_key === ZERO_KEY ? 'none' : s.row.variant_key}`
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Reposición inteligente', 'Smart replenishment')}
        description={tr('Proyección = disponible + en tránsito + órdenes abiertas. Sin ventas registradas se aplican reglas básicas y se indica. Los pedidos se crean como borradores que requieren aprobación.',
          'Projection = available + in transit + open orders. Without recorded sales, basic rules apply and it is said so. Orders are created as drafts that need approval.')} />
      <InventoryNav tr={tr} current="/inventory/replenishment" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch" defaultValue={branch ?? ''} className="field"><option value="">{tr('Todas', 'All')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="all" value="1" defaultChecked={sp.all === '1'} /> {tr('Mostrar también lo que no necesita reposición', 'Also show what needs no reorder')}</label>
        <button className="btn-secondary">{tr('Filtrar', 'Filter')}</button>
      </form>
      {rows.length === 0 ? <div className="card"><EmptyState icon="check" title={tr('Nada por reponer', 'Nothing to reorder')} description={tr('Ningún producto está en su punto de reposición. Define reglas en cada producto (Existencias → producto).', 'No product is at its reorder point. Set rules on each product (Stock → product).')} /></div> : (
        <form action={ordersFromSuggestions} className="space-y-4">
          <ul className="space-y-3" data-testid="replenishment">{rows.map((s) => { const k = key(s); const vendor = s.row.preferred_vendor_id; return (
            <li key={k} className="card grid gap-3 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]" data-testid="suggestion" data-needed={s.needed ? 'yes' : 'no'}>
              <div className="min-w-0">
                <Link href={`/inventory/items/${s.row.item_id}${s.row.variant_key !== ZERO_KEY ? `?variant=${s.row.variant_key}` : ''}`} className="font-semibold text-fg hover:text-accent">{productLabel(products, s.row.item_id, s.row.variant_key)}</Link>
                <p className="text-xs text-muted">{bname.get(s.row.branch_id)} · {tr('disponible', 'available')} {qtyText(s.row.available)} · {tr('en tránsito', 'in transit')} {qtyText(s.row.in_transit)} · {tr('pedido', 'on order')} {qtyText(s.row.on_order)}
                  {s.trigger !== null ? ` · ${tr('reponer en', 'reorder at')} ${qtyText(s.trigger)}` : ''}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted" aria-label={tr('Por qué', 'Why')}>{s.reasons.map((r) => <li key={r}>• {replenishmentReason(r, locale)}</li>)}
                  {s.daily !== null && <li>• {tr('Ventas registradas', 'Recorded sales')}: {s.daily.toFixed(2)} / {tr('día', 'day')}{s.daysOfCover !== null ? ` · ${tr('cobertura', 'cover')} ${s.daysOfCover} ${tr('días', 'days')}` : ''}</li>}</ul>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label><span className="field-label">{tr('Cantidad', 'Quantity')}</span><input name={`qty_${k}`} inputMode="decimal" defaultValue={s.qty ? qtyText(s.qty) : ''} className="field" /></label>
                <div><span className="field-label">{tr('Proveedor', 'Vendor')}</span><p className="pt-2 text-sm">{vendor ? vname.get(vendor) ?? '—' : <span className="text-amber-200">{tr('Sin proveedor preferido', 'No preferred vendor')}</span>}</p></div>
                <input type="hidden" name={`cost_${k}`} value={s.row.unit_cost_cents ?? 0} />
                {access.approve && s.row.unit_cost_cents ? <p className="col-span-2 text-xs text-muted">{tr('Costo de referencia', 'Reference cost')}: {money(s.row.unit_cost_cents)}</p> : null}
              </div>
              <label className="flex items-center gap-2 self-center text-sm">
                <input type="checkbox" name="pick" value={`${s.row.branch_id}|${s.row.item_id}|${s.row.variant_key === ZERO_KEY ? '' : s.row.variant_key}|${vendor ?? ''}`} disabled={!vendor || !access.operate} defaultChecked={s.needed && !!vendor} />
                {tr('Incluir', 'Include')}</label>
            </li>) })}</ul>
          {access.operate && <SubmitButton className="w-full sm:w-auto">{tr('Crear borradores de órdenes de compra (por proveedor)', 'Create draft purchase orders (per vendor)')}</SubmitButton>}
        </form>
      )}
    </div>
  )
}

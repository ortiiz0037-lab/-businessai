import Link from 'next/link'
import { fetchAllPages, complete } from '@/lib/supabase/paged'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches, productCode, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, qtyText, ZERO_KEY } from '@/lib/inventory/labels'
import { normalizeRow, suggest } from '@/lib/inventory/replenishment'

export const dynamic = 'force-dynamic'
type Level = { branch_id: string; item_id: string; variant_key: string; on_hand: number; reserved: number; committed: number; available: number; in_transit: number; on_order: number; last_movement_at: string | null }

/** Stock by branch: on hand, reserved, committed, available, in transit, on order — all derived from the records. */
export default async function StockPage({ searchParams }: { searchParams: Promise<{ branch?: string; q?: string; low?: string; done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const branches = await myBranches(supabase, companyId)
  const branch = branches.find((b) => b.id === sp.branch)?.id ?? null
  const [products, { data: lv }, { data: rp }] = await Promise.all([
    trackedProducts(supabase, companyId),
    fetchAllPages((a, b) => supabase.rpc('inventory_levels', { target: companyId, branch }).order('branch_id').order('item_id').order('variant_key').range(a, b)).then(complete),
    fetchAllPages((a, b) => supabase.rpc('inventory_replenishment_data', { target: companyId, branch }).order('branch_id').order('item_id').order('variant_key').range(a, b)).then(complete),
  ])
  const lowKeys = new Set(((rp ?? []) as Record<string, unknown>[]).map((r) => suggest(normalizeRow(r))).filter((s) => s.needed).map((s) => `${s.row.branch_id}|${s.row.item_id}|${s.row.variant_key}`))
  const q = (sp.q ?? '').trim().toLowerCase()
  let rows = (lv ?? []) as Level[]
  if (q) rows = rows.filter((r) => `${productLabel(products, r.item_id, r.variant_key)} ${productCode(products, r.item_id, r.variant_key)}`.toLowerCase().includes(q))
  if (sp.low === '1') rows = rows.filter((r) => lowKeys.has(`${r.branch_id}|${r.item_id}|${r.variant_key}`))
  rows.sort((a, b) => productLabel(products, a.item_id, a.variant_key).localeCompare(productLabel(products, b.item_id, b.variant_key)))
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const done: Record<string, string> = { rules: tr('Reglas guardadas.', 'Rules saved.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Existencias por sucursal', 'Stock by branch')}
        description={tr('Disponible = en mano − reservado − comprometido. En tránsito y pedido llegan cuando se reciben.', 'Available = on hand − reserved − committed. In transit and on order count once received.')} />
      <InventoryNav tr={tr} current="/inventory/stock" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-4 sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span>
          <select name="branch" defaultValue={branch ?? ''} className="field"><option value="">{tr('Todas mis sucursales', 'All my branches')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Buscar', 'Search')}</span><input name="q" defaultValue={sp.q ?? ''} className="field" placeholder={tr('Nombre, código o SKU', 'Name, code or SKU')} /></label>
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="low" value="1" defaultChecked={sp.low === '1'} /> {tr('Solo por reponer', 'Only to reorder')}</label>
        <button type="submit" className="btn-secondary sm:col-span-4 sm:w-fit">{tr('Filtrar', 'Filter')}</button>
      </form>
      {rows.length === 0 ? <div className="card"><EmptyState icon="archive" title={tr('Sin existencias', 'No stock')} description={tr('Activa «Controlará inventario» en un producto del catálogo y registra su inventario inicial.', 'Turn on "Will track stock" for a catalog product and record its opening stock.')} /></div> : (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm" data-testid="stock-table">
              <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr>
                <th className="px-4 py-3">{tr('Producto', 'Product')}</th><th className="px-4 py-3">{tr('Sucursal', 'Branch')}</th>
                <th className="px-3 py-3 text-right">{tr('En mano', 'On hand')}</th><th className="px-3 py-3 text-right">{tr('Reservado', 'Reserved')}</th>
                <th className="px-3 py-3 text-right">{tr('Comprometido', 'Committed')}</th><th className="px-3 py-3 text-right">{tr('Disponible', 'Available')}</th>
                <th className="px-3 py-3 text-right">{tr('En tránsito', 'In transit')}</th><th className="px-3 py-3 text-right">{tr('Pedido', 'On order')}</th>
                <th className="px-4 py-3">{tr('Último movimiento', 'Last movement')}</th></tr></thead>
              <tbody className="divide-y divide-line/60">
                {rows.map((r) => {
                  const low = lowKeys.has(`${r.branch_id}|${r.item_id}|${r.variant_key}`)
                  return (
                    <tr key={`${r.branch_id}${r.item_id}${r.variant_key}`} data-testid="stock-row">
                      <td className="px-4 py-2"><Link href={`/inventory/items/${r.item_id}${r.variant_key !== ZERO_KEY ? `?variant=${r.variant_key}` : ''}`} className="font-semibold text-fg hover:text-accent">{productLabel(products, r.item_id, r.variant_key)}</Link>
                        <span className="block text-xs text-muted">{productCode(products, r.item_id, r.variant_key)}{low ? ' · ' : ''}{low && <StateChip tone="pending">{tr('Reponer', 'Reorder')}</StateChip>}</span></td>
                      <td className="px-4 py-2 text-muted">{bname.get(r.branch_id) ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{qtyText(r.on_hand)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{qtyText(r.reserved)}</td><td className="px-3 py-2 text-right tabular-nums">{qtyText(r.committed)}</td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${Number(r.available) < 0 ? 'text-red-200' : ''}`}>{qtyText(r.available)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{qtyText(r.in_transit)}</td><td className="px-3 py-2 text-right tabular-nums">{qtyText(r.on_order)}</td>
                      <td className="px-4 py-2 text-xs text-muted">{r.last_movement_at ? f.date(r.last_movement_at.slice(0, 10)) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

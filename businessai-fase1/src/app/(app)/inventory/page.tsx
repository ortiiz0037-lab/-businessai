import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, productLabel, trackedProducts } from '@/lib/inventory/page'
import { movementKind, qtyText } from '@/lib/inventory/labels'
import { normalizeRow, suggest } from '@/lib/inventory/replenishment'

export const dynamic = 'force-dynamic'

/** Inventory overview: low stock, what is in transit and on order, pending approvals, latest movements. */
export default async function InventoryHome() {
  const { locale, tr, f, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [products, { data: lv }, { data: rp }, { data: mv }, { data: pos }, { data: trs }, { data: adj }, { data: br }] = await Promise.all([
    trackedProducts(supabase, companyId),
    supabase.rpc('inventory_levels', { target: companyId, branch: null }),
    supabase.rpc('inventory_replenishment_data', { target: companyId, branch: null }),
    supabase.from('inventory_movements').select('id, kind, quantity, item_id, variant_id, branch_id, occurred_at').eq('company_id', companyId).order('id', { ascending: false }).limit(10),
    supabase.from('purchase_orders').select('id, status').eq('company_id', companyId).in('status', ['draft', 'pending_approval', 'approved', 'partially_received']),
    supabase.from('inventory_transfers').select('id, status').eq('company_id', companyId).in('status', ['requested', 'approved', 'prepared', 'in_transit']),
    supabase.from('inventory_adjustments').select('id').eq('company_id', companyId).eq('status', 'pending'),
    supabase.from('branches').select('id, name').eq('company_id', companyId),
  ])
  const levels = (lv ?? []) as { branch_id: string; on_hand: number; in_transit: number; avg_cost_cents: number | null }[]
  const low = ((rp ?? []) as Record<string, unknown>[]).map((r) => suggest(normalizeRow(r))).filter((s) => s.needed)
  const value = levels.reduce((s, l) => s + Number(l.on_hand) * Number(l.avg_cost_cents ?? 0), 0)
  const branchName = new Map(((br ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]))
  const movements = (mv ?? []) as { id: number; kind: string; quantity: number; item_id: string; variant_id: string | null; branch_id: string; occurred_at: string }[]
  const pendingPo = ((pos ?? []) as { status: string }[]).filter((p) => p.status === 'pending_approval').length
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Operaciones', 'Operations')} title={tr('Inventario', 'Inventory')}
        description={tr('Una sola fuente de verdad: cada existencia sale de un movimiento registrado, con su responsable y su documento.', 'One source of truth: every quantity comes from a recorded movement, with who made it and its document.')}
        actions={access.operate ? <Link href="/inventory/scan" className="btn-primary">{tr('Abrir escáner', 'Open scanner')}</Link> : undefined} />
      <InventoryNav tr={tr} current="/inventory" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="archive" label={tr('Productos con inventario', 'Tracked products')} value={String(products.filter((p) => p.status === 'active').length)} />
        <StatCard icon="alert" tone="warning" label={tr('Por reponer', 'To reorder')} value={String(low.length)} hint={tr('Según las reglas de reposición', 'By the reorder rules')} />
        <StatCard icon="clock" label={tr('En tránsito', 'In transit')} value={qtyText(levels.reduce((s, l) => s + Number(l.in_transit), 0))} hint={tr(`${((trs ?? []) as unknown[]).length} transferencias abiertas`, `${((trs ?? []) as unknown[]).length} open transfers`)} />
        <StatCard icon="file" tone="gold" label={tr('Por aprobar', 'To approve')} value={String(((adj ?? []) as unknown[]).length + pendingPo)} hint={tr('Ajustes y órdenes de compra', 'Adjustments and purchase orders')} />
      </div>
      {access.approve && <p className="text-sm text-muted">{tr('Valor del inventario (costo promedio, no contabilizado): ', 'Inventory value (average cost, not posted): ')}<strong className="text-fg tabular-nums" data-testid="inventory-value">{money(value)}</strong></p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card min-w-0 p-5" aria-labelledby="low-title">
          <div className="flex items-center justify-between"><h2 id="low-title" className="font-display text-lg font-semibold text-fg">{tr('Alertas de inventario bajo', 'Low stock alerts')}</h2>
            <Link href="/inventory/replenishment" className="text-sm text-accent hover:underline">{tr('Reposición', 'Replenishment')}</Link></div>
          {low.length === 0 ? <p className="mt-3 text-sm text-muted">{tr('Nada por debajo del punto de reposición.', 'Nothing below its reorder point.')}</p> : (
            <ul className="mt-3 divide-y divide-line/60 text-sm" data-testid="low-stock">{low.slice(0, 8).map((s) => (
              <li key={`${s.row.branch_id}${s.row.item_id}${s.row.variant_key}`} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="block truncate text-fg">{productLabel(products, s.row.item_id, s.row.variant_key)}</span><span className="text-xs text-muted">{branchName.get(s.row.branch_id)}</span></span>
                <span className="shrink-0 text-right tabular-nums"><StateChip tone="pending">{qtyText(s.row.available)} / {qtyText(s.trigger)}</StateChip></span>
              </li>))}</ul>)}
        </section>
        <section className="card min-w-0 p-5" aria-labelledby="mv-title">
          <div className="flex items-center justify-between"><h2 id="mv-title" className="font-display text-lg font-semibold text-fg">{tr('Últimos movimientos', 'Latest movements')}</h2>
            <Link href="/inventory/movements" className="text-sm text-accent hover:underline">{tr('Ver todos', 'See all')}</Link></div>
          {movements.length === 0 ? <EmptyState icon="archive" title={tr('Sin movimientos', 'No movements')} description={tr('Registra el inventario inicial o recibe una compra.', 'Record opening stock or receive a purchase.')} /> : (
            <ul className="mt-3 divide-y divide-line/60 text-sm">{movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="block truncate text-fg">{productLabel(products, m.item_id, m.variant_id)}</span>
                  <span className="text-xs text-muted">{movementKind(m.kind, locale)} · {branchName.get(m.branch_id)} · {f.date(m.occurred_at.slice(0, 10))}</span></span>
                <span className={`shrink-0 font-semibold tabular-nums ${Number(m.quantity) < 0 ? 'text-red-200' : 'text-green-200'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qtyText(m.quantity)}</span>
              </li>))}</ul>)}
        </section>
      </div>
    </div>
  )
}

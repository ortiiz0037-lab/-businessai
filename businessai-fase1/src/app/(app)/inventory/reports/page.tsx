import { PageHeader, StatCard } from '@/components/ui/page'
import { fetchAllPages, complete } from '@/lib/supabase/paged'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches, productLabel, trackedProducts } from '@/lib/inventory/page'
import { MOVEMENT_KINDS, movementKind, qtyText } from '@/lib/inventory/labels'

export const dynamic = 'force-dynamic'

/**
 * Reports: valuation by method (average and FIFO, NOT posted to the ledger), movements by kind in a
 * period, count differences, and the consistency check of the stock against the ledger.
 */
export default async function InventoryReports({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams
  const { locale, tr, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date())
  const iso = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const from = iso(sp.from) ?? `${today.slice(0, 7)}-01`, to = iso(sp.to) ?? today
  const [branches, products, { data: lv }, { data: layers }, { data: mv }, { data: settings }, { data: verify }, { data: counts }] = await Promise.all([
    myBranches(supabase, companyId), trackedProducts(supabase, companyId),
    fetchAllPages((a, b) => supabase.rpc('inventory_levels', { target: companyId, branch: null }).order('branch_id').order('item_id').order('variant_key').range(a, b)).then(complete),
    access.approve ? supabase.from('inventory_cost_layers').select('branch_id, item_id, variant_key, qty_remaining, unit_cost_cents').eq('company_id', companyId).gt('qty_remaining', 0).limit(20000) : Promise.resolve({ data: [] }),
    supabase.from('inventory_movements').select('kind, quantity, fifo_cost_cents, avg_cost_cents').eq('company_id', companyId).gte('occurred_at', `${from}T00:00:00-04:00`).lte('occurred_at', `${to}T23:59:59-04:00`).limit(50000),
    supabase.from('inventory_settings').select('valuation_method, allow_negative').eq('company_id', companyId).maybeSingle(),
    supabase.rpc('inventory_verify', { target: companyId }),
    supabase.from('inventory_count_lines').select('item_id, variant_key, difference_qty, inventory_counts!inner(number, status, branch_id, approved_at)').eq('company_id', companyId).neq('difference_qty', 0).eq('inventory_counts.status', 'approved').limit(200),
  ])
  const levels = (lv ?? []) as { branch_id: string; item_id: string; variant_key: string; on_hand: number; avg_cost_cents: number | null }[]
  const avgValue = levels.reduce((s, l) => s + Math.max(0, Number(l.on_hand)) * Number(l.avg_cost_cents ?? 0), 0)
  const fifoValue = ((layers ?? []) as { qty_remaining: number; unit_cost_cents: number }[]).reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost_cents), 0)
  const byKind = new Map<string, { qty: number; avg: number; fifo: number; n: number }>()
  for (const m of (mv ?? []) as { kind: string; quantity: number; fifo_cost_cents: number | null; avg_cost_cents: number | null }[]) {
    const k = byKind.get(m.kind) ?? { qty: 0, avg: 0, fifo: 0, n: 0 }
    k.qty += Number(m.quantity); k.avg += Number(m.avg_cost_cents ?? 0); k.fifo += Number(m.fifo_cost_cents ?? 0); k.n++
    byKind.set(m.kind, k)
  }
  const method = (settings as { valuation_method?: string } | null)?.valuation_method ?? 'average'
  const problems = (verify ?? []) as unknown[]
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const diffs = (counts ?? []) as unknown as { item_id: string; variant_key: string; difference_qty: number; inventory_counts: { number: string; branch_id: string; approved_at: string } }[]
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Historial e informes', 'History and reports')}
        actions={<a href={`/inventory/export?from=${from}&to=${to}`} download className="btn-secondary">{tr('Exportar movimientos (CSV)', 'Export movements (CSV)')}</a>} />
      <InventoryNav tr={tr} current="/inventory/reports" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {access.approve && <StatCard icon="wallet" label={tr('Valor (promedio ponderado)', 'Value (weighted average)')} value={money(avgValue)} hint={method === 'average' ? tr('Método de la empresa', 'Company method') : undefined} />}
        {access.approve && <StatCard icon="wallet" label={tr('Valor (FIFO)', 'Value (FIFO)')} value={money(fifoValue)} hint={method === 'fifo' ? tr('Método de la empresa', 'Company method') : undefined} />}
        <StatCard icon="check" tone={problems.length ? 'warning' : 'success'} label={tr('Consistencia con el registro', 'Consistency with the ledger')} value={problems.length ? String(problems.length) : 'OK'} hint={tr('Existencias = suma de movimientos', 'Stock = sum of movements')} />
        <StatCard icon="archive" label={tr('Movimientos en el periodo', 'Movements in the period')} value={String(((mv ?? []) as unknown[]).length)} />
      </div>
      {access.approve && <p className="text-xs text-muted" data-testid="valuation-note">{tr('Valoración informativa: no se contabiliza en el libro mayor. Las compras siguen registrándose como gasto en Gastos; el inventario perpetuo contable requiere una decisión del propietario (ver docs/INVENTORY.md).',
        'Informational valuation: it is not posted to the ledger. Purchases are still recorded as expenses in Expenses; perpetual inventory accounting needs an owner decision (see docs/INVENTORY.md).')}</p>}
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <button className="btn-secondary">{tr('Aplicar', 'Apply')}</button>
      </form>
      <section className="card overflow-hidden"><h2 className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Movimientos por tipo', 'Movements by kind')}</h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[560px] text-sm" data-testid="report-kinds">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Tipo', 'Kind')}</th><th className="px-3 py-2 text-right">{tr('Movimientos', 'Movements')}</th><th className="px-3 py-2 text-right">{tr('Cantidad neta', 'Net quantity')}</th>
            {access.approve && <><th className="px-3 py-2 text-right">{tr('Costo (promedio)', 'Cost (average)')}</th><th className="px-3 py-2 text-right">{tr('Costo (FIFO)', 'Cost (FIFO)')}</th></>}</tr></thead>
          <tbody className="divide-y divide-line/60">{Object.keys(MOVEMENT_KINDS).filter((k) => byKind.has(k)).map((k) => { const v = byKind.get(k)!; return (
            <tr key={k}><td className="px-4 py-2">{movementKind(k, locale)}</td><td className="px-3 py-2 text-right tabular-nums">{v.n}</td><td className="px-3 py-2 text-right tabular-nums">{qtyText(v.qty)}</td>
              {access.approve && <><td className="px-3 py-2 text-right tabular-nums">{money(v.avg)}</td><td className="px-3 py-2 text-right tabular-nums">{money(v.fifo)}</td></>}</tr>) })}</tbody>
        </table></div></section>
      <section className="card overflow-hidden"><h2 className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Diferencias de conteos aprobados', 'Approved count differences')}</h2>
        {diffs.length === 0 ? <p className="p-5 text-sm text-muted">{tr('Sin diferencias.', 'No differences.')}</p> : (
          <ul className="mt-3 divide-y divide-line/60 text-sm">{diffs.map((d, i) => (
            <li key={i} className="flex items-center justify-between gap-2 px-5 py-2"><span className="min-w-0 truncate">{d.inventory_counts.number} · {bname.get(d.inventory_counts.branch_id) ?? '—'} · {productLabel(products, d.item_id, d.variant_key)}</span>
              <StateChip tone={Number(d.difference_qty) < 0 ? 'issue' : 'ok'}>{Number(d.difference_qty) > 0 ? '+' : ''}{qtyText(d.difference_qty)}</StateChip></li>))}</ul>)}
      </section>
    </div>
  )
}

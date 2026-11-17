import Link from 'next/link'
import { fetchAllPages } from '@/lib/supabase/paged'
import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches } from '@/lib/inventory/page'
import { inventoryMessage, movementKind, qtyText, ZERO_KEY } from '@/lib/inventory/labels'
import { releaseReservation, reserveStock, revalueItem, saveItemSettings } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f-]{36}$/i

/** One product (or variant): stock per branch, reorder rules, reservations, cost and its full movement history. */
export default async function InventoryItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ variant?: string; done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  if (!UUID.test(id)) notFound()
  const { data: it } = await supabase.from('catalog_items').select('id, code, name, unit, cost_cents, track_inventory, status').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!it) notFound()
  const item = it as { id: string; code: string; name: string; unit: string; cost_cents: number | null; track_inventory: boolean; status: string }
  const { data: vs } = await supabase.from('catalog_variants').select('id, sku, attributes, status').eq('item_id', id).order('sku')
  const variants = (vs ?? []) as { id: string; sku: string; attributes: Record<string, string>; status: string }[]
  const variant = variants.find((v) => v.id === sp.variant) ?? null
  if (variants.length && !variant) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={item.code} title={item.name} description={tr('Elige la variante.', 'Choose the variant.')} />
        <InventoryNav tr={tr} current="/inventory/stock" />
        <ul className="grid gap-3 sm:grid-cols-2">{variants.map((v) => (
          <li key={v.id}><Link href={`/inventory/items/${id}?variant=${v.id}`} className="card block p-4 hover:border-electric/40"><span className="font-semibold text-fg">{Object.values(v.attributes).join(' / ') || v.sku}</span><span className="block text-xs text-muted">{v.sku}</span></Link></li>))}</ul>
      </div>
    )
  }
  const vkey = variant?.id ?? ZERO_KEY
  const branches = await myBranches(supabase, companyId)
  const [{ data: lv }, { data: settings }, { data: mv }, { data: res }, { data: vendors }] = await Promise.all([
    fetchAllPages((a, b) => supabase.rpc('inventory_levels', { target: companyId, branch: null }).order('branch_id').order('item_id').order('variant_key').range(a, b)).then((r) => ({ data: r.rows, error: r.error })),
    supabase.from('inventory_item_settings').select('*').eq('item_id', id).eq('variant_key', vkey),
    supabase.from('inventory_movements').select('id, kind, quantity, branch_id, unit_cost_cents, reason, source_type, source_id, document_id, corrects_id, occurred_at, created_by')
      .eq('item_id', id).filter('variant_id', variant ? 'eq' : 'is', variant ? variant.id : null).order('id', { ascending: false }).limit(200),
    supabase.from('inventory_reservations').select('id, branch_id, quantity, kind, reference, status, created_at').eq('item_id', id).filter('variant_id', variant ? 'eq' : 'is', variant ? variant.id : null).eq('status', 'active'),
    supabase.from('vendors').select('id, name').eq('company_id', companyId).eq('status', 'active').order('name'),
  ])
  const levels = ((lv ?? []) as { branch_id: string; item_id: string; variant_key: string; on_hand: number; reserved: number; committed: number; available: number; in_transit: number; on_order: number; avg_cost_cents: number | null }[])
    .filter((l) => l.item_id === id && l.variant_key === vkey)
  const rules = (settings ?? []) as { branch_id: string; min_qty: number | null; max_qty: number | null; reorder_point: number | null; reorder_qty: number | null; preferred_vendor_id: string | null; lead_time_days: number | null }[]
  const movements = (mv ?? []) as { id: number; kind: string; quantity: number; branch_id: string; unit_cost_cents: number | null; reason: string | null; source_type: string | null; source_id: string | null; document_id: string | null; corrects_id: number | null; occurred_at: string }[]
  const reservations = ((res ?? []) as { id: string; branch_id: string; quantity: number; kind: string; reference: string | null; created_at: string }[])
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const title = variant ? `${item.name} · ${Object.values(variant.attributes).join(' / ')}` : item.name
  const back = `/inventory/items/${id}${variant ? `?variant=${variant.id}` : ''}`
  const done: Record<string, string> = { rules: tr('Reglas guardadas.', 'Rules saved.'), revalued: tr('Costo revaluado.', 'Cost revalued.'), reserved: tr('Reserva creada.', 'Reservation created.'), released: tr('Reserva liberada.', 'Reservation released.') }
  const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : qtyText(v))
  return (
    <div className="space-y-6">
      <Link href="/inventory/stock" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Existencias', '← Stock')}</Link>
      <PageHeader eyebrow={variant?.sku ?? item.code} title={title} description={`${tr('Unidad', 'Unit')}: ${item.unit}${!item.track_inventory ? ` · ${tr('no controla inventario', 'does not track stock')}` : ''}`}
        actions={access.catalog ? <Link href={`/catalog/${id}`} className="btn-secondary">{tr('Códigos, variantes y costo', 'Codes, variants and cost')}</Link> : undefined} />
      <InventoryNav tr={tr} current="/inventory/stock" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />

      <section className="card overflow-hidden" aria-labelledby="lv-title">
        <h2 id="lv-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Por sucursal', 'By branch')}</h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[720px] text-sm" data-testid="item-levels">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Sucursal', 'Branch')}</th><th className="px-3 py-2 text-right">{tr('En mano', 'On hand')}</th>
            <th className="px-3 py-2 text-right">{tr('Reservado', 'Reserved')}</th><th className="px-3 py-2 text-right">{tr('Comprometido', 'Committed')}</th><th className="px-3 py-2 text-right">{tr('Disponible', 'Available')}</th>
            <th className="px-3 py-2 text-right">{tr('En tránsito', 'In transit')}</th><th className="px-3 py-2 text-right">{tr('Pedido', 'On order')}</th>{access.approve && <th className="px-3 py-2 text-right">{tr('Costo prom.', 'Avg cost')}</th>}</tr></thead>
          <tbody className="divide-y divide-line/60">{branches.map((b) => { const l = levels.find((x) => x.branch_id === b.id); return (
            <tr key={b.id} data-branch={b.name}><td className="px-4 py-2 font-semibold text-fg">{b.name}</td><td className="px-3 py-2 text-right tabular-nums" data-testid="on-hand">{qtyText(l?.on_hand ?? 0)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{qtyText(l?.reserved ?? 0)}</td><td className="px-3 py-2 text-right tabular-nums">{qtyText(l?.committed ?? 0)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{qtyText(l?.available ?? 0)}</td><td className="px-3 py-2 text-right tabular-nums">{qtyText(l?.in_transit ?? 0)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{qtyText(l?.on_order ?? 0)}</td>{access.approve && <td className="px-3 py-2 text-right tabular-nums">{l?.avg_cost_cents ? money(l.avg_cost_cents) : '—'}</td>}</tr>) })}</tbody>
        </table></div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {access.approve && branches.map((b) => { const r = rules.find((x) => x.branch_id === b.id); return (
          <form key={b.id} action={saveItemSettings} className="card grid grid-cols-2 gap-3 p-5" data-testid="item-rules">
            <h2 className="col-span-2 font-display text-base font-semibold text-fg">{tr('Reposición', 'Replenishment')} · {b.name}</h2>
            <input type="hidden" name="branch_id" value={b.id} /><input type="hidden" name="item_id" value={id} /><input type="hidden" name="variant_id" value={variant?.id ?? ''} /><input type="hidden" name="back" value={back} />
            <label className="text-sm"><span className="field-label">{tr('Mínimo', 'Minimum')}</span><input name="min_qty" inputMode="decimal" defaultValue={num(r?.min_qty)} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Máximo (opcional)', 'Maximum (optional)')}</span><input name="max_qty" inputMode="decimal" defaultValue={num(r?.max_qty)} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Punto de reposición', 'Reorder point')}</span><input name="reorder_point" inputMode="decimal" defaultValue={num(r?.reorder_point)} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Cantidad a pedir', 'Reorder quantity')}</span><input name="reorder_qty" inputMode="decimal" defaultValue={num(r?.reorder_qty)} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Proveedor preferido', 'Preferred vendor')}</span>
              <select name="vendor_id" defaultValue={r?.preferred_vendor_id ?? ''} className="field"><option value="">—</option>{((vendors ?? []) as { id: string; name: string }[]).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Entrega (días)', 'Lead time (days)')}</span><input name="lead_time_days" inputMode="numeric" defaultValue={r?.lead_time_days ?? ''} className="field" /></label>
            <div className="col-span-2"><SubmitButton className="btn-sm">{tr('Guardar reglas', 'Save rules')}</SubmitButton></div>
          </form>) })}
        {access.operate && (
          <form action={reserveStock} className="card grid grid-cols-2 gap-3 p-5">
            <h2 className="col-span-2 font-display text-base font-semibold text-fg">{tr('Reservar existencias', 'Reserve stock')}</h2>
            <p className="col-span-2 text-xs text-muted">{tr('Aparta unidades para un pedido o una venta futura (también la usará el punto de venta). Reduce lo disponible, no lo que hay en mano.', 'Holds units for an order or a future sale (the point of sale will use it too). Reduces available, not on hand.')}</p>
            <input type="hidden" name="item_id" value={id} /><input type="hidden" name="variant_id" value={variant?.id ?? ''} /><input type="hidden" name="back" value={back} /><input type="hidden" name="idempotency_key" value={randomUUID()} />
            <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch_id" className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Cantidad', 'Quantity')}</span><input name="qty" required inputMode="decimal" className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span><select name="kind" className="field"><option value="reserved">{tr('Reservado', 'Reserved')}</option><option value="committed">{tr('Comprometido', 'Committed')}</option></select></label>
            <label className="text-sm"><span className="field-label">{tr('Referencia', 'Reference')}</span><input name="reference" maxLength={120} className="field" /></label>
            <div className="col-span-2"><SubmitButton className="btn-sm">{tr('Reservar', 'Reserve')}</SubmitButton></div>
            {reservations.length > 0 && <ul className="col-span-2 divide-y divide-line/60 text-sm">{reservations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2"><span>{qtyText(r.quantity)} · {r.kind === 'committed' ? tr('comprometido', 'committed') : tr('reservado', 'reserved')} · {bname.get(r.branch_id)}{r.reference ? ` · ${r.reference}` : ''}</span>
                <button formAction={releaseReservation} name="reservation_id" value={r.id} className="btn-secondary btn-sm">{tr('Liberar', 'Release')}</button></li>))}</ul>}
          </form>
        )}
        {access.approve && (
          <form action={revalueItem} className="card grid grid-cols-2 gap-3 p-5">
            <h2 className="col-span-2 font-display text-base font-semibold text-fg">{tr('Revaluar costo', 'Revalue cost')}</h2>
            <p className="col-span-2 text-xs text-muted">{tr('Cambia el costo promedio y el de las capas FIFO abiertas. Queda como movimiento de revaluación con su motivo; la cantidad no cambia y no se contabiliza.', 'Changes the average cost and the open FIFO layers. Recorded as a revaluation movement with its reason; quantity unchanged and not posted.')}</p>
            <input type="hidden" name="item_id" value={id} /><input type="hidden" name="variant_id" value={variant?.id ?? ''} /><input type="hidden" name="back" value={back} />
            <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch_id" className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Nuevo costo unitario ($)', 'New unit cost ($)')}</span><input name="cost" required inputMode="decimal" className="field" /></label>
            <label className="col-span-2 text-sm"><span className="field-label">{tr('Motivo', 'Reason')}</span><input name="reason" required minLength={3} maxLength={300} className="field" /></label>
            <div className="col-span-2"><SubmitButton className="btn-sm">{tr('Revaluar', 'Revalue')}</SubmitButton></div>
          </form>
        )}
      </div>

      <section className="card overflow-hidden" aria-labelledby="hist-title">
        <h2 id="hist-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Historial de existencias', 'Stock history')}</h2>
        <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[680px] text-sm" data-testid="item-history">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Fecha', 'Date')}</th><th className="px-4 py-2">{tr('Tipo', 'Kind')}</th><th className="px-4 py-2">{tr('Sucursal', 'Branch')}</th>
            <th className="px-3 py-2 text-right">{tr('Cantidad', 'Quantity')}</th><th className="px-4 py-2">{tr('Motivo / documento', 'Reason / document')}</th></tr></thead>
          <tbody className="divide-y divide-line/60">{movements.map((m) => (
            <tr key={m.id}><td className="px-4 py-2 text-muted">{f.date(m.occurred_at.slice(0, 10))} {m.occurred_at.slice(11, 16)}</td><td className="px-4 py-2">{movementKind(m.kind, locale)}{m.corrects_id ? ` (#${m.corrects_id})` : ''}</td>
              <td className="px-4 py-2 text-muted">{bname.get(m.branch_id) ?? '—'}</td>
              <td className={`px-3 py-2 text-right font-semibold tabular-nums ${Number(m.quantity) < 0 ? 'text-red-200' : 'text-green-200'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qtyText(m.quantity)}</td>
              <td className="px-4 py-2 text-xs text-muted">{m.reason ?? ''}{m.document_id ? <> · <Link href={`/documents/${m.document_id}`} className="text-accent">{tr('documento', 'document')}</Link></> : null}</td></tr>))}</tbody>
        </table></div>
      </section>
    </div>
  )
}

/**
 * Smart replenishment (pure). From what the database knows — available stock, reservations,
 * goods in transit and on order, the reorder rule, recorded sales of the last 90 days and the
 * vendor's lead time — decide whether to reorder and how much, and say why.
 *
 * Nothing is invented: without recorded sales there is no velocity and the suggestion uses the
 * basic rule (reorder point / minimum / maximum / reorder quantity) and says so; without a
 * lead time the velocity is not projected. Every suggestion is only a proposal: purchase
 * orders are created as drafts and need approval.
 */
export type ReplenishmentRow = {
  branch_id: string; item_id: string; variant_key: string
  on_hand: number; reserved: number; committed: number; available: number; in_transit: number; on_order: number
  min_qty: number | null; max_qty: number | null; reorder_point: number | null; reorder_qty: number | null
  preferred_vendor_id: string | null; lead_time_days: number | null
  sold_90d: number | null; sale_days: number | null; first_sale: string | null; unit_cost_cents: number | null
}
export type Basis = 'rules' | 'velocity'
export type Reason = 'below_reorder_point' | 'below_minimum' | 'no_rule' | 'covered_by_incoming' | 'velocity_lead_time' | 'no_sales_history' | 'no_lead_time' | 'to_maximum' | 'reorder_quantity'
export type Suggestion = {
  row: ReplenishmentRow; projected: number; trigger: number | null; needed: boolean; qty: number; basis: Basis
  daily: number | null; daysOfCover: number | null; reasons: Reason[]
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const ceil = (x: number) => Math.ceil(Math.round(x * 1000) / 1000)

export function normalizeRow(r: Record<string, unknown>): ReplenishmentRow {
  const num = (k: string) => Number(r[k] ?? 0)
  return {
    branch_id: String(r.branch_id), item_id: String(r.item_id), variant_key: String(r.variant_key),
    on_hand: num('on_hand'), reserved: num('reserved'), committed: num('committed'), available: num('available'), in_transit: num('in_transit'), on_order: num('on_order'),
    min_qty: n(r.min_qty), max_qty: n(r.max_qty), reorder_point: n(r.reorder_point), reorder_qty: n(r.reorder_qty),
    preferred_vendor_id: (r.preferred_vendor_id as string | null) ?? null, lead_time_days: n(r.lead_time_days),
    sold_90d: n(r.sold_90d), sale_days: n(r.sale_days), first_sale: (r.first_sale as string | null) ?? null, unit_cost_cents: n(r.unit_cost_cents),
  }
}

export function suggest(r: ReplenishmentRow, today = new Date()): Suggestion {
  const reasons: Reason[] = []
  const projected = r.available + r.in_transit + r.on_order
  // the level that triggers a reorder: reorder point, else minimum
  const trigger = r.reorder_point ?? r.min_qty
  // recorded velocity over the days since the first sale in the window (max 90): never extrapolated from nothing
  let daily: number | null = null
  if (r.sold_90d !== null && r.sold_90d > 0 && r.first_sale) {
    const span = Math.min(90, Math.max(1, Math.round((today.getTime() - Date.parse(r.first_sale)) / 86400000) + 1))
    daily = r.sold_90d / span
  } else reasons.push('no_sales_history')
  const daysOfCover = daily ? Math.floor(r.available / daily) : null
  if (trigger === null) {
    reasons.push('no_rule')
    return { row: r, projected, trigger, needed: false, qty: 0, basis: daily ? 'velocity' : 'rules', daily, daysOfCover, reasons }
  }
  let needed = projected <= trigger
  if (needed) reasons.push(r.reorder_point !== null ? 'below_reorder_point' : 'below_minimum')
  else if (r.available <= trigger) reasons.push('covered_by_incoming')
  let qty = 0, basis: Basis = 'rules'
  if (needed) {
    if (r.max_qty !== null) { qty = r.max_qty - projected; reasons.push('to_maximum') }
    else if (r.reorder_qty !== null) { qty = Math.max(r.reorder_qty, trigger - projected + 1); reasons.push('reorder_quantity') }
    else qty = Math.max(trigger, r.min_qty ?? 0) * 2 - projected
    // with recorded sales and a known lead time: enough to cover the lead time above the trigger
    if (daily !== null) {
      if (r.lead_time_days !== null) {
        const cover = trigger + daily * r.lead_time_days - projected
        if (cover > qty) { qty = cover; basis = 'velocity'; reasons.push('velocity_lead_time') }
      } else reasons.push('no_lead_time')
    }
    qty = Math.max(0, ceil(qty))
    needed = qty > 0
  }
  return { row: r, projected, trigger, needed, qty, basis, daily, daysOfCover, reasons }
}

/** Groups the chosen suggestions by vendor and branch: one draft purchase order each. */
export function groupForOrders(items: { vendor: string | null; branch: string; item: string; variant: string | null; qty: number; unit_cost: number | null }[]) {
  const groups = new Map<string, typeof items>()
  for (const i of items) {
    if (!i.vendor || i.qty <= 0) continue
    const k = `${i.vendor}|${i.branch}`
    groups.set(k, [...(groups.get(k) ?? []), i])
  }
  return [...groups.entries()].map(([k, lines]) => ({ vendor: k.split('|')[0], branch: k.split('|')[1], lines }))
}

const REASONS: Record<Reason, { es: string; en: string }> = {
  below_reorder_point: { es: 'Disponible + en tránsito + pedido no supera el punto de reposición', en: 'Available + in transit + on order is at or below the reorder point' },
  below_minimum: { es: 'Por debajo del mínimo', en: 'Below the minimum' },
  no_rule: { es: 'Sin regla de reposición: defina punto de reposición o mínimo', en: 'No reorder rule: set a reorder point or minimum' },
  covered_by_incoming: { es: 'Bajo, pero ya cubierto por mercancía en tránsito u órdenes abiertas', en: 'Low, but already covered by goods in transit or open orders' },
  velocity_lead_time: { es: 'Ventas registradas × tiempo de entrega del proveedor', en: 'Recorded sales × vendor lead time' },
  no_sales_history: { es: 'Sin ventas registradas: se usan reglas básicas de reposición', en: 'No recorded sales: basic reorder rules are used' },
  no_lead_time: { es: 'Sin tiempo de entrega: no se proyectan las ventas', en: 'No lead time: sales are not projected' },
  to_maximum: { es: 'Hasta el máximo configurado', en: 'Up to the configured maximum' },
  reorder_quantity: { es: 'Cantidad de reposición configurada', en: 'Configured reorder quantity' },
}
export const replenishmentReason = (r: Reason, locale: 'es' | 'en') => REASONS[r][locale]

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { ScanIntoForm } from '@/components/inventory/scanners'
import { inventoryPage, productCode, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, qtyText, statusLabel, statusTone } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { linkPurchaseBill, purchaseOrderTransition, receivePurchaseOrder } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
type Line = { id: string; line_no: number; item_id: string; variant_id: string | null; qty_ordered: number; qty_received: number; qty_damaged: number; unit_cost_cents: number }

/** One purchase order: approval, receiving by scanning (partial or full, with damages), receipts and the linked vendor bill. */
export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: p } = await supabase.from('purchase_orders').select('*, vendors(name), branches(name)').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!p) notFound()
  const po = p as { id: string; number: string; status: string; vendor_id: string; branch_id: string; source: string; expected_date: string | null; notes: string | null; created_at: string; approved_at: string | null; close_reason: string | null
    vendors: { name: string } | null; branches: { name: string } | null }
  const [products, { data: ls }, { data: rc }, { data: links }, { data: members }] = await Promise.all([
    trackedProducts(supabase, companyId),
    supabase.from('purchase_order_lines').select('*').eq('po_id', id).order('line_no'),
    supabase.from('inventory_receipts').select('id, received_at, received_by, notes, inventory_receipt_lines(po_line_id, qty_received, qty_damaged, note)').eq('po_id', id).order('received_at'),
    supabase.from('purchase_order_bills').select('bill_id, linked_at, bills(vendor_invoice_number, total_cents, bill_date, status)').eq('po_id', id),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const lines = (ls ?? []) as Line[]
  const receipts = (rc ?? []) as unknown as { id: string; received_at: string; received_by: string | null; notes: string | null; inventory_receipt_lines: { po_line_id: string; qty_received: number; qty_damaged: number; note: string | null }[] }[]
  const linked = (links ?? []) as unknown as { bill_id: string; bills: { vendor_invoice_number: string | null; total_cents: number; bill_date: string; status: string } | null }[]
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const receivable = ['approved', 'partially_received'].includes(po.status)
  const total = lines.reduce((s, l) => s + Number(l.qty_ordered) * Number(l.unit_cost_cents), 0)
  let bills: { id: string; vendor_invoice_number: string | null; total_cents: number; bill_date: string }[] = []
  if (access.approve && access.payables) {
    const { data: b } = await supabase.from('bills').select('id, vendor_invoice_number, total_cents, bill_date, status').eq('company_id', companyId).eq('vendor_id', po.vendor_id).neq('status', 'void').order('bill_date', { ascending: false }).limit(50)
    const { data: taken } = await supabase.from('purchase_order_bills').select('bill_id').eq('company_id', companyId)
    const used = new Set(((taken ?? []) as { bill_id: string }[]).map((x) => x.bill_id))
    bills = ((b ?? []) as typeof bills).filter((x) => !used.has(x.id))
  }
  const lineLabel = (l: Line) => productLabel(products, l.item_id, l.variant_id)
  const done: Record<string, string> = {
    created: tr('Orden creada como borrador.', 'Order created as a draft.'), saved: tr('Orden guardada.', 'Order saved.'), submit: tr('Enviada a aprobación.', 'Sent for approval.'),
    approve: tr('Orden aprobada y emitida: ya se puede recibir mercancía.', 'Order approved and issued: goods can be received.'), reject: tr('Devuelta a borrador.', 'Returned to draft.'),
    cancel: tr('Orden cancelada.', 'Order cancelled.'), close: tr('Orden cerrada: lo pendiente no se recibirá.', 'Order closed: the rest will not be received.'),
    received: tr('Recepción registrada: la orden está completa.', 'Receipt recorded: the order is complete.'), partially_received: tr('Recepción parcial registrada.', 'Partial receipt recorded.'),
    bill_linked: tr('Factura del proveedor vinculada. El gasto y su pago se gestionan en Gastos (sin duplicados).', 'Vendor bill linked. The expense and its payment are handled in Expenses (no duplicates).'),
  }
  return (
    <div className="space-y-6">
      <Link href="/inventory/purchase-orders" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Compras', '← Purchasing')}</Link>
      <PageHeader eyebrow={tr('Orden de compra', 'Purchase order')} title={`${po.number} · ${po.vendors?.name ?? '—'}`}
        description={`${tr('Recibe en', 'Deliver to')} ${po.branches?.name ?? '—'} · ${f.date(po.created_at.slice(0, 10))}${po.expected_date ? ` · ${tr('esperada', 'expected')} ${f.date(po.expected_date)}` : ''}${access.approve ? ` · ${money(total)}` : ''}`} />
      <InventoryNav tr={tr} current="/inventory/purchase-orders" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <div className="flex flex-wrap items-center gap-3">
        <StateChip tone={statusTone(po.status)}><span data-testid="po-status">{statusLabel(po.status, locale)}</span></StateChip>
        {po.status === 'draft' && access.operate && <form action={purchaseOrderTransition}><input type="hidden" name="po_id" value={id} /><input type="hidden" name="action" value="submit" /><SubmitButton className="w-full sm:w-auto">{tr('Enviar a aprobación', 'Send for approval')}</SubmitButton></form>}
        {['draft', 'pending_approval'].includes(po.status) && access.approve && <form action={purchaseOrderTransition}><input type="hidden" name="po_id" value={id} /><input type="hidden" name="action" value="approve" /><SubmitButton className="w-full sm:w-auto">{tr('Aprobar y emitir', 'Approve and issue')}</SubmitButton></form>}
        {po.status === 'pending_approval' && access.approve && <form action={purchaseOrderTransition}><input type="hidden" name="po_id" value={id} /><input type="hidden" name="action" value="reject" /><button className="btn-secondary">{tr('Devolver a borrador', 'Return to draft')}</button></form>}
        {['draft', 'pending_approval', 'approved'].includes(po.status) && receipts.length === 0 && access.approve && <form action={purchaseOrderTransition}><input type="hidden" name="po_id" value={id} /><input type="hidden" name="action" value="cancel" /><button className="btn-secondary">{tr('Cancelar orden', 'Cancel order')}</button></form>}
      </div>
      {po.close_reason && <p className="text-sm text-muted">{tr('Motivo de cierre', 'Close reason')}: {po.close_reason}</p>}

      <section className="card overflow-hidden" aria-labelledby="lines-title">
        <h2 id="lines-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{receivable && access.operate ? tr('Recibir mercancía', 'Receive goods') : tr('Líneas', 'Lines')}</h2>
        {receivable && access.operate && (
          <div className="px-5 pt-3"><ScanIntoForm formId="receive-form" copy={scanCopy(tr)} labels={{ added: tr('{name}: {n} recibidos', '{name}: {n} received'),
            notInDocument: tr('no está en esta orden de compra', 'is not on this purchase order'), unknown: tr('Código desconocido.', 'Unknown code.'), errors: errorMap(locale) }} /></div>)}
        <form id="receive-form" action={receivePurchaseOrder}>
          <input type="hidden" name="po_id" value={id} /><input type="hidden" name="idempotency_key" value={randomUUID()} />
          <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[760px] text-sm" data-testid="po-lines">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Producto', 'Product')}</th><th className="px-3 py-2 text-right">{tr('Pedido', 'Ordered')}</th>
              <th className="px-3 py-2 text-right">{tr('Recibido', 'Received')}</th><th className="px-3 py-2 text-right">{tr('Dañado', 'Damaged')}</th><th className="px-3 py-2 text-right">{tr('Pendiente', 'Pending')}</th>
              {access.approve && <th className="px-3 py-2 text-right">{tr('Costo', 'Cost')}</th>}
              {receivable && access.operate && <><th className="px-3 py-2">{tr('Llega ahora', 'Arriving now')}</th><th className="px-3 py-2">{tr('Dañado', 'Damaged')}</th><th className="px-3 py-2">{tr('Nota', 'Note')}</th></>}</tr></thead>
            <tbody className="divide-y divide-line/60">{lines.map((l) => { const rest = Number(l.qty_ordered) - Number(l.qty_received) - Number(l.qty_damaged); return (
              <tr key={l.id} data-testid="po-line">
                <td className="px-4 py-2"><span className="text-fg">{lineLabel(l)}</span><span className="block text-xs text-muted">{productCode(products, l.item_id, l.variant_id)}</span></td>
                <td className="px-3 py-2 text-right tabular-nums">{qtyText(l.qty_ordered)}</td><td className="px-3 py-2 text-right tabular-nums" data-testid="po-received">{qtyText(l.qty_received)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{qtyText(l.qty_damaged)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{qtyText(rest)}</td>
                {access.approve && <td className="px-3 py-2 text-right tabular-nums">{money(l.unit_cost_cents)}</td>}
                {receivable && access.operate && <>
                  <td className="px-3 py-2"><input type="hidden" name="po_line" value={l.id} /><label className="sr-only" htmlFor={`q-${l.id}`}>{tr('Llega ahora', 'Arriving now')}</label>
                    <input id={`q-${l.id}`} name={`qty_${l.id}`} inputMode="decimal" className="field w-24" disabled={rest <= 0} max={rest} data-scan-key={`${l.item_id}|${l.variant_id ?? ''}`} /></td>
                  <td className="px-3 py-2"><label className="sr-only" htmlFor={`d-${l.id}`}>{tr('Dañado', 'Damaged')}</label><input id={`d-${l.id}`} name={`dmg_${l.id}`} inputMode="decimal" className="field w-20" disabled={rest <= 0} /></td>
                  <td className="px-3 py-2"><label className="sr-only" htmlFor={`n-${l.id}`}>{tr('Nota', 'Note')}</label><input id={`n-${l.id}`} name={`note_${l.id}`} maxLength={200} className="field w-40" disabled={rest <= 0} /></td></>}
              </tr>) })}</tbody>
          </table></div>
          {receivable && access.operate && (
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 text-sm"><span className="field-label">{tr('Notas de la entrega', 'Delivery notes')}</span><input name="notes" maxLength={500} className="field" placeholder={tr('Conduce, faltantes…', 'Delivery slip, shortages…')} /></label>
              <SubmitButton className="w-full sm:w-auto">{tr('Confirmar recepción', 'Confirm receipt')}</SubmitButton>
            </div>)}
        </form>
      </section>
      {receivable && access.approve && (
        <form action={purchaseOrderTransition} className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
          <input type="hidden" name="po_id" value={id} /><input type="hidden" name="action" value="close" />
          <label className="min-w-0 flex-1 text-sm"><span className="field-label">{tr('Cerrar con pendientes (no llegará el resto)', 'Close with pending lines (the rest will not arrive)')}</span><input name="reason" required minLength={3} maxLength={300} className="field" placeholder={tr('Motivo', 'Reason')} /></label>
          <button className="btn-secondary">{tr('Cerrar orden', 'Close order')}</button>
        </form>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="rc-title">
          <h2 id="rc-title" className="font-display text-lg font-semibold text-fg">{tr('Recepciones', 'Receipts')}</h2>
          {receipts.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Todavía no se ha recibido nada.', 'Nothing received yet.')}</p> : (
            <ul className="mt-3 space-y-3 text-sm" data-testid="po-receipts">{receipts.map((r) => (
              <li key={r.id} className="rounded-xl border border-line p-3"><p className="font-semibold text-fg">{f.date(r.received_at.slice(0, 10))} {r.received_at.slice(11, 16)} · {r.received_by ? who.get(r.received_by) : '—'}</p>
                {r.notes && <p className="text-xs text-muted">{r.notes}</p>}
                <ul className="mt-1 text-xs text-muted">{r.inventory_receipt_lines.map((x, i) => { const l = lines.find((y) => y.id === x.po_line_id); return <li key={i}>{l ? lineLabel(l) : '—'}: {qtyText(x.qty_received)}{Number(x.qty_damaged) ? ` + ${qtyText(x.qty_damaged)} ${tr('dañado', 'damaged')}` : ''}{x.note ? ` · ${x.note}` : ''}</li> })}</ul></li>))}</ul>)}
        </section>
        <section className="card space-y-3 p-5" aria-labelledby="bill-title">
          <h2 id="bill-title" className="font-display text-lg font-semibold text-fg">{tr('Factura del proveedor', 'Vendor bill')}</h2>
          <p className="text-xs text-muted">{tr('El gasto se registra en Gastos (cuentas por pagar) con su aprobación y pago. Aquí solo se vincula: una factura pertenece a una sola orden.', 'The expense is recorded in Expenses (payables) with its approval and payment. Here it is only linked: a bill belongs to one order.')}</p>
          {linked.length > 0 && <ul className="text-sm" data-testid="po-bills">{linked.map((b) => <li key={b.bill_id}><Link href={`/payables/${b.bill_id}`} className="text-accent">{b.bills?.vendor_invoice_number ?? tr('Factura', 'Bill')}</Link>{b.bills ? ` · ${money(b.bills.total_cents)} · ${f.date(b.bills.bill_date)}` : ''}</li>)}</ul>}
          {access.approve && access.payables && bills.length > 0 && (
            <form action={linkPurchaseBill} className="flex flex-col gap-2 sm:flex-row">
              <input type="hidden" name="po_id" value={id} />
              <label className="sr-only" htmlFor="bill">{tr('Factura', 'Bill')}</label>
              <select id="bill" name="bill_id" required className="field min-w-0 flex-1"><option value="">{tr('Elegir factura del proveedor…', 'Choose vendor bill…')}</option>
                {bills.map((b) => <option key={b.id} value={b.id}>{b.vendor_invoice_number ?? '—'} · {money(b.total_cents)} · {f.date(b.bill_date)}</option>)}</select>
              <SubmitButton className="w-full sm:w-auto">{tr('Vincular', 'Link')}</SubmitButton>
            </form>)}
          {access.payables && <Link href="/payables/new" className="text-sm text-accent hover:underline">{tr('Registrar la factura en Gastos', 'Record the bill in Expenses')}</Link>}
        </section>
      </div>
    </div>
  )
}

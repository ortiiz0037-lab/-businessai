import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { ScanIntoForm } from '@/components/inventory/scanners'
import { inventoryPage, productCode, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, qtyText, statusLabel } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { transferStep } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
type TLine = { id: string; item_id: string; variant_id: string | null; qty_requested: number; qty_prepared: number | null; qty_dispatched: number | null; qty_received: number | null; qty_damaged: number | null }

/** One transfer: each step by the right branch and role; receiving records differences with a note. */
export default async function TransferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: t } = await supabase.from('inventory_transfers').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!t) notFound()
  const tr0 = t as { id: string; number: string; status: string; from_branch_id: string; to_branch_id: string; notes: string | null; difference_note: string | null
    requested_by: string | null; requested_at: string; approved_by: string | null; prepared_by: string | null; dispatched_by: string | null; dispatched_at: string | null; received_by: string | null; received_at: string | null }
  const [products, { data: ls }, { data: br }, { data: members }, fromOk, toOk] = await Promise.all([
    trackedProducts(supabase, companyId), supabase.from('inventory_transfer_lines').select('*').eq('transfer_id', id),
    supabase.from('branches').select('id, name').eq('company_id', companyId), supabase.rpc('company_members', { target: companyId }),
    supabase.rpc('inventory_branch_ok', { target: companyId, branch: tr0.from_branch_id }), supabase.rpc('inventory_branch_ok', { target: companyId, branch: tr0.to_branch_id }),
  ])
  const lines = (ls ?? []) as TLine[]
  const bname = new Map(((br ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]))
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const atOrigin = access.operate && fromOk.data === true, atDest = access.operate && toOk.data === true
  const step = tr0.status
  const done: Record<string, string> = { requested: tr('Transferencia solicitada.', 'Transfer requested.'), approve: tr('Aprobada: comprometida en la sucursal de origen.', 'Approved: committed at the origin branch.'),
    prepare: tr('Preparación guardada.', 'Preparation saved.'), dispatch: tr('Despachada: en tránsito hacia el destino.', 'Dispatched: in transit to the destination.'),
    receive: tr('Recepción confirmada: el destino ya suma las existencias.', 'Receipt confirmed: the destination now holds the stock.'), cancel: tr('Transferencia cancelada.', 'Transfer cancelled.') }
  const editing = (step === 'approved' || step === 'prepared') && atOrigin ? 'prepare' : step === 'in_transit' && atDest ? 'receive' : null
  const trail = [[tr('Solicitada', 'Requested'), tr0.requested_by], [tr('Aprobada', 'Approved'), tr0.approved_by], [tr('Preparada', 'Prepared'), tr0.prepared_by], [tr('Despachada', 'Dispatched'), tr0.dispatched_by], [tr('Recibida', 'Received'), tr0.received_by]] as [string, string | null][]
  return (
    <div className="space-y-6">
      <Link href="/inventory/transfers" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Transferencias', '← Transfers')}</Link>
      <PageHeader eyebrow={tr('Transferencia', 'Transfer')} title={`${tr0.number} · ${bname.get(tr0.from_branch_id)} → ${bname.get(tr0.to_branch_id)}`} description={tr0.notes ?? undefined} />
      <InventoryNav tr={tr} current="/inventory/transfers" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <div className="flex flex-wrap items-center gap-3">
        <StateChip tone={step === 'received' ? 'ok' : step === 'cancelled' ? 'issue' : 'pending'}><span data-testid="transfer-status">{statusLabel(step, locale)}</span></StateChip>
        {step === 'requested' && access.approve && <form action={transferStep}><input type="hidden" name="transfer_id" value={id} /><input type="hidden" name="action" value="approve" /><SubmitButton className="w-full sm:w-auto">{tr('Aprobar', 'Approve')}</SubmitButton></form>}
        {(step === 'approved' || step === 'prepared') && atOrigin && <form action={transferStep}><input type="hidden" name="transfer_id" value={id} /><input type="hidden" name="action" value="dispatch" /><SubmitButton className="w-full sm:w-auto">{tr('Despachar', 'Dispatch')}</SubmitButton></form>}
        {['requested', 'approved', 'prepared'].includes(step) && atOrigin && <form action={transferStep}><input type="hidden" name="transfer_id" value={id} /><input type="hidden" name="action" value="cancel" /><button className="btn-secondary">{tr('Cancelar', 'Cancel')}</button></form>}
      </div>
      <ol className="flex flex-wrap gap-2 text-xs text-muted" aria-label={tr('Trazabilidad', 'Traceability')}>{trail.map(([label, u]) => <li key={label} className={`rounded-full border px-3 py-1 ${u ? 'border-electric/40 text-fg' : 'border-line'}`}>{label}{u ? `: ${who.get(u) || tr('usuario', 'user')}` : ''}</li>)}</ol>
      {tr0.difference_note && <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100" data-testid="transfer-difference">{tr('Diferencias', 'Differences')}: {tr0.difference_note}</p>}
      <section className="card overflow-hidden">
        {editing && <div className="px-5 pt-5"><ScanIntoForm formId="transfer-form" copy={scanCopy(tr)} labels={{ added: editing === 'prepare' ? tr('{name}: {n} preparados', '{name}: {n} picked') : tr('{name}: {n} recibidos', '{name}: {n} received'),
          notInDocument: tr('no está en esta transferencia', 'is not on this transfer'), unknown: tr('Código desconocido.', 'Unknown code.'), errors: errorMap(locale) }} /></div>}
        <form id="transfer-form" action={transferStep}>
          <input type="hidden" name="transfer_id" value={id} /><input type="hidden" name="action" value={editing ?? ''} />
          <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[700px] text-sm" data-testid="transfer-lines">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Producto', 'Product')}</th><th className="px-3 py-2 text-right">{tr('Solicitado', 'Requested')}</th>
              <th className="px-3 py-2 text-right">{tr('Preparado', 'Picked')}</th><th className="px-3 py-2 text-right">{tr('Despachado', 'Dispatched')}</th><th className="px-3 py-2 text-right">{tr('Recibido', 'Received')}</th>
              <th className="px-3 py-2 text-right">{tr('Dañado', 'Damaged')}</th>{editing && <th className="px-3 py-2">{editing === 'prepare' ? tr('Preparar', 'Pick') : tr('Llegó', 'Arrived')}</th>}{editing === 'receive' && <th className="px-3 py-2">{tr('Dañado', 'Damaged')}</th>}</tr></thead>
            <tbody className="divide-y divide-line/60">{lines.map((l) => (
              <tr key={l.id}><td className="px-4 py-2"><span className="text-fg">{productLabel(products, l.item_id, l.variant_id)}</span><span className="block text-xs text-muted">{productCode(products, l.item_id, l.variant_id)}</span></td>
                <td className="px-3 py-2 text-right tabular-nums">{qtyText(l.qty_requested)}</td><td className="px-3 py-2 text-right tabular-nums">{l.qty_prepared === null ? '—' : qtyText(l.qty_prepared)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.qty_dispatched === null ? '—' : qtyText(l.qty_dispatched)}</td><td className="px-3 py-2 text-right tabular-nums">{l.qty_received === null ? '—' : qtyText(l.qty_received)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.qty_damaged === null ? '—' : qtyText(l.qty_damaged)}</td>
                {editing && <td className="px-3 py-2"><input type="hidden" name="transfer_line" value={l.id} /><label className="sr-only" htmlFor={`q-${l.id}`}>{tr('Cantidad', 'Quantity')}</label>
                  <input id={`q-${l.id}`} name={`qty_${l.id}`} inputMode="decimal" className="field w-24" data-scan-key={`${l.item_id}|${l.variant_id ?? ''}`}
                    max={editing === 'receive' ? Number(l.qty_dispatched ?? 0) : undefined} defaultValue={editing === 'receive' ? '' : l.qty_prepared === null ? '' : qtyText(l.qty_prepared)} /></td>}
                {editing === 'receive' && <td className="px-3 py-2"><label className="sr-only" htmlFor={`d-${l.id}`}>{tr('Dañado', 'Damaged')}</label><input id={`d-${l.id}`} name={`dmg_${l.id}`} inputMode="decimal" className="field w-20" /></td>}
              </tr>))}</tbody>
          </table></div>
          {editing && (
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
              {editing === 'receive' && <label className="min-w-0 flex-1 text-sm"><span className="field-label">{tr('Nota de diferencias (obligatoria si no llegó todo o llegó dañado)', 'Difference note (required if not everything arrived or something is damaged)')}</span><input name="note" maxLength={500} className="field" /></label>}
              <SubmitButton className="w-full sm:w-auto">{editing === 'prepare' ? tr('Guardar preparación', 'Save picking') : tr('Confirmar recepción', 'Confirm receipt')}</SubmitButton>
            </div>)}
        </form>
      </section>
      <p className="text-xs text-muted">{tr('Solicitada el', 'Requested on')} {f.date(tr0.requested_at.slice(0, 10))}{tr0.dispatched_at ? ` · ${tr('despachada el', 'dispatched on')} ${f.date(tr0.dispatched_at.slice(0, 10))}` : ''}{tr0.received_at ? ` · ${tr('recibida el', 'received on')} ${f.date(tr0.received_at.slice(0, 10))}` : ''}</p>
    </div>
  )
}

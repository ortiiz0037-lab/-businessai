import Link from 'next/link'
import { fetchAllPages, complete } from '@/lib/supabase/paged'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, MOVEMENT_KINDS, movementKind, qtyText } from '@/lib/inventory/labels'
import { correctMovement } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
type Mv = { id: number; kind: string; quantity: number; item_id: string; variant_id: string | null; branch_id: string; reason: string | null; document_id: string | null
  source_type: string | null; source_id: string | null; corrects_id: number | null; occurred_at: string; created_by: string | null }

/** The movement ledger: every entry and exit with who, when, why and its document. Corrections add a compensating entry. */
export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ branch?: string; kind?: string; from?: string; to?: string; done?: string; error?: string; n?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const branches = await myBranches(supabase, companyId)
  const branch = branches.find((b) => b.id === sp.branch)?.id
  const kind = sp.kind && MOVEMENT_KINDS[sp.kind] ? sp.kind : ''
  const iso = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  let q = supabase.from('inventory_movements').select('id, kind, quantity, item_id, variant_id, branch_id, reason, document_id, source_type, source_id, corrects_id, occurred_at, created_by').eq('company_id', companyId)
  if (branch) q = q.eq('branch_id', branch)
  if (kind) q = q.eq('kind', kind)
  if (iso(sp.from)) q = q.gte('occurred_at', `${iso(sp.from)}T00:00:00-04:00`)
  if (iso(sp.to)) q = q.lte('occurred_at', `${iso(sp.to)}T23:59:59-04:00`)
  const [products, { data }, { data: corrected }, { data: members }] = await Promise.all([
    trackedProducts(supabase, companyId), q.order('id', { ascending: false }).limit(300),
    fetchAllPages((a, b) => supabase.from('inventory_movements').select('corrects_id').eq('company_id', companyId).not('corrects_id', 'is', null).order('id').range(a, b), { max: 200000 }).then(complete),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const rows = (data ?? []) as Mv[]
  const correctedIds = new Set(((corrected ?? []) as { corrects_id: number }[]).map((c) => c.corrects_id))
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const done: Record<string, string> = {
    recorded: tr('Movimiento registrado.', 'Movement recorded.'), requested: tr('Solicitud enviada: un aprobador debe confirmarla antes de que cambien las existencias.', 'Request sent: an approver must confirm it before stock changes.'),
    corrected: tr('Corrección registrada como movimiento compensatorio.', 'Correction recorded as a compensating movement.'), issued: tr(`Salida de la factura registrada (${sp.n ?? 0} líneas).`, `Invoice issue recorded (${sp.n ?? 0} lines).`),
  }
  const srcLink = (m: Mv) => m.source_type === 'purchase_receipt' ? null : m.source_type === 'transfer' ? `/inventory/transfers/${m.source_id}` : m.source_type === 'count' ? `/inventory/counts/${m.source_id}` : m.document_id ? `/documents/${m.document_id}` : null
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Movimientos', 'Movements')}
        description={tr('El historial no se edita: una corrección crea un movimiento compensatorio que apunta al original.', 'History is never edited: a correction creates a compensating movement pointing to the original.')}
        actions={access.operate ? <><Link href="/inventory/movements/new" className="btn-primary">{tr('Nuevo movimiento', 'New movement')}</Link><Link href="/inventory/adjustments" className="btn-secondary">{tr('Ajustes por aprobar', 'Adjustments to approve')}</Link></> : undefined} />
      <InventoryNav tr={tr} current="/inventory/movements" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-5 sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch" defaultValue={branch ?? ''} className="field"><option value="">{tr('Todas', 'All')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{tr('Tipo', 'Kind')}</span><select name="kind" defaultValue={kind} className="field"><option value="">{tr('Todos', 'All')}</option>{Object.keys(MOVEMENT_KINDS).map((k) => <option key={k} value={k}>{movementKind(k, locale)}</option>)}</select></label>
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={iso(sp.from) ?? ''} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={iso(sp.to) ?? ''} className="field" /></label>
        <button type="submit" className="btn-secondary">{tr('Filtrar', 'Filter')}</button>
      </form>
      {rows.length === 0 ? <div className="card"><EmptyState icon="archive" title={tr('Sin movimientos', 'No movements')} description={tr('No hay movimientos con estos filtros.', 'No movements with these filters.')} /></div> : (
        <section className="card overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm" data-testid="movements-table">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">#</th><th className="px-4 py-3">{tr('Fecha', 'Date')}</th><th className="px-4 py-3">{tr('Producto', 'Product')}</th>
              <th className="px-4 py-3">{tr('Tipo', 'Kind')}</th><th className="px-4 py-3">{tr('Sucursal', 'Branch')}</th><th className="px-3 py-3 text-right">{tr('Cantidad', 'Quantity')}</th>
              <th className="px-4 py-3">{tr('Responsable', 'By')}</th><th className="px-4 py-3">{tr('Motivo / origen', 'Reason / source')}</th>{access.approve && <th className="px-4 py-3" />}</tr></thead>
            <tbody className="divide-y divide-line/60">{rows.map((m) => { const link = srcLink(m); return (
              <tr key={m.id} data-testid="movement-row" data-kind={m.kind}>
                <td className="px-4 py-2 text-xs text-muted">{m.id}</td><td className="px-4 py-2 text-muted">{f.date(m.occurred_at.slice(0, 10))} {m.occurred_at.slice(11, 16)}</td>
                <td className="px-4 py-2"><Link href={`/inventory/items/${m.item_id}${m.variant_id ? `?variant=${m.variant_id}` : ''}`} className="text-fg hover:text-accent">{productLabel(products, m.item_id, m.variant_id)}</Link></td>
                <td className="px-4 py-2">{movementKind(m.kind, locale)}{m.corrects_id ? <span className="text-xs text-muted"> → #{m.corrects_id}</span> : null}</td>
                <td className="px-4 py-2 text-muted">{bname.get(m.branch_id) ?? '—'}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${Number(m.quantity) < 0 ? 'text-red-200' : 'text-green-200'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qtyText(m.quantity)}</td>
                <td className="px-4 py-2 text-xs text-muted">{m.created_by ? who.get(m.created_by) || tr('usuario', 'user') : '—'}</td>
                <td className="px-4 py-2 text-xs text-muted">{m.reason ?? ''}{link && <> · <Link href={link} className="text-accent">{tr('ver', 'view')}</Link></>}</td>
                {access.approve && <td className="px-4 py-2">{!['correction', 'revaluation', 'transfer_in', 'transfer_out'].includes(m.kind) && !correctedIds.has(m.id) && (
                  <details><summary className="cursor-pointer text-xs font-semibold text-red-200">{tr('Corregir', 'Correct')}</summary>
                    <form action={correctMovement} className="mt-2 flex gap-2"><input type="hidden" name="movement_id" value={m.id} />
                      <label className="sr-only" htmlFor={`r-${m.id}`}>{tr('Motivo', 'Reason')}</label>
                      <input id={`r-${m.id}`} name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field py-1.5" />
                      <SubmitButton className="btn-sm">{tr('Corregir', 'Correct')}</SubmitButton></form></details>)}</td>}
              </tr>) })}</tbody>
          </table></div></section>
      )}
    </div>
  )
}

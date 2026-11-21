import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches, productLabel, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, movementKind, qtyText, statusLabel, statusTone } from '@/lib/inventory/labels'
import { decideAdjustment } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
type Adj = { id: string; number: string; branch_id: string; kind: string; lines: { item: string; variant?: string | null; qty: string }[]; reason: string; status: string
  requested_by: string | null; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null }

/** Adjustments, damaged, lost and returns waiting for an approver, and the decided ones (who, when, why). */
export default async function AdjustmentsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [branches, products, { data }, { data: members }] = await Promise.all([
    myBranches(supabase, companyId), trackedProducts(supabase, companyId),
    supabase.from('inventory_adjustments').select('*').eq('company_id', companyId).order('requested_at', { ascending: false }).limit(100),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const rows = (data ?? []) as Adj[]
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const done: Record<string, string> = { approved: tr('Aprobado: las existencias se actualizaron.', 'Approved: stock was updated.'), rejected: tr('Rechazado: las existencias no cambian.', 'Rejected: stock does not change.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Ajustes y bajas', 'Adjustments and write-offs')}
        description={tr('Ajustes, dañados, perdidos, no vendibles y devoluciones: conservan su motivo, quién lo pidió y quién lo decidió.', 'Adjustments, damaged, lost, unsellable and returns: they keep their reason, who asked and who decided.')} />
      <InventoryNav tr={tr} current="/inventory/movements" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      {rows.length === 0 ? <div className="card"><EmptyState icon="check" title={tr('Sin ajustes', 'No adjustments')} description={tr('No hay ajustes registrados.', 'No adjustments recorded.')} /></div> : (
        <ul className="space-y-3" data-testid="adjustments">{rows.map((a) => (
          <li key={a.id} className="card space-y-3 p-4" data-testid="adjustment" data-status={a.status}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="font-semibold text-fg">{a.number} · {movementKind(a.kind, locale)}</p>
                <p className="text-xs text-muted">{bname.get(a.branch_id) ?? '—'} · {a.requested_by ? who.get(a.requested_by) : '—'} · {f.date(a.requested_at.slice(0, 10))}</p></div>
              <StateChip tone={statusTone(a.status)}>{statusLabel(a.status, locale)}</StateChip>
            </div>
            <ul className="text-sm">{a.lines.map((l, i) => <li key={i}>{qtyText(l.qty)} × {productLabel(products, l.item, l.variant ?? null)}</li>)}</ul>
            <p className="text-sm text-muted">{tr('Motivo', 'Reason')}: {a.reason}</p>
            {a.decided_by && <p className="text-xs text-muted">{tr('Decidido por', 'Decided by')} {who.get(a.decided_by)} · {a.decided_at ? f.date(a.decided_at.slice(0, 10)) : ''}{a.decision_note ? ` · ${a.decision_note}` : ''}</p>}
            {access.approve && a.status === 'pending' && (
              <form action={decideAdjustment} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input type="hidden" name="adjustment_id" value={a.id} />
                <label className="sr-only" htmlFor={`n-${a.id}`}>{tr('Nota', 'Note')}</label>
                <input id={`n-${a.id}`} name="note" maxLength={300} placeholder={tr('Nota (obligatoria para rechazar)', 'Note (required to reject)')} className="field min-w-0 flex-1" />
                <button name="decision" value="approve" className="btn-primary btn-sm">{tr('Aprobar', 'Approve')}</button>
                <button name="decision" value="reject" className="btn-secondary btn-sm">{tr('Rechazar', 'Reject')}</button>
              </form>
            )}
          </li>))}</ul>
      )}
    </div>
  )
}

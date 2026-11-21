import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { LineEditor } from '@/components/inventory/scanners'
import { inventoryPage, myBranches, stockOptions, trackedProducts } from '@/lib/inventory/page'
import { ADJUSTMENT_KINDS, inventoryMessage, movementKind } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { issueDocument, recordMovement } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
const KINDS = ['sale', 'customer_return', ...ADJUSTMENT_KINDS.filter((k) => k !== 'customer_return')]

/** A new movement: sales and customer returns are recorded at once; adjustments, damaged, lost and returns to vendor need an approver. */
export default async function NewMovementPage({ searchParams }: { searchParams: Promise<{ kind?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await inventoryPage()
  if (!access.operate || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const kind = KINDS.includes(sp.kind ?? '') ? sp.kind! : 'sale'
  const [branches, products, { data: locs }, { data: vendors }, { data: invoices }] = await Promise.all([
    myBranches(supabase, companyId), trackedProducts(supabase, companyId),
    supabase.from('inventory_locations').select('id, branch_id, code, name').eq('company_id', companyId).is('archived_at', null).order('code'),
    supabase.from('vendors').select('id, name').eq('company_id', companyId).eq('status', 'active').order('name'),
    supabase.from('documents').select('id, document_number, issue_date').eq('company_id', companyId).eq('document_type', 'invoice').in('status', ['sent', 'overdue', 'paid']).order('issue_date', { ascending: false }).limit(100),
  ])
  const options = stockOptions(products).map((o) => ({ ...o, cost: undefined }))
  const direct = kind === 'sale' || kind === 'customer_return'
  const lineLabels = { product: tr('Producto', 'Product'), qty: tr('Cantidad', 'Quantity'), cost: tr('Costo unit. ($)', 'Unit cost ($)'), add: tr('Añadir línea', 'Add line'), remove: tr('Quitar', 'Remove'),
    unknown: tr('Código desconocido.', 'Unknown code.'), notTracked: tr('no controla inventario', 'does not track stock'), choose: tr('Elegir producto…', 'Choose product…'), errors: errorMap(locale) }
  const withCost = ['opening', 'adjustment_in'].includes(kind)
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Nuevo movimiento', 'New movement')}
        description={direct ? tr('Se registra al instante; nunca deja el inventario en negativo.', 'Recorded at once; stock never goes below zero.')
          : access.approve ? tr('Como aprobador, se registra al instante con su motivo.', 'As an approver, it is recorded at once with its reason.')
          : tr('Queda pendiente hasta que un aprobador lo confirme. Las existencias no cambian antes.', 'It stays pending until an approver confirms it. Stock does not change before.')} />
      <InventoryNav tr={tr} current="/inventory/movements" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr('Tipo de movimiento', 'Movement kind')}>
        {KINDS.map((k) => <a key={k} href={`/inventory/movements/new?kind=${k}`} aria-current={k === kind ? 'page' : undefined}
          className={`rounded-xl border px-3 py-1.5 ${k === kind ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line text-slate-300'}`}>{movementKind(k, locale)}</a>)}
      </nav>
      <form action={recordMovement} className="card space-y-4 p-5" data-testid="movement-form">
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="idempotency_key" value={randomUUID()} /><input type="hidden" name="back" value={`/inventory/movements/new?kind=${kind}`} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch_id" required className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="text-sm"><span className="field-label">{tr('Ubicación (opcional)', 'Location (optional)')}</span>
            <select name="location_id" className="field"><option value="">—</option>{((locs ?? []) as { id: string; branch_id: string; code: string; name: string }[]).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
          {kind === 'vendor_return' && <label className="text-sm"><span className="field-label">{tr('Proveedor', 'Vendor')}</span>
            <select name="vendor_id" className="field"><option value="">—</option>{((vendors ?? []) as { id: string; name: string }[]).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
          {(kind === 'sale' || kind === 'customer_return') && <label className="text-sm"><span className="field-label">{tr('Factura (opcional)', 'Invoice (optional)')}</span>
            <select name="document_id" className="field"><option value="">—</option>{((invoices ?? []) as { id: string; document_number: string | null }[]).map((d) => <option key={d.id} value={d.id}>{d.document_number}</option>)}</select></label>}
        </div>
        <LineEditor options={options} withCost={withCost} copy={scanCopy(tr)} labels={lineLabels} />
        <label className="block text-sm"><span className="field-label">{direct ? tr('Nota (opcional)', 'Note (optional)') : tr('Motivo *', 'Reason *')}</span>
          <input name="reason" required={!direct} minLength={direct ? undefined : 3} maxLength={300} className="field" /></label>
        <SubmitButton>{direct || access.approve ? tr('Registrar', 'Record') : tr('Enviar para aprobación', 'Send for approval')}</SubmitButton>
      </form>
      {kind === 'sale' && (
        <form action={issueDocument} className="card grid gap-3 p-5 sm:grid-cols-3 sm:items-end" data-testid="issue-invoice">
          <p className="text-sm text-muted sm:col-span-3">{tr('O da salida a todos los productos del catálogo de una factura emitida (una sola vez por factura).', 'Or issue every catalog product of an issued invoice (once per invoice).')}</p>
          <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch_id" className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="text-sm"><span className="field-label">{tr('Factura', 'Invoice')}</span>
            <select name="document_id" required className="field"><option value="">—</option>{((invoices ?? []) as { id: string; document_number: string | null }[]).map((d) => <option key={d.id} value={d.id}>{d.document_number}</option>)}</select></label>
          <SubmitButton>{tr('Dar salida a la factura', 'Issue the invoice')}</SubmitButton>
        </form>
      )}
    </div>
  )
}

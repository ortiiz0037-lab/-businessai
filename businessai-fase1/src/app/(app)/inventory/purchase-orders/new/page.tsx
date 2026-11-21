import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { LineEditor } from '@/components/inventory/scanners'
import { inventoryPage, myBranches, stockOptions, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { savePurchaseOrder } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'

/** A new purchase order (draft): vendor, branch that receives, catalog products, quantities and agreed cost. */
export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await inventoryPage()
  if (!access.operate || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [branches, products, { data: vendors }] = await Promise.all([
    myBranches(supabase, companyId), trackedProducts(supabase, companyId),
    supabase.from('vendors').select('id, name').eq('company_id', companyId).eq('status', 'active').order('name'),
  ])
  const costs = new Map(products.flatMap((p) => [[`${p.id}|`, p.cost_cents]]))
  const options = stockOptions(products).map((o) => ({ value: o.value, label: o.label, cost: costs.get(o.value) ? (Number(costs.get(o.value)) / 100).toFixed(2) : undefined }))
  const vlist = (vendors ?? []) as { id: string; name: string }[]
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Compras', 'Purchasing')} title={tr('Nueva orden de compra', 'New purchase order')}
        description={tr('Se guarda como borrador. Un aprobador la emite antes de recibir mercancía.', 'It is saved as a draft. An approver issues it before goods are received.')} />
      <InventoryNav tr={tr} current="/inventory/purchase-orders" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      {vlist.length === 0 ? <p className="card p-5 text-sm text-muted">{tr('Primero crea un proveedor en Gastos → Proveedores.', 'First create a vendor in Expenses → Vendors.')}</p> : (
        <form action={savePurchaseOrder} className="card space-y-4 p-5" data-testid="po-form">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm"><span className="field-label">{tr('Proveedor *', 'Vendor *')}</span><select name="vendor_id" required className="field">{vlist.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Recibe en *', 'Deliver to *')}</span><select name="branch_id" required className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Fecha esperada', 'Expected date')}</span><input type="date" name="expected_date" className="field" /></label>
          </div>
          <LineEditor options={options} withCost copy={scanCopy(tr)} labels={{ product: tr('Producto', 'Product'), qty: tr('Cantidad', 'Quantity'), cost: tr('Costo unit. ($)', 'Unit cost ($)'),
            add: tr('Añadir línea', 'Add line'), remove: tr('Quitar', 'Remove'), unknown: tr('Código desconocido.', 'Unknown code.'), notTracked: tr('no controla inventario', 'does not track stock'),
            choose: tr('Elegir producto…', 'Choose product…'), errors: errorMap(locale) }} />
          <label className="block text-sm"><span className="field-label">{tr('Notas', 'Notes')}</span><textarea name="notes" maxLength={1000} rows={2} className="field" /></label>
          <div className="flex flex-wrap gap-3">
            <SubmitButton className="w-full sm:w-auto">{tr('Guardar borrador', 'Save draft')}</SubmitButton>
            <button name="then" value="submit" className="btn-secondary">{tr('Guardar y enviar a aprobación', 'Save and send for approval')}</button>
          </div>
        </form>
      )}
    </div>
  )
}

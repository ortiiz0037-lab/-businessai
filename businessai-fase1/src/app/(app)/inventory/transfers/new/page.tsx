import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { LineEditor } from '@/components/inventory/scanners'
import { inventoryPage, stockOptions, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { createTransfer } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'

/** Request a transfer between two branches of the company. */
export default async function NewTransferPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await inventoryPage()
  if (!access.operate || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [products, { data: br }] = await Promise.all([trackedProducts(supabase, companyId), supabase.from('branches').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name')])
  const branches = (br ?? []) as { id: string; name: string }[]
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Transferencias', 'Transfers')} title={tr('Nueva transferencia', 'New transfer')}
        description={tr('Un aprobador la autoriza; la sucursal de origen la prepara y despacha; la de destino confirma lo recibido.', 'An approver authorizes it; the origin branch prepares and dispatches it; the destination confirms what arrived.')} />
      <InventoryNav tr={tr} current="/inventory/transfers" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      {branches.length < 2 ? <p className="card p-5 text-sm text-muted">{tr('Se necesitan al menos dos sucursales (CRM → Sucursales).', 'At least two branches are needed (CRM → Branches).')}</p> : (
        <form action={createTransfer} className="card space-y-4 p-5" data-testid="transfer-form">
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className="field-label">{tr('Desde *', 'From *')}</span><select name="from_branch" required className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Hacia *', 'To *')}</span><select name="to_branch" required defaultValue={branches[1].id} className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          </div>
          <LineEditor options={stockOptions(products)} copy={scanCopy(tr)} labels={{ product: tr('Producto', 'Product'), qty: tr('Cantidad', 'Quantity'), cost: '', add: tr('Añadir línea', 'Add line'),
            remove: tr('Quitar', 'Remove'), unknown: tr('Código desconocido.', 'Unknown code.'), notTracked: tr('no controla inventario', 'does not track stock'), choose: tr('Elegir producto…', 'Choose product…'), errors: errorMap(locale) }} />
          <label className="block text-sm"><span className="field-label">{tr('Notas', 'Notes')}</span><input name="notes" maxLength={500} className="field" /></label>
          <SubmitButton className="w-full sm:w-auto">{tr('Solicitar transferencia', 'Request transfer')}</SubmitButton>
        </form>
      )}
    </div>
  )
}

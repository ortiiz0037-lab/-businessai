import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches } from '@/lib/inventory/page'
import { inventoryMessage } from '@/lib/inventory/labels'
import { saveInventorySettings, saveLocation } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'

/** Company inventory settings (valuation method for reports, negative stock) and storage locations per branch. */
export default async function InventorySettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [branches, { data: s }, { data: locs }] = await Promise.all([
    myBranches(supabase, companyId),
    supabase.from('inventory_settings').select('allow_negative, valuation_method').eq('company_id', companyId).maybeSingle(),
    supabase.from('inventory_locations').select('id, branch_id, code, name, archived_at').eq('company_id', companyId).order('code'),
  ])
  const settings = (s ?? { allow_negative: false, valuation_method: 'average' }) as { allow_negative: boolean; valuation_method: string }
  const locations = (locs ?? []) as { id: string; branch_id: string; code: string; name: string; archived_at: string | null }[]
  const done: Record<string, string> = { settings: tr('Ajustes guardados.', 'Settings saved.'), location: tr('Ubicación guardada.', 'Location saved.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Ajustes de inventario', 'Inventory settings')} />
      <InventoryNav tr={tr} current="/inventory/settings" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <form action={saveInventorySettings} className="card grid gap-4 p-5 sm:grid-cols-2">
        <label className="text-sm"><span className="field-label">{tr('Método de valoración (informes)', 'Valuation method (reports)')}</span>
          <select name="method" defaultValue={settings.valuation_method} disabled={!access.approve} className="field">
            <option value="average">{tr('Promedio ponderado', 'Weighted average')}</option><option value="fifo">FIFO</option></select>
          <span className="mt-1 block text-xs text-muted">{tr('Ambos se calculan siempre desde los movimientos; el método elegido es el que se destaca. No se contabiliza en el libro mayor.', 'Both are always computed from the movements; the chosen one is highlighted. Nothing is posted to the ledger.')}</span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="allow_negative" defaultChecked={settings.allow_negative} disabled={!access.approve} className="mt-1" />
          <span>{tr('Permitir existencias negativas', 'Allow negative stock')}<span className="block text-xs text-muted">{tr('Desactivado (recomendado): ninguna salida deja el inventario por debajo de cero.', 'Off (recommended): no issue takes stock below zero.')}</span></span></label>
        {access.approve && <div className="sm:col-span-2"><SubmitButton className="w-full sm:w-auto">{tr('Guardar', 'Save')}</SubmitButton></div>}
      </form>
      <section className="card space-y-4 p-5" aria-labelledby="loc-title">
        <h2 id="loc-title" className="font-display text-lg font-semibold text-fg">{tr('Ubicaciones de almacenamiento', 'Storage locations')}</h2>
        <p className="text-xs text-muted">{tr('Opcional: estantes, pasillos o bodegas dentro de una sucursal. Los movimientos y conteos pueden indicar la ubicación.', 'Optional: shelves, aisles or stockrooms within a branch. Movements and counts can name the location.')}</p>
        {branches.map((b) => (
          <div key={b.id} className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">{b.name}</h3>
            <ul className="flex flex-wrap gap-2 text-xs">{locations.filter((l) => l.branch_id === b.id).map((l) => <li key={l.id} className={`rounded-full border px-3 py-1 ${l.archived_at ? 'border-line text-muted line-through' : 'border-electric/40'}`}>{l.code} · {l.name}</li>)}</ul>
            {access.approve && (
              <form action={saveLocation} className="flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="branch_id" value={b.id} />
                <label className="sr-only" htmlFor={`c-${b.id}`}>{tr('Código', 'Code')}</label><input id={`c-${b.id}`} name="code" required maxLength={20} placeholder={tr('Código (A-1)', 'Code (A-1)')} className="field sm:w-32" />
                <label className="sr-only" htmlFor={`n-${b.id}`}>{tr('Nombre', 'Name')}</label><input id={`n-${b.id}`} name="name" required maxLength={80} placeholder={tr('Nombre', 'Name')} className="field min-w-0 flex-1" />
                <SubmitButton className="w-full sm:w-auto">{tr('Añadir ubicación', 'Add location')}</SubmitButton>
              </form>)}
          </div>))}
      </section>
    </div>
  )
}

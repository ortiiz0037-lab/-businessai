import { PageHeader } from '@/components/ui/page'
import { fetchAllPages as selectAll, complete } from '@/lib/supabase/paged'
import { NoPosAccess, PosNav, Flash } from '@/components/pos/nav'
import { assignRegister, savePosSettings, saveRegister, saveTaxRate, setItemTax } from '@/app/actions/pos'
import { posBranches, posPage } from '@/lib/pos/page'
import { posMessage } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

/** Discount limit, shifts, receipt texts, tax rates (IVU), product rates, registers and assigned cashiers. */
export default async function PosSettings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  if (!access.manage) return <NoPosAccess tr={tr} unavailable={false} />
  const branches = await posBranches(supabase, companyId)
  const [{ data: cfg }, { data: rates }, { data: regs }, { data: assigned }, { data: members }, { data: items }, { data: itemTaxes }] = await Promise.all([
    supabase.from('pos_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('pos_tax_rates').select('id, code, name, rate, is_default, archived_at').eq('company_id', companyId).order('code'),
    supabase.from('pos_registers').select('id, code, name, branch_id, kind, archived_at').eq('company_id', companyId).order('code'),
    supabase.from('pos_register_users').select('register_id, user_id').eq('company_id', companyId),
    supabase.rpc('company_members', { target: companyId }),
    selectAll((a, b) => supabase.from('catalog_items').select('id, code, name').eq('company_id', companyId).eq('status', 'active').order('name').order('id').range(a, b)).then(complete),
    supabase.from('pos_item_taxes').select('item_id, tax_rate_id').eq('company_id', companyId),
  ])
  const c = (cfg ?? {}) as { max_discount_pct?: number; require_shift?: boolean; cash_tolerance_cents?: number; receipt_header?: string | null; receipt_footer?: string | null; allow_card_external?: boolean }
  const rs = (rates ?? []) as { id: string; code: string; name: string; rate: number; is_default: boolean; archived_at: string | null }[]
  const rg = (regs ?? []) as { id: string; code: string; name: string; branch_id: string; kind: string; archived_at: string | null }[]
  const as = (assigned ?? []) as { register_id: string; user_id: string }[]
  const ms = ((members ?? []) as { user_id: string; email: string | null; status: string }[]).filter((m) => m.status === 'active')
  const it = (items ?? []) as { id: string; code: string; name: string }[]
  const itx = new Map(((itemTaxes ?? []) as { item_id: string; tax_rate_id: string }[]).map((x) => [x.item_id, x.tax_rate_id]))
  const back = '/pos/settings'
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Ajustes', 'Settings')} />
      <PosNav tr={tr} current="/pos/settings" />
      <Flash done={sp.done ? tr('Guardado.', 'Saved.') : null} error={posMessage(sp.error, locale)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <form action={savePosSettings} className="card space-y-3 p-5" data-testid="pos-settings">
          <h2 className="font-semibold text-fg">{tr('Reglas de venta', 'Selling rules')}</h2><input type="hidden" name="back" value={back} />
          <label className="block text-sm">{tr('Descuento máximo sin autorización (%)', 'Max discount without approval (%)')}<input name="max_discount_pct" defaultValue={String(c.max_discount_pct ?? 0)} inputMode="decimal" className="field mt-1 h-11 w-full" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="require_shift" defaultChecked={c.require_shift ?? true} /> {tr('Vender solo con un turno de caja abierto', 'Sell only with an open cash shift')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allow_card_external" defaultChecked={c.allow_card_external ?? true} /> {tr('Registrar pagos con tarjeta de una terminal independiente (con su referencia)', 'Record card payments from a stand-alone terminal (with its reference)')}</label>
          <label className="block text-sm">{tr('Tolerancia informativa de caja', 'Informative cash tolerance')}<input name="cash_tolerance" defaultValue={((c.cash_tolerance_cents ?? 0) / 100).toFixed(2)} inputMode="decimal" className="field mt-1 h-11 w-full" />
            <span className="text-xs text-muted">{tr('Toda diferencia se registra y se revisa igualmente.', 'Every difference is recorded and reviewed anyway.')}</span></label>
          <label className="block text-sm">{tr('Encabezado del recibo', 'Receipt header')}<input name="receipt_header" defaultValue={c.receipt_header ?? ''} className="field mt-1 h-11 w-full" /></label>
          <label className="block text-sm">{tr('Pie del recibo', 'Receipt footer')}<input name="receipt_footer" defaultValue={c.receipt_footer ?? ''} className="field mt-1 h-11 w-full" /></label>
          <button className="btn-primary min-h-11">{tr('Guardar', 'Save')}</button>
        </form>
        <section className="card space-y-3 p-5" data-testid="pos-taxes">
          <h2 className="font-semibold text-fg">{tr('Impuestos', 'Taxes')}</h2>
          <p className="text-xs text-muted">{tr('Ej.: IVU 11.5 % (estatal 10.5 % + municipal 1 %), IVU reducido, Exento. Configura las tasas que te indique tu contador: BusinessAI no decide qué producto tributa.',
            'E.g. IVU 11.5% (state 10.5% + municipal 1%), reduced IVU, Exempt. Set the rates your accountant tells you: BusinessAI does not decide what is taxable.')}</p>
          <ul className="divide-y divide-line/50 text-sm">{rs.map((r) => (
            <li key={r.id}><form action={saveTaxRate} className="flex flex-wrap items-center gap-2 py-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="rate_id" value={r.id} />
              <input name="code" defaultValue={r.code} className="field h-11 w-24" /><input name="name" defaultValue={r.name} className="field h-11 min-w-0 flex-1" /><input name="rate" defaultValue={String(r.rate)} className="field h-11 w-20 text-right" />
              <label className="text-xs"><input type="checkbox" name="is_default" defaultChecked={r.is_default} /> {tr('Por defecto', 'Default')}</label>
              <label className="text-xs"><input type="checkbox" name="archived" defaultChecked={!!r.archived_at} /> {tr('Archivada', 'Archived')}</label><button className="btn-secondary btn-sm min-h-11">{tr('Guardar', 'Save')}</button></form></li>))}</ul>
          <form action={saveTaxRate} className="flex flex-wrap items-center gap-2 border-t border-line pt-3"><input type="hidden" name="back" value={back} />
            <input name="code" placeholder="IVU" required className="field h-11 w-24" /><input name="name" placeholder={tr('Nombre', 'Name')} required className="field h-11 min-w-0 flex-1" /><input name="rate" placeholder="11.5" required className="field h-11 w-20 text-right" />
            <label className="text-xs"><input type="checkbox" name="is_default" /> {tr('Por defecto', 'Default')}</label><button className="btn-secondary btn-sm min-h-11">{tr('Añadir', 'Add')}</button></form>
          <form action={setItemTax} className="flex flex-wrap items-center gap-2 border-t border-line pt-3"><input type="hidden" name="back" value={back} />
            <select name="item_id" className="field h-11 min-w-0 flex-1">{it.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code}){itx.has(i.id) ? ` · ${rs.find((r) => r.id === itx.get(i.id))?.code}` : ''}</option>)}</select>
            <select name="rate_id" className="field h-11 w-36"><option value="">{tr('Tasa por defecto', 'Default rate')}</option>{rs.filter((r) => !r.archived_at).map((r) => <option key={r.id} value={r.id}>{r.code} ({Number(r.rate)}%)</option>)}</select>
            <button className="btn-secondary btn-sm min-h-11">{tr('Asignar', 'Assign')}</button></form>
        </section>
      </div>
      <section className="card space-y-3 p-5" data-testid="pos-registers">
        <h2 className="font-semibold text-fg">{tr('Cajas y cajeros asignados', 'Registers and assigned cashiers')}</h2>
        <p className="text-xs text-muted">{tr('Si una caja tiene cajeros asignados, solo ellos (y los aprobadores) abren turno en ella.', 'When a register has assigned cashiers, only they (and approvers) open shifts on it.')}</p>
        <ul className="space-y-3">{rg.filter((r) => r.kind === 'native').map((r) => (
          <li key={r.id} className="rounded-xl border border-line p-3 text-sm">
            <form action={saveRegister} className="flex flex-wrap items-center gap-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="register_id" value={r.id} />
              <input name="code" defaultValue={r.code} className="field h-11 w-28" /><input name="name" defaultValue={r.name} className="field h-11 min-w-0 flex-1" />
              <select name="branch_id" defaultValue={r.branch_id} className="field h-11">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              <label className="text-xs"><input type="checkbox" name="archived" defaultChecked={!!r.archived_at} /> {tr('Archivada', 'Archived')}</label><button className="btn-secondary btn-sm min-h-11">{tr('Guardar', 'Save')}</button></form>
            <div className="mt-2 flex flex-wrap gap-2">{as.filter((a) => a.register_id === r.id).map((a) => (
              <form key={a.user_id} action={assignRegister}><input type="hidden" name="back" value={back} /><input type="hidden" name="register_id" value={r.id} /><input type="hidden" name="user_id" value={a.user_id} /><input type="hidden" name="assigned" value="0" />
                <button className="rounded-full border border-line px-3 py-1 text-xs">{ms.find((m) => m.user_id === a.user_id)?.email ?? a.user_id.slice(0, 8)} ✕</button></form>))}
              <form action={assignRegister} className="flex gap-2"><input type="hidden" name="back" value={back} /><input type="hidden" name="register_id" value={r.id} /><input type="hidden" name="assigned" value="1" />
                <select name="user_id" className="field h-9 text-xs">{ms.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select><button className="btn-secondary btn-sm">{tr('Asignar', 'Assign')}</button></form></div>
          </li>))}</ul>
        <form action={saveRegister} className="flex flex-wrap items-center gap-2 border-t border-line pt-3"><input type="hidden" name="back" value={back} />
          <input name="code" placeholder="CAJA1" required className="field h-11 w-28" /><input name="name" placeholder={tr('Nombre de la caja', 'Register name')} required className="field h-11 min-w-0 flex-1" />
          <select name="branch_id" className="field h-11">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button className="btn-primary min-h-11">{tr('Crear caja', 'Create register')}</button></form>
      </section>
    </div>
  )
}

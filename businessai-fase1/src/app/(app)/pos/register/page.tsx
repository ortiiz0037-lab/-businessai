import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { NoPosAccess, PosNav, Flash } from '@/components/pos/nav'
import { Register } from '@/components/pos/register'
import { openShift } from '@/app/actions/pos'
import { posBranches, posPage } from '@/lib/pos/page'
import { methodLabel, posMessage } from '@/lib/pos/labels'
import { scanCopy } from '@/lib/inventory/copy'

export const dynamic = 'force-dynamic'

const ERRS = ['forbidden', 'branch_forbidden', 'pos_shift_required', 'pos_shift_not_open', 'pos_register_invalid', 'pos_payments_mismatch', 'pos_payments_invalid',
  'pos_payment_method_invalid', 'pos_payment_reference_required', 'pos_stock_unavailable', 'pos_lines_invalid', 'pos_item_invalid', 'pos_qty_invalid', 'pos_discount_invalid',
  'pos_client_invalid', 'pos_approval_required', 'inventory_variant_required', 'reason_required', 'pos_invalid', 'unavailable', 'save']

/** The selling screen: pick the register, open the shift, sell. */
export default async function PosRegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, supabase, user, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const branches = await posBranches(supabase, companyId)
  const [{ data: regs }, { data: myShift }, { data: settings }, { data: cl }] = await Promise.all([
    supabase.from('pos_registers').select('id, code, name, branch_id').eq('company_id', companyId).eq('kind', 'native').is('archived_at', null).order('code'),
    supabase.from('pos_shifts').select('id, number, register_id, branch_id, opened_at').eq('company_id', companyId).eq('cashier_id', user.id).eq('status', 'open').maybeSingle(),
    supabase.from('pos_settings').select('max_discount_pct, require_shift').eq('company_id', companyId).maybeSingle(),
    supabase.from('clients').select('id, name').eq('company_id', companyId).order('name').limit(500),
  ])
  const registers = ((regs ?? []) as { id: string; code: string; name: string; branch_id: string }[]).filter((r) => branches.some((b) => b.id === r.branch_id))
  const shift = myShift as { id: string; number: string; register_id: string; branch_id: string; opened_at: string } | null
  const reg = registers.find((r) => r.id === (shift?.register_id ?? sp.register)) ?? (registers.length === 1 ? registers[0] : undefined)
  const t = (es: string, en: string) => tr(es, en)
  const copy = {
    products: t('Productos', 'Products'), searchName: t('Buscar por nombre o código', 'Search by name or code'), search: t('Buscar', 'Search'),
    notFound: t('No se encontró ese producto.', 'Product not found.'), available: t('Disponible', 'Available'), cart: t('Venta actual', 'Current sale'),
    empty: t('Escanea o busca un producto.', 'Scan or search a product.'), less: t('Quitar uno', 'One less'), more: t('Añadir uno', 'One more'),
    discount: t('Descuento', 'Discount'), cartDiscount: t('Descuento a la venta', 'Sale discount'), client: t('Cliente', 'Client'), noClient: t('Sin cliente', 'No client'),
    discountReason: t('Motivo del descuento', 'Discount reason'), approvalCode: t('Código del supervisor (8 dígitos)', 'Supervisor code (8 digits)'),
    overLimit: t('Supera el límite de descuento: necesita autorización.', 'Above the discount limit: needs authorisation.'),
    subtotal: t('Subtotal', 'Subtotal'), tax: t('Impuesto', 'Tax'), total: t('Total', 'Total'), payment: t('Cobro', 'Payment'), method: t('Método', 'Method'),
    amount: t('Importe', 'Amount'), rest: t('Resto', 'Rest'), tendered: t('Efectivo recibido', 'Cash received'), reference: t('Referencia / autorización', 'Reference / authorisation'),
    last4: t('Últ. 4', 'Last 4'), removePayment: t('Quitar pago', 'Remove payment'), splitPayment: t('Dividir el pago', 'Split payment'),
    remaining: t('Por cobrar', 'Remaining'), overpaid: t('Cobrado de más', 'Overpaid'), change: t('Cambio', 'Change'),
    cardNote: t('Tarjeta: se cobra en la terminal del procesador y aquí se registra su referencia. BusinessAI no procesa ni guarda datos de tarjetas.',
      'Card: charged on the processor terminal and its reference is recorded here. BusinessAI neither processes nor stores card data.'),
    charge: t('Cobrar', 'Charge'), charging: t('Registrando…', 'Recording…'), sold: t('Venta registrada', 'Sale recorded'), receipt: t('Ver recibo', 'View receipt'),
  }
  const methodLabels = Object.fromEntries(['cash', 'ath_movil', 'card_external', 'check', 'transfer', 'other'].map((m) => [m, methodLabel(m, locale)]))
  const errors = Object.fromEntries(ERRS.map((k) => [k, posMessage(k, locale)!]))
  const requireShift = (settings as { require_shift: boolean } | null)?.require_shift ?? true
  const ready = reg && (shift || !requireShift)
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Vender', 'Sell')}
        description={shift ? tr(`Turno ${shift.number} abierto en ${reg?.name ?? ''}.`, `Shift ${shift.number} open on ${reg?.name ?? ''}.`) : tr('Elige la caja y abre tu turno para empezar.', 'Pick the register and open your shift to start.')}
        actions={shift ? <Link href="/pos/shifts" className="btn-secondary">{tr('Caja y cierre', 'Cash & closing')}</Link> : undefined} />
      <PosNav tr={tr} current="/pos/register" />
      <Flash done={sp.done ? tr('Turno abierto.', 'Shift opened.') : null} error={posMessage(sp.error, locale)} />
      {!access.sell ? <p className="alert-info">{tr('Tu rol puede ver, pero no vender.', 'Your role can view, not sell.')}</p>
        : registers.length === 0 ? (
          <div className="card p-6 text-sm text-muted">{tr('No hay cajas en tus sucursales. ', 'There are no registers in your branches. ')}
            {access.manage && <Link className="text-accent underline" href="/pos/settings">{tr('Crear una caja', 'Create a register')}</Link>}</div>
        ) : !ready ? (
          <form action={openShift} className="card max-w-xl space-y-4 p-5" data-testid="open-shift">
            <input type="hidden" name="back" value="/pos/register" />
            <input type="hidden" name="idempotency_key" value={randomUUID()} />
            <label className="block text-sm text-fg">{tr('Caja', 'Register')}
              <select name="register_id" defaultValue={reg?.id ?? registers[0].id} className="field mt-1 h-12 w-full">
                {registers.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code}) · {branches.find((b) => b.id === r.branch_id)?.name}</option>)}</select></label>
            <label className="block text-sm text-fg">{tr('Fondo inicial (efectivo en la gaveta)', 'Opening float (cash in the drawer)')}
              <input name="float" inputMode="decimal" defaultValue="0.00" className="field mt-1 h-12 w-full text-right" data-testid="shift-float" /></label>
            <button className="btn-primary min-h-12 w-full">{tr('Abrir turno', 'Open shift')}</button>
          </form>
        ) : (
          <Register locale={locale} copy={copy} scan={scanCopy(tr)} branchId={reg!.branch_id} registerId={reg!.id} shiftId={shift?.id ?? null}
            clients={((cl ?? []) as { id: string; name: string }[])} maxDiscountPct={Number((settings as { max_discount_pct: number } | null)?.max_discount_pct ?? 0)}
            methodLabels={methodLabels} errors={errors} />
        )}
    </div>
  )
}

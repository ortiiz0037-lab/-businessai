import { PageHeader, StatCard } from '@/components/ui/page'
import { NoPosAccess, PosNav } from '@/components/pos/nav'
import { posBranches, posPage, prDay } from '@/lib/pos/page'
import { methodLabel, posStatus } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

type Report = {
  totals: Record<string, number>; daily: { day: string; sales: number; total_cents: number; tax_cents: number; discount_cents: number }[]
  by_branch: { branch_id: string; sales: number; total_cents: number }[]; by_cashier: { cashier_id: string | null; cashier_ref: string | null; sales: number; total_cents: number; discount_cents: number }[]
  top_products: { name: string; qty: number; net_cents: number }[]; payment_methods: { method: string; count: number; amount_cents: number; refunded_cents: number }[]
  taxes: { tax_name: string | null; tax_rate: number; taxable_cents: number; tax_cents: number }[]; discounts: { number: string; discount_cents: number; reason: string | null }[]
  refunds: { number: string; amount_cents: number; method: string; reason: string }[]; cash_differences: { number: string; difference_cents: number; status: string }[]
  sync: Record<string, number>; settlements: Record<string, number>
}

/** Reports from confirmed sales only (pos_report): voids excluded, refunds subtracted, never invented. */
export default async function PosReports({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from! : prDay(-29), to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to! : prDay()
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1)
  const pFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10), pTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10)
  const branches = await posBranches(supabase, companyId)
  const branch = branches.some((b) => b.id === sp.branch) ? sp.branch! : null
  const [{ data, error }, { data: prev }, { data: members }] = await Promise.all([
    supabase.rpc('pos_report', { target: companyId, p_from: from, p_to: to, branch }),
    supabase.rpc('pos_report', { target: companyId, p_from: pFrom, p_to: pTo, branch }),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const r = (data ?? null) as Report | null
  const p = (prev ?? null) as Report | null
  const bn = new Map(branches.map((b) => [b.id, b.name]))
  const names = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const delta = (a: number, b: number) => (b === 0 ? '—' : `${a >= b ? '+' : ''}${Math.round(((a - b) * 1000) / b) / 10}%`)
  const T = (title: string, head: string[], rows: (string | number)[][], id: string) => (
    <section className="card min-w-0 overflow-hidden" data-testid={id}><h2 className="p-4 pb-0 font-semibold text-fg">{title}</h2>
      {rows.length === 0 ? <p className="p-4 text-sm text-muted">{tr('Sin datos en el periodo.', 'No data in the period.')}</p> : (
        <div className="overflow-x-auto"><table className="mt-2 w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-muted">{head.map((h, i) => <th key={h} className={`p-3 ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => <tr key={i} className="border-b border-line/40">{row.map((c, j) => <td key={j} className={`p-3 ${j > 0 ? 'text-right tabular-nums' : ''}`}>{c}</td>)}</tr>)}</tbody></table></div>)}
    </section>)
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Informes de ventas', 'Sales reports')}
        description={tr('Solo ventas confirmadas: las anuladas no cuentan y las devoluciones se restan. Cada venta aparece una sola vez.', 'Confirmed sales only: voids do not count and refunds are subtracted. Each sale appears once.')} />
      <PosNav tr={tr} current="/pos/reports" />
      <form className="card flex flex-wrap items-end gap-3 p-4" method="get">
        <label className="text-xs text-muted">{tr('Desde', 'From')}<input type="date" name="from" defaultValue={from} className="field mt-1 h-11" /></label>
        <label className="text-xs text-muted">{tr('Hasta', 'To')}<input type="date" name="to" defaultValue={to} className="field mt-1 h-11" /></label>
        <label className="text-xs text-muted">{tr('Sucursal', 'Branch')}<select name="branch" defaultValue={branch ?? ''} className="field mt-1 h-11"><option value="">{tr('Todas', 'All')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <button className="btn-secondary min-h-11">{tr('Ver', 'View')}</button>
      </form>
      {error || !r ? <p className="alert-danger">{tr('No se pudo calcular el informe.', 'The report could not be computed.')}</p> : (<>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon="receipt" label={tr('Ventas', 'Sales')} value={String(r.totals.sales)} hint={`${tr('vs. periodo anterior', 'vs. previous period')}: ${delta(r.totals.sales, p?.totals.sales ?? 0)}`} />
          <StatCard icon="wallet" tone="gold" label={tr('Neto', 'Net')} value={<span data-testid="report-net">{money(r.totals.net_cents)}</span>} hint={`${tr('vs. periodo anterior', 'vs. previous period')}: ${delta(r.totals.net_cents, p?.totals.net_cents ?? 0)}`} />
          <StatCard icon="chart" label={tr('Impuestos cobrados', 'Tax collected')} value={money(r.totals.tax_cents - r.totals.refunded_tax_cents)} hint={tr('Menos impuesto devuelto', 'Less refunded tax')} />
          <StatCard icon="alert" tone="warning" label={tr('Devoluciones / anuladas', 'Refunds / voided')} value={`${r.totals.refunds} / ${r.totals.voided}`} hint={money(r.totals.refunded_cents)} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {T(tr('Ventas diarias', 'Daily sales'), [tr('Día', 'Day'), tr('Ventas', 'Sales'), tr('Descuentos', 'Discounts'), tr('Total', 'Total')], r.daily.map((d) => [f.date(d.day), d.sales, money(d.discount_cents), money(d.total_cents)]), 'report-daily')}
          {T(tr('Por sucursal', 'By branch'), [tr('Sucursal', 'Branch'), tr('Ventas', 'Sales'), tr('Total', 'Total')], r.by_branch.map((b) => [bn.get(b.branch_id) ?? '—', b.sales, money(b.total_cents)]), 'report-branch')}
          {T(tr('Por cajero', 'By cashier'), [tr('Cajero', 'Cashier'), tr('Ventas', 'Sales'), tr('Descuentos', 'Discounts'), tr('Total', 'Total')], r.by_cashier.map((c) => [c.cashier_id ? names.get(c.cashier_id) ?? c.cashier_id.slice(0, 8) : c.cashier_ref ?? tr('Externo', 'External'), c.sales, money(c.discount_cents), money(c.total_cents)]), 'report-cashier')}
          {T(tr('Productos más vendidos', 'Top products'), [tr('Producto', 'Product'), tr('Cantidad', 'Qty'), tr('Neto', 'Net')], r.top_products.map((x) => [x.name, Number(x.qty), money(x.net_cents)]), 'report-products')}
          {T(tr('Métodos de pago', 'Payment methods'), [tr('Método', 'Method'), tr('Pagos', 'Payments'), tr('Cobrado', 'Collected'), tr('Devuelto', 'Refunded')], r.payment_methods.map((m) => [methodLabel(m.method, locale), m.count, money(m.amount_cents), money(m.refunded_cents)]), 'report-methods')}
          {T(tr('Impuestos', 'Taxes'), [tr('Impuesto', 'Tax'), tr('Base', 'Base'), tr('Impuesto', 'Tax')], r.taxes.map((x) => [`${x.tax_name ?? tr('Sin nombre', 'Unnamed')} (${Number(x.tax_rate)}%)`, money(x.taxable_cents), money(x.tax_cents)]), 'report-taxes')}
          {T(tr('Descuentos', 'Discounts'), [tr('Venta', 'Sale'), tr('Motivo', 'Reason'), tr('Descuento', 'Discount')], r.discounts.map((d) => [d.number, d.reason ?? '—', money(d.discount_cents)]), 'report-discounts')}
          {T(tr('Devoluciones', 'Refunds'), [tr('Devolución', 'Refund'), tr('Método', 'Method'), tr('Importe', 'Amount')], r.refunds.map((x) => [`${x.number} · ${x.reason}`, methodLabel(x.method, locale), money(x.amount_cents)]), 'report-refunds')}
          {T(tr('Diferencias de caja', 'Cash differences'), [tr('Turno', 'Shift'), tr('Estado', 'Status'), tr('Diferencia', 'Difference')], r.cash_differences.map((x) => [x.number, posStatus(x.status, locale), money(x.difference_cents)]), 'report-cash')}
          <section className="card space-y-2 p-4 text-sm" data-testid="report-sync"><h2 className="font-semibold text-fg">{tr('Sincronización y conciliación', 'Sync and reconciliation')}</h2>
            <p>{tr('Ventas externas por revisar', 'External sales to review')}: <strong>{r.sync.needs_review}</strong> · {tr('con error', 'failed')}: <strong>{r.sync.failed}</strong> · {tr('inventario bloqueado', 'stock blocked')}: <strong>{r.sync.inventory_blocked}</strong></p>
            <p>{tr('Tarjeta capturada', 'Card captured')}: <strong>{money(r.settlements.card_captured_cents)}</strong> · {tr('liquidado por el procesador', 'settled by the processor')}: <strong>{money(r.settlements.settled_cents)}</strong> · {tr('depositado y conciliado', 'deposited and reconciled')}: <strong>{money(r.settlements.deposited_cents)}</strong> · {tr('liquidaciones sin depósito', 'payouts without deposit')}: <strong>{r.settlements.pending_deposit}</strong></p>
          </section>
        </div>
      </>)}
    </div>
  )
}

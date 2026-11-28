import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { isoDay } from '@/lib/finance/ledger'
import { sumCents, toCents } from '@/lib/finance/money'

export const dynamic = 'force-dynamic'

type Row = { key: string; label: string; bills: number; total_cents: number; paid_cents: number | null }
type Integrity = { payable_cents: number; open_bills_cents: number; posted_bill_cents: number; approved_bills_cents: number; unposted_bills: number }

/** Expenses by category, vendor and month (approved, not voided), reconciled with the ledger. */
export default async function PayablesReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const p = await searchParams
  const { tr, f, money, today, supabase, companyId, access } = await payablesPage()
  if (!access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const from = isoDay(p.from) ?? `${today.slice(0, 4)}-01-01`
  const to = isoDay(p.to) ?? today
  const report = (dim: string) => supabase.rpc('payables_report', { target: companyId, from_date: from, to_date: to, dim })
  const [cat, ven, mon, integ] = await Promise.all([report('category'), report('vendor'), report('month'), supabase.rpc('payables_integrity', { target: companyId })])
  const byCat = (cat.data ?? []) as Row[]
  const byVendor = (ven.data ?? []) as Row[]
  const byMonth = ((mon.data ?? []) as Row[]).sort((a, b) => a.key.localeCompare(b.key))
  const i = ((integ.data ?? []) as Integrity[])[0]
  const total = sumCents(byCat.map((r) => r.total_cents))
  const ok = i && toCents(i.payable_cents) === toCents(i.open_bills_cents) && toCents(i.posted_bill_cents) === toCents(i.approved_bills_cents) && Number(i.unposted_bills) === 0
  const table = (title: string, rows: Row[], label: (r: Row) => string, paid: boolean) => (
    <section className="card overflow-hidden">
      <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{title}</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-2"> </th><th className="px-5 py-2 text-right">{tr('Facturas', 'Bills')}</th>
          <th className="px-5 py-2 text-right">{tr('Total', 'Total')}</th>{paid && <th className="px-5 py-2 text-right">{tr('Pagado', 'Paid')}</th>}</tr></thead>
        <tbody className="divide-y divide-line/60">
          {rows.map((r) => <tr key={r.key}><td className="px-5 py-2 text-fg">{label(r)}</td><td className="px-5 py-2 text-right tabular-nums">{r.bills}</td>
            <td className="px-5 py-2 text-right tabular-nums">{money(r.total_cents)}</td>{paid && <td className="px-5 py-2 text-right tabular-nums">{money(r.paid_cents ?? 0)}</td>}</tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="px-5 py-4 text-muted">{tr('Sin gastos aprobados en el periodo.', 'No approved expenses in the period.')}</td></tr>}
        </tbody>
        <tfoot className="border-t border-line font-semibold"><tr><td className="px-5 py-2">{tr('Total', 'Total')}</td><td /><td className="px-5 py-2 text-right tabular-nums">{money(sumCents(rows.map((r) => r.total_cents)))}</td>{paid && <td className="px-5 py-2 text-right tabular-nums">{money(sumCents(rows.map((r) => r.paid_cents ?? 0)))}</td>}</tr></tfoot>
      </table></div>
    </section>
  )
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Informes de gastos', 'Expense reports')}
        description={tr(`Gastos aprobados del ${f.date(from)} al ${f.date(to)} (fecha del gasto). Borradores, pendientes y anulados no cuentan.`,
          `Approved expenses from ${f.date(from)} to ${f.date(to)} (expense date). Drafts, pending and voided do not count.`)}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <PayablesNav tr={tr} current="/payables/reports" full />
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end print:hidden">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <button type="submit" className="btn-secondary">{tr('Ver', 'Show')}</button>
      </form>
      <p className="text-sm text-muted">{tr('Total del periodo:', 'Period total:')} <span className="font-semibold text-fg">{money(total)}</span></p>
      {table(tr('Por categoría', 'By category'), byCat, (r) => r.label, false)}
      {table(tr('Por proveedor', 'By vendor'), byVendor, (r) => r.label, true)}
      {table(tr('Por mes', 'By month'), byMonth, (r) => f.monthLong(r.key), true)}
      {i && (
        <section className={`card p-5 text-sm ${ok ? 'text-green-300' : 'text-amber-300'}`}>
          <p>{ok ? '✓ ' : '! '}{tr(`Cuentas por pagar en el libro mayor (${money(i.payable_cents)}) = saldo de los gastos aprobados (${money(i.open_bills_cents)}).`,
            `Accounts payable in the ledger (${money(i.payable_cents)}) = balance of the approved expenses (${money(i.open_bills_cents)}).`)}</p>
          <p>{ok ? '✓ ' : '! '}{tr(`Gasto registrado en el libro (${money(i.posted_bill_cents)}) = total de gastos aprobados (${money(i.approved_bills_cents)}), en todas las fechas.`,
            `Expense posted in the ledger (${money(i.posted_bill_cents)}) = total of approved expenses (${money(i.approved_bills_cents)}), all dates.`)}</p>
        </section>
      )}
    </div>
  )
}

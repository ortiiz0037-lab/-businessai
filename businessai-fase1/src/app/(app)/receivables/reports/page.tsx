import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { isoDay } from '@/lib/finance/ledger'
import { sumCents, toCents } from '@/lib/finance/money'

export const dynamic = 'force-dynamic'

type Row = { client_id: string | null; client_name: string; opening_cents: number; invoiced_cents: number; collected_cents: number; payments_voided_cents: number; invoices_voided_cents: number; closing_cents: number }

/** Receivables by client and period: opening + invoiced − collected + voided payments − voided invoices = closing. */
export default async function ReceivablesReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams
  const { tr, f, money, today, supabase, companyId, access } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  const from = isoDay(sp.from) ?? `${today.slice(0, 8)}01`
  const to = isoDay(sp.to) ?? today
  const { data } = await supabase.rpc('ar_client_report', { target: companyId, from_date: from, to_date: to })
  const rows = (data ?? []) as Row[]
  const cols: [keyof Row, string][] = [['opening_cents', tr('Saldo inicial', 'Opening')], ['invoiced_cents', tr('Facturado', 'Invoiced')], ['collected_cents', tr('Cobrado', 'Collected')],
    ['payments_voided_cents', tr('Pagos anulados', 'Voided payments')], ['invoices_voided_cents', tr('Facturas anuladas', 'Voided invoices')], ['closing_cents', tr('Saldo final', 'Closing')]]
  const ok = rows.every((r) => toCents(r.opening_cents) + toCents(r.invoiced_cents) - toCents(r.collected_cents) + toCents(r.payments_voided_cents) - toCents(r.invoices_voided_cents) === toCents(r.closing_cents))
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Cuentas por cobrar', 'Receivables')} title={tr('Informe por cliente y periodo', 'Report by client and period')}
        description={tr(`Del ${f.date(from)} al ${f.date(to)}.`, `From ${f.date(from)} to ${f.date(to)}.`)} actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <ReceivablesNav tr={tr} current="/receivables/reports" />
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end print:hidden">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} max={today} className="field" /></label>
        <button type="submit" className="btn-secondary">{tr('Ver', 'Show')}</button>
      </form>
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">{tr('Cliente', 'Client')}</th>{cols.map(([k, l]) => <th key={k} className="px-4 py-3 text-right">{l}</th>)}</tr></thead>
            <tbody className="divide-y divide-line/60">
              {rows.map((r) => (
                <tr key={r.client_id ?? 'none'}>
                  <td className="px-4 py-2 text-fg">{r.client_id ? <Link href={`/receivables/clients/${r.client_id}`} className="hover:text-accent">{r.client_name}</Link> : tr('Sin cliente', 'No client')}</td>
                  {cols.map(([k]) => <td key={k} className={`px-4 py-2 text-right tabular-nums ${k === 'closing_cents' ? 'font-semibold' : ''}`}>{money(r[k] as number)}</td>)}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-muted">{tr('Sin movimientos en el periodo.', 'No activity in the period.')}</td></tr>}
            </tbody>
            <tfoot className="border-t-2 border-line font-bold"><tr><td className="px-4 py-3">{tr('Totales', 'Totals')}</td>{cols.map(([k]) => <td key={k} className="px-4 py-3 text-right tabular-nums">{money(sumCents(rows.map((r) => r[k] as number)))}</td>)}</tr></tfoot>
          </table>
        </div>
        <p className={`border-t border-line p-4 text-sm ${ok ? 'text-green-300' : 'text-amber-300'}`}>{ok ? '✓ ' : '! '}{tr('Saldo inicial + facturado − cobrado + pagos anulados − facturas anuladas = saldo final, en cada cliente.', 'Opening + invoiced − collected + voided payments − voided invoices = closing, for every client.')}</p>
      </section>
    </div>
  )
}

import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { bucketLabel, type AgingRow } from '@/lib/finance/receivables'
import { isoDay } from '@/lib/finance/ledger'
import { sumCents } from '@/lib/finance/money'

export const dynamic = 'force-dynamic'

/** Aging by client as of a date; clients with overdue balances first. */
export default async function AgingPage({ searchParams }: { searchParams: Promise<{ as_of?: string; overdue?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  const asOf = isoDay(sp.as_of) ?? today
  const onlyOverdue = sp.overdue === '1'
  const [{ data }, { data: ledger }] = await Promise.all([
    supabase.rpc('ar_aging', { target: companyId, as_of: asOf }),
    asOf === today ? supabase.rpc('ledger_integrity', { target: companyId }) : Promise.resolve({ data: null }),
  ])
  const all = (data ?? []) as AgingRow[]
  const rows = onlyOverdue ? all.filter((r) => Number(r.overdue_cents) > 0) : all
  const total = (k: keyof AgingRow) => money(sumCents(rows.map((r) => r[k] as number)))
  const integ = ((ledger ?? []) as { receivable_cents: number }[])[0]
  const allTotal = sumCents(all.map((r) => r.total_cents))
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Cuentas por cobrar', 'Receivables')} title={tr('Antigüedad de saldos', 'Accounts receivable aging')}
        description={tr(`Al ${f.date(asOf)}. Días desde el vencimiento; 0–30 incluye lo que aún no vence.`, `As of ${f.date(asOf)}. Days since due date; 0–30 includes what is not due yet.`)}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <ReceivablesNav tr={tr} current="/receivables/aging" />
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end print:hidden">
        <label className="text-sm"><span className="field-label">{tr('Al día', 'As of')}</span><input type="date" name="as_of" defaultValue={asOf} max={today} className="field" /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="overdue" value="1" defaultChecked={onlyOverdue} /> {tr('Solo clientes con balances vencidos', 'Only clients with overdue balances')}</label>
        <button type="submit" className="btn-secondary">{tr('Ver', 'Show')}</button>
      </form>
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-3">{tr('Cliente', 'Client')}</th>
                {(['0_30', '31_60', '61_90', '90_plus'] as const).map((b) => <th key={b} className="px-4 py-3 text-right">{bucketLabel(b, locale)}</th>)}
                <th className="px-4 py-3 text-right">{tr('Total', 'Total')}</th><th className="px-4 py-3 text-right">{tr('Vencido', 'Overdue')}</th></tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {rows.map((r) => (
                <tr key={r.client_id ?? 'none'}>
                  <td className="px-4 py-2 text-fg">{r.client_id ? <Link href={`/receivables/clients/${r.client_id}`} className="hover:text-accent">{r.client_name}</Link> : tr('Sin cliente', 'No client')}
                    <span className="block text-xs text-muted">{tr(`${r.invoices} facturas`, `${r.invoices} invoices`)}{r.oldest_days > 0 ? ` · ${tr(`${r.oldest_days} días`, `${r.oldest_days} days`)}` : ''}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.b0_30) ? money(r.b0_30) : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-300">{Number(r.b31_60) ? money(r.b31_60) : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-orange-300">{Number(r.b61_90) ? money(r.b61_90) : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-300">{Number(r.b90_plus) ? money(r.b90_plus) : ''}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{money(r.total_cents)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.overdue_cents) ? money(r.overdue_cents) : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-muted">{tr('Sin balances pendientes.', 'No open balances.')}</td></tr>}
            </tbody>
            <tfoot className="border-t-2 border-line font-bold">
              <tr><td className="px-4 py-3">{tr('Totales', 'Totals')}</td><td className="px-4 py-3 text-right tabular-nums">{total('b0_30')}</td><td className="px-4 py-3 text-right tabular-nums">{total('b31_60')}</td>
                <td className="px-4 py-3 text-right tabular-nums">{total('b61_90')}</td><td className="px-4 py-3 text-right tabular-nums">{total('b90_plus')}</td>
                <td className="px-4 py-3 text-right tabular-nums">{total('total_cents')}</td><td className="px-4 py-3 text-right tabular-nums">{total('overdue_cents')}</td></tr>
            </tfoot>
          </table>
        </div>
        {integ && !onlyOverdue && (
          <p className={`border-t border-line p-4 text-sm ${BigInt(integ.receivable_cents) === allTotal ? 'text-green-300' : 'text-amber-300'}`}>
            {BigInt(integ.receivable_cents) === allTotal ? '✓ ' : '! '}{tr(`Cuentas por cobrar en el libro mayor: ${money(integ.receivable_cents)}.`, `Accounts receivable in the ledger: ${money(integ.receivable_cents)}.`)}
            {BigInt(integ.receivable_cents) !== allTotal && ` ${tr('Hay facturas o pagos anteriores a la contabilidad sin importar.', 'There are invoices or payments from before accounting not imported yet.')}`}
          </p>
        )}
      </section>
    </div>
  )
}

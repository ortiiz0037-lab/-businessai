import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { FinanceNav, NoFinanceAccess, PeriodForm, QualityBanner, ReportMeta } from '@/components/finance-nav'
import { StatementTable } from '@/components/statement-table'
import { financePage, loadCashFlow, loadQuality, periodName, readPeriod } from '@/lib/finance/finance-page'
import { cashFlowLines } from '@/lib/finance/statement-layout'
import { cashFlowTotals, qualityNotes } from '@/lib/finance/statements'

export const dynamic = 'force-dynamic'

/** Cash flow statement, indirect method, from the ledger movements of the period. */
export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ period?: string; ref?: string; from?: string; to?: string; compare?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access, currency, companyName } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const p = readPeriod(sp, today)
  const [cur, base, quality] = await Promise.all([
    loadCashFlow(supabase, companyId, p.range),
    p.base ? loadCashFlow(supabase, companyId, p.base) : Promise.resolve(null),
    loadQuality(supabase, companyId, p.range),
  ])
  const totals = cashFlowTotals(cur.rows)
  const q = qualityNotes(quality, locale)
  if (!cur.rows.some((r) => r.section === 'non_cash')) q.notes.push({ code: 'no_depreciation', blocking: false,
    text: tr('No hay depreciación registrada: no se agrega ningún ajuste no monetario (BusinessAI no la estima).', 'No depreciation is recorded: no non-cash adjustment is added (BusinessAI does not estimate it).') })
  const qs = new URLSearchParams({ report: 'cashflow', period: p.kind, ref: p.ref, from: p.range.from, to: p.range.to, compare: p.compare }).toString()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Flujo de efectivo', 'Cash flow')}
        description={tr('Método indirecto: parte del resultado neto y lo ajusta por los cambios en las demás cuentas del balance.',
          'Indirect method: starts from the net result and adjusts it for the changes in the other balance-sheet accounts.')}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <FinanceNav tr={tr} current="/finance/cash-flow" />
      <PeriodForm tr={tr} action="/finance/cash-flow" kind={p.kind} refDate={p.ref} from={p.range.from} to={p.range.to} compare={p.compare} />
      <ReportMeta tr={tr} company={companyName} period={`${periodName(p.kind, p.range, f, locale)} (${f.date(p.range.from)} – ${f.date(p.range.to)})`} currency={currency}
        generated={f.dateTime(new Date().toISOString())} final={q.final && totals.reconciles} />
      <div role="status" className={totals.reconciles ? 'alert-success p-4' : 'alert-danger p-4'}>
        {totals.reconciles ? tr(`Cuadra con el efectivo: ${money(totals.opening)} + ${money(totals.netChange)} = ${money(totals.closing)}.`, `Matches cash: ${money(totals.opening)} + ${money(totals.netChange)} = ${money(totals.closing)}.`)
          : tr(`No cuadra con el cambio de efectivo (${money(totals.closing - totals.opening)}).`, `Does not match the change in cash (${money(totals.closing - totals.opening)}).`)}
      </div>
      <QualityBanner tr={tr} notes={q.notes} />
      {cur.error ? <div role="alert" className="alert-danger p-4">{tr('No se pudo calcular el flujo de efectivo.', 'Could not compute the cash flow.')}</div>
        : <StatementTable tr={tr} lines={cashFlowLines(cur.rows, base?.rows ?? null, locale)} money={money} curLabel={periodName(p.kind, p.range, f, locale)}
            baseLabel={p.base ? periodName(p.kind, p.base, f, locale) : null} ledgerFrom={p.range.from} ledgerTo={p.range.to} />}
      <div className="flex flex-wrap gap-2 print:hidden">
        <Link href={`/finance/export?${qs}&format=xlsx`} className="btn-secondary btn-sm">Excel</Link>
        <Link href={`/finance/export?${qs}&format=csv`} className="btn-secondary btn-sm">CSV</Link>
      </div>
    </div>
  )
}

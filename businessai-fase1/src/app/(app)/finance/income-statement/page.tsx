import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { FinanceNav, NoFinanceAccess, PeriodForm, QualityBanner, ReportMeta } from '@/components/finance-nav'
import { StatementTable } from '@/components/statement-table'
import { financePage, loadIncome, loadQuality, periodName, readPeriod } from '@/lib/finance/finance-page'
import { incomeLines } from '@/lib/finance/statement-layout'
import { incomeTotals, qualityNotes } from '@/lib/finance/statements'

export const dynamic = 'force-dynamic'

type SP = { period?: string; ref?: string; from?: string; to?: string; compare?: string }

/** Income statement for a period, compared with the previous period or the same period last year. */
export default async function IncomeStatementPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access, currency, companyName } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const p = readPeriod(sp, today)
  const [cur, base, quality] = await Promise.all([
    loadIncome(supabase, companyId, p.range),
    p.base ? loadIncome(supabase, companyId, p.base) : Promise.resolve(null),
    loadQuality(supabase, companyId, p.range),
  ])
  const totals = incomeTotals(cur.rows)
  const q = qualityNotes(quality, locale)
  if (!totals.taxRecorded) q.notes.push({ code: 'no_tax', blocking: false, text: tr('No hay gasto de impuesto sobre ingresos registrado: el resultado neto es antes de impuestos. BusinessAI no calcula impuestos.',
    'No income-tax expense is recorded: the net result is before taxes. BusinessAI does not calculate taxes.') })
  const lines = incomeLines(cur.rows, base?.rows ?? null, locale)
  const qs = new URLSearchParams({ report: 'income', period: p.kind, ref: p.ref, from: p.range.from, to: p.range.to, compare: p.compare }).toString()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Estado de resultados', 'Income statement')}
        description={tr('Ingresos, costos y gastos del periodo, calculados desde los asientos contabilizados del libro mayor.',
          'Revenue, costs and expenses of the period, computed from the posted ledger entries.')}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <FinanceNav tr={tr} current="/finance/income-statement" />
      <PeriodForm tr={tr} action="/finance/income-statement" kind={p.kind} refDate={p.ref} from={p.range.from} to={p.range.to} compare={p.compare} />
      <ReportMeta tr={tr} company={companyName} period={`${periodName(p.kind, p.range, f, locale)} (${f.date(p.range.from)} – ${f.date(p.range.to)})`} currency={currency}
        generated={f.dateTime(new Date().toISOString())} final={q.final} />
      <QualityBanner tr={tr} notes={q.notes} />
      {cur.error ? <div role="alert" className="alert-danger p-4">{tr('No se pudo calcular el estado de resultados.', 'Could not compute the income statement.')}</div>
        : <StatementTable tr={tr} lines={lines} money={money} curLabel={periodName(p.kind, p.range, f, locale)} baseLabel={p.base ? periodName(p.kind, p.base, f, locale) : null}
            ledgerFrom={p.range.from} ledgerTo={p.range.to} />}
      <div className="flex flex-wrap gap-2 print:hidden">
        <Link href={`/finance/export?${qs}&format=xlsx`} className="btn-secondary btn-sm">Excel</Link>
        <Link href={`/finance/export?${qs}&format=csv`} className="btn-secondary btn-sm">CSV</Link>
        <Link href={`/accounting/trial-balance?as_of=${p.range.to}`} className="btn-secondary btn-sm">{tr('Balanza de comprobación', 'Trial balance')}</Link>
      </div>
    </div>
  )
}

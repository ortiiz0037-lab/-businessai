import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { FinanceNav, NoFinanceAccess, QualityBanner, ReportMeta } from '@/components/finance-nav'
import { StatementTable } from '@/components/statement-table'
import { financePage, loadBalance, loadQuality } from '@/lib/finance/finance-page'
import { balanceLines } from '@/lib/finance/statement-layout'
import { balanceTotals, previousYearRange, qualityNotes } from '@/lib/finance/statements'

export const dynamic = 'force-dynamic'
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Balance sheet at a date: assets = liabilities + equity, with the check shown. */
export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ as_of?: string; compare?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access, currency, companyName } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const asOf = sp.as_of && DAY.test(sp.as_of) ? sp.as_of : today
  const compareTo = sp.compare === 'none' ? null : sp.compare && DAY.test(sp.compare) ? sp.compare : previousYearRange({ from: asOf, to: asOf }).to
  const [cur, base, quality] = await Promise.all([
    loadBalance(supabase, companyId, asOf),
    compareTo ? loadBalance(supabase, companyId, compareTo) : Promise.resolve(null),
    loadQuality(supabase, companyId, { from: `${asOf.slice(0, 4)}-01-01`, to: asOf }),
  ])
  const totals = balanceTotals(cur.rows)
  const q = qualityNotes(quality, locale, { balanced: totals.balanced })
  q.notes.push({ code: 'no_year_close', blocking: false, text: tr('Los resultados de años anteriores se muestran calculados: no hay asiento de cierre anual.',
    'Prior years’ results are shown computed: there is no year-end closing entry.') })
  const qs = new URLSearchParams({ report: 'balance', as_of: asOf, ...(compareTo ? { compare: compareTo } : { compare: 'none' }) }).toString()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Balance general', 'Balance sheet')}
        description={tr('Activos, pasivos y patrimonio a una fecha. Debe cuadrar: activos = pasivos + patrimonio.', 'Assets, liabilities and equity at a date. It must balance: assets = liabilities + equity.')}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <FinanceNav tr={tr} current="/finance/balance-sheet" />
      <form action="/finance/balance-sheet" className="card grid gap-3 p-4 print:hidden sm:grid-cols-3 sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Al', 'As of')}</span><input type="date" name="as_of" defaultValue={asOf} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Comparar con la fecha', 'Compare with date')}</span><input type="date" name="compare" defaultValue={compareTo ?? ''} className="field" /></label>
        <button type="submit" className="btn-primary">{tr('Ver', 'View')}</button>
      </form>
      <ReportMeta tr={tr} company={companyName} period={`${tr('Al', 'As of')} ${f.date(asOf)}`} currency={currency} generated={f.dateTime(new Date().toISOString())} final={q.final} />
      <div role="status" className={totals.balanced ? 'alert-success p-4' : 'alert-danger p-4'}>
        {totals.empty ? tr('No hay saldos a esta fecha.', 'There are no balances at this date.')
          : totals.balanced ? tr(`Cuadra: activos ${money(totals.totalAssets)} = pasivos + patrimonio ${money(totals.totalLiabilitiesEquity)}.`, `Balanced: assets ${money(totals.totalAssets)} = liabilities + equity ${money(totals.totalLiabilitiesEquity)}.`)
            : tr(`No cuadra: diferencia ${money(totals.difference)}. Este balance no es definitivo.`, `Does not balance: difference ${money(totals.difference)}. This balance sheet is not final.`)}
      </div>
      <QualityBanner tr={tr} notes={q.notes} />
      {cur.error ? <div role="alert" className="alert-danger p-4">{tr('No se pudo calcular el balance.', 'Could not compute the balance sheet.')}</div>
        : <StatementTable tr={tr} lines={balanceLines(cur.rows, base?.rows ?? null, locale)} money={money} curLabel={f.date(asOf)} baseLabel={compareTo ? f.date(compareTo) : null}
            ledgerFrom={`${asOf.slice(0, 4)}-01-01`} ledgerTo={asOf} />}
      <div className="flex flex-wrap gap-2 print:hidden">
        <Link href={`/finance/export?${qs}&format=xlsx`} className="btn-secondary btn-sm">Excel</Link>
        <Link href={`/finance/export?${qs}&format=csv`} className="btn-secondary btn-sm">CSV</Link>
        <Link href={`/accounting/trial-balance?as_of=${asOf}`} className="btn-secondary btn-sm">{tr('Balanza de comprobación', 'Trial balance')}</Link>
      </div>
    </div>
  )
}

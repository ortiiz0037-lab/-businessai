import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import PrintButton from '@/components/PrintButton'
import { AccountingNav, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { ACCOUNT_TYPES, accountName, accountTypePlural, isoDay } from '@/lib/finance/ledger'
import { sumCents, toCents } from '@/lib/finance/money'

export const dynamic = 'force-dynamic'

type TB = { account_id: string; code: string; name: string; name_en: string | null; type: string; status: string; debit_cents: number; credit_cents: number; balance_cents: number }

/** Trial balance at a date: debit and credit balance of each account; totals must match. */
export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const asOf = isoDay(p.as_of) ?? today
  const { data } = await supabase.rpc('ledger_trial_balance', { target: companyId, as_of: asOf })
  const rows = (data ?? []) as TB[]
  // Debit-side and credit-side balance of each account (net of its movements).
  const side = (r: TB) => {
    const net = toCents(r.debit_cents) - toCents(r.credit_cents)
    return { dr: net > 0n ? net : 0n, cr: net < 0n ? -net : 0n }
  }
  const totalDr = sumCents(rows.map((r) => side(r).dr))
  const totalCr = sumCents(rows.map((r) => side(r).cr))
  const balanced = totalDr === totalCr

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Balance de comprobación', 'Trial balance')}
        description={tr(`Saldos de todas las cuentas al ${f.date(asOf)}. La suma de saldos deudores debe ser igual a la de saldos acreedores.`,
          `Balances of every account as of ${f.date(asOf)}. Total debit balances must equal total credit balances.`)}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <AccountingNav tr={tr} current="/accounting/trial-balance" />
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end print:hidden">
        <label className="text-sm"><span className="field-label">{tr('Al día', 'As of')}</span><input type="date" name="as_of" defaultValue={asOf} className="field" /></label>
        <button type="submit" className="btn-secondary">{tr('Ver', 'Show')}</button>
      </form>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-3">{tr('Cuenta', 'Account')}</th><th className="px-4 py-3 text-right">{tr('Saldo deudor', 'Debit balance')}</th><th className="px-4 py-3 text-right">{tr('Saldo acreedor', 'Credit balance')}</th></tr>
            </thead>
            {ACCOUNT_TYPES.map((t) => {
              const group = rows.filter((r) => r.type === t)
              if (group.length === 0) return null
              return (
                <tbody key={t} className="divide-y divide-line/60">
                  <tr><th colSpan={3} className="bg-white/[0.03] px-4 py-2 text-left text-xs font-bold uppercase tracking-wide text-accent">{accountTypePlural(t, locale)}</th></tr>
                  {group.map((r) => {
                    const s = side(r)
                    return (
                      <tr key={r.account_id}>
                        <td className="px-4 py-2 text-fg"><Link href={`/accounting/ledger?account=${r.account_id}&to=${asOf}`} className="hover:text-accent">{r.code} · {accountName(r, locale)}</Link>
                          {r.status === 'archived' && <span className="ml-2 text-xs text-muted">({tr('archivada', 'archived')})</span>}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.dr > 0n ? money(s.dr) : ''}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.cr > 0n ? money(s.cr) : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              )
            })}
            <tfoot className="border-t-2 border-line font-bold">
              <tr><td className="px-4 py-3 text-fg">{tr('Totales', 'Totals')}</td><td className="px-4 py-3 text-right tabular-nums">{money(totalDr)}</td><td className="px-4 py-3 text-right tabular-nums">{money(totalCr)}</td></tr>
            </tfoot>
          </table>
        </div>
        <p className={`border-t border-line p-4 text-sm font-semibold ${balanced ? 'text-green-300' : 'text-red-300'}`}>
          {balanced ? tr('✓ Cuadrado: saldos deudores = saldos acreedores.', '✓ Balanced: debit balances = credit balances.')
            : tr(`Diferencia de ${money(totalDr - totalCr)}: revisa la integridad del libro.`, `Difference of ${money(totalDr - totalCr)}: check the ledger integrity.`)}
        </p>
      </section>
      <p className="text-xs text-muted">{tr('Los ingresos y gastos aparecen acumulados: el cierre anual a utilidades retenidas llegará con los estados financieros.',
        'Revenue and expenses appear accumulated: the year-end close to retained earnings will come with the financial statements.')}</p>
    </div>
  )
}

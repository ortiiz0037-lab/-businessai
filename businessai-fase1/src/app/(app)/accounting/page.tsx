import Link from 'next/link'
import { PageHeader, StatCard } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AccountingNav, Flash, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { accountName, ledgerMessage, sourceLabel, type EntryRow } from '@/lib/finance/ledger'
import { toCents } from '@/lib/finance/money'
import { importHistory, initLedger } from '@/app/actions/accounting'

export const dynamic = 'force-dynamic'

type Integrity = { debit_cents: number; credit_cents: number; unbalanced_entries: number; receivable_cents: number; open_invoices_cents: number; unposted_invoices: number; unposted_payments: number }
type TB = { account_id: string; code: string; name: string; name_en: string | null; type: string; balance_cents: number }

/** Accounting overview: the three money questions kept apart, integrity, latest entries. */
export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; n?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  // getLocale() is called by accountingPage(); translator( too.
  const done: Record<string, string> = {
    initialized: tr('Contabilidad activada con el catálogo predeterminado.', 'Accounting activated with the default chart.'),
    imported: tr(`Historial importado: ${params.n ?? 0} asientos con sus fechas reales.`, `History imported: ${params.n ?? 0} entries with their real dates.`),
  }

  if (!access.initialized) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Contabilidad', 'Accounting')} />
        <Flash done={params.done ? done[params.done] : null} error={ledgerMessage(params.error, locale)} />
        <section className="card max-w-2xl space-y-4 p-6">
          <h2 className="font-display text-xl font-semibold text-fg">{tr('Contabilidad de doble entrada', 'Double-entry accounting')}</h2>
          <p className="text-sm leading-6 text-muted">
            {tr('Al activarla se crea un catálogo de cuentas predeterminado (que puedes ampliar). Desde entonces, cada factura emitida, pago recibido y anulación se registra automáticamente en el libro diario. Los borradores no generan asientos. Los documentos anteriores solo se registran si los importas.',
              'Activating it creates a default chart of accounts (which you can extend). From then on, every issued invoice, received payment and void is posted to the journal automatically. Drafts post nothing. Earlier documents are posted only if you import them.')}
          </p>
          {access.manage
            ? <form action={initLedger}><SubmitButton className="w-full sm:w-auto">{tr('Activar contabilidad', 'Activate accounting')}</SubmitButton></form>
            : <p className="text-sm text-muted">{tr('Pide al propietario o a un administrador que la active.', 'Ask the owner or an admin to activate it.')}</p>}
        </section>
      </div>
    )
  }

  const [{ data: integ }, { data: tbData }, { data: sys }, { data: recent }] = await Promise.all([
    supabase.rpc('ledger_integrity', { target: companyId }).maybeSingle(),
    supabase.rpc('ledger_trial_balance', { target: companyId }),
    supabase.from('ledger_accounts').select('id, system_key').eq('company_id', companyId).not('system_key', 'is', null),
    supabase.from('journal_entries').select('id, entry_number, entry_date, description, reference, source, total_cents, reverses_entry_id')
      .eq('company_id', companyId).order('entry_number', { ascending: false }).limit(8),
  ])
  const i = (integ ?? null) as Integrity | null
  const tb = (tbData ?? []) as TB[]
  const idOf = (key: string) => ((sys ?? []) as { id: string; system_key: string }[]).find((a) => a.system_key === key)?.id
  const bal = (key: string) => toCents(tb.find((r) => r.account_id === idOf(key))?.balance_cents ?? 0)
  const revenue = tb.filter((r) => r.type === 'revenue').reduce((s, r) => s + toCents(r.balance_cents), 0n)
  const expenses = tb.filter((r) => r.type === 'expense').reduce((s, r) => s + toCents(r.balance_cents), 0n)
  const balanced = i ? toCents(i.debit_cents) === toCents(i.credit_cents) && Number(i.unbalanced_entries) === 0 : false
  const arMatches = i ? toCents(i.receivable_cents) === toCents(i.open_invoices_cents) : false
  const unposted = i ? Number(i.unposted_invoices) + Number(i.unposted_payments) : 0
  const entries = (recent ?? []) as Pick<EntryRow, 'id' | 'entry_number' | 'entry_date' | 'description' | 'reference' | 'source' | 'total_cents' | 'reverses_entry_id'>[]
  const cashAccount = tb.find((r) => r.account_id === idOf('cash'))

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Contabilidad', 'Accounting')}
        description={tr('Libro de doble entrada en centavos exactos. Los asientos publicados no se modifican: se corrigen con reversiones.',
          'Double-entry ledger in exact cents. Posted entries are never modified: they are corrected with reversals.')}
        actions={access.post ? <Link href="/accounting/journal/new" className="btn-primary">{tr('Nuevo asiento', 'New entry')}</Link> : undefined} />
      <AccountingNav tr={tr} current="/accounting" />
      <Flash done={params.done ? done[params.done] : null} error={ledgerMessage(params.error, locale)} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon="wallet" tone="success" label={cashAccount ? accountName(cashAccount, locale) : tr('Efectivo', 'Cash')} value={money(bal('cash'))}
          hint={tr('Efectivo recibido de clientes (pagos registrados).', 'Cash received from clients (recorded payments).')} />
        <StatCard icon="chart" tone="gold" label={tr('Ingresos reconocidos', 'Recognised revenue')} value={money(revenue)}
          hint={tr('Se reconocen al emitir la factura, no al cobrarla.', 'Recognised when the invoice is issued, not when it is collected.')} />
        <StatCard icon="receipt" tone="warning" label={tr('Cuentas por cobrar', 'Accounts receivable')} value={money(bal('accounts_receivable'))}
          hint={tr('Facturado y todavía no cobrado.', 'Invoiced and not yet collected.')} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon="file" label={tr('Impuesto sobre ventas por pagar', 'Sales tax payable')} value={money(bal('sales_tax_payable'))} />
        <StatCard icon="card" label={tr('Gastos registrados', 'Recorded expenses')} value={money(expenses)} />
        <StatCard icon="shield" tone={balanced ? 'success' : 'warning'} label={tr('Cuadre del libro', 'Ledger balance')}
          value={balanced ? tr('Cuadrado', 'Balanced') : tr('Revisar', 'Review')}
          hint={i ? `${tr('Débitos', 'Debits')} ${money(i.debit_cents)} · ${tr('Créditos', 'Credits')} ${money(i.credit_cents)}` : undefined} />
      </div>

      <section className="card space-y-3 p-5" aria-labelledby="integrity-title">
        <h2 id="integrity-title" className="font-display text-lg font-semibold text-fg">{tr('Verificación', 'Verification')}</h2>
        <ul className="space-y-2 text-sm">
          <li className={balanced ? 'text-green-300' : 'text-amber-300'}>
            {balanced ? '✓ ' : '! '}{tr('Todos los asientos cuadran (débitos = créditos).', 'Every entry balances (debits = credits).')}
          </li>
          <li className={arMatches ? 'text-green-300' : 'text-amber-300'}>
            {arMatches ? '✓ ' : '! '}
            {tr(`Cuentas por cobrar (${money(i?.receivable_cents)}) = saldo abierto de las facturas registradas (${money(i?.open_invoices_cents)}).`,
              `Accounts receivable (${money(i?.receivable_cents)}) = open balance of the posted invoices (${money(i?.open_invoices_cents)}).`)}
          </li>
          <li className={unposted === 0 ? 'text-green-300' : 'text-amber-300'}>
            {unposted === 0 ? '✓ ' : '! '}
            {unposted === 0
              ? tr('Todas las facturas emitidas y los pagos están en el libro.', 'Every issued invoice and payment is in the ledger.')
              : tr(`${i?.unposted_invoices ?? 0} facturas y ${i?.unposted_payments ?? 0} pagos anteriores a la contabilidad no están en el libro.`,
                `${i?.unposted_invoices ?? 0} invoices and ${i?.unposted_payments ?? 0} payments from before accounting are not in the ledger.`)}
          </li>
        </ul>
        {unposted > 0 && access.post && (
          <form action={importHistory} className="space-y-2">
            <p className="text-xs text-muted">{tr('La importación registra solo documentos reales (facturas emitidas, pagos y anulaciones) con sus fechas reales. No inventa movimientos y se puede repetir sin duplicar. Falla si alguna fecha cae en un mes cerrado.',
              'The import posts only real documents (issued invoices, payments and voids) with their real dates. It invents no movement and can be repeated without duplicating. It fails if a date falls in a closed month.')}</p>
            <SubmitButton className="w-full sm:w-auto">{tr('Importar historial', 'Import history')}</SubmitButton>
          </form>
        )}
      </section>

      <section className="card overflow-hidden" aria-labelledby="recent-title">
        <div className="flex items-center justify-between gap-3 p-5">
          <h2 id="recent-title" className="font-display text-lg font-semibold text-fg">{tr('Últimos asientos', 'Latest entries')}</h2>
          <Link href="/accounting/journal" className="text-sm font-semibold text-accent">{tr('Ver libro diario', 'Open journal')}</Link>
        </div>
        {entries.length === 0
          ? <p className="px-5 pb-5 text-sm text-muted">{tr('Todavía no hay asientos. Se crean al emitir facturas, registrar pagos o publicar asientos manuales.', 'No entries yet. They are created when invoices are issued, payments are recorded or manual entries are posted.')}</p>
          : (
            <ul className="divide-y divide-line">
              {entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold text-fg">#{e.entry_number}</span>{' '}
                    <span className="text-muted">{f.date(e.entry_date)} · {sourceLabel(e.source, locale)}</span>
                    <span className="block truncate text-slate-300">{e.description}</span>
                  </span>
                  <span className="font-semibold tabular-nums text-fg">{money(e.total_cents)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}

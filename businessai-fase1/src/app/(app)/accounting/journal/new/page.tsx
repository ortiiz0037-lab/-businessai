import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AccountingNav, Flash, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { ACCOUNT_TYPES, accountName, accountTypePlural, ledgerMessage, type LedgerAccount } from '@/lib/finance/ledger'
import { postManualEntry } from '@/app/actions/accounting'

export const dynamic = 'force-dynamic'
const ROWS = 6

/** Manual journal entry: balanced lines in exact cents; the database checks it again. */
export default async function NewEntryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const p = await searchParams
  const { locale, tr, today, supabase, companyId, access } = await accountingPage()
  if (!access.view || !access.post) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const { data } = await supabase.from('ledger_accounts').select('id, code, name, name_en, type, status')
    .eq('company_id', companyId).eq('status', 'active').order('code')
  const accounts = (data ?? []) as LedgerAccount[]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Nuevo asiento manual', 'New manual entry')}
        description={tr('Ajustes, aportaciones del dueño, gastos pagados, préstamos… Las facturas y los pagos se registran solos: no los repitas aquí.',
          'Adjustments, owner contributions, paid expenses, loans… Invoices and payments are posted automatically: do not repeat them here.')} />
      <AccountingNav tr={tr} current="/accounting/journal" />
      <Flash error={ledgerMessage(p.error, locale)} />
      {!access.initialized
        ? <p className="card p-5 text-sm text-muted">{tr('Activa primero la contabilidad desde el resumen.', 'Activate accounting first from the overview.')} <Link href="/accounting" className="text-accent">{tr('Ir al resumen', 'Go to the overview')}</Link></p>
        : (
          <form action={postManualEntry} className="card space-y-5 p-5">
            <input type="hidden" name="idempotency_key" value={randomUUID()} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-sm"><span className="field-label">{tr('Fecha contable', 'Accounting date')}</span>
                <input type="date" name="entry_date" required defaultValue={today} className="field" /></label>
              <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Descripción', 'Description')}</span>
                <input name="description" required maxLength={300} className="field" /></label>
              <label className="text-sm"><span className="field-label">{tr('Referencia (opcional)', 'Reference (optional)')}</span>
                <input name="reference" maxLength={100} className="field" /></label>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-fg">{tr('Líneas (cada una es un débito o un crédito)', 'Lines (each one is a debit or a credit)')}</legend>
              {Array.from({ length: ROWS }, (_, i) => (
                <div key={i} className="grid gap-2 rounded-xl border border-line/70 p-3 sm:grid-cols-[2fr_1fr_1fr_2fr] sm:border-0 sm:p-0">
                  <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Cuenta', 'Account')}</span>
                    <select name={`account_${i}`} defaultValue="" className="field">
                      <option value="">—</option>
                      {ACCOUNT_TYPES.map((t) => (
                        <optgroup key={t} label={accountTypePlural(t, locale)}>
                          {accounts.filter((a) => a.type === t).map((a) => <option key={a.id} value={a.id}>{a.code} · {accountName(a, locale)}</option>)}
                        </optgroup>
                      ))}
                    </select></label>
                  <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Débito', 'Debit')}</span>
                    <input name={`debit_${i}`} inputMode="decimal" pattern="[0-9.,]*" placeholder="0.00" className="field text-right tabular-nums" /></label>
                  <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Crédito', 'Credit')}</span>
                    <input name={`credit_${i}`} inputMode="decimal" pattern="[0-9.,]*" placeholder="0.00" className="field text-right tabular-nums" /></label>
                  <label className="text-sm"><span className={i === 0 ? 'field-label' : 'field-label sm:sr-only'}>{tr('Detalle', 'Memo')}</span>
                    <input name={`memo_${i}`} maxLength={200} className="field" /></label>
                </div>
              ))}
            </fieldset>
            <p className="text-xs text-muted">
              {tr('Importes con hasta dos decimales. El total de débitos debe ser exactamente igual al de créditos; si no, no se publica nada. Un asiento publicado no se edita: se corrige con una reversión.',
                'Amounts with up to two decimals. Total debits must equal total credits exactly; otherwise nothing is posted. A posted entry is never edited: it is corrected with a reversal.')}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Link href="/accounting/journal" className="btn-secondary">{tr('Cancelar', 'Cancel')}</Link>
              <SubmitButton className="w-full sm:w-auto">{tr('Publicar asiento', 'Post entry')}</SubmitButton>
            </div>
          </form>
        )}
    </div>
  )
}

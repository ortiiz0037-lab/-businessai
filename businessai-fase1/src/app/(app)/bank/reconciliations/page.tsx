import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, type BankAccount, type Reconciliation } from '@/lib/finance/bank'
import { createReconciliation } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

/** Reconciliations by account and period; start a new one with the statement balances. */
export default async function ReconciliationsPage({ searchParams }: { searchParams: Promise<{ error?: string; account?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const [{ data: acc }, { data: recs }] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id', companyId).order('name'),
    supabase.from('bank_reconciliations').select('*').eq('company_id', companyId).order('period_end', { ascending: false }).limit(200),
  ])
  const accounts = (acc ?? []) as BankAccount[]
  const list = ((recs ?? []) as Reconciliation[]).filter((r) => !sp.account || r.bank_account_id === sp.account)
  const name = new Map(accounts.map((a) => [a.id, a.name]))
  const lastClosing = new Map<string, number>()
  for (const r of (recs ?? []) as Reconciliation[]) if (r.status === 'closed' && !lastClosing.has(r.bank_account_id)) lastClosing.set(r.bank_account_id, r.statement_closing_cents)
  const monthStart = `${today.slice(0, 8)}01`
  const prevEnd = new Date(Date.parse(`${monthStart}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  const prevStart = `${prevEnd.slice(0, 8)}01`
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Conciliaciones', 'Reconciliations')}
        description={tr('Una conciliación compara el estado del banco con el libro mayor para un periodo. Solo cierra con diferencia cero.', 'A reconciliation compares the bank statement with the ledger for a period. It only closes with a zero difference.')} />
      <BankNav tr={tr} current="/bank/reconciliations" />
      <Flash error={bankMessage(sp.error, locale)} />
      {access.reconcile && accounts.some((a) => a.status === 'active') && (
        <details className="card p-5" open={list.length === 0}>
          <summary className="cursor-pointer font-semibold text-accent">{tr('Nueva conciliación', 'New reconciliation')}</summary>
          <form action={createReconciliation} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm"><span className="field-label">{tr('Cuenta', 'Account')}</span>
              <select name="bank_account_id" required defaultValue={sp.account ?? ''} className="field"><option value="" disabled>—</option>
                {accounts.filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name}{lastClosing.has(a.id) ? ` (${tr('último cierre', 'last close')} ${money(lastClosing.get(a.id))})` : ''}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="period_start" required defaultValue={prevStart} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="period_end" required defaultValue={prevEnd} max={today} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Saldo inicial del estado', 'Statement opening balance')}</span><input name="opening" required inputMode="decimal" placeholder="0.00" className="field text-right" /></label>
            <label className="text-sm"><span className="field-label">{tr('Saldo final del estado', 'Statement closing balance')}</span><input name="closing" required inputMode="decimal" placeholder="0.00" className="field text-right" /></label>
            <label className="text-sm"><span className="field-label">{tr('Nota', 'Note')}</span><input name="note" maxLength={500} className="field" /></label>
            <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{tr('Usa los saldos impresos en el estado del banco. El saldo inicial debe coincidir con el final de la conciliación anterior.', 'Use the balances printed on the bank statement. The opening balance must equal the previous closing balance.')}</p>
            <div><SubmitButton>{tr('Crear', 'Create')}</SubmitButton></div>
          </form>
        </details>
      )}
      <section className="card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">{tr('Cuenta', 'Account')}</th><th className="px-4 py-3">{tr('Periodo', 'Period')}</th>
            <th className="px-4 py-3 text-right">{tr('Saldo inicial', 'Opening')}</th><th className="px-4 py-3 text-right">{tr('Saldo final', 'Closing')}</th><th className="px-4 py-3">{tr('Estado', 'Status')}</th></tr></thead>
          <tbody className="divide-y divide-line/60">{list.map((r) => (
            <tr key={r.id} className="hover:bg-white/[0.02]">
              <td className="px-4 py-2"><Link href={`/bank/reconciliations/${r.id}`} className="text-fg hover:text-accent">{name.get(r.bank_account_id) ?? '—'}</Link></td>
              <td className="px-4 py-2 text-muted">{f.date(r.period_start)} – {f.date(r.period_end)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.statement_opening_cents)}</td><td className="px-4 py-2 text-right tabular-nums">{money(r.statement_closing_cents)}</td>
              <td className="px-4 py-2">{r.status === 'closed' ? <StateChip tone="ok">{tr('Cerrada', 'Closed')}</StateChip> : <StateChip tone="pending">{tr('Abierta', 'Open')}</StateChip>}{r.adjustment_entry_id && <span className="ml-2 badge-warning">{tr('Con ajuste', 'Adjusted')}</span>}</td>
            </tr>))}
            {list.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-muted">{tr('Sin conciliaciones todavía.', 'No reconciliations yet.')}</td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  )
}

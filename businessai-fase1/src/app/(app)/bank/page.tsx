import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, type BankAccount, type Reconciliation } from '@/lib/finance/bank'
import { sumCents } from '@/lib/finance/money'
import { initBank } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

/** Banking overview: each account with its book balance, pending lines and last reconciliation. */
export default async function BankPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const [{ data: acc }, { data: lines }, { data: recs }, { data: tb }] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id', companyId).order('status').order('name'),
    supabase.from('bank_lines').select('bank_account_id, status, amount_cents, txn_date').eq('company_id', companyId).neq('status', 'excluded'),
    supabase.from('bank_reconciliations').select('*').eq('company_id', companyId).order('period_end', { ascending: false }),
    supabase.rpc('ledger_trial_balance', { target: companyId }),
  ])
  const accounts = (acc ?? []) as BankAccount[]
  const all = (lines ?? []) as { bank_account_id: string; status: string; amount_cents: number; txn_date: string }[]
  const reconciliations = (recs ?? []) as Reconciliation[]
  const balance = new Map(((tb ?? []) as { account_id: string; balance_cents: number }[]).map((r) => [r.account_id, r.balance_cents]))
  const pending = all.filter((l) => l.status === 'unmatched')
  const openRecs = reconciliations.filter((r) => r.status === 'open')
  const done: Record<string, string> = { initialized: tr('Banca activada (cuenta 6500 Comisiones bancarias disponible).', 'Banking activated (account 6500 Bank fees available).') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Bancos y conciliación', 'Banking and reconciliation')}
        description={tr('Cada movimiento del banco se empareja con partidas del libro mayor. Importar un estado no cambia ingresos ni gastos.',
          'Each bank line is matched with ledger items. Importing a statement does not change revenue or expenses.')}
        actions={access.manage && accounts.length ? <Link href="/bank/import" className="btn-primary">{tr('Importar estado', 'Import statement')}</Link> : undefined} />
      <BankNav tr={tr} current="/bank" />
      <Flash done={sp.done ? done[sp.done] : null} error={bankMessage(sp.error, locale)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="building" label={tr('Cuentas activas', 'Active accounts')} value={String(accounts.filter((a) => a.status === 'active').length)} />
        <StatCard icon="alert" tone="warning" label={tr('Movimientos pendientes', 'Pending lines')} value={String(pending.length)} hint={money(sumCents(pending.map((l) => l.amount_cents)))} />
        <StatCard icon="check" tone="success" label={tr('Emparejados', 'Matched')} value={String(all.filter((l) => l.status === 'matched').length)} />
        <StatCard icon="clock" tone="gold" label={tr('Conciliaciones abiertas', 'Open reconciliations')} value={String(openRecs.length)} />
      </div>
      {accounts.length === 0 ? (
        <div className="card">
          <EmptyState icon="building" title={tr('Sin cuentas bancarias', 'No bank accounts')}
            description={tr('Crea una cuenta bancaria y vincúlala a una cuenta de activo del catálogo (por ejemplo 1010 Banco). Nunca se guardan credenciales bancarias.',
              'Create a bank account and link it to an asset account of the chart (for example 1010 Bank). Bank credentials are never stored.')}
            action={access.manage ? <div className="flex flex-wrap justify-center gap-2"><form action={initBank}><SubmitButton className="w-full sm:w-auto">{tr('Activar banca', 'Activate banking')}</SubmitButton></form>
              <Link href="/bank/accounts" className="btn-secondary">{tr('Crear cuenta', 'Create account')}</Link></div> : undefined} />
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {accounts.map((a) => {
            const mine = all.filter((l) => l.bank_account_id === a.id)
            const pend = mine.filter((l) => l.status === 'unmatched').length
            const last = reconciliations.find((r) => r.bank_account_id === a.id)
            return (
              <li key={a.id} className="card space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/bank/accounts/${a.id}`} className="font-display text-lg font-semibold text-fg hover:text-accent">{a.name}</Link>
                    <p className="text-xs text-muted">{[a.bank_name, a.last4 ? `••${a.last4}` : null, a.currency].filter(Boolean).join(' · ')}</p>
                  </div>
                  {a.status === 'archived' ? <span className="badge-neutral">{tr('Archivada', 'Archived')}</span>
                    : pend > 0 ? <StateChip tone="pending">{tr(`${pend} pendientes`, `${pend} pending`)}</StateChip> : <StateChip tone="ok">{tr('Al día', 'Up to date')}</StateChip>}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted">{tr('Saldo en libros', 'Book balance')}</dt><dd className="font-semibold tabular-nums text-fg">{money(balance.get(a.ledger_account_id) ?? 0)}</dd></div>
                  <div><dt className="text-muted">{tr('Última conciliación', 'Last reconciliation')}</dt>
                    <dd className="text-fg">{last ? <Link href={`/bank/reconciliations/${last.id}`} className="hover:text-accent">{f.date(last.period_end)} · {last.status === 'closed' ? tr('cerrada', 'closed') : tr('abierta', 'open')}</Link> : '—'}</dd></div>
                </dl>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

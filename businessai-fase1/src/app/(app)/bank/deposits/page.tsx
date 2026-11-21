import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankingMessage } from '@/lib/banking/messages'
import { openInvoices, type Allocation, type DepositLine } from '@/lib/banking/deposits'
import { suggestMatches } from '@/lib/banking/matching'
import { paymentMethodLabel } from '@/lib/documents/payments'
import type { BankAccount } from '@/lib/finance/bank'

export const dynamic = 'force-dynamic'

/**
 * Deposits waiting for a decision, with the best suggestion of each, and the
 * register of decisions taken (who applied what, with which confidence).
 * Four different things are shown apart: payments recorded in BusinessAI,
 * payments received by a processor, bank deposits and reconciled lines.
 */
export default async function DepositsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; account?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access, who } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const probe = await supabase.from('bank_line_allocations').select('id').limit(1)
  if (probe.error) {
    return (<div className="space-y-6"><PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Depósitos y pagos', 'Deposits and payments')} />
      <BankNav tr={tr} current="/bank/deposits" /><div className="card p-6 text-sm text-muted">{bankingMessage('unavailable', locale)}</div></div>)
  }
  const [{ data: acc }, { data: dep }, { data: alloc }, { data: pays }, { data: recs }] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id', companyId).order('name'),
    supabase.from('bank_lines').select('id, bank_account_id, txn_date, description, reference, amount_cents, status, branch_id, reconciliation_id').eq('company_id', companyId).gt('amount_cents', 0).neq('status', 'excluded').order('txn_date', { ascending: false }).limit(400),
    supabase.from('bank_line_allocations').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200),
    supabase.from('payments').select('id, amount, payment_method, paid_at, document_id, voided_at, documents(document_number)').eq('company_id', companyId).order('paid_at', { ascending: false }).limit(1000),
    supabase.from('bank_reconciliations').select('id, status').eq('company_id', companyId),
  ])
  const accounts = (acc ?? []) as BankAccount[]
  const deposits = (dep ?? []) as DepositLine[]
  const allocations = (alloc ?? []) as Allocation[]
  const payments = (pays ?? []) as unknown as { id: string; amount: number; payment_method: string | null; paid_at: string; document_id: string; voided_at: string | null; documents: { document_number: string | null } | null }[]
  const closed = new Set(((recs ?? []) as { id: string; status: string }[]).filter((r) => r.status === 'closed').map((r) => r.id))
  const applied = new Map<string, number>()
  for (const a of allocations) if (!a.voided_at) applied.set(a.bank_line_id, (applied.get(a.bank_line_id) ?? 0) + a.amount_cents)
  const pending = deposits.filter((d) => d.status === 'unmatched')
  const invoices = await openInvoices(supabase, companyId)
  const name = await who()
  const payById = new Map(payments.map((p) => [p.id, p]))
  const accountName = new Map(accounts.map((a) => [a.id, `${a.name}${a.last4 ? ` ••${a.last4}` : ''}`]))
  const livePayments = payments.filter((p) => !p.voided_at)
  const processor = livePayments.filter((p) => p.payment_method === 'stripe')
  const done: Record<string, string> = { allocation_voided: tr('Aplicación deshecha. El pago creado sigue registrado: anúlelo desde Cuentas por cobrar si no corresponde.', 'Application undone. The payment created stays recorded: void it from Receivables if it does not apply.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Depósitos y pagos', 'Deposits and payments')}
        description={tr('BusinessAI sugiere a qué facturas corresponde cada depósito y explica por qué. Nada se marca como pagado sin su confirmación.',
          'BusinessAI suggests which invoices each deposit belongs to and explains why. Nothing is marked paid without your confirmation.')}
        actions={<Link href="/payments/new" className="btn-secondary">{tr('Registrar pago manual', 'Record manual payment')}</Link>} />
      <BankNav tr={tr} current="/bank/deposits" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={bankingMessage(sp.error, locale)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="money-kinds">
        <StatCard icon="file" label={tr('Pagos registrados', 'Recorded payments')} value={String(livePayments.length - processor.length)} hint={tr('Registrados en BusinessAI (manuales o desde depósitos)', 'Recorded in BusinessAI (manual or from deposits)')} />
        <StatCard icon="card" label={tr('Pagos de procesador', 'Processor payments')} value={String(processor.length)} hint={tr('Cobrados por un procesador (p. ej. Stripe)', 'Collected by a processor (e.g. Stripe)')} />
        <StatCard icon="building" tone="warning" label={tr('Depósitos por decidir', 'Deposits to decide')} value={String(pending.length)} hint={money(pending.reduce((s, d) => s + d.amount_cents - (applied.get(d.id) ?? 0), 0))} />
        <StatCard icon="check" tone="success" label={tr('Conciliados', 'Reconciled')} value={String(deposits.filter((d) => d.reconciliation_id && closed.has(d.reconciliation_id)).length)} hint={tr('En una conciliación cerrada', 'In a closed reconciliation')} />
      </div>

      <section className="card overflow-hidden" aria-labelledby="pending-title">
        <h2 id="pending-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Depósitos pendientes', 'Pending deposits')}</h2>
        {pending.length === 0 ? (
          <EmptyState icon="check" title={tr('Nada pendiente', 'Nothing pending')} description={tr('Todos los depósitos están aplicados o emparejados.', 'Every deposit is applied or matched.')} />
        ) : (
          <ul className="mt-3 divide-y divide-line/60" data-testid="pending-deposits">
            {pending.map((d) => {
              const rest = d.amount_cents - (applied.get(d.id) ?? 0)
              const best = suggestMatches({ ...d, allocated_cents: applied.get(d.id) ?? 0 }, invoices, [])[0]
              return (
                <li key={d.id}>
                  <Link href={`/bank/deposits/${d.id}`} className="flex flex-col gap-2 px-5 py-3 transition hover:bg-electric/10 sm:flex-row sm:items-center sm:justify-between" data-testid="pending-deposit">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{d.description}</span>
                      <span className="block text-xs text-muted">{f.date(d.txn_date)} · {accountName.get(d.bank_account_id)}{d.reference ? ` · ${d.reference}` : ''}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {best ? <StateChip tone={best.ambiguous ? 'pending' : 'ok'}>{tr('Sugerencia', 'Suggestion')} {best.confidence}%</StateChip> : <StateChip tone="pending">{tr('Sin sugerencia', 'No suggestion')}</StateChip>}
                      <span className="text-right">
                        <span className="block font-bold tabular-nums text-fg">{money(d.amount_cents)}</span>
                        {rest !== d.amount_cents && <span className="block text-xs text-warning">{tr('por aplicar', 'to apply')} {money(rest)}</span>}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden" aria-labelledby="decisions-title">
        <h2 id="decisions-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Decisiones registradas', 'Recorded decisions')}</h2>
        <p className="px-5 text-xs text-muted">{tr('Cada aplicación de un depósito queda con su autor, fecha, confianza y motivo; deshacerla también queda registrado.', 'Each application of a deposit keeps its author, date, confidence and reason; undoing it is recorded too.')}</p>
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-[720px] text-sm" data-testid="decisions">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr>
              <th className="px-4 py-2">{tr('Fecha', 'Date')}</th><th className="px-4 py-2">{tr('Depósito', 'Deposit')}</th><th className="px-4 py-2">{tr('Pago / factura', 'Payment / invoice')}</th>
              <th className="px-4 py-2 text-right">{tr('Importe', 'Amount')}</th><th className="px-4 py-2">{tr('Confianza', 'Confidence')}</th><th className="px-4 py-2">{tr('Por', 'By')}</th><th className="px-4 py-2">{tr('Estado', 'Status')}</th></tr></thead>
            <tbody className="divide-y divide-line/60">
              {allocations.length === 0 && <tr><td colSpan={7} className="px-4 py-4 text-center text-muted">{tr('Todavía no hay decisiones.', 'No decisions yet.')}</td></tr>}
              {allocations.map((a) => {
                const p = payById.get(a.payment_id), d = deposits.find((x) => x.id === a.bank_line_id)
                return (
                  <tr key={a.id}>
                    <td className="px-4 py-2 text-muted">{f.date(a.created_at.slice(0, 10))}</td>
                    <td className="px-4 py-2"><Link href={`/bank/deposits/${a.bank_line_id}`} className="hover:text-accent">{d ? `${f.date(d.txn_date)} · ${d.description}` : '—'}</Link></td>
                    <td className="px-4 py-2">{p ? <Link href={`/documents/${p.document_id}`} className="hover:text-accent">{p.documents?.document_number ?? '—'} · {paymentMethodLabel(p.payment_method, locale)}</Link> : '—'}
                      <span className="block text-xs text-muted">{a.kind === 'new_payment' ? tr('Pago creado desde el depósito', 'Payment created from the deposit') : tr('Pago existente vinculado', 'Existing payment linked')}</span></td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(a.amount_cents)}</td>
                    <td className="px-4 py-2">{a.confidence ? `${a.confidence}%` : tr('Manual', 'Manual')}</td>
                    <td className="px-4 py-2 text-muted">{name(a.created_by)}</td>
                    <td className="px-4 py-2">{a.voided_at ? <span title={a.void_reason ?? ''}><StateChip tone="issue">{tr('Deshecha', 'Undone')}</StateChip></span> : <StateChip tone="ok">{tr('Vigente', 'Active')}</StateChip>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

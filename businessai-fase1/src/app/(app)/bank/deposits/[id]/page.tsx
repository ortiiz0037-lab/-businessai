import Link from 'next/link'
import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankingMessage } from '@/lib/banking/messages'
import { linkablePayments, openInvoices, type Allocation, type DepositLine } from '@/lib/banking/deposits'
import { reasonText, suggestMatches } from '@/lib/banking/matching'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { applyDeposit, linkDepositPayment, setLineBranch, voidAllocation } from '@/app/actions/banking'
import type { BankAccount } from '@/lib/finance/bank'

export const dynamic = 'force-dynamic'
const METHODS = ['bank_transfer', 'ath_movil', 'check', 'cash', 'credit_card', 'debit_card', 'other'] as const

/** One deposit: suggestions with their reasons, manual application (split / partial), links to recorded payments, history. */
export default async function DepositPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access, who } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: l } = await supabase.from('bank_lines').select('id, bank_account_id, txn_date, description, reference, amount_cents, status, branch_id, reconciliation_id').eq('id', id).eq('company_id', companyId).maybeSingle()
  const line = l as DepositLine | null
  if (!line) notFound()
  const [{ data: acc }, { data: al }, { data: br }] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('id', line.bank_account_id).single(),
    supabase.from('bank_line_allocations').select('*').eq('bank_line_id', id).order('created_at'),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
  ])
  const account = acc as BankAccount
  const allocations = (al ?? []) as Allocation[]
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  const applied = allocations.filter((a) => !a.voided_at).reduce((s, a) => s + a.amount_cents, 0)
  const remaining = line.amount_cents - applied
  const canDecide = access.manage && access.reconcile && line.amount_cents > 0 && line.status === 'unmatched'
  const [invoices, payments] = await Promise.all([openInvoices(supabase, companyId), linkablePayments(supabase, companyId, account.ledger_account_id)])
  const suggestions = canDecide ? suggestMatches({ ...line, allocated_cents: applied }, invoices, payments) : []
  const invById = new Map(invoices.map((i) => [i.id, i]))
  const payById = new Map(payments.map((p) => [p.id, p]))
  const { data: payRows } = allocations.length ? await supabase.from('payments').select('id, document_id, payment_method, amount, documents(document_number)').in('id', allocations.map((a) => a.payment_id)) : { data: [] }
  const paid = new Map(((payRows ?? []) as unknown as { id: string; document_id: string; payment_method: string | null; documents: { document_number: string | null } | null }[]).map((p) => [p.id, p]))
  const name = await who()
  const back = `/bank/deposits/${id}`
  const dollars = (c: number) => (c / 100).toFixed(2)
  const done: Record<string, string> = {
    applied: tr('Depósito aplicado: se registraron los pagos en Cuentas por cobrar y el movimiento quedó emparejado.', 'Deposit applied: the payments were recorded in Receivables and the line is matched.'),
    applied_partial: tr('Aplicación registrada. Queda una parte del depósito por decidir.', 'Application recorded. Part of the deposit is still to decide.'),
    linked_payment: tr('Pago existente vinculado (no se creó un pago nuevo).', 'Existing payment linked (no new payment was created).'),
    allocation_voided: tr('Aplicación deshecha. El pago sigue registrado: anúlelo desde la factura si no corresponde.', 'Application undone. The payment stays recorded: void it from the invoice if it does not apply.'),
    branch_set: tr('Sucursal asignada al movimiento.', 'Branch assigned to the line.'),
  }
  const methodSelect = (
    <label className="field-label">{tr('Método', 'Method')}
      <select name="method" defaultValue="bank_transfer" className="field mt-2">{METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m, locale)}</option>)}</select>
    </label>
  )

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Depósito', 'Deposit')} title={money(line.amount_cents)}
        description={`${f.date(line.txn_date)} · ${line.description}${line.reference ? ` · ${line.reference}` : ''} · ${account.name}`} />
      <BankNav tr={tr} current="/bank/deposits" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={bankingMessage(sp.error, locale)} />
      <div className="card flex flex-wrap items-center gap-4 p-4 text-sm" data-testid="deposit-summary">
        <span>{tr('Aplicado', 'Applied')}: <strong className="tabular-nums">{money(applied)}</strong></span>
        <span>{tr('Por aplicar', 'To apply')}: <strong className="tabular-nums text-warning" data-testid="deposit-remaining">{money(Math.max(0, remaining))}</strong></span>
        <StateChip tone={line.status === 'matched' ? 'ok' : line.status === 'excluded' ? 'issue' : 'pending'}>
          {({ matched: tr('Emparejado', 'Matched'), unmatched: tr('Pendiente', 'Pending'), excluded: tr('Excluido', 'Excluded') } as Record<string, string>)[line.status]}</StateChip>
        {line.amount_cents <= 0 && <span className="text-muted">{bankingMessage('bank_line_not_deposit', locale)}</span>}
        {access.manage && branches.length > 0 && (
          <form action={setLineBranch} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="line_id" value={id} /><input type="hidden" name="back" value={back} />
            <label className="sr-only" htmlFor="line-branch">{tr('Sucursal', 'Branch')}</label>
            <select id="line-branch" name="branch_id" defaultValue={line.branch_id ?? ''} className="field py-1.5">
              <option value="">{tr('Sin sucursal', 'No branch')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <SubmitButton className="btn-sm">{tr('Asignar', 'Assign')}</SubmitButton>
          </form>
        )}
      </div>

      {canDecide && (
        <section className="space-y-3" aria-labelledby="sugg-title">
          <h2 id="sugg-title" className="font-display text-lg font-semibold text-fg">{tr('Sugerencias', 'Suggestions')}</h2>
          {suggestions.length === 0 && <p className="card p-4 text-sm text-muted">{tr('No hay una coincidencia clara. Aplíquelo manualmente abajo o déjelo pendiente.', 'There is no clear match. Apply it manually below or leave it pending.')}</p>}
          <ul className="grid gap-3 lg:grid-cols-2">
            {suggestions.map((s, n) => (
              <li key={n} className="card space-y-3 p-4" data-testid="deposit-suggestion" data-kind={s.kind}>
                <div className="flex items-center justify-between gap-2">
                  <StateChip tone={s.ambiguous ? 'pending' : s.confidence >= 80 ? 'ok' : 'pending'}>{tr('Confianza', 'Confidence')} {s.confidence}%</StateChip>
                  <span className="text-xs text-muted">{s.kind === 'payment' ? tr('Pago ya registrado', 'Payment already recorded') : s.allocations.length > 1 ? tr('Varias facturas', 'Several invoices') : tr('Factura', 'Invoice')}</span>
                </div>
                <ul className="text-sm">
                  {s.kind === 'payment' ? (() => { const p = payById.get(s.payment_id)!; return <li>{p.document_number ?? '—'} · {paymentMethodLabel(p.method, locale)} · {money(p.amount_cents)} · {f.date(p.paid_at.slice(0, 10))}{p.reference ? ` · ${p.reference}` : ''}</li> })()
                    : s.allocations.map((a) => { const i = invById.get(a.document_id)!; return <li key={a.document_id} className="flex justify-between gap-2"><span className="truncate">{i.number ?? '—'} · {i.client_name ?? '—'}</span><span className="tabular-nums">{money(a.amount_cents)} <span className="text-xs text-muted">/ {money(i.balance_cents)}</span></span></li> })}
                </ul>
                <ul className="space-y-0.5 text-xs text-muted" aria-label={tr('Por qué', 'Why')}>{s.reasons.map((r) => <li key={r}>• {reasonText(r, locale)}</li>)}</ul>
                {s.kind === 'payment' ? (
                  <form action={linkDepositPayment}>
                    <input type="hidden" name="line_id" value={id} /><input type="hidden" name="payment_id" value={s.payment_id} />
                    <input type="hidden" name="confidence" value={s.confidence} /><input type="hidden" name="reasons" value={s.reasons.join(',')} />
                    <SubmitButton className="btn-sm w-full sm:w-auto">{tr('Confirmar vínculo', 'Confirm link')}</SubmitButton>
                  </form>
                ) : (
                  <form action={applyDeposit} className="space-y-2">
                    <input type="hidden" name="line_id" value={id} /><input type="hidden" name="idempotency_key" value={randomUUID()} />
                    <input type="hidden" name="confidence" value={s.confidence} /><input type="hidden" name="reasons" value={s.reasons.join(',')} />
                    {s.allocations.map((a) => <span key={a.document_id}><input type="hidden" name="alloc_doc" value={a.document_id} /><input type="hidden" name="alloc_amount" value={dollars(a.amount_cents)} /></span>)}
                    {methodSelect}
                    <SubmitButton className="btn-sm w-full sm:w-auto">{tr('Confirmar y registrar pago', 'Confirm and record payment')}</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canDecide && remaining > 0 && (
        <section className="card space-y-4 p-5" aria-labelledby="manual-title">
          <h2 id="manual-title" className="font-display text-lg font-semibold text-fg">{tr('Aplicar manualmente', 'Apply manually')}</h2>
          <p className="text-xs text-muted">{tr('Reparta el depósito entre una o varias facturas (pagos parciales permitidos). La suma no puede superar lo que falta por aplicar; Cuentas por cobrar valida cada balance.',
            'Split the deposit across one or several invoices (partial payments allowed). The total cannot exceed what is left to apply; Receivables checks each balance.')}</p>
          <form action={applyDeposit} className="space-y-3" data-testid="manual-apply">
            <input type="hidden" name="line_id" value={id} /><input type="hidden" name="idempotency_key" value={randomUUID()} />
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <label className="sr-only" htmlFor={`doc-${n}`}>{tr('Factura', 'Invoice')} {n + 1}</label>
                <select id={`doc-${n}`} name="alloc_doc" defaultValue="" className="field min-w-0">
                  <option value="">{n === 0 ? tr('Elegir factura…', 'Choose invoice…') : tr('(otra factura, opcional)', '(another invoice, optional)')}</option>
                  {invoices.map((i) => <option key={i.id} value={i.id}>{i.number ?? '—'} · {i.client_name ?? '—'} · {money(i.balance_cents)}</option>)}
                </select>
                <label className="sr-only" htmlFor={`amt-${n}`}>{tr('Importe', 'Amount')} {n + 1}</label>
                <input id={`amt-${n}`} name="alloc_amount" inputMode="decimal" placeholder="0.00" defaultValue={n === 0 ? dollars(remaining) : ''} className="field" />
              </div>
            ))}
            <div className="grid gap-3 sm:grid-cols-2">{methodSelect}</div>
            <SubmitButton>{tr('Confirmar y registrar pagos', 'Confirm and record payments')}</SubmitButton>
          </form>
          {payments.length > 0 && (
            <form action={linkDepositPayment} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end" data-testid="manual-link">
              <input type="hidden" name="line_id" value={id} />
              <label className="field-label min-w-0 flex-1">{tr('O vincular un pago ya registrado en esta cuenta', 'Or link a payment already recorded into this account')}
                <select name="payment_id" defaultValue="" className="field mt-2">
                  <option value="" disabled>{tr('Elegir pago…', 'Choose payment…')}</option>
                  {payments.map((p) => <option key={p.id} value={p.id}>{p.document_number ?? '—'} · {money(p.amount_cents)} · {f.date(p.paid_at.slice(0, 10))}{p.reference ? ` · ${p.reference}` : ''}</option>)}
                </select>
              </label>
              <SubmitButton className="w-full sm:w-auto">{tr('Vincular', 'Link')}</SubmitButton>
            </form>
          )}
        </section>
      )}

      <section className="card overflow-hidden" aria-labelledby="hist-title">
        <h2 id="hist-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Aplicaciones de este depósito', 'Applications of this deposit')}</h2>
        <ul className="mt-3 divide-y divide-line/60" data-testid="deposit-allocations">
          {allocations.length === 0 && <li className="px-5 py-4 text-sm text-muted">{tr('Ninguna todavía.', 'None yet.')}</li>}
          {allocations.map((a) => {
            const p = paid.get(a.payment_id)
            return (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="deposit-allocation" data-voided={a.voided_at ? 'yes' : 'no'}>
                <span className="min-w-0 text-sm">
                  {p ? <Link href={`/documents/${p.document_id}`} className="font-semibold text-fg hover:text-accent">{p.documents?.document_number ?? '—'}</Link> : '—'} · {money(a.amount_cents)}
                  <span className="block text-xs text-muted">{name(a.created_by)} · {f.date(a.created_at.slice(0, 10))} · {a.confidence ? `${tr('confianza', 'confidence')} ${a.confidence}%` : tr('manual', 'manual')}
                    {a.voided_at ? ` · ${tr('deshecha', 'undone')}: ${a.void_reason}` : ''}</span>
                </span>
                {!a.voided_at && access.reconcile && (
                  <details><summary className="cursor-pointer text-xs font-semibold text-red-200">{tr('Deshacer', 'Undo')}</summary>
                    <form action={voidAllocation} className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input type="hidden" name="allocation_id" value={a.id} /><input type="hidden" name="back" value={back} />
                      <label className="sr-only" htmlFor={`reason-${a.id}`}>{tr('Motivo', 'Reason')}</label>
                      <input id={`reason-${a.id}`} name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field py-1.5" />
                      <SubmitButton className="btn-sm">{tr('Deshacer', 'Undo')}</SubmitButton>
                    </form>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

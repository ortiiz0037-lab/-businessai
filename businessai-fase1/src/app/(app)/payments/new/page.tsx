import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow } from '@/lib/active-company'
import { billingErrorMessage } from '@/lib/billing/state'
import { balanceOf, todayIn } from '@/lib/documents/lifecycle'
import { PAYMENT_METHODS, paymentErrorMessage, paymentMethodLabel } from '@/lib/documents/payments'
import { paidByDocument } from '@/lib/supabase/paged'
import { registerPayment } from '@/app/actions/documents'
import { newIdempotencyKey } from '@/lib/documents/capabilities'
import { SubmitButton } from '@/components/submit-button'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

export const dynamic = 'force-dynamic'

type OpenInvoice = { id: string; number: string; client: string; total: number; paid: number; balance: number; dueDate: string | null; issueDate: string | null }

/** Record a payment: choose an issued invoice with an open balance, then amount, method, date and reference. */
export default async function NewPaymentPage({
  searchParams,
}: {
  searchParams?: Promise<{ document?: string; paymentError?: string }>
}) {
  const params = (await searchParams) ?? {}
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const member = await activeCompanyRow(supabase, user.id)
  if (!member?.company_id) redirect('/onboarding')

  // Issued invoices that can still receive payments.
  const { data: invoices } = await supabase
    .from('documents')
    .select('id, document_number, title, total, due_date, issue_date, client_id, status')
    .eq('company_id', member.company_id)
    .eq('document_type', 'invoice')
    .in('status', ['sent', 'overdue'])
    .order('issue_date', { ascending: false })
    .limit(200)

  const ids = (invoices ?? []).map((d) => d.id)
  const clientIds = [...new Set((invoices ?? []).map((d) => d.client_id).filter((v): v is string => !!v))]
  const [paid, { data: clients }] = await Promise.all([
    paidByDocument(supabase, ids),
    clientIds.length ? supabase.from('clients').select('id, name, business_name').in('id', clientIds) : Promise.resolve({ data: [] }),
  ])
  const clientName = new Map(((clients ?? []) as { id: string; name: string | null; business_name: string | null }[])
    .map((c) => [c.id, c.business_name || c.name || tr('Cliente', 'Client')]))

  const open: OpenInvoice[] = (invoices ?? [])
    .map((d) => {
      const p = Math.round((paid.get(d.id) ?? 0) * 100) / 100
      return {
        id: d.id, number: d.document_number || d.title || tr('Factura', 'Invoice'),
        client: d.client_id ? clientName.get(d.client_id) ?? tr('Cliente', 'Client') : tr('Sin cliente', 'No client'),
        total: Number(d.total ?? 0), paid: p, balance: balanceOf(d, p), dueDate: d.due_date, issueDate: d.issue_date,
      }
    })
    .filter((d) => d.balance > 0)

  const selected = open.find((d) => d.id === params.document) ?? null
  const today = todayIn()
  const errorText = params.paymentError
    ? paymentErrorMessage(params.paymentError, locale) ?? billingErrorMessage(params.paymentError, locale) ?? paymentErrorMessage('save', locale)
    : null

  return (
    <div className="space-y-6">
      <Link href="/payments" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Volver a Pagos', '← Back to Payments')}</Link>
      <PageHeader eyebrow={tr('Cobros', 'Collections')} title={tr('Registrar pago', 'Record payment')}
        description={tr('Registra un pago total o parcial de una factura emitida.', 'Record a full or partial payment on an issued invoice.')} />

      {errorText && <div role="alert" className="alert-danger p-4">{errorText}</div>}

      {open.length === 0 ? (
        <div className="card">
          <EmptyState icon="wallet" title={tr('No hay facturas con balance pendiente.', 'No invoices with an open balance.')}
            description={tr('Solo las facturas emitidas (marcadas como enviadas) y con balance pueden recibir pagos.',
              'Only issued invoices (marked as sent) with an open balance can receive payments.')}
            action={<Link className="btn-primary" href="/documents?status=draft#lista">{tr('Ver borradores', 'View drafts')}</Link>} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="card min-w-0 p-5 sm:p-6" aria-labelledby="open-title">
            <h2 id="open-title" className="font-display text-lg font-semibold text-fg">{tr('Facturas por cobrar', 'Invoices to collect')}</h2>
            <ul className="mt-3 divide-y divide-line">
              {open.map((d) => (
                <li key={d.id}>
                  <Link href={`/payments/new?document=${d.id}`}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition hover:bg-electric/10 ${selected?.id === d.id ? 'bg-brand/15 ring-1 ring-inset ring-electric/40' : ''}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{d.number}</span>
                      <span className="block truncate text-xs text-muted">{d.client}{d.dueDate ? ` · ${tr('vence', 'due')} ${f.date(d.dueDate)}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-bold tabular-nums text-fg">{f.money(d.balance)}</span>
                      <span className="block text-xs text-muted">{tr('de', 'of')} {f.money(d.total)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="card min-w-0 p-5 sm:p-6" aria-labelledby="form-title">
            {selected ? (
              <form action={registerPayment} className="space-y-4">
                <input type="hidden" name="document_id" value={selected.id} />
                <input type="hidden" name="return_to" value="payments" />
                <input type="hidden" name="idempotency_key" value={newIdempotencyKey()} />
                <div>
                  <h2 id="form-title" className="font-display text-lg font-semibold text-fg">{selected.number}</h2>
                  <p className="mt-1 text-sm text-muted">
                    {selected.client} · {tr('Total', 'Total')} {f.money(selected.total)} · {tr('Pagado', 'Paid')} {f.money(selected.paid)} ·{' '}
                    <span className="font-semibold text-warning">{tr('Balance', 'Balance')} {f.money(selected.balance)}</span>
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="field-label">{tr('Cantidad *', 'Amount *')}
                    <input name="amount" required inputMode="decimal" defaultValue={selected.balance.toFixed(2)} className="field mt-2" />
                  </label>
                  <label className="field-label">{tr('Método *', 'Method *')}
                    <select name="method" required defaultValue="" className="field mt-2">
                      <option value="" disabled>{tr('Seleccionar', 'Select')}</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m, locale)}</option>)}
                    </select>
                  </label>
                  <label className="field-label">{tr('Fecha *', 'Date *')}
                    <input name="date" type="date" required defaultValue={today} max={today} min={selected.issueDate ?? undefined} className="field mt-2" />
                  </label>
                  <label className="field-label">{tr('Referencia', 'Reference')}
                    <input name="reference" maxLength={120} className="field mt-2" placeholder={tr('Nº de cheque, confirmación…', 'Check no., confirmation…')} />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" name="create_receipt" defaultChecked className="h-4 w-4 accent-blue-600" />
                  {tr('Crear el recibo de este pago', 'Create the receipt for this payment')}
                </label>
                <SubmitButton pendingLabel={tr('Registrando…', 'Recording…')}>{tr('Registrar pago', 'Record payment')}</SubmitButton>
                <p className="text-xs text-muted">{tr('Pagos parciales permitidos hasta el balance pendiente. Los pagos registrados no se editan ni se borran.',
                  'Partial payments are allowed up to the open balance. Recorded payments are never edited or deleted.')}</p>
              </form>
            ) : (
              <div className="py-6 text-center">
                <h2 id="form-title" className="font-display text-lg font-semibold text-fg">{tr('Elige una factura', 'Choose an invoice')}</h2>
                <p className="mt-2 text-sm text-muted">{tr('Selecciona en la lista la factura que recibió el pago.', 'Select the invoice that received the payment from the list.')}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

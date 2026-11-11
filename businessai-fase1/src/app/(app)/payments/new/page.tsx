import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow } from '@/lib/active-company'
import { BILLING_ERROR_MESSAGE } from '@/lib/billing/state'
import { balanceOf, todayIn } from '@/lib/documents/lifecycle'
import { PAYMENT_ERROR_MESSAGE, PAYMENT_METHODS, paymentMethodLabel } from '@/lib/documents/payments'
import { paidByDocument } from '@/lib/supabase/paged'
import { registerPayment } from '@/app/actions/documents'
import { newIdempotencyKey } from '@/lib/documents/capabilities'
import { SubmitButton } from '@/components/submit-button'

export const dynamic = 'force-dynamic'

type OpenInvoice = { id: string; number: string; client: string; total: number; paid: number; balance: number; dueDate: string | null; issueDate: string | null }

const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)

/** Record a payment: choose an issued invoice with an open balance, then amount, method, date and reference. */
export default async function NewPaymentPage({
  searchParams,
}: {
  searchParams?: Promise<{ document?: string; paymentError?: string }>
}) {
  const params = (await searchParams) ?? {}
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
    .map((c) => [c.id, c.business_name || c.name || 'Cliente']))

  const open: OpenInvoice[] = (invoices ?? [])
    .map((d) => {
      const p = Math.round((paid.get(d.id) ?? 0) * 100) / 100
      return {
        id: d.id, number: d.document_number || d.title || 'Factura', client: d.client_id ? clientName.get(d.client_id) ?? 'Cliente' : 'Sin cliente',
        total: Number(d.total ?? 0), paid: p, balance: balanceOf(d, p), dueDate: d.due_date, issueDate: d.issue_date,
      }
    })
    .filter((d) => d.balance > 0)

  const selected = open.find((d) => d.id === params.document) ?? null
  const today = todayIn()
  const errorText = params.paymentError
    ? PAYMENT_ERROR_MESSAGE[params.paymentError] ?? (BILLING_ERROR_MESSAGE as Record<string, string>)[params.paymentError] ?? PAYMENT_ERROR_MESSAGE.save
    : null

  return (
    <div className="space-y-6">
      <Link href="/payments" className="text-sm font-semibold text-muted hover:text-fg">← Volver a Pagos</Link>
      <PageHeader eyebrow="Cobros" title="Registrar pago" description="Registra un pago total o parcial de una factura emitida." />

      {errorText && <div role="alert" className="alert-danger p-4">{errorText}</div>}

      {open.length === 0 ? (
        <div className="card">
          <EmptyState icon="wallet" title="No hay facturas con balance pendiente."
            description="Solo las facturas emitidas (marcadas como enviadas) y con balance pueden recibir pagos."
            action={<Link className="btn-primary" href="/documents?status=draft#lista">Ver borradores</Link>} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="card min-w-0 p-5 sm:p-6" aria-labelledby="open-title">
            <h2 id="open-title" className="font-display text-lg font-semibold text-fg">Facturas por cobrar</h2>
            <ul className="mt-3 divide-y divide-line">
              {open.map((d) => (
                <li key={d.id}>
                  <Link href={`/payments/new?document=${d.id}`}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition hover:bg-electric/10 ${selected?.id === d.id ? 'bg-brand/15 ring-1 ring-inset ring-electric/40' : ''}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{d.number}</span>
                      <span className="block truncate text-xs text-muted">{d.client}{d.dueDate ? ` · vence ${d.dueDate}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-bold tabular-nums text-fg">{usd(d.balance)}</span>
                      <span className="block text-xs text-muted">de {usd(d.total)}</span>
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
                    {selected.client} · Total {usd(selected.total)} · Pagado {usd(selected.paid)} ·{' '}
                    <span className="font-semibold text-warning">Balance {usd(selected.balance)}</span>
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="field-label">Cantidad *
                    <input name="amount" required inputMode="decimal" defaultValue={selected.balance.toFixed(2)} className="field mt-2" />
                  </label>
                  <label className="field-label">Método *
                    <select name="method" required defaultValue="" className="field mt-2">
                      <option value="" disabled>Seleccionar</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}
                    </select>
                  </label>
                  <label className="field-label">Fecha *
                    <input name="date" type="date" required defaultValue={today} max={today} min={selected.issueDate ?? undefined} className="field mt-2" />
                  </label>
                  <label className="field-label">Referencia
                    <input name="reference" maxLength={120} className="field mt-2" placeholder="Nº de cheque, confirmación…" />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" name="create_receipt" defaultChecked className="h-4 w-4 accent-blue-600" />
                  Crear el recibo de este pago
                </label>
                <SubmitButton pendingLabel="Registrando…">Registrar pago</SubmitButton>
                <p className="text-xs text-muted">Pagos parciales permitidos hasta el balance pendiente. Los pagos registrados no se editan ni se borran.</p>
              </form>
            ) : (
              <div className="py-6 text-center">
                <h2 id="form-title" className="font-display text-lg font-semibold text-fg">Elige una factura</h2>
                <p className="mt-2 text-sm text-muted">Selecciona en la lista la factura que recibió el pago.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

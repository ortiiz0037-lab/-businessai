import { redirect } from 'next/navigation'
import Link from 'next/link'
import { EmptyState, PageHeader, StatCard } from '@/components/ui/page'
import { documentTypeName } from '@/components/ui/status'
import { createClient } from '@/lib/supabase/server'
import { activeCompanyRow } from '@/lib/active-company'
import { activePayments, paymentMethodLabel } from '@/lib/documents/payments'
import { fetchAllPages } from '@/lib/supabase/paged'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'

const PAGE_SIZE = 50

type LinkedDocument = {
  id: string
  document_number: string | null
  document_type: string | null
  title: string | null
}

export default async function PaymentsPage({ searchParams }: { searchParams?: Promise<{ page?: string }> }) {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const member = await activeCompanyRow(supabase, user.id)
  if (!member?.company_id) redirect('/dashboard')

  const requested = Math.max(1, Math.min(10_000, Number.parseInt((await searchParams)?.page ?? '1', 10) || 1))
  // Total collected over every payment (all pages, not only the first 1000 rows).
  const all = await fetchAllPages<{ id: string; amount: number | string; voided_at?: string | null }>((from, to) =>
    supabase.from('payments').select('*').eq('company_id', member.company_id).order('id').range(from, to))
  const count = all.rows.length
  // Voided payments (0025) stay listed but do not count as collected.
  const totalCollected = Math.round(activePayments(all.rows).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE))
  if (requested > pages) redirect(pages > 1 ? `/payments?page=${pages}` : '/payments')
  const page = requested

  const from = (page - 1) * PAGE_SIZE
  const { data: payments, error } = await supabase
    .from('payments')
    .select('*')
    .eq('company_id', member.company_id)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, from + PAGE_SIZE - 1)
  if (error || all.error) {
    console.error('PAYMENTS_LOAD_ERROR:', { code: error?.code, message: error?.message ?? all.error?.message })
  }

  // Linked documents in one query, limited to the company. A payment whose
  // document is not available gets no broken link.
  const documentIds = [...new Set((payments ?? []).map((p) => p.document_id).filter((v): v is string => typeof v === 'string' && v.length > 0))]
  const linkedDocuments = new Map<string, LinkedDocument>()
  if (documentIds.length > 0) {
    const { data: docs, error: docsError } = await supabase
      .from('documents').select('id, document_number, document_type, title')
      .eq('company_id', member.company_id).in('id', documentIds)
    if (docsError) console.error('PAYMENTS_DOCUMENTS_LOAD_ERROR:', { code: docsError.code, message: docsError.message })
    for (const doc of (docs ?? []) as LinkedDocument[]) linkedDocuments.set(doc.id, doc)
  }

  // Receipt of each payment on screen (voided receipts excluded).
  const receiptByPayment = new Map<string, { id: string; number: string | null }>()
  const paymentIds = (payments ?? []).map((p) => p.id as string)
  if (paymentIds.length > 0) {
    const { data: receipts } = await supabase
      .from('documents').select('id, document_number, metadata')
      .eq('company_id', member.company_id).eq('document_type', 'receipt').neq('status', 'cancelled')
      .in('metadata->>payment_id', paymentIds)
    for (const r of receipts ?? []) {
      const pid = String((r.metadata as Record<string, unknown> | null)?.payment_id ?? '')
      if (pid) receiptByPayment.set(pid, { id: r.id, number: r.document_number })
    }
  }

  const rows = payments ?? []
  const pageHref = (n: number) => (n > 1 ? `/payments?page=${n}` : '/payments')

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={tr('Cobros', 'Collections')} title={tr('Pagos y cobros', 'Payments')}
        description={tr('Historial de pagos registrados en tu empresa.', 'History of the payments recorded in your company.')}
        actions={<Link href="/payments/new" className="btn-primary">{tr('Registrar pago', 'Record payment')}</Link>} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={tr('Total cobrado', 'Total collected')} value={f.money(totalCollected)}
          hint={count === 1 ? tr('1 pago registrado', '1 payment recorded') : tr(`${count} pagos registrados`, `${count} payments recorded`)}
          icon="wallet" tone="gold" />
      </div>

      <section className="card overflow-hidden" aria-labelledby="history-title">
        <div className="border-b border-line px-6 py-5">
          <h2 id="history-title" className="font-display text-2xl font-semibold tracking-tight text-fg">{tr('Historial de pagos', 'Payment history')}</h2>
        </div>

        {error ? (
          <p className="alert-danger m-6">{tr('No se pudieron cargar los pagos. Inténtalo nuevamente.', 'Payments could not be loaded. Please try again.')}</p>
        ) : rows.length === 0 ? (
          <EmptyState icon="wallet" title={tr('Todavía no hay pagos registrados.', 'No payments recorded yet.')}
            description={tr('Registra el pago de una factura emitida y aparecerá aquí.', 'Record a payment on an issued invoice and it will appear here.')}
            action={<Link className="btn-primary" href="/payments/new">{tr('Registrar pago', 'Record payment')}</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-premium sm:min-w-[640px]">
              <thead>
                <tr>
                  <th>{tr('Fecha', 'Date')}</th>
                  <th>{tr('Documento', 'Document')}</th>
                  <th className="hidden sm:table-cell">{tr('Método', 'Method')}</th>
                  <th className="text-right">{tr('Importe', 'Amount')}</th>
                  <th className="hidden md:table-cell">{tr('Recibo', 'Receipt')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((payment) => {
                  const doc = payment.document_id ? linkedDocuments.get(payment.document_id) : undefined
                  const method = paymentMethodLabel(payment.payment_method, locale)
                  const receipt = receiptByPayment.get(payment.id)
                  return (
                    <tr key={payment.id}>
                      <td className="whitespace-nowrap text-slate-400">
                        {payment.paid_at || payment.created_at ? f.date(payment.paid_at ?? payment.created_at) : '—'}
                      </td>
                      <td>
                        {doc ? (
                          <Link className="font-semibold text-fg underline decoration-blue-400 underline-offset-4 hover:text-blue-400" href={`/documents/${doc.id}`}>
                            {documentTypeName(doc.document_type, locale)} {doc.document_number || doc.title || ''}
                          </Link>
                        ) : (
                          <span className="text-slate-500">
                            {payment.document_id ? tr('Documento no disponible', 'Document not available') : tr('Sin documento vinculado', 'No linked document')}
                          </span>
                        )}
                        <span className="mt-1.5 block sm:hidden"><span className="badge-neutral">{method}</span></span>
                        {(payment as { voided_at?: string | null }).voided_at && <span className="mt-1.5 block"><span className="badge-danger">{tr('Anulado: no cuenta como cobrado', 'Voided: not counted as collected')}</span></span>}
                      </td>
                      <td className="hidden sm:table-cell"><span className="badge-neutral">{method}</span></td>
                      <td className="text-right font-bold tabular-nums text-fg">{f.money(Number(payment.amount ?? 0))}</td>
                      <td className="hidden md:table-cell">
                        {receipt ? (
                          <Link className="text-sm font-semibold text-blue-400 hover:underline" href={`/documents/${receipt.id}`}>
                            {receipt.number ?? tr('Ver recibo', 'View receipt')}
                          </Link>
                        ) : (
                          <Link className="text-sm text-muted hover:text-fg" href="/documents/new?type=receipt">{tr('Crear recibo', 'Create receipt')}</Link>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav aria-label={tr('Páginas', 'Pages')} className="flex items-center justify-between gap-3 border-t border-line px-6 py-4 text-sm">
            {page > 1 ? <Link className="btn-secondary btn-sm" href={pageHref(page - 1)}>{tr('← Anterior', '← Previous')}</Link> : <span />}
            <span className="text-muted">{tr(`Página ${page} de ${pages}`, `Page ${page} of ${pages}`)}</span>
            {page < pages ? <Link className="btn-secondary btn-sm" href={pageHref(page + 1)}>{tr('Siguiente →', 'Next →')}</Link> : <span />}
          </nav>
        )}
      </section>
    </div>
  )
}


import { redirect } from 'next/navigation'
import Link from 'next/link'
import { EmptyState, PageHeader, StatCard } from '@/components/ui/page'
import { createClient } from '@/lib/supabase/server'

type LinkedDocument = {
  id: string
  document_number: string | null
  document_type: string | null
  title: string | null
}

function documentTypeLabel(value: string | null) {
  const types: Record<string, string> = {
    invoice: 'Factura',
    quote: 'Cotización',
    receipt: 'Recibo',
    work_order: 'Orden de trabajo',
    letter: 'Carta',
    payment_reminder: 'Recordatorio',
  }

  return types[value ?? ''] ?? 'Documento'
}

export default async function PaymentsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: member } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!member?.company_id) redirect('/dashboard')

  const { data: payments, error } = await supabase
    .from('payments')
    .select('id, document_id, amount, payment_method, reference, paid_at, created_at')
    .eq('company_id', member.company_id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('PAYMENTS_LOAD_ERROR:', { code: error.code, message: error.message })
  }

  // Documentos vinculados, en una sola consulta y limitados a la empresa.
  // Un pago cuyo documento fue eliminado (o sin documento) no genera un
  // enlace roto hacia /documents/[id].
  const documentIds = [
    ...new Set(
      (payments ?? [])
        .map((payment) => payment.document_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ),
  ]

  const linkedDocuments = new Map<string, LinkedDocument>()

  if (documentIds.length > 0) {
    const { data: docs, error: docsError } = await supabase
      .from('documents')
      .select('id, document_number, document_type, title')
      .eq('company_id', member.company_id)
      .in('id', documentIds)

    if (docsError) {
      console.error('PAYMENTS_DOCUMENTS_LOAD_ERROR:', {
        code: docsError.code,
        message: docsError.message,
      })
    }

    for (const doc of (docs ?? []) as LinkedDocument[]) {
      linkedDocuments.set(doc.id, doc)
    }
  }

  const rows = payments ?? []
  const total = rows.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0
  )

  const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
  const methodLabel = (method: string | null) =>
    method === 'manual' ? 'Registro manual' : method || 'No especificado'

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Cobros" title="Pagos y cobros" description="Historial de pagos registrados en tu empresa." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Total cobrado" value={usd(total)} hint={`${rows.length} ${rows.length === 1 ? 'pago registrado' : 'pagos registrados'}`} icon="wallet" tone="gold" />
      </div>

      <section className="card overflow-hidden" aria-labelledby="history-title">
        <div className="border-b border-stone-100 px-6 py-5">
          <h2 id="history-title" className="font-display text-2xl font-semibold tracking-tight text-ink-950">Historial de pagos</h2>
        </div>

        {error ? (
          <p className="alert-danger m-6">No se pudieron cargar los pagos. Revisa la conexión con Supabase.</p>
        ) : rows.length === 0 ? (
          <EmptyState icon="wallet" title="Todavía no hay pagos registrados."
            description="Registra los pagos desde cada documento y aparecerán aquí."
            action={<Link className="btn-primary" href="/documents">Ir a documentos</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-premium min-w-[640px]">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Documento</th>
                  <th>Método</th>
                  <th className="text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((payment) => {
                  const doc = payment.document_id ? linkedDocuments.get(payment.document_id) : undefined
                  return (
                    <tr key={payment.id}>
                      <td className="whitespace-nowrap text-stone-600">
                        {payment.paid_at || payment.created_at
                          ? new Date(payment.paid_at ?? payment.created_at).toLocaleDateString('es-PR')
                          : '—'}
                      </td>
                      <td>
                        {doc ? (
                          <Link className="font-semibold text-ink-950 underline decoration-gold-400 underline-offset-4 hover:text-gold-700" href={`/documents/${doc.id}`}>
                            {documentTypeLabel(doc.document_type)} {doc.document_number || doc.title || ''}
                          </Link>
                        ) : (
                          <span className="text-stone-400">
                            {payment.document_id ? 'Documento no disponible' : 'Sin documento vinculado'}
                          </span>
                        )}
                      </td>
                      <td><span className="badge-neutral">{methodLabel(payment.payment_method)}</span></td>
                      <td className="text-right font-bold tabular-nums text-ink-950">{usd(Number(payment.amount ?? 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

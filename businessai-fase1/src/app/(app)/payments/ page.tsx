import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

type PaymentRow = {
  id: string
  document_id: string
  amount: number | null
  payment_method: string | null
  reference: string | null
  paid_at: string
  created_at: string
}

type DocumentRow = {
  id: string
  document_number: string | null
  title: string | null
  client_id: string | null
}

type ClientRow = {
  id: string
  name: string | null
  business_name: string | null
}

function money(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value ?? 0))
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'

  return new Intl.DateTimeFormat('es-PR', {
    dateStyle: 'medium',
  }).format(new Date(value))
}

function paymentMethodLabel(value: string | null) {
  if (!value) return 'No especificado'

  const methods: Record<string, string> = {
    manual: 'Manual',
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    check: 'Cheque',
    other: 'Otro',
  }

  return methods[value] ?? value
}

export default async function PaymentsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: member } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.company_id) {
    redirect('/dashboard')
  }

  const companyId = member.company_id

  const { data: payments, error } = await supabase
    .from('payments')
    .select(
      'id, document_id, amount, payment_method, reference, paid_at, created_at'
    )
    .eq('company_id', companyId)
    .order('paid_at', { ascending: false })

  if (error) {
    console.error('PAYMENTS_LOAD_ERROR', error)
  }

  const paymentRows = (payments ?? []) as PaymentRow[]

  const documentIds = [
    ...new Set(
      paymentRows
        .map((payment) => payment.document_id)
        .filter(Boolean)
    ),
  ]

  let documents: DocumentRow[] = []

  if (documentIds.length > 0) {
    const { data: documentData } = await supabase
      .from('documents')
      .select('id, document_number, title, client_id')
      .eq('company_id', companyId)
      .in('id', documentIds)

    documents = (documentData ?? []) as DocumentRow[]
  }

  const clientIds = [
    ...new Set(
      documents
        .map((document) => document.client_id)
        .filter(Boolean)
    ),
  ]

  let clients: ClientRow[] = []

  if (clientIds.length > 0) {
    const { data: clientData } = await supabase
      .from('clients')
      .select('id, name, business_name')
      .eq('company_id', companyId)
      .in('id', clientIds)

    clients = (clientData ?? []) as ClientRow[]
  }

  const documentMap = new Map(
    documents.map((document) => [document.id, document])
  )

  const clientMap = new Map(
    clients.map((client) => [client.id, client])
  )

  const totalCollected = paymentRows.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0
  )

  const paymentCount = paymentRows.length

  const currentMonth = new Date()
  const currentYear = currentMonth.getFullYear()
  const currentMonthNumber = currentMonth.getMonth()

  const collectedThisMonth = paymentRows
    .filter((payment) => {
      const date = new Date(payment.paid_at)

      return (
        date.getFullYear() === currentYear &&
        date.getMonth() === currentMonthNumber
      )
    })
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0)

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <section className="mb-8 overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-blue-950 to-blue-700 p-6 text-white shadow-xl sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-blue-200">
                BusinessAI
              </p>

              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Pagos y cobros
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-blue-100 sm:text-base">
                Lleva el control de todo el dinero que tu empresa ha recibido,
                con cada pago conectado a su factura.
              </p>
            </div>

            <a
              href="/documents"
              className="inline-flex w-fit items-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-blue-50"
            >
              Ver documentos
            </a>
          </div>
        </section>

        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">
              Total cobrado
            </p>

            <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {money(totalCollected)}
            </p>

            <p className="mt-2 text-sm text-slate-500">
              Dinero registrado como recibido
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">
              Cobrado este mes
            </p>

            <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {money(collectedThisMonth)}
            </p>

            <p className="mt-2 text-sm text-slate-500">
              Pagos recibidos durante este mes
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">
              Pagos registrados
            </p>

            <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {paymentCount}
            </p>

            <p className="mt-2 text-sm text-slate-500">
              Transacciones guardadas
            </p>
          </div>
        </section>

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-5">
            <h2 className="text-xl font-bold text-slate-950">
              Historial de pagos
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Cada pago queda asociado a la factura correspondiente.
            </p>
          </div>

          {paymentRows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-2xl">
                💰
              </div>

              <h3 className="mt-5 text-lg font-semibold text-slate-950">
                Todavía no hay pagos registrados
              </h3>

              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
                Cuando marques una factura como pagada, BusinessAI registrará
                automáticamente el pago aquí.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {paymentRows.map((payment) => {
                const document = documentMap.get(payment.document_id)
                const client = document?.client_id
                  ? clientMap.get(document.client_id)
                  : undefined

                const clientName =
                  client?.business_name ||
                  client?.name ||
                  'Cliente no disponible'

                return (
                  <div
                    key={payment.id}
                    className="p-6 transition hover:bg-slate-50"
                  >
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                            Pago recibido
                          </span>

                          <span className="text-xs text-slate-400">
                            {formatDate(payment.paid_at)}
                          </span>
                        </div>

                        <h3 className="mt-3 text-lg font-bold text-slate-950">
                          {clientName}
                        </h3>

                        <p className="mt-1 text-sm text-slate-500">
                          {document?.document_number ||
                            document?.title ||
                            'Factura'}
                        </p>

                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-500">
                          <span>
                            Método:{' '}
                            <strong className="text-slate-700">
                              {paymentMethodLabel(payment.payment_method)}
                            </strong>
                          </span>

                          {payment.reference && (
                            <span>
                              Referencia:{' '}
                              <strong className="text-slate-700">
                                {payment.reference}
                              </strong>
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 lg:text-right">
                        <p className="text-2xl font-bold text-slate-950">
                          {money(payment.amount)}
                        </p>

                        <a
                          href={`/documents/${payment.document_id}`}
                          className="mt-2 inline-flex text-sm font-semibold text-blue-600 hover:text-blue-800"
                        >
                          Ver factura →
                        </a>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
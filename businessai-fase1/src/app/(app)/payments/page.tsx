
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export default async function PaymentsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: member } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!member?.company_id) redirect('/dashboard')

  const { data: payments, error } = await supabase
    .from('payments')
    .select('id, document_id, amount, payment_method, reference, paid_at, created_at')
    .eq('company_id', member.company_id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('PAYMENTS_LOAD_ERROR:', error)
  }

  const rows = payments ?? []
  const total = rows.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0
  )

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold text-slate-950">
          Pagos y cobros
        </h1>

        <p className="mt-2 text-slate-500">
          Historial de pagos de tu empresa.
        </p>

        <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">Total cobrado</p>
          <p className="mt-2 text-3xl font-bold text-slate-950">
            {new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
            }).format(total)}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {rows.length} pagos registrados
          </p>
        </section>

        <section className="mt-6 overflow-hidden rounded-2xl border bg-white">
          <div className="border-b p-5">
            <h2 className="text-xl font-bold">Historial de pagos</h2>
          </div>

          {error ? (
            <p className="p-6 text-red-600">
              No se pudieron cargar los pagos. Revisa la conexión con Supabase.
            </p>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="font-semibold">Todavía no hay pagos registrados.</p>
              <Link className="mt-4 inline-block text-blue-600 underline" href="/documents">
                Ir a documentos
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-4">Fecha</th>
                    <th className="p-4">Factura</th>
                    <th className="p-4">Método</th>
                    <th className="p-4 text-right">Importe</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((payment) => (
                    <tr key={payment.id} className="border-t">
                      <td className="p-4">
                        {payment.paid_at
                          ? new Date(payment.paid_at).toLocaleDateString('es-PR')
                          : '—'}
                      </td>
                      <td className="p-4">
                        <Link
                          className="text-blue-600 underline"
                          href={`/documents/${payment.document_id}`}
                        >
                          Ver factura
                        </Link>
                      </td>
                      <td className="p-4">
                        {payment.payment_method || 'No especificado'}
                      </td>
                      <td className="p-4 text-right font-semibold">
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        }).format(Number(payment.amount ?? 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

type ClientRow = {
  id: string
  name: string | null
  business_name: string | null
  email: string | null
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

async function createInvoice(formData: FormData) {
  'use server'

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: membership, error: membershipError } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (membershipError || !membership?.company_id) {
    redirect('/documents/new?type=invoice&error=company')
  }

  const companyId = membership.company_id

  const clientId = String(formData.get('client_id') ?? '').trim()
  const service = String(formData.get('service') ?? '').trim()
  const quantity = Number(formData.get('quantity') ?? 1)
  const unitPrice = Number(formData.get('unit_price') ?? 0)
  const taxRate = Number(formData.get('tax_rate') ?? 0)
  const issueDate =
    String(formData.get('issue_date') ?? '').trim() || today()
  const notes = String(formData.get('notes') ?? '').trim()

  if (!clientId || !service || !Number.isFinite(quantity) || quantity <= 0) {
    redirect('/documents/new?type=invoice&error=required')
  }

  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    redirect('/documents/new?type=invoice&error=price')
  }

  if (!Number.isFinite(taxRate) || taxRate < 0) {
    redirect('/documents/new?type=invoice&error=tax')
  }

  const subtotal = Number((quantity * unitPrice).toFixed(2))
  const tax = Number((subtotal * (taxRate / 100)).toFixed(2))
  const total = Number((subtotal + tax).toFixed(2))

  const { data: client } = await supabase
    .from('clients')
    .select('name, business_name')
    .eq('id', clientId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!client) {
    redirect('/documents/new?type=invoice&error=client')
  }

  const clientName =
    client.business_name?.trim() ||
    client.name?.trim() ||
    'Cliente'

  const documentNumber = `FAC-${new Date().getFullYear()}-${crypto
    .randomUUID()
    .slice(0, 8)
    .toUpperCase()}`

  const detailNotes = [
    `Servicio: ${service}`,
    `Cantidad: ${quantity}`,
    `Precio unitario: $${unitPrice.toFixed(2)}`,
    taxRate > 0 ? `Impuesto: ${taxRate}%` : null,
    notes ? `Notas: ${notes}` : null,
  ]
    .filter(Boolean)
    .join(' | ')

  const { data: document, error } = await supabase
    .from('documents')
    .insert({
      company_id: companyId,
      document_type: 'invoice',
      title: `Factura - ${clientName}`,
      document_number: documentNumber,
      client_id: clientId,
      issue_date: issueDate,
      subtotal,
      tax,
      total,
      status: 'draft',
      notes: detailNotes,
    })
    .select('id')
    .single()

  if (error || !document) {
    console.error('INVOICE_CREATE_ERROR', error)

    redirect('/documents/new?type=invoice&error=save')
  }

  revalidatePath('/documents')
  revalidatePath('/dashboard')

  redirect(`/documents/${document.id}`)
}

export default async function NewDocumentPage({
  searchParams,
}: {
  searchParams?: Promise<{
    type?: string
    error?: string
  }>
}) {
  const params = await searchParams
  const type = params?.type ?? 'invoice'
  const error = params?.error

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  if (!membership?.company_id) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700">
        No encontramos la empresa asociada a tu cuenta.
      </div>
    )
  }

  const { data: clients } = await supabase
    .from('clients')
    .select('id, name, business_name, email')
    .eq('company_id', membership.company_id)
    .order('name', { ascending: true })

  const clientList = (clients ?? []) as ClientRow[]

  if (type !== 'invoice') {
    return (
      <div className="space-y-6">
        <Link
          href="/documents"
          className="inline-flex text-sm font-semibold text-slate-600 hover:text-slate-950"
        >
          ← Volver a Documentos
        </Link>

        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-slate-950">
            Crear documento
          </h1>

          <p className="mt-2 text-slate-500">
            Por ahora estamos preparando el creador de facturas. Los demás
            documentos se añadirán a continuación.
          </p>

          <Link
            href="/documents/new?type=invoice"
            className="mt-6 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
          >
            Crear factura
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          href="/documents"
          className="inline-flex text-sm font-semibold text-slate-500 transition hover:text-slate-950"
        >
          ← Volver a Documentos
        </Link>

        <div className="mt-6 overflow-hidden rounded-3xl bg-slate-950 px-6 py-8 text-white shadow-xl sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-2xl">
              🧾
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-blue-300">
                BusinessAI
              </p>

              <h1 className="text-3xl font-bold tracking-tight">
                Nueva factura
              </h1>
            </div>
          </div>

          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">
            Crea una factura profesional seleccionando el cliente, indicando
            el servicio y calculando automáticamente subtotal, impuestos y
            total.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          {error === 'required' &&
            'Completa el cliente, el servicio y una cantidad válida.'}

          {error === 'price' &&
            'El precio debe ser un número válido mayor o igual a cero.'}

          {error === 'tax' &&
            'El impuesto debe ser un porcentaje válido.'}

          {error === 'client' &&
            'No pudimos encontrar ese cliente en tu empresa.'}

          {error === 'company' &&
            'No pudimos identificar la empresa de tu cuenta.'}

          {error === 'save' &&
            'No pudimos guardar la factura. Revisa la consola para ver el detalle.'}
        </div>
      )}

      <form action={createInvoice} className="space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-slate-950">
              Información del cliente
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Selecciona uno de tus clientes registrados.
            </p>
          </div>

          {clientList.length === 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <p className="font-semibold text-amber-900">
                Todavía no tienes clientes registrados.
              </p>

              <p className="mt-1 text-sm text-amber-800">
                Primero crea un cliente para poder facturarlo.
              </p>

              <Link
                href="/clients"
                className="mt-4 inline-flex rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white"
              >
                Ir a Clientes
              </Link>
            </div>
          ) : (
            <div>
              <label
                htmlFor="client_id"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Cliente *
              </label>

              <select
                id="client_id"
                name="client_id"
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
                defaultValue=""
              >
                <option value="" disabled>
                  Selecciona un cliente
                </option>

                {clientList.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.business_name || client.name || 'Cliente'}
                    {client.email ? ` — ${client.email}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-slate-950">
              Detalle del servicio
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Indica qué servicio o producto estás facturando.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label
                htmlFor="service"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Servicio o descripción *
              </label>

              <input
                id="service"
                name="service"
                type="text"
                required
                placeholder="Ej. Transporte médico"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div>
              <label
                htmlFor="quantity"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Cantidad *
              </label>

              <input
                id="quantity"
                name="quantity"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue="1"
                required
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div>
              <label
                htmlFor="unit_price"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Precio unitario *
              </label>

              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                  $
                </span>

                <input
                  id="unit_price"
                  name="unit_price"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  required
                  className="w-full rounded-xl border border-slate-300 py-3 pl-8 pr-4 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="tax_rate"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Impuesto %
              </label>

              <input
                id="tax_rate"
                name="tax_rate"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div>
              <label
                htmlFor="issue_date"
                className="mb-2 block text-sm font-semibold text-slate-800"
              >
                Fecha de factura
              </label>

              <input
                id="issue_date"
                name="issue_date"
                type="date"
                defaultValue={today()}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-slate-950">
              Notas
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Añade información adicional para el cliente.
            </p>
          </div>

          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Ej. Servicio realizado según coordinación previa."
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
          />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-slate-50 p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-500">
                Al guardar
              </p>

              <p className="mt-1 text-sm text-slate-600">
                BusinessAI calculará automáticamente subtotal, impuesto y total.
              </p>
            </div>

            <button
              type="submit"
              disabled={clientList.length === 0}
              className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-7 py-4 text-sm font-bold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Guardar factura →
            </button>
          </div>
        </section>
      </form>
    </div>
  )
}
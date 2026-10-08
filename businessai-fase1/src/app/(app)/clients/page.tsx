import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

async function getCompanyId() {
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
    redirect('/onboarding')
  }

  return {
    supabase,
    companyId: membership.company_id,
  }
}

async function createClientAction(formData: FormData) {
  'use server'

  const name = String(formData.get('name') ?? '').trim()

  if (!name) {
    redirect('/clients?error=missing_name')
  }

  const { supabase, companyId } = await getCompanyId()

  const { error } = await supabase.from('clients').insert({
    company_id: companyId,
    name,
    business_name: String(formData.get('business_name') ?? '').trim() || null,
    email: String(formData.get('email') ?? '').trim() || null,
    phone: String(formData.get('phone') ?? '').trim() || null,
    address: String(formData.get('address') ?? '').trim() || null,
    city: String(formData.get('city') ?? '').trim() || null,
    state: String(formData.get('state') ?? '').trim() || null,
    postal_code: String(formData.get('postal_code') ?? '').trim() || null,
    notes: String(formData.get('notes') ?? '').trim() || null,
    status: 'active',
  })

  if (error) {
    console.error('CLIENT_SAVE_ERROR:', error)
    redirect('/clients?error=save')
  }

  revalidatePath('/clients')
  revalidatePath('/dashboard')

  redirect('/clients?success=created')
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    success?: string
    error?: string
  }>
}) {
  const params = await searchParams
  const query = (params.q ?? '').trim()

  const { supabase, companyId } = await getCompanyId()

  let clientsQuery = supabase
    .from('clients')
    .select(
      'id, name, business_name, email, phone, address, city, state, postal_code, notes, status, created_at'
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })

  if (query) {
    clientsQuery = clientsQuery.or(
      `name.ilike.%${query}%,business_name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`
    )
  }

  const { data: clients, error } = await clientsQuery

  const totalClients = clients?.length ?? 0

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-slate-900 px-6 py-8 text-white shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-300">
              Clientes
            </p>

            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              Tus clientes, organizados en un solo lugar.
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Guarda la información de tus clientes y úsala después para
              preparar cotizaciones, facturas, documentos y seguimiento de
              cobros.
            </p>
          </div>

          <div className="rounded-xl bg-white/10 px-5 py-4">
            <p className="text-xs uppercase tracking-wide text-slate-300">
              Clientes registrados
            </p>
            <p className="mt-1 text-3xl font-bold">
              {totalClients}
            </p>
          </div>
        </div>
      </section>

      {params.success === 'created' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Cliente guardado correctamente.
        </div>
      )}

      {params.error === 'missing_name' && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
          El nombre del cliente es obligatorio.
        </div>
      )}

      {params.error === 'save' && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
          No se pudo guardar el cliente. Revisa la consola para ver el error.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Mis clientes
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Busca y administra los clientes de tu empresa.
              </p>
            </div>

            <form
              method="get"
              className="flex w-full gap-2 sm:w-auto"
            >
              <input
                name="q"
                defaultValue={query}
                placeholder="Buscar cliente..."
                className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 sm:w-64"
              />

              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Buscar
              </button>
            </form>
          </div>

          <div className="mt-6 overflow-x-auto">
            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
                No se pudieron cargar los clientes.
              </div>
            ) : clients && clients.length > 0 ? (
              <div className="min-w-[700px] divide-y divide-slate-100">
                {clients.map((client) => (
                  <div
                    key={client.id}
                    className="flex items-center justify-between gap-4 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">
                        {client.name}
                      </p>

                      {client.business_name && (
                        <p className="truncate text-sm text-slate-500">
                          {client.business_name}
                        </p>
                      )}

                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                        {client.email && <span>{client.email}</span>}
                        {client.phone && <span>{client.phone}</span>}
                        {client.city && <span>{client.city}</span>}
                      </div>
                    </div>

                    <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      {client.status === 'active'
                        ? 'Activo'
                        : client.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center">
                <p className="font-semibold text-slate-900">
                  {query
                    ? 'No encontramos clientes.'
                    : 'Todavía no tienes clientes.'}
                </p>

                <p className="mt-1 text-sm text-slate-500">
                  {query
                    ? 'Prueba con otro nombre, teléfono o correo.'
                    : 'Agrega tu primer cliente usando el formulario.'}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Nuevo cliente
          </p>

          <h2 className="mt-1 text-xl font-bold text-slate-900">
            Agregar cliente
          </h2>

          <p className="mt-2 text-sm text-slate-500">
            Una vez guardado, BusinessAI podrá reutilizar estos datos en
            documentos y procesos administrativos.
          </p>

          <form action={createClientAction} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Nombre *
              </label>

              <input
                name="name"
                required
                placeholder="Ej. Juan Pérez"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Empresa
              </label>

              <input
                name="business_name"
                placeholder="Nombre del negocio"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Correo
                </label>

                <input
                  name="email"
                  type="email"
                  placeholder="cliente@email.com"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Teléfono
                </label>

                <input
                  name="phone"
                  placeholder="787-000-0000"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Dirección
              </label>

              <input
                name="address"
                placeholder="Dirección física o postal"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Ciudad
                </label>

                <input
                  name="city"
                  placeholder="Ponce"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Estado
                </label>

                <input
                  name="state"
                  placeholder="PR"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  ZIP
                </label>

                <input
                  name="postal_code"
                  placeholder="00730"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Notas
              </label>

              <textarea
                name="notes"
                rows={3}
                placeholder="Información adicional del cliente..."
                className="w-full resize-none rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
            >
              Guardar cliente
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
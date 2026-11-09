import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { BILLING_ERROR_MESSAGE, billingErrorCode } from '@/lib/billing/state'
import { fetchUsage, isBlocked, usageNotice } from '@/lib/billing/usage'

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

  // Server-side check before inserting (the database enforces it too).
  if (isBlocked(await fetchUsage(supabase, companyId), 'clients')) {
    redirect('/clients?error=limit_clients')
  }

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
    // Subscription inactive or plan limit (enforced in the database, 0010).
    const billing = billingErrorCode(error)
    if (billing) redirect(`/clients?error=${billing}`)
    console.error('CLIENT_SAVE_ERROR:', { code: error.code, message: error.message })
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
  const usage = await fetchUsage(supabase, companyId)
  const clientNotice = usageNotice(usage.find((u) => u.metric === 'clients'))
  const clientsBlocked = clientNotice?.level === 'blocked'

  const totalClients = clients?.length ?? 0

  return (
    <div className="space-y-6">
      <section className="card-dark px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-stone-300">
              Clientes
            </p>

            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Tus clientes, organizados en un solo lugar.
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-stone-300">
              Guarda la información de tus clientes y úsala después para
              preparar cotizaciones, facturas, documentos y seguimiento de
              cobros.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.06] px-6 py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gold-300">
              Clientes registrados
            </p>
            <p className="mt-1 font-display text-4xl font-semibold">
              {totalClients}
            </p>
          </div>
        </div>
      </section>

      {clientNotice && (
        <div role={clientNotice.level === 'warning' ? 'status' : 'alert'}
          className={`font-medium ${clientNotice.level === 'warning' ? 'alert-warning' : 'alert-danger'}`}>
          {clientNotice.text}{' '}
          {clientNotice.offerUpgrade && <a href="/billing" className="underline">Mejorar plan</a>}
        </div>
      )}

      {params.success === 'created' && (
        <div className="alert-success font-medium">
          Cliente guardado correctamente.
        </div>
      )}

      {params.error === 'missing_name' && (
        <div className="alert-danger font-medium">
          El nombre del cliente es obligatorio.
        </div>
      )}

      {(params.error === 'billing' || params.error === 'limit_clients') && (
        <div role="alert" className="alert-warning font-medium">
          {BILLING_ERROR_MESSAGE[params.error]}{' '}
          <a href="/billing" className="underline">Ver planes</a>
        </div>
      )}

      {params.error === 'save' && (
        <div className="alert-danger font-medium">
          No se pudo guardar el cliente. Revisa la consola para ver el error.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="card p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-ink-900">
                Mis clientes
              </h2>

              <p className="mt-1 text-sm text-stone-500">
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
                className="field min-w-0 flex-1 py-2.5 sm:w-64"
              />

              <button
                type="submit"
                className="btn-primary py-2.5"
              >
                Buscar
              </button>
            </form>
          </div>

          <div className="mt-6 overflow-x-auto">
            {error ? (
              <div className="alert-danger py-4">
                No se pudieron cargar los clientes.
              </div>
            ) : clients && clients.length > 0 ? (
              <div className="min-w-[700px] divide-y divide-stone-100">
                {clients.map((client) => (
                  <div
                    key={client.id}
                    className="flex items-center justify-between gap-4 py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink-900">
                        {client.name}
                      </p>

                      {client.business_name && (
                        <p className="truncate text-sm text-stone-500">
                          {client.business_name}
                        </p>
                      )}

                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-400">
                        {client.email && <span>{client.email}</span>}
                        {client.phone && <span>{client.phone}</span>}
                        {client.city && <span>{client.city}</span>}
                      </div>
                    </div>

                    <span className="badge-success shrink-0">
                      {client.status === 'active'
                        ? 'Activo'
                        : client.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-gold-300/60 bg-gold-50/30 px-6 py-12 text-center">
                <p className="font-semibold text-ink-900">
                  {query
                    ? 'No encontramos clientes.'
                    : 'Todavía no tienes clientes.'}
                </p>

                <p className="mt-1 text-sm text-stone-500">
                  {query
                    ? 'Prueba con otro nombre, teléfono o correo.'
                    : 'Agrega tu primer cliente usando el formulario.'}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="card p-6">
          <p className="eyebrow">
            Nuevo cliente
          </p>

          <h2 className="mt-1.5 font-display text-2xl font-semibold text-ink-950">
            Agregar cliente
          </h2>

          <p className="mt-2 text-sm text-stone-500">
            Una vez guardado, BusinessAI podrá reutilizar estos datos en
            documentos y procesos administrativos.
          </p>

          <form action={createClientAction} className="mt-6 space-y-4">
            <div>
              <label className="field-label">
                Nombre *
              </label>

              <input
                name="name"
                required
                placeholder="Ej. Juan Pérez"
                className="field"
              />
            </div>

            <div>
              <label className="field-label">
                Empresa
              </label>

              <input
                name="business_name"
                placeholder="Nombre del negocio"
                className="field"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="field-label">
                  Correo
                </label>

                <input
                  name="email"
                  type="email"
                  placeholder="cliente@email.com"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Teléfono
                </label>

                <input
                  name="phone"
                  placeholder="787-000-0000"
                  className="field"
                />
              </div>
            </div>

            <div>
              <label className="field-label">
                Dirección
              </label>

              <input
                name="address"
                placeholder="Dirección física o postal"
                className="field"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="field-label">
                  Ciudad
                </label>

                <input
                  name="city"
                  placeholder="Ponce"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  Estado
                </label>

                <input
                  name="state"
                  placeholder="PR"
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">
                  ZIP
                </label>

                <input
                  name="postal_code"
                  placeholder="00730"
                  className="field"
                />
              </div>
            </div>

            <div>
              <label className="field-label">
                Notas
              </label>

              <textarea
                name="notes"
                rows={3}
                placeholder="Información adicional del cliente..."
                className="field resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={clientsBlocked}
              className="btn-primary btn-lg w-full"
            >
              {clientsBlocked ? 'Límite del plan alcanzado' : 'Guardar cliente'}
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
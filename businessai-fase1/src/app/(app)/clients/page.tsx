import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { searchTerm } from '@/lib/search'
import { createClient } from '@/lib/supabase/server'
import { billingErrorCode, billingErrorMessage } from '@/lib/billing/state'
import { fetchUsage, isBlocked, usageNotice } from '@/lib/billing/usage'
import { activeCompanyRow } from '@/lib/active-company'
import { parseClientInput } from '@/lib/clients'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { SubmitButton } from '@/components/submit-button'
import { crmAvailable } from '@/lib/documents/capabilities'

const PAGE_SIZE = 25

async function getCompanyId() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const membership = await activeCompanyRow(supabase, user.id)
  if (!membership?.company_id) redirect('/onboarding')
  return { supabase, companyId: membership.company_id as string }
}

async function createClientAction(formData: FormData) {
  'use server'
  // Same validation as editing a client (lib/clients): required name, lengths, email.
  const parsed = parseClientInput((key) => (key === 'status' ? 'active' : String(formData.get(key) ?? '')))
  if (!parsed.ok) redirect(`/clients?error=${parsed.error}#nuevo-cliente`)

  const { supabase, companyId } = await getCompanyId()
  // Server-side check before inserting (the database enforces it too).
  if (isBlocked(await fetchUsage(supabase, companyId), 'clients')) redirect('/clients?error=limit_clients')

  const { error } = await supabase.from('clients').insert({ company_id: companyId, ...parsed.value, status: 'active' })
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
  searchParams: Promise<{ q?: string; success?: string; error?: string; page?: string; status?: string }>
}) {
  const params = await searchParams
  const locale = await getLocale()
  const tr = translator(locale)
  const query = (params.q ?? '').trim()
  const term = searchTerm(query)
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.page ?? '1', 10) || 1))
  const { supabase, companyId } = await getCompanyId()
  const crm = await crmAvailable()
  const STATUS_FILTERS = ['active', 'inactive', 'archived', 'all'] as const
  const statusFilter = (STATUS_FILTERS as readonly string[]).includes(params.status ?? '') ? params.status! : 'active'

  const listQuery = (head: boolean) => {
    let q = supabase
      .from('clients')
      .select((crm ? 'id, name, business_name, email, phone, city, status, created_at, archived_at' : 'id, name, business_name, email, phone, city, status, created_at') as 'id', { count: 'exact', head })
      .eq('company_id', companyId)
    if (term) q = q.or(`name.ilike.%${term}%,business_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
    // Archived clients only appear when asked for (0019); without 0019 the filter is ignored.
    if (crm && statusFilter === 'archived') q = q.not('archived_at', 'is', null)
    else if (crm && statusFilter !== 'all') q = q.is('archived_at', null)
    if (statusFilter === 'active' || statusFilter === 'inactive') q = q.eq('status', statusFilter)
    return q
  }
  const href = (n: number) => {
    const sp = new URLSearchParams()
    if (query) sp.set('q', query)
    if (statusFilter !== 'active') sp.set('status', statusFilter)
    if (n > 1) sp.set('page', String(n))
    const qs = sp.toString()
    return `/clients${qs ? `?${qs}` : ''}`
  }
  const from = (page - 1) * PAGE_SIZE
  const { data: clientRows, count, error } = await listQuery(false)
    .order('created_at', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1)
  type ClientRow = { id: string; name: string; business_name: string | null; email: string | null; phone: string | null; city: string | null; status: string; archived_at?: string | null }
  const clients = (clientRows ?? []) as unknown as ClientRow[]
  if (page > 1 && (error || !clients.length)) {
    const { count: all } = await listQuery(true)
    const last = Math.max(1, Math.ceil((all ?? 0) / PAGE_SIZE))
    if (last < page) redirect(href(last))
  }
  const total = count ?? clients.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const usage = await fetchUsage(supabase, companyId)
  const clientNotice = usageNotice(usage.find((u) => u.metric === 'clients'), locale)
  const clientsBlocked = clientNotice?.level === 'blocked'

  const formError: Record<string, string> = {
    missing_name: tr('El nombre del cliente es obligatorio.', 'The client name is required.'),
    too_long: tr('Uno de los campos es demasiado largo.', 'One of the fields is too long.'),
    email: tr('Escribe un correo válido o déjalo vacío.', 'Enter a valid email or leave it empty.'),
    not_found: tr('No encontramos ese cliente en tu empresa.', 'We could not find that client in your company.'),
    save: tr('No se pudo guardar el cliente. Inténtalo nuevamente.', 'The client could not be saved. Please try again.'),
  }
  const billingText = params.error ? billingErrorMessage(params.error, locale) : null

  const input = (name: string, label: string, placeholder: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field-label">{label}
      <input name={name} placeholder={placeholder} className="field mt-2" {...props} />
    </label>
  )

  return (
    <div className="space-y-6">
      <section className="card-hero px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-muted">{tr('Clientes', 'Clients')}</p>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              {tr('Tus clientes, organizados en un solo lugar.', 'Your clients, organized in one place.')}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              {tr('Guarda la información de tus clientes y úsala después para preparar cotizaciones, facturas, documentos y seguimiento de cobros.',
                'Keep your clients\' details and reuse them for quotes, invoices, documents and collections.')}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-card/[0.06] px-6 py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-accent">{term ? tr('Resultados', 'Results') : tr('Clientes registrados', 'Clients')}</p>
            <p className="mt-1 font-display text-4xl font-semibold">{total}</p>
          </div>
        </div>
      </section>

      {clientNotice && (
        <div role={clientNotice.level === 'warning' ? 'status' : 'alert'}
          className={`font-medium ${clientNotice.level === 'warning' ? 'alert-warning' : 'alert-danger'}`}>
          {clientNotice.text}{' '}
          {clientNotice.offerUpgrade && <a href="/billing" className="underline">{tr('Mejorar plan', 'Upgrade plan')}</a>}
        </div>
      )}

      {(params.success === 'created' || params.success === 'updated') && (
        <div role="status" className="alert-success font-medium">
          {params.success === 'updated' ? tr('Cliente actualizado correctamente.', 'Client updated.') : tr('Cliente guardado correctamente.', 'Client saved.')}
        </div>
      )}
      {params.success === 'deleted' && (
        <div role="status" className="alert-success font-medium">
          {tr('Cliente eliminado.', 'Client deleted.')}
        </div>
      )}
      {params.error && billingText && (
        <div role="alert" className="alert-warning font-medium">
          {billingText}{' '}<a href="/billing" className="underline">{tr('Ver planes', 'See plans')}</a>
        </div>
      )}
      {params.error && !billingText && (
        <div role="alert" className="alert-danger font-medium">{formError[params.error] ?? formError.save}</div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="card min-w-0 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-fg">{tr('Mis clientes', 'My clients')}</h2>
              <p className="mt-1 text-sm text-muted">{tr('Busca y administra los clientes de tu empresa.', 'Search and manage your company\'s clients.')}</p>
            </div>
            <form method="get" className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap" role="search">
              <input name="q" defaultValue={query} maxLength={60} aria-label={tr('Buscar cliente', 'Search client')}
                placeholder={tr('Buscar cliente...', 'Search client...')} className="field min-w-0 flex-1 py-2.5 sm:w-56" />
              <select name="status" defaultValue={statusFilter} aria-label={tr('Estado', 'Status')} className="field w-auto py-2.5">
                <option value="active">{tr('Activos', 'Active')}</option>
                <option value="inactive">{tr('Inactivos', 'Inactive')}</option>
                {crm && <option value="archived">{tr('Archivados', 'Archived')}</option>}
                <option value="all">{tr('Todos', 'All')}</option>
              </select>
              <button type="submit" className="btn-primary py-2.5">{tr('Buscar', 'Search')}</button>
            </form>
          </div>

          <div className="mt-6 overflow-x-auto">
            {error ? (
              <div className="alert-danger py-4">{tr('No se pudieron cargar los clientes.', 'Clients could not be loaded.')}</div>
            ) : clients && clients.length > 0 ? (
              <div className="divide-y divide-line">
                {clients.map((client) => (
                  <div key={client.id} className="flex items-center justify-between gap-4 py-4">
                    <div className="min-w-0">
                      <Link href={`/clients/${client.id}`} className="block truncate font-semibold text-fg hover:text-blue-400">{client.name}</Link>
                      {client.business_name && <p className="truncate text-sm text-muted">{client.business_name}</p>}
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        {client.email && <span>{client.email}</span>}
                        {client.phone && <span>{client.phone}</span>}
                        {client.city && <span>{client.city}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {client.archived_at ? (
                        <span className="badge-neutral">{tr('Archivado', 'Archived')}</span>
                      ) : (
                        <span className={client.status === 'inactive' ? 'badge-neutral' : 'badge-success'}>
                          {client.status === 'inactive' ? tr('Inactivo', 'Inactive') : tr('Activo', 'Active')}
                        </span>
                      )}
                      <Link href={`/clients/${client.id}`} className="btn-secondary btn-sm" aria-label={`${tr('Ver', 'View')} ${client.name}`}>
                        {tr('Ver', 'View')}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-electric/50 bg-electric/10 px-6 py-12 text-center">
                <p className="font-semibold text-fg">{query ? tr('No encontramos clientes.', 'No clients found.') : tr('Todavía no tienes clientes.', 'You have no clients yet.')}</p>
                <p className="mt-1 text-sm text-muted">
                  {query ? tr('Prueba con otro nombre, teléfono o correo.', 'Try another name, phone or email.') : tr('Agrega tu primer cliente usando el formulario.', 'Add your first client with the form.')}
                </p>
              </div>
            )}
          </div>
          {pages > 1 && (
            <nav aria-label={tr('Páginas', 'Pages')} className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4 text-sm">
              {page > 1 ? <Link className="btn-secondary btn-sm" href={href(page - 1)}>{tr('← Anterior', '← Previous')}</Link> : <span />}
              <span className="text-muted">{tr(`Página ${page} de ${pages}`, `Page ${page} of ${pages}`)}</span>
              {page < pages ? <Link className="btn-secondary btn-sm" href={href(page + 1)}>{tr('Siguiente →', 'Next →')}</Link> : <span />}
            </nav>
          )}
        </section>

        <section id="nuevo-cliente" className="card min-w-0 scroll-mt-24 p-6">
          <p className="eyebrow">{tr('Nuevo cliente', 'New client')}</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold text-fg">{tr('Agregar cliente', 'Add client')}</h2>
          <p className="mt-2 text-sm text-muted">
            {tr('Una vez guardado, podrás reutilizar estos datos en documentos y procesos administrativos.',
              'Once saved, you can reuse these details in documents and administrative work.')}
          </p>
          <form action={createClientAction} className="mt-6 space-y-4">
            {input('name', tr('Nombre *', 'Name *'), tr('Ej. Juan Pérez', 'e.g. John Smith'), { required: true, maxLength: 160 })}
            {input('business_name', tr('Empresa', 'Company'), tr('Nombre del negocio', 'Business name'), { maxLength: 160 })}
            <div className="grid gap-4 sm:grid-cols-2">
              {input('email', tr('Correo', 'Email'), 'cliente@email.com', { type: 'email', maxLength: 160 })}
              {input('phone', tr('Teléfono', 'Phone'), '787-000-0000', { maxLength: 40 })}
            </div>
            {input('address', tr('Dirección', 'Address'), tr('Dirección física o postal', 'Street or mailing address'), { maxLength: 240 })}
            <div className="grid gap-4 sm:grid-cols-3">
              {input('city', tr('Ciudad', 'City'), 'Ponce', { maxLength: 80 })}
              {input('state', tr('Estado', 'State'), 'PR', { maxLength: 80 })}
              {input('postal_code', 'ZIP', '00730', { maxLength: 20 })}
            </div>
            <label className="field-label">{tr('Notas', 'Notes')}
              <textarea name="notes" rows={3} maxLength={2000} placeholder={tr('Información adicional del cliente...', 'Additional client information...')} className="field mt-2 resize-none" />
            </label>
            {clientsBlocked ? (
              <button type="button" disabled className="btn-primary btn-lg w-full">{tr('Límite del plan alcanzado', 'Plan limit reached')}</button>
            ) : (
              <SubmitButton pendingLabel={tr('Guardando…', 'Saving…')}>{tr('Guardar cliente', 'Save client')}</SubmitButton>
            )}
          </form>
        </section>
      </div>
    </div>
  )
}

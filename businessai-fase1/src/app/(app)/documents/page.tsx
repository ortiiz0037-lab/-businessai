import Link from 'next/link'
import { redirect } from 'next/navigation'
import { searchTerm } from '@/lib/search'
import { createClient } from '@/lib/supabase/server'
import { Icon } from '@/components/ui/icon'
import { StatusBadge, documentIcon } from '@/components/ui/status'
import { activeCompanyRow } from '@/lib/active-company'
import { effectiveStatus, isDocumentType, todayIn } from '@/lib/documents/lifecycle'

type DocumentRow = {
  id: string
  document_type: string
  document_number: string | null
  title: string | null
  status: string
  total: number | null
  due_date: string | null
  client_id: string | null
  created_at: string
}

const PAGE_SIZE = 20

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Todos los estados' },
  { value: 'draft', label: 'Borradores' },
  { value: 'pending', label: 'Facturas por cobrar' },
  { value: 'overdue', label: 'Facturas vencidas' },
  { value: 'paid', label: 'Pagados' },
  { value: 'sent', label: 'Enviados (sin vencer)' },
  { value: 'accepted', label: 'Cotizaciones aceptadas' },
  { value: 'rejected', label: 'Cotizaciones rechazadas' },
  { value: 'cancelled', label: 'Anulados' },
]


const documentTypes = [
  {
    type: 'quote',
    title: 'Cotización',
    description: 'Crea una cotización profesional para tus clientes.',
  },
  {
    type: 'invoice',
    title: 'Factura',
    description: 'Crea facturas y lleva control de tus cuentas por cobrar.',
  },
  {
    type: 'receipt',
    title: 'Recibo',
    description: 'Registra pagos recibidos de tus clientes.',
  },
  {
    type: 'work_order',
    title: 'Orden de trabajo',
    description: 'Organiza servicios, trabajos y órdenes pendientes.',
  },
  {
    type: 'letter',
    title: 'Carta comercial',
    description: 'Genera cartas y comunicaciones profesionales.',
  },
  {
    type: 'payment_reminder',
    title: 'Recordatorio de pago',
    description: 'Prepara recordatorios para cuentas pendientes.',
  },
]

function formatMoney(value: number | null) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value ?? 0)
}

function typeLabel(type: string) {
  const found = documentTypes.find((item) => item.type === type)
  return found?.title ?? 'Documento'
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; type?: string; status?: string; page?: string; done?: string; error?: string }>
}) {
  const params = (await searchParams) ?? {}
  const q = searchTerm(params.q ?? '')
  const typeFilter = params.type && isDocumentType(params.type) ? params.type : ''
  const statusFilter = STATUS_FILTERS.some((f) => f.value === params.status) ? (params.status ?? '') : ''
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.page ?? '1', 10) || 1))
  const today = todayIn()
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return null
  }

  const membership = await activeCompanyRow(supabase, user.id)

  const companyId = membership?.company_id

  let documents: DocumentRow[] = []
  let total = 0
  const paidByDoc = new Map<string, number>()
  const clientName = new Map<string, string>()

  if (companyId) {
    let clientMatches: string[] = []
    if (q) {
      // Number, title, or the name of the client.
      const { data: matching } = await supabase
        .from('clients').select('id').eq('company_id', companyId)
        .or(`name.ilike.%${q}%,business_name.ilike.%${q}%`).limit(200)
      clientMatches = (matching ?? []).map((c) => c.id as string)
    }
    // The same filters for the page and for the total count.
    const filteredQuery = (head: boolean) => {
      let query = supabase
        .from('documents')
        .select('id, document_type, document_number, title, status, total, due_date, client_id, created_at', { count: 'exact', head })
        .eq('company_id', companyId)
      if (typeFilter) query = query.eq('document_type', typeFilter)
      if (statusFilter === 'pending') {
        query = query.eq('document_type', 'invoice').in('status', ['sent', 'overdue'])
      } else if (statusFilter === 'overdue') {
        query = query.eq('document_type', 'invoice').in('status', ['sent', 'overdue']).lt('due_date', today)
      } else if (statusFilter === 'sent') {
        // M8: what the list shows as "sent": issued and not past due
        // (a past-due invoice is listed under "Facturas vencidas").
        query = query.eq('status', 'sent').or(`document_type.neq.invoice,due_date.is.null,due_date.gte.${today}`)
      } else if (statusFilter) {
        query = query.eq('status', statusFilter)
      }
      if (q) {
        query = query.or([`document_number.ilike.%${q}%`, `title.ilike.%${q}%`,
          ...(clientMatches.length ? [`client_id.in.(${clientMatches.join(',')})`] : [])].join(','))
      }
      return query
    }

    const from = (page - 1) * PAGE_SIZE
    const { data, count, error: listError } = await filteredQuery(false)
      .order('created_at', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1)
    if (page > 1 && (listError || !(data ?? []).length)) {
      // M2: a page past the end (or a stale link) goes to the last page instead of "no documents".
      const { count: all } = await filteredQuery(true)
      const last = Math.max(1, Math.ceil((all ?? 0) / PAGE_SIZE))
      if (last < page) {
        const sp = new URLSearchParams()
        if (q) sp.set('q', q)
        if (typeFilter) sp.set('type', typeFilter)
        if (statusFilter) sp.set('status', statusFilter)
        if (last > 1) sp.set('page', String(last))
        const qs = sp.toString()
        redirect(`/documents${qs ? `?${qs}` : ''}#lista`)
      }
    }
    documents = (data ?? []) as DocumentRow[]
    total = count ?? documents.length

    const invoiceIds = documents.filter((d) => d.document_type === 'invoice').map((d) => d.id)
    const clientIds = [...new Set(documents.map((d) => d.client_id).filter((v): v is string => !!v))]
    const [{ data: pays }, { data: clients }] = await Promise.all([
      invoiceIds.length ? supabase.from('payments').select('document_id, amount').in('document_id', invoiceIds) : Promise.resolve({ data: [] }),
      clientIds.length ? supabase.from('clients').select('id, name, business_name').in('id', clientIds) : Promise.resolve({ data: [] }),
    ])
    for (const p of (pays ?? []) as { document_id: string; amount: number }[]) {
      paidByDoc.set(p.document_id, (paidByDoc.get(p.document_id) ?? 0) + Number(p.amount ?? 0))
    }
    for (const c of (clients ?? []) as { id: string; name: string | null; business_name: string | null }[]) {
      clientName.set(c.id, c.business_name || c.name || '')
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtered = Boolean(q || typeFilter || statusFilter)
  const pageHref = (n: number) => {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    if (typeFilter) sp.set('type', typeFilter)
    if (statusFilter) sp.set('status', statusFilter)
    if (n > 1) sp.set('page', String(n))
    const qs = sp.toString()
    return `/documents${qs ? `?${qs}` : ''}#lista`
  }

  return (
    <div className="space-y-8">
      {/* HERO */}
      <section className="card-hero px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-electric/25 bg-brand/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-electric" />
              Facturación y documentos
            </div>

            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">
              Documentos
            </h1>

            <p className="mt-3 text-sm leading-6 text-white/60 sm:text-base">
              Crea y administra cotizaciones, facturas, recibos y documentos
              comerciales desde un solo lugar.
            </p>
          </div>

          <Link
            href="#crear-documento"
            className="btn-accent btn-lg"
          >
            <Icon name="plus" className="h-4 w-4" /> Nuevo documento
          </Link>
        </div>
      </section>

      {/* CREAR DOCUMENTO */}
      <section id="crear-documento">
        <div className="mb-5">
          <p className="eyebrow">Nuevo</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">
            Crear un documento
          </h2>

          <p className="mt-1 text-sm text-muted">
            Selecciona el tipo de documento que necesitas.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {documentTypes.map((item) => (
            <Link
              key={item.type}
              href={`/documents/new?type=${item.type}`}
              className="card-interactive group p-6"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-app-2 text-accent transition group-hover:bg-brand group-hover:text-fg">
                  <Icon name={documentIcon(item.type)} />
                </div>

                <span className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 transition group-hover:text-blue-400">
                  Crear <Icon name="arrowRight" className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </span>
              </div>

              <h3 className="mt-5 text-lg font-bold text-fg">
                {item.title}
              </h3>

              <p className="mt-2 text-sm leading-6 text-muted">
                {item.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* DOCUMENTOS */}
      <section id="lista" className="scroll-mt-24">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Historial</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">Todos los documentos</h2>
            <p className="mt-1 text-sm text-muted">Busca por número, título o cliente, y filtra por tipo o estado.</p>
          </div>
          <span className="badge-neutral">{total} documento{total === 1 ? '' : 's'}</span>
        </div>

        {params.done === 'deleted' && <div role="status" className="alert-success mb-4 p-4">Borrador eliminado.</div>}
        {params.error === 'not_found' && <div role="alert" className="alert-danger mb-4 p-4">No encontramos ese documento en tu empresa.</div>}

        <form method="get" action="/documents#lista" className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_200px_220px_auto]">
          <input name="q" defaultValue={q} placeholder="Buscar número, título o cliente" aria-label="Buscar documentos" className="field" />
          <select name="type" defaultValue={typeFilter} aria-label="Tipo de documento" className="field">
            <option value="">Todos los tipos</option>
            {documentTypes.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
          </select>
          <select name="status" defaultValue={statusFilter} aria-label="Estado" className="field">
            {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1 lg:flex-none">Buscar</button>
            {filtered && <Link href="/documents#lista" className="btn-secondary">Limpiar</Link>}
          </div>
        </form>

        {documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-electric/50 bg-electric/10 p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-electric/10 text-blue-400 ring-1 ring-inset ring-electric/30">
              <Icon name="file" className="h-6 w-6" />
            </span>
            <h3 className="mt-4 font-semibold text-fg">
              {filtered ? 'No hay documentos con esos filtros' : 'Todavía no tienes documentos'}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
              {filtered
                ? 'Prueba con otro texto, tipo o estado.'
                : 'Crea tu primera factura, cotización u otro documento comercial utilizando las opciones de arriba.'}
            </p>
            {!filtered && (
              <Link href="#crear-documento" className="btn-primary mt-5">
                Crear mi primer documento <Icon name="arrowRight" className="h-4 w-4" />
              </Link>
            )}
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="divide-y divide-line">
              {documents.map((document) => {
                const status = effectiveStatus(document, paidByDoc.get(document.id) ?? 0, today)
                const client = document.client_id ? clientName.get(document.client_id) : ''
                return (
                  <Link key={document.id} href={`/documents/${document.id}`} className="group block transition hover:bg-electric/10">
                    <div className="flex items-center justify-between gap-4 p-4 sm:p-5">
                      <div className="flex min-w-0 items-center gap-4">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-elevated text-slate-300 transition group-hover:bg-app-2 group-hover:text-accent">
                          <Icon name={documentIcon(document.document_type)} />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-fg">{document.title || typeLabel(document.document_type)}</p>
                          <p className="mt-1 truncate text-sm text-muted">
                            {typeLabel(document.document_type)}
                            {document.document_number ? ` · ${document.document_number}` : ''}
                            {client ? ` · ${client}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <span className="hidden sm:inline-flex"><StatusBadge status={status} /></span>
                        <div className="text-right">
                          <p className="font-bold tabular-nums text-fg">{formatMoney(document.total)}</p>
                          <p className="mt-1 sm:hidden"><StatusBadge status={status} /></p>
                        </div>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Páginas" className="mt-4 flex items-center justify-between gap-3">
            {page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">← Anterior</Link> : <span />}
            <span className="text-sm text-muted">Página {Math.min(page, pages)} de {pages}</span>
            {page < pages ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Siguiente →</Link> : <span />}
          </nav>
        )}
      </section>
    </div>
  )
}
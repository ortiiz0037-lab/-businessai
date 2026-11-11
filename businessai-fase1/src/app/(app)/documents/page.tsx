import Link from 'next/link'
import { redirect } from 'next/navigation'
import { searchTerm } from '@/lib/search'
import { createClient } from '@/lib/supabase/server'
import { Icon } from '@/components/ui/icon'
import { StatusBadge, documentIcon } from '@/components/ui/status'
import { activeCompanyRow } from '@/lib/active-company'
import { effectiveStatus, isDocumentType, todayIn } from '@/lib/documents/lifecycle'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator, type Tr } from '@/lib/i18n/t'

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

const STATUS_VALUES = ['', 'draft', 'pending', 'overdue', 'paid', 'sent', 'accepted', 'rejected', 'cancelled'] as const

const statusFilters = (tr: Tr): { value: string; label: string }[] => [
  { value: '', label: tr('Todos los estados', 'All statuses') },
  { value: 'draft', label: tr('Borradores', 'Drafts') },
  { value: 'pending', label: tr('Facturas por cobrar', 'Invoices to collect') },
  { value: 'overdue', label: tr('Facturas vencidas', 'Overdue invoices') },
  { value: 'paid', label: tr('Pagados', 'Paid') },
  { value: 'sent', label: tr('Enviados (sin vencer)', 'Sent (not overdue)') },
  { value: 'accepted', label: tr('Cotizaciones aceptadas', 'Accepted quotes') },
  { value: 'rejected', label: tr('Cotizaciones rechazadas', 'Rejected quotes') },
  { value: 'cancelled', label: tr('Anulados', 'Voided') },
]

const documentTypesFor = (tr: Tr) => [
  { type: 'quote', title: tr('Cotización', 'Quote'), description: tr('Crea una cotización profesional para tus clientes.', 'Create a professional quote for your clients.') },
  { type: 'invoice', title: tr('Factura', 'Invoice'), description: tr('Crea facturas y lleva control de tus cuentas por cobrar.', 'Create invoices and track your receivables.') },
  { type: 'receipt', title: tr('Recibo', 'Receipt'), description: tr('Emite el recibo de un pago registrado.', 'Issue the receipt of a recorded payment.') },
  { type: 'work_order', title: tr('Orden de trabajo', 'Work order'), description: tr('Organiza servicios, trabajos y órdenes pendientes.', 'Organize services, jobs and pending orders.') },
  { type: 'letter', title: tr('Carta comercial', 'Business letter'), description: tr('Genera cartas y comunicaciones profesionales.', 'Write professional letters and communications.') },
  { type: 'payment_reminder', title: tr('Recordatorio de pago', 'Payment reminder'), description: tr('Prepara recordatorios para cuentas pendientes.', 'Prepare reminders for open balances.') },
]

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; type?: string; status?: string; page?: string; done?: string; error?: string }>
}) {
  const params = (await searchParams) ?? {}
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const STATUS_FILTERS = statusFilters(tr)
  const documentTypes = documentTypesFor(tr)
  const typeLabel = (type: string) => documentTypes.find((item) => item.type === type)?.title ?? tr('Documento', 'Document')
  const q = searchTerm(params.q ?? '')
  const typeFilter = params.type && isDocumentType(params.type) ? params.type : ''
  const statusFilter = (STATUS_VALUES as readonly string[]).includes(params.status ?? '') ? (params.status ?? '') : ''
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
              {tr('Facturación y documentos', 'Billing and documents')}
            </div>

            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">
              {tr('Documentos', 'Documents')}
            </h1>

            <p className="mt-3 text-sm leading-6 text-white/60 sm:text-base">
              {tr('Crea y administra cotizaciones, facturas, recibos y documentos comerciales desde un solo lugar.',
                'Create and manage quotes, invoices, receipts and business documents in one place.')}
            </p>
          </div>

          <Link
            href="#crear-documento"
            className="btn-accent btn-lg"
          >
            <Icon name="plus" className="h-4 w-4" /> {tr('Nuevo documento', 'New document')}
          </Link>
        </div>
      </section>

      {/* CREAR DOCUMENTO */}
      <section id="crear-documento">
        <div className="mb-5">
          <p className="eyebrow">{tr('Nuevo', 'New')}</p>
          <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">
            {tr('Crear un documento', 'Create a document')}
          </h2>

          <p className="mt-1 text-sm text-muted">
            {tr('Selecciona el tipo de documento que necesitas.', 'Choose the type of document you need.')}
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
                  {tr('Crear', 'Create')} <Icon name="arrowRight" className="h-4 w-4 transition group-hover:translate-x-0.5" />
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
            <p className="eyebrow">{tr('Historial', 'History')}</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg">{tr('Todos los documentos', 'All documents')}</h2>
            <p className="mt-1 text-sm text-muted">{tr('Busca por número, título o cliente, y filtra por tipo o estado.', 'Search by number, title or client, and filter by type or status.')}</p>
          </div>
          <span className="badge-neutral">{total === 1 ? tr('1 documento', '1 document') : tr(`${total} documentos`, `${total} documents`)}</span>
        </div>

        {params.done === 'deleted' && <div role="status" className="alert-success mb-4 p-4">{tr('Borrador eliminado.', 'Draft deleted.')}</div>}
        {params.error === 'not_found' && <div role="alert" className="alert-danger mb-4 p-4">{tr('No encontramos ese documento en tu empresa.', 'We could not find that document in your company.')}</div>}

        <form method="get" action="/documents#lista" className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_200px_220px_auto]">
          <input name="q" defaultValue={q} placeholder={tr('Buscar número, título o cliente', 'Search number, title or client')} aria-label={tr('Buscar documentos', 'Search documents')} maxLength={60} className="field" />
          <select name="type" defaultValue={typeFilter} aria-label={tr('Tipo de documento', 'Document type')} className="field">
            <option value="">{tr('Todos los tipos', 'All types')}</option>
            {documentTypes.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
          </select>
          <select name="status" defaultValue={statusFilter} aria-label={tr('Estado', 'Status')} className="field">
            {STATUS_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1 lg:flex-none">{tr('Buscar', 'Search')}</button>
            {filtered && <Link href="/documents#lista" className="btn-secondary">{tr('Limpiar', 'Clear')}</Link>}
          </div>
        </form>

        {documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-electric/50 bg-electric/10 p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-electric/10 text-blue-400 ring-1 ring-inset ring-electric/30">
              <Icon name="file" className="h-6 w-6" />
            </span>
            <h3 className="mt-4 font-semibold text-fg">
              {filtered ? tr('No hay documentos con esos filtros', 'No documents match those filters') : tr('Todavía no tienes documentos', 'You have no documents yet')}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
              {filtered
                ? tr('Prueba con otro texto, tipo o estado.', 'Try another text, type or status.')
                : tr('Crea tu primera factura, cotización u otro documento comercial utilizando las opciones de arriba.', 'Create your first invoice, quote or other business document with the options above.')}
            </p>
            {!filtered && (
              <Link href="#crear-documento" className="btn-primary mt-5">
                {tr('Crear mi primer documento', 'Create my first document')} <Icon name="arrowRight" className="h-4 w-4" />
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
                        <span className="hidden sm:inline-flex"><StatusBadge status={status} locale={locale} /></span>
                        <div className="text-right">
                          <p className="font-bold tabular-nums text-fg">{f.money(Number(document.total ?? 0))}</p>
                          <p className="mt-1 sm:hidden"><StatusBadge status={status} locale={locale} /></p>
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
          <nav aria-label={tr('Páginas', 'Pages')} className="mt-4 flex items-center justify-between gap-3">
            {page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">{tr('← Anterior', '← Previous')}</Link> : <span />}
            <span className="text-sm text-muted">{tr(`Página ${Math.min(page, pages)} de ${pages}`, `Page ${Math.min(page, pages)} of ${pages}`)}</span>
            {page < pages ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">{tr('Siguiente →', 'Next →')}</Link> : <span />}
          </nav>
        )}
      </section>
    </div>
  )
}
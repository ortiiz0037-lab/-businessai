import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { StatusBadge, documentIcon, documentTypeName } from '@/components/ui/status'
import { Icon } from '@/components/ui/icon'
import { EmptyState } from '@/components/ui/page'
import { effectiveStatus, todayIn } from '@/lib/documents/lifecycle'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { fetchAllPages, paidByDocument } from '@/lib/supabase/paged'
import { crmAvailable } from '@/lib/documents/capabilities'
import { clientSummary } from '@/lib/clients'
import { formatters } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { deleteClient, setClientArchived } from '@/app/actions/clients'
import { ClientCrm, CLIENT_ERRORS } from '@/components/client-crm'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 15

type Client = {
  id: string; company_id: string; name: string; business_name: string | null; email: string | null; phone: string | null
  address: string | null; city: string | null; state: string | null; postal_code: string | null; notes: string | null
  status: string; created_at: string; archived_at?: string | null
  kind?: string; legal_name?: string | null; tax_id?: string | null; lifecycle?: string; source?: string | null; owner_id?: string | null; branch_id?: string | null
}
type Doc = { id: string; document_type: string; document_number: string | null; title: string | null; status: string; total: number | null; due_date: string | null; issue_date: string | null; created_at: string }
type Activity = { at: string; text: string }

/** Client record: details, totals, documents, payments and activity. */
export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string; done?: string; error?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  if (!UUID.test(id)) redirect('/clients?error=not_found')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const crm = await crmAvailable()
  const { data } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
  if (!data) redirect('/clients?error=not_found')
  const client = data as Client
  const { data: member } = await supabase.from('memberships').select('role, status')
    .eq('user_id', user.id).eq('company_id', client.company_id).maybeSingle()
  if (!member || member.status === 'suspended') redirect('/clients?error=not_found')
  const manager = member.role === 'owner' || member.role === 'admin'

  // Every invoice of the client for the totals (all pages), and the page of documents.
  const invoices = await fetchAllPages<{ id: string; status: string; total: number | null }>((from, to) =>
    supabase.from('documents').select('id, status, total').eq('company_id', client.company_id).eq('client_id', id)
      .eq('document_type', 'invoice').order('id').range(from, to))
  const paid = await paidByDocument(supabase, invoices.rows.map((d) => d.id))
  const summary = clientSummary(invoices.rows, paid)

  const page = Math.max(1, Math.min(10_000, Number.parseInt(query.page ?? '1', 10) || 1))
  const from = (page - 1) * PAGE_SIZE
  const { data: docsData, count } = await supabase.from('documents')
    .select('id, document_type, document_number, title, status, total, due_date, issue_date, created_at', { count: 'exact' })
    .eq('company_id', client.company_id).eq('client_id', id)
    .order('created_at', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1)
  const docs = (docsData ?? []) as Doc[]
  const total = count ?? docs.length
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (page > pages) redirect(`/clients/${id}`)
  const today = todayIn()

  const recentInvoiceIds = invoices.rows.slice(-100).map((d) => d.id)
  const [{ data: paymentsData }, { data: clientEvents }, { data: docEvents }] = await Promise.all([
    recentInvoiceIds.length
      ? supabase.from('payments').select('*').in('document_id', recentInvoiceIds)
          .order('paid_at', { ascending: false }).limit(15)
      : Promise.resolve({ data: [] }),
    crm ? supabase.from('client_events').select('event, fields, created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(20)
        : Promise.resolve({ data: [] }),
    docs.length ? supabase.from('document_events').select('event, document_number, document_type, to_status, created_at')
        .in('document_id', docs.map((d) => d.id)).order('created_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
  ])
  const payments = (paymentsData ?? []) as { id: string; document_id: string; amount: number; payment_method: string | null; paid_at: string | null; voided_at?: string | null }[]
  const fieldName = (k: string) => ({
    name: tr('nombre', 'name'), business_name: tr('empresa', 'company'), email: tr('correo', 'email'), phone: tr('teléfono', 'phone'),
    address: tr('dirección', 'address'), city: tr('ciudad', 'city'), state: tr('estado', 'state'), postal_code: 'ZIP', notes: tr('notas', 'notes'),
    status: tr('estado activo/inactivo', 'active/inactive status'), kind: tr('tipo', 'type'), legal_name: tr('nombre legal', 'legal name'),
    tax_id: tr('identificación fiscal', 'tax ID'), lifecycle: tr('etapa del cliente', 'client stage'), source: tr('origen', 'source'),
    owner_id: tr('responsable', 'owner'), branch_id: tr('sucursal', 'branch'),
  } as Record<string, string>)[k] ?? k
  const activity: Activity[] = [
    ...((clientEvents ?? []) as { event: string; fields: string[]; created_at: string }[]).map((e) => ({
      at: e.created_at,
      text: e.event === 'created' ? tr('Cliente creado', 'Client created')
        : e.event === 'archived' ? tr('Cliente archivado', 'Client archived')
        : e.event === 'restored' ? tr('Cliente restaurado', 'Client restored')
        : tr(`Datos actualizados: ${e.fields.map(fieldName).join(', ')}`, `Details updated: ${e.fields.map(fieldName).join(', ')}`),
    })),
    ...((docEvents ?? []) as { event: string; document_number: string | null; document_type: string; to_status: string | null; created_at: string }[]).map((e) => {
      const what = `${documentTypeName(e.document_type, locale)} ${e.document_number ?? ''}`.trim()
      return {
        at: e.created_at,
        text: e.event === 'created' ? tr(`${what} creado`, `${what} created`)
          : e.event === 'voided' ? tr(`${what} anulado`, `${what} voided`)
          : e.event === 'deleted' ? tr(`${what} eliminado (borrador)`, `${what} deleted (draft)`)
          : `${what}: ${e.to_status ? (STATUS_TEXT[locale][e.to_status] ?? e.to_status) : ''}`,
      }
    }),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)

  const archived = !!client.archived_at
  const doneText: Record<string, string> = {
    updated: tr('Cliente actualizado.', 'Client updated.'),
    archived: tr('Cliente archivado. Sus documentos y pagos se conservan.', 'Client archived. Their documents and payments are kept.'),
    restored: tr('Cliente restaurado.', 'Client restored.'),
  }
  const errorText: Record<string, string> = {
    client_archive_forbidden: tr('Solo el propietario o un administrador puede archivar clientes.', 'Only the owner or an admin can archive clients.'),
    client_has_history: tr('Este cliente tiene documentos: no se elimina, archívalo para conservar su historial.', 'This client has documents: it is not deleted; archive it to keep its history.'),
    forbidden: tr('Tu rol no permite hacer esto.', 'Your role cannot do this.'),
    confirm: tr('Marca la casilla de confirmación.', 'Tick the confirmation box.'),
    unavailable: tr('El archivo de clientes todavía no está activado en esta base de datos.', 'Client archiving is not enabled in this database yet.'),
    save: tr('No se pudo completar la acción. Inténtalo nuevamente.', 'The action could not be completed. Please try again.'),
  }
  const address = [client.address, [client.city, client.state, client.postal_code].filter(Boolean).join(', ')].filter(Boolean).join(' · ')

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link href="/clients" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Volver a Clientes', '← Back to Clients')}</Link>

      <section className="card-hero px-6 py-7 sm:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">{tr('Cliente', 'Client')}</p>
            <h1 className="mt-2 break-words font-display text-3xl font-semibold tracking-tight">{client.business_name || client.name}</h1>
            {client.business_name && <p className="mt-1 text-white/70">{client.name}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {archived ? <span className="badge-neutral">{tr('Archivado', 'Archived')}</span>
                : <span className={client.status === 'inactive' ? 'badge-neutral' : 'badge-success'}>{client.status === 'inactive' ? tr('Inactivo', 'Inactive') : tr('Activo', 'Active')}</span>}
              <span className="badge-neutral">{tr('Desde', 'Since')} {f.date(client.created_at)}</span>
            </div>
            <dl className="mt-4 grid gap-1 text-sm text-white/70">
              {client.email && <dd><a className="hover:underline" href={`mailto:${client.email}`}>{client.email}</a></dd>}
              {client.phone && <dd><a className="hover:underline" href={`tel:${client.phone}`}>{client.phone}</a></dd>}
              {address && <dd>{address}</dd>}
            </dl>
          </div>
          <div className="flex flex-wrap gap-2">
            {!archived && <Link href={`/documents/new?type=invoice&client=${client.id}`} className="btn-accent btn-sm"><Icon name="plus" className="h-4 w-4" /> {tr('Nueva factura', 'New invoice')}</Link>}
            {!archived && <Link href={`/documents/new?type=quote&client=${client.id}`} className="btn-outline-light btn-sm">{tr('Nueva cotización', 'New quote')}</Link>}
            <Link href={`/clients/${client.id}/edit`} className="btn-outline-light btn-sm">{tr('Editar', 'Edit')}</Link>
          </div>
        </div>
      </section>

      {query.done && doneText[query.done] && <div role="status" className="alert-success p-4">{doneText[query.done]}</div>}
      {query.error && CLIENT_ERRORS.includes(query.error) && <div role="alert" className="alert-danger p-4">{errorText[query.error] ?? errorText.save}</div>}
      {archived && <div role="status" className="alert-warning p-4">{tr('Cliente archivado: se conserva con su historial, pero no recibe documentos nuevos.', 'Archived client: kept with its history, but it receives no new documents.')}</div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [tr('Facturado', 'Billed'), f.money(summary.billed)],
          [tr('Cobrado', 'Collected'), f.money(summary.paid)],
          [tr('Balance pendiente', 'Open balance'), f.money(summary.balance)],
          [tr('Facturas emitidas', 'Issued invoices'), String(summary.issued)],
        ].map(([label, value]) => (
          <div key={label} className="card p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
            <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-fg">{value}</p>
          </div>
        ))}
      </div>

      {crm && <ClientCrm supabase={supabase} client={client} user={{ id: user.id, email: user.email }} locale={locale} tr={tr} f={f} done={query.done} error={query.error} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="card min-w-0 overflow-hidden" aria-labelledby="docs-title">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 id="docs-title" className="font-display text-lg font-semibold text-fg">{tr('Documentos', 'Documents')}</h2>
            <span className="badge-neutral">{total}</span>
          </div>
          {docs.length === 0 ? (
            <EmptyState icon="file" title={tr('Este cliente todavía no tiene documentos.', 'This client has no documents yet.')} />
          ) : (
            <ul className="divide-y divide-line">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link href={`/documents/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-electric/10">
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon name={documentIcon(d.document_type)} className="h-5 w-5 shrink-0 text-accent" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-fg">{documentTypeName(d.document_type, locale)} {d.document_number ?? ''}</span>
                        <span className="block truncate text-xs text-muted">{d.issue_date ? f.date(d.issue_date) : f.date(d.created_at)}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={effectiveStatus(d, paid.get(d.id) ?? 0, today)} locale={locale} />
                      <span className="hidden font-semibold tabular-nums text-fg sm:inline">{f.money(Number(d.total ?? 0))}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label={tr('Páginas', 'Pages')} className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
              {page > 1 ? <Link className="btn-secondary btn-sm" href={`/clients/${id}?page=${page - 1}`}>{tr('← Anterior', '← Previous')}</Link> : <span />}
              <span className="text-muted">{tr(`Página ${page} de ${pages}`, `Page ${page} of ${pages}`)}</span>
              {page < pages ? <Link className="btn-secondary btn-sm" href={`/clients/${id}?page=${page + 1}`}>{tr('Siguiente →', 'Next →')}</Link> : <span />}
            </nav>
          )}
        </section>

        <div className="min-w-0 space-y-6">
          <section className="card p-5" aria-labelledby="pay-title">
            <h2 id="pay-title" className="font-display text-lg font-semibold text-fg">{tr('Pagos recientes', 'Recent payments')}</h2>
            {payments.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Sin pagos registrados.', 'No payments recorded.')}</p> : (
              <ul className="mt-3 divide-y divide-line text-sm">
                {payments.map((p) => (
                  <li key={p.id} className={`flex justify-between gap-3 py-2 ${p.voided_at ? 'line-through opacity-60' : ''}`}>
                    <Link href={`/documents/${p.document_id}`} className="text-slate-300 hover:text-fg">{p.paid_at ? f.date(p.paid_at) : '—'} · {paymentMethodLabel(p.payment_method, locale)}{p.voided_at ? ` · ${tr('anulado', 'voided')}` : ''}</Link>
                    <span className="font-semibold tabular-nums text-fg">{f.money(Number(p.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-5" aria-labelledby="act-title">
            <h2 id="act-title" className="font-display text-lg font-semibold text-fg">{tr('Actividad', 'Activity')}</h2>
            {activity.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Sin actividad registrada.', 'No recorded activity.')}</p> : (
              <ol className="mt-3 space-y-2 text-sm">
                {activity.map((a, i) => (
                  <li key={i} className="flex flex-col">
                    <span className="text-slate-300">{a.text}</span>
                    <span className="text-xs text-muted">{f.dateTime(a.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {client.notes && (
            <section className="card p-5">
              <h2 className="font-display text-lg font-semibold text-fg">{tr('Notas', 'Notes')}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{client.notes}</p>
            </section>
          )}

          {manager && crm && (
            <section className="card space-y-3 p-5">
              <h2 className="font-display text-lg font-semibold text-fg">{tr('Administrar', 'Manage')}</h2>
              <form action={setClientArchived}>
                <input type="hidden" name="id" value={client.id} />
                <input type="hidden" name="archive" value={archived ? 'no' : 'yes'} />
                <button type="submit" className="btn-secondary btn-sm w-full">{archived ? tr('Restaurar cliente', 'Restore client') : tr('Archivar cliente', 'Archive client')}</button>
              </form>
              {total === 0 && (
                <form action={deleteClient} className="space-y-2 rounded-xl border border-danger/40 p-3">
                  <input type="hidden" name="id" value={client.id} />
                  <label className="flex items-start gap-2 text-xs text-slate-300">
                    <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-4 w-4" />
                    {tr('Eliminar este cliente sin documentos. No se puede deshacer.', 'Delete this client without documents. This cannot be undone.')}
                  </label>
                  <button type="submit" className="btn-danger btn-sm w-full">{tr('Eliminar cliente', 'Delete client')}</button>
                </form>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

const STATUS_TEXT: Record<'es' | 'en', Record<string, string>> = {
  es: { sent: 'enviado', paid: 'pagado', overdue: 'vencido', accepted: 'aceptada', rejected: 'rechazada', cancelled: 'anulado', draft: 'borrador' },
  en: { sent: 'sent', paid: 'paid', overdue: 'overdue', accepted: 'accepted', rejected: 'rejected', cancelled: 'voided', draft: 'draft' },
}

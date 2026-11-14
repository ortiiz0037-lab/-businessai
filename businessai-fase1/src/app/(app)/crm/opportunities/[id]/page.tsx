import Link from 'next/link'
import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { CrmFlash, CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { ActivityForm, ActivityList, type ActivityRow } from '@/components/crm-activities'
import { CrmHistory, type CrmEvent } from '@/components/crm-history'
import { crmPage, loadMembers, loadStages, memberName } from '@/lib/crm/page'
import { crmLabel, percent, stageName, weightedCents } from '@/lib/crm/core'
import { centsToInput } from '@/lib/finance/money'
import { documentStatus, documentTypeName } from '@/components/ui/status'
import { addDays, localDay } from '@/lib/workforce/hours'
import { archiveOpportunity, convertQuote, linkDocument, moveOpportunity, saveOpportunity } from '@/app/actions/crm'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Opp = { id: string; company_id: string; client_id: string; contact_id: string | null; name: string; description: string | null; amount_cents: string | number; probability_bp: number
  probability_manual: boolean; expected_close: string | null; owner_id: string | null; source: string | null; stage_id: string; status: string; lost_reason: string | null
  closed_at: string | null; branch_id: string | null; archived_at: string | null; version: number; created_at: string }
type Doc = { id: string; document_type: string; document_number: string | null; title: string | null; status: string; total: string | number | null; issue_date: string; client_id: string | null }

export default async function OpportunityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const { id } = await params
  const sp = await searchParams
  if (!UUID.test(id)) notFound()
  const { locale, tr, f, supabase, user, companyId, can, money, available } = await crmPage(`/crm/opportunities/${id}`)
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoCrmAccess tr={tr} reason="role" />
  const { data } = await supabase.from('crm_opportunities').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const o = data as Opp | null
  if (!o) notFound()
  const [stages, members, { data: client }, { data: links }, { data: acts }, { data: events }, { data: contactRows }, { data: br }] = await Promise.all([
    loadStages(supabase, companyId), loadMembers(supabase, companyId, { id: user.id, email: user.email }),
    supabase.from('clients').select('id, name, business_name, archived_at, lifecycle').eq('id', o.client_id).maybeSingle(),
    supabase.from('crm_opportunity_documents').select('document_id, linked_at').eq('opportunity_id', id),
    supabase.from('crm_activities').select('id, kind, subject, body, direction, due_at, status, outcome, assigned_to, created_by, created_at, completed_at, version, origin, client_id, opportunity_id')
      .eq('opportunity_id', id).order('created_at', { ascending: false }).limit(100),
    supabase.from('crm_events').select('id, entity, action, changes, actor, created_at').eq('opportunity_id', id).order('id', { ascending: false }).limit(100),
    supabase.from('crm_contacts').select('id, first_name, last_name').eq('client_id', o.client_id).is('archived_at', null).order('first_name'),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
  ])
  const c = client as { id: string; name: string; business_name: string | null; archived_at: string | null; lifecycle: string } | null
  const linkIds = ((links ?? []) as { document_id: string }[]).map((l) => l.document_id)
  const [{ data: linkedDocs }, { data: clientDocs }, { data: conv }] = await Promise.all([
    linkIds.length && can.docsView ? supabase.from('documents').select('id, document_type, document_number, title, status, total, issue_date, client_id').in('id', linkIds).order('issue_date', { ascending: false }) : Promise.resolve({ data: [] }),
    can.docsView ? supabase.from('documents').select('id, document_type, document_number, title, status, total, issue_date, client_id').eq('client_id', o.client_id).in('document_type', ['quote', 'invoice', 'receipt', 'contract', 'work_order']).order('issue_date', { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    linkIds.length ? supabase.from('crm_quote_conversions').select('quote_id, invoice_id').in('quote_id', linkIds) : Promise.resolve({ data: [] }),
  ])
  const linked = (linkedDocs ?? []) as Doc[]
  const available2 = ((clientDocs ?? []) as Doc[]).filter((d) => !linkIds.includes(d.id))
  const conversions = (conv ?? []) as { quote_id: string; invoice_id: string }[]
  const contacts = (contactRows ?? []) as { id: string; first_name: string; last_name: string | null }[]
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  const stage = stages.find((s) => s.id === o.stage_id)
  const open = o.status === 'open' && !o.archived_at
  const today = localDay(new Date(), 'America/Puerto_Rico')
  const back = `/crm/opportunities/${id}`
  const docLabel = (d: Doc) => `${documentTypeName(d.document_type, locale)} ${d.document_number ?? ''}${d.title ? ` · ${d.title}` : ''}`

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Oportunidad', 'Opportunity')} title={o.name}
        description={<>{c ? <Link href={`/clients/${c.id}`} className="text-blue-400 hover:text-blue-300">{c.name}</Link> : '—'}{c?.business_name ? ` · ${c.business_name}` : ''}{c ? ` · ${crmLabel(c.lifecycle, locale)}` : ''}</>} />
      <CrmNav tr={tr} current="/crm/opportunities" configure={can.configure} />
      <CrmFlash locale={locale} done={sp.done} error={sp.error} />
      {o.archived_at && <div role="status" className="alert-warning p-4">{tr('Oportunidad archivada: no cuenta en el pipeline.', 'Archived opportunity: it does not count in the pipeline.')}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="opp-summary">
        <div className="card p-4"><p className="text-xs text-muted">{tr('Etapa', 'Stage')}</p><p className="mt-1 font-semibold text-fg">{stage ? stageName(stage, locale) : '—'}</p>
          <span className={o.status === 'won' ? 'badge-success' : o.status === 'lost' ? 'badge-neutral' : 'badge-accent'}>{crmLabel(o.status, locale)}</span></div>
        <div className="card p-4"><p className="text-xs text-muted">{tr('Valor estimado', 'Estimated value')}</p><p className="mt-1 text-xl font-bold tabular-nums text-fg">{money(o.amount_cents)}</p></div>
        <div className="card p-4"><p className="text-xs text-muted">{tr('Probabilidad', 'Probability')}</p><p className="mt-1 text-xl font-bold tabular-nums text-fg">{percent(o.probability_bp)}</p>
          <p className="text-xs text-muted">{o.probability_manual ? tr('definida a mano', 'set manually') : tr('de la etapa', 'from the stage')}</p></div>
        <div className="card p-4"><p className="text-xs text-muted">{tr('Ponderado', 'Weighted')}</p><p className="mt-1 text-xl font-bold tabular-nums text-fg">{money(weightedCents([o]))}</p></div>
      </div>

      <section className="card p-5 text-sm" aria-label={tr('Detalles', 'Details')}>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted">{tr('Cierre estimado', 'Expected close')}</dt><dd className="text-fg">{o.expected_close ? f.date(o.expected_close) : '—'}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Responsable', 'Owner')}</dt><dd className="text-fg">{memberName(members, o.owner_id)}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Origen', 'Source')}</dt><dd className="text-fg">{o.source ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Sucursal', 'Branch')}</dt><dd className="text-fg">{branches.find((b) => b.id === o.branch_id)?.name ?? '—'}</dd></div>
          {o.lost_reason && <div className="sm:col-span-2"><dt className="text-xs text-muted">{tr('Motivo de pérdida', 'Loss reason')}</dt><dd className="text-rose-200">{o.lost_reason}</dd></div>}
          {o.closed_at && <div><dt className="text-xs text-muted">{tr('Cerrada', 'Closed')}</dt><dd className="text-fg">{f.dateTime(o.closed_at)}</dd></div>}
        </dl>
        {o.description && <p className="mt-3 whitespace-pre-wrap text-slate-300">{o.description}</p>}
      </section>

      {can.manage && !o.archived_at && (
        <section className="card p-5" aria-labelledby="move-title">
          <h2 id="move-title" className="font-display text-lg font-semibold text-fg">{open ? tr('Mover de etapa', 'Move stage') : tr('Reabrir o cambiar el resultado', 'Reopen or change the outcome')}</h2>
          <form action={moveOpportunity} className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto]" data-testid="move-form">
            <input type="hidden" name="id" value={o.id} /><input type="hidden" name="version" value={o.version} /><input type="hidden" name="back" value={back} />
            <label className="field-label">{tr('Etapa', 'Stage')}<select name="stage_id" defaultValue={o.stage_id} className="field mt-1">
              {stages.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{stageName(s, locale)} · {percent(s.probability_bp)}</option>)}</select></label>
            <label className="field-label">{tr('Motivo (obligatorio si se pierde)', 'Reason (required if lost)')}<input name="reason" maxLength={300} className="field mt-1" /></label>
            <div className="flex items-end"><SubmitButton pendingLabel="…" className="w-auto">{tr('Mover', 'Move')}</SubmitButton></div>
          </form>
        </section>
      )}

      {can.manage && open && (
        <details className="card p-5">
          <summary className="cursor-pointer font-display text-lg font-semibold text-fg">{tr('Editar oportunidad', 'Edit opportunity')}</summary>
          <form action={saveOpportunity} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="edit-opportunity">
            <input type="hidden" name="id" value={o.id} /><input type="hidden" name="version" value={o.version} /><input type="hidden" name="client_id" value={o.client_id} /><input type="hidden" name="back" value={back} />
            <label className="field-label sm:col-span-2">{tr('Nombre *', 'Name *')}<input name="name" required maxLength={160} defaultValue={o.name} className="field mt-1" /></label>
            <label className="field-label">{tr('Contacto', 'Contact')}<select name="contact_id" defaultValue={o.contact_id ?? ''} className="field mt-1"><option value="">—</option>
              {contacts.map((x) => <option key={x.id} value={x.id}>{x.first_name} {x.last_name ?? ''}</option>)}</select></label>
            <label className="field-label">{tr('Valor estimado ($)', 'Estimated value ($)')}<input name="amount" inputMode="decimal" defaultValue={centsToInput(o.amount_cents)} className="field mt-1" /></label>
            <label className="field-label">{tr('Probabilidad (%, vacío = etapa)', 'Probability (%, empty = stage)')}<input name="probability" inputMode="decimal" defaultValue={o.probability_manual ? String(o.probability_bp / 100) : ''} className="field mt-1" /></label>
            <label className="field-label">{tr('Cierre estimado', 'Expected close')}<input name="expected_close" type="date" defaultValue={o.expected_close ?? ''} className="field mt-1" /></label>
            <label className="field-label">{tr('Responsable', 'Owner')}<select name="owner_id" defaultValue={o.owner_id ?? ''} className="field mt-1"><option value="">—</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select></label>
            <label className="field-label">{tr('Origen', 'Source')}<input name="source" maxLength={80} defaultValue={o.source ?? ''} className="field mt-1" /></label>
            {branches.length > 0 && <label className="field-label">{tr('Sucursal', 'Branch')}<select name="branch_id" defaultValue={o.branch_id ?? ''} className="field mt-1"><option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>}
            <label className="field-label sm:col-span-2 lg:col-span-4">{tr('Descripción', 'Description')}<textarea name="description" rows={3} maxLength={4000} defaultValue={o.description ?? ''} className="field mt-1" /></label>
            <div className="sm:col-span-2 lg:col-span-4"><SubmitButton pendingLabel="…" className="w-auto">{tr('Guardar cambios', 'Save changes')}</SubmitButton></div>
          </form>
        </details>
      )}

      <section className="card p-5" aria-labelledby="docs-title" data-testid="opp-documents">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="docs-title" className="font-display text-lg font-semibold text-fg">{tr('Cotizaciones y documentos', 'Quotes and documents')}</h2>
          {can.docsCreate && c && !c.archived_at && <Link href={`/documents/new?type=quote&client=${o.client_id}`} className="btn-secondary btn-sm">{tr('Crear cotización', 'Create quote')}</Link>}
        </div>
        {!can.docsView ? <p className="mt-2 text-sm text-muted">{tr('Tu rol no ve documentos.', 'Your role does not see documents.')}</p> : <>
          <ul className="mt-2 divide-y divide-line text-sm">
            {linked.length === 0 && <li className="py-2 text-muted">{tr('Ningún documento asociado.', 'No linked documents.')}</li>}
            {linked.map((d) => {
              const conversion = conversions.find((x) => x.quote_id === d.id)
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="min-w-0"><Link href={`/documents/${d.id}`} className="font-semibold text-fg hover:text-blue-400">{docLabel(d)}</Link>
                    <span className="block text-xs text-muted">{f.date(d.issue_date)} · {money(Math.round(Number(d.total ?? 0) * 100))} · {documentStatus(d.status, locale).label}
                      {conversion && <> · <Link href={`/documents/${conversion.invoice_id}`} className="text-blue-400">{tr('factura creada', 'invoice created')}</Link></>}</span></span>
                  <span className="flex flex-wrap gap-2">
                    {d.document_type === 'quote' && d.status === 'accepted' && can.docsCreate && (
                      <form action={convertQuote} className="flex items-center gap-2" data-testid="convert-quote">
                        <input type="hidden" name="quote_id" value={d.id} /><input type="hidden" name="opportunity_id" value={o.id} /><input type="hidden" name="idem" value={randomUUID()} /><input type="hidden" name="back" value={back} />
                        <input name="due_date" type="date" required defaultValue={addDays(today, 30)} min={today} aria-label={tr('Vencimiento de la factura', 'Invoice due date')} className="field w-36 py-1 text-sm" />
                        <button type="submit" className="btn-primary btn-sm">{tr('Convertir en factura', 'Convert to invoice')}</button>
                      </form>)}
                    {can.manage && <form action={linkDocument}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="document_id" value={d.id} /><input type="hidden" name="linked" value="no" /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Desvincular', 'Unlink')}</button></form>}
                  </span>
                </li>
              )
            })}
          </ul>
          {can.manage && available2.length > 0 && (
            <form action={linkDocument} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <input type="hidden" name="id" value={o.id} /><input type="hidden" name="back" value={back} />
              <label className="field-label min-w-0 flex-1">{tr('Asociar un documento existente del cliente', 'Link an existing document of the client')}<select name="document_id" className="field mt-1">
                {available2.map((d) => <option key={d.id} value={d.id}>{docLabel(d)} · {documentStatus(d.status, locale).label}</option>)}</select></label>
              <button type="submit" className="btn-secondary">{tr('Asociar', 'Link')}</button>
            </form>
          )}
          <p className="mt-2 text-xs text-muted">{tr('Convertir crea una factura en BORRADOR con las mismas líneas; se contabiliza solo cuando la envías desde Documentos.',
            'Converting creates a DRAFT invoice with the same lines; it is posted only when you send it from Documents.')}</p>
        </>}
      </section>

      <section className="card p-5" aria-labelledby="acts-title">
        <h2 id="acts-title" className="font-display text-lg font-semibold text-fg">{tr('Actividades', 'Activities')}</h2>
        <ActivityList rows={(acts ?? []) as ActivityRow[]} members={members} locale={locale} tr={tr} f={f} canManage={can.manage} back={back} />
        {can.manage && <ActivityForm tr={tr} locale={locale} members={members} selfId={user.id} clientId={o.client_id} opportunityId={o.id} contacts={contacts} back={back} />}
      </section>

      <section className="card p-5" aria-labelledby="hist-title">
        <h2 id="hist-title" className="font-display text-lg font-semibold text-fg">{tr('Historial de cambios', 'Change history')}</h2>
        <CrmHistory rows={(events ?? []) as CrmEvent[]} members={members} locale={locale} tr={tr} f={f} stages={stages} />
      </section>

      {can.manage && (
        <form action={archiveOpportunity} className="flex justify-end">
          <input type="hidden" name="id" value={o.id} /><input type="hidden" name="version" value={o.version} /><input type="hidden" name="back" value={back} />
          <input type="hidden" name="archived" value={o.archived_at ? 'no' : 'yes'} />
          <button type="submit" className="btn-secondary btn-sm">{o.archived_at ? tr('Restaurar oportunidad', 'Restore opportunity') : tr('Archivar oportunidad', 'Archive opportunity')}</button>
        </form>
      )}
    </div>
  )
}

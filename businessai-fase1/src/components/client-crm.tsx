import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale, formatters } from '@/lib/i18n/app'
import type { Tr } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'
import { loadMembers, loadStages, memberName } from '@/lib/crm/page'
import { crmLabel, percent, stageName, TAG_CLASS, type TagColor } from '@/lib/crm/core'
import { documentStatus } from '@/components/ui/status'
import { ActivityForm, ActivityList, type ActivityRow } from '@/components/crm-activities'
import { CrmHistory, type CrmEvent } from '@/components/crm-history'
import { CrmFlash } from '@/components/crm-nav'
import { SubmitButton } from '@/components/submit-button'
import { archiveContact, saveContact, setClientTags, shareClient } from '@/app/actions/crm'

/** Errors the client page itself explains (archive / delete). */
export const CLIENT_ERRORS = ['client_archive_forbidden', 'client_has_history', 'forbidden', 'confirm', 'unavailable', 'save']
const PERMS = ['crm.view', 'crm.manage', 'crm.configure', 'receivables.view', 'documents.view', 'documents.create'] as const

type C = { id: string; company_id: string; kind?: string; legal_name?: string | null; tax_id?: string | null; lifecycle?: string; source?: string | null; owner_id?: string | null; branch_id?: string | null; archived_at?: string | null }

/**
 * CRM part of the client profile (0035): classification, tags, contacts,
 * opportunities, activities, quotes, receivables (read from ar_invoice_balances /
 * ar_aging — no copy of balances) and the change history. Each block follows
 * the caller's permissions in the client's own company.
 */
export async function ClientCrm({ supabase, client, user, locale, tr, f, done, error }: {
  supabase: SupabaseClient; client: C; user: { id: string; email?: string | null }; locale: Locale; tr: Tr; f: ReturnType<typeof formatters>; done?: string; error?: string
}) {
  const companyId = client.company_id
  const { data: acc, error: accErr } = await supabase.rpc('assistant_access', { target: companyId, keys: [...PERMS] })
  const p = ((accErr ? null : acc) as { perms?: Record<string, boolean> } | null)?.perms ?? {}
  if (p['crm.view'] !== true) return null
  const { data: setting } = await supabase.from('ledger_settings').select('base_currency').eq('company_id', companyId).maybeSingle()
  const money = (c: string | number | bigint | null | undefined) => formatCents(c ?? 0, locale, (setting as { base_currency?: string } | null)?.base_currency ?? 'USD')
  const manage = p['crm.manage'] === true
  const back = `/clients/${client.id}`
  const [stages, members, { data: tagRows }, { data: myTags }, { data: contactRows }, { data: oppRows }, { data: actRows }, { data: evRows }, { data: brRows }, { data: shared }, { data: quotes }, ar, aging] = await Promise.all([
    loadStages(supabase, companyId), loadMembers(supabase, companyId, user),
    supabase.from('crm_tags').select('id, name, color').eq('company_id', companyId).is('archived_at', null).order('name'),
    supabase.from('crm_client_tags').select('tag_id').eq('client_id', client.id),
    supabase.from('crm_contacts').select('id, first_name, last_name, title, email, phone, is_primary, notes, archived_at').eq('client_id', client.id).order('is_primary', { ascending: false }).order('first_name'),
    supabase.from('crm_opportunities').select('id, name, amount_cents, probability_bp, stage_id, status, expected_close, owner_id').eq('client_id', client.id).is('archived_at', null).order('created_at', { ascending: false }),
    supabase.from('crm_activities').select('id, kind, subject, body, direction, due_at, status, outcome, assigned_to, created_by, created_at, completed_at, version, origin, client_id, opportunity_id')
      .eq('client_id', client.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('crm_events').select('id, entity, action, changes, actor, created_at').eq('client_id', client.id).order('id', { ascending: false }).limit(50),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
    supabase.from('crm_client_branches').select('branch_id').eq('client_id', client.id),
    p['documents.view'] ? supabase.from('documents').select('id, document_number, title, status, total, issue_date').eq('client_id', client.id).eq('document_type', 'quote').order('issue_date', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
    p['receivables.view'] ? supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }).eq('client_id', client.id).gt('balance_cents', 0).order('days_past_due', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
    p['receivables.view'] ? supabase.rpc('ar_aging', { target: companyId, as_of: null }).eq('client_id', client.id) : Promise.resolve({ data: [] }),
  ])
  const tags = (tagRows ?? []) as { id: string; name: string; color: TagColor }[]
  const mine = new Set(((myTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id))
  const contacts = (contactRows ?? []) as { id: string; first_name: string; last_name: string | null; title: string | null; email: string | null; phone: string | null; is_primary: boolean; notes: string | null; archived_at: string | null }[]
  const opps = (oppRows ?? []) as { id: string; name: string; amount_cents: string | number; probability_bp: number; stage_id: string; status: string; expected_close: string | null; owner_id: string | null }[]
  const branches = (brRows ?? []) as { id: string; name: string; code: string }[]
  const sharedIds = new Set(((shared ?? []) as { branch_id: string }[]).map((s) => s.branch_id))
  const openInv = ((ar as { data: unknown }).data ?? []) as { document_id: string; document_number: string; due_date: string | null; total_cents: string; paid_cents: string; balance_cents: string; days_past_due: number; bucket: string }[]
  const ag = (((aging as { data: unknown }).data ?? []) as { b0_30: string; b31_60: string; b61_90: string; b90_plus: string; total_cents: string; overdue_cents: string }[])[0]
  const { data: conv } = (quotes ?? []).length ? await supabase.from('crm_quote_conversions').select('quote_id, invoice_id').in('quote_id', ((quotes ?? []) as { id: string }[]).map((q) => q.id)) : { data: [] }
  const converted = new Map(((conv ?? []) as { quote_id: string; invoice_id: string }[]).map((c) => [c.quote_id, c.invoice_id]))
  const sn = new Map(stages.map((s) => [s.id, s]))
  const branch = branches.find((b) => b.id === client.branch_id)

  return (
    <div className="space-y-6" data-testid="client-crm">
      <CrmFlash locale={locale} done={done && !['updated', 'archived', 'restored'].includes(done) ? done : undefined} error={error && !CLIENT_ERRORS.includes(error) ? error : undefined} />
      <section className="card p-5" aria-labelledby="crm-profile-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="crm-profile-title" className="font-display text-lg font-semibold text-fg">{tr('Perfil comercial', 'Commercial profile')}</h2>
          {manage && !client.archived_at && <Link href={`/crm/opportunities?client=${client.id}#new`} className="btn-primary btn-sm">{tr('Nueva oportunidad', 'New opportunity')}</Link>}
        </div>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted">{tr('Tipo', 'Type')}</dt><dd className="text-fg">{crmLabel(client.kind ?? 'individual', locale)}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Etapa del cliente', 'Client stage')}</dt><dd><span className="badge-accent">{crmLabel(client.lifecycle ?? 'customer', locale)}</span></dd></div>
          <div><dt className="text-xs text-muted">{tr('Nombre legal', 'Legal name')}</dt><dd className="text-fg">{client.legal_name ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Identificación fiscal', 'Tax ID')}</dt><dd className="text-fg">{client.tax_id ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Origen', 'Source')}</dt><dd className="text-fg">{client.source ?? '—'}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Responsable', 'Owner')}</dt><dd className="text-fg">{memberName(members, client.owner_id)}</dd></div>
          <div><dt className="text-xs text-muted">{tr('Sucursal', 'Branch')}</dt><dd className="text-fg">{branch ? `${branch.code} · ${branch.name}` : tr('Compartido (sin sucursal)', 'Shared (no branch)')}</dd></div>
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted">{tr('Etiquetas', 'Tags')}</p>
          {manage && tags.length > 0 ? (
            <form action={setClientTags} className="mt-2 flex flex-wrap items-center gap-2" data-testid="client-tags">
              <input type="hidden" name="client_id" value={client.id} /><input type="hidden" name="back" value={back} />
              {tags.map((t) => (
                <label key={t.id} className={`flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TAG_CLASS[t.color]}`}>
                  <input type="checkbox" name="tag_ids" value={t.id} defaultChecked={mine.has(t.id)} className="h-3 w-3" /> {t.name}</label>))}
              <button type="submit" className="btn-secondary btn-sm">{tr('Guardar etiquetas', 'Save tags')}</button>
            </form>
          ) : (
            <p className="mt-1 flex flex-wrap gap-2">{tags.filter((t) => mine.has(t.id)).map((t) => <span key={t.id} className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TAG_CLASS[t.color]}`}>{t.name}</span>)}
              {mine.size === 0 && <span className="text-sm text-muted">—</span>}</p>
          )}
        </div>
        {p['crm.configure'] && client.branch_id && branches.length > 1 && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="text-xs text-muted">{tr('Compartir con otras sucursales', 'Share with other branches')}</p>
            <div className="mt-1 flex flex-wrap gap-2">{branches.filter((b) => b.id !== client.branch_id).map((b) => (
              <form key={b.id} action={shareClient}><input type="hidden" name="client_id" value={client.id} /><input type="hidden" name="branch_id" value={b.id} /><input type="hidden" name="back" value={back} />
                <input type="hidden" name="shared" value={sharedIds.has(b.id) ? 'no' : 'yes'} />
                <button type="submit" className={sharedIds.has(b.id) ? 'badge-accent' : 'badge-neutral'}>{b.code} {sharedIds.has(b.id) ? '✓' : '+'}</button></form>))}</div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card min-w-0 p-5" aria-labelledby="contacts-title" data-testid="client-contacts">
          <h2 id="contacts-title" className="font-display text-lg font-semibold text-fg">{tr('Contactos', 'Contacts')}</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {contacts.length === 0 && <li className="py-2 text-muted">{tr('Sin contactos.', 'No contacts.')}</li>}
            {contacts.map((c) => (
              <li key={c.id} className={`flex flex-wrap items-start justify-between gap-2 py-2.5 ${c.archived_at ? 'opacity-50' : ''}`}>
                <span className="min-w-0"><strong className="text-fg">{c.first_name} {c.last_name ?? ''}</strong>{c.is_primary && <span className="badge-accent ml-2">{tr('Principal', 'Primary')}</span>}
                  <span className="block text-xs text-muted">{[c.title, c.email, c.phone].filter(Boolean).join(' · ')}</span>
                  {c.notes && <span className="block text-xs text-slate-300">{c.notes}</span>}</span>
                {manage && <form action={archiveContact}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="client_id" value={client.id} /><input type="hidden" name="back" value={back} />
                  <input type="hidden" name="archived" value={c.archived_at ? 'no' : 'yes'} /><button type="submit" className="btn-ghost btn-sm">{c.archived_at ? tr('Restaurar', 'Restore') : tr('Archivar', 'Archive')}</button></form>}
              </li>
            ))}
          </ul>
          {manage && (
            <form action={saveContact} className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-2">
              <input type="hidden" name="client_id" value={client.id} /><input type="hidden" name="back" value={back} />
              <label className="field-label">{tr('Nombre *', 'First name *')}<input name="first_name" required maxLength={80} className="field mt-1 py-1.5" /></label>
              <label className="field-label">{tr('Apellido', 'Last name')}<input name="last_name" maxLength={80} className="field mt-1 py-1.5" /></label>
              <label className="field-label">{tr('Cargo', 'Title')}<input name="title" maxLength={80} className="field mt-1 py-1.5" /></label>
              <label className="field-label">{tr('Correo', 'Email')}<input name="email" type="email" maxLength={160} className="field mt-1 py-1.5" /></label>
              <label className="field-label">{tr('Teléfono', 'Phone')}<input name="phone" maxLength={40} className="field mt-1 py-1.5" /></label>
              <label className="flex items-center gap-2 pt-5 text-sm text-slate-300"><input type="checkbox" name="is_primary" /> {tr('Contacto principal', 'Primary contact')}</label>
              <label className="field-label sm:col-span-2">{tr('Notas internas', 'Internal notes')}<input name="notes" maxLength={1000} className="field mt-1 py-1.5" /></label>
              <div className="sm:col-span-2"><SubmitButton pendingLabel="…" className="w-auto">{tr('Agregar contacto', 'Add contact')}</SubmitButton></div>
            </form>
          )}
        </section>

        <section className="card min-w-0 p-5" aria-labelledby="client-opps-title" data-testid="client-opportunities">
          <h2 id="client-opps-title" className="font-display text-lg font-semibold text-fg">{tr('Oportunidades', 'Opportunities')}</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {opps.length === 0 && <li className="py-2 text-muted">{tr('Sin oportunidades visibles.', 'No visible opportunities.')}</li>}
            {opps.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="min-w-0"><Link href={`/crm/opportunities/${o.id}`} className="font-semibold text-fg hover:text-blue-400">{o.name}</Link>
                  <span className="block text-xs text-muted">{sn.get(o.stage_id) ? stageName(sn.get(o.stage_id)!, locale) : '—'} · {percent(o.probability_bp)}{o.expected_close ? ` · ${f.date(o.expected_close)}` : ''} · {memberName(members, o.owner_id)}</span></span>
                <span className="tabular-nums text-fg">{money(o.amount_cents)}</span>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-semibold text-fg">{tr('Historial de cotizaciones', 'Quote history')}</h3>
          <ul className="mt-1 divide-y divide-line text-sm" data-testid="client-quotes">
            {!p['documents.view'] && <li className="py-2 text-muted">{tr('Tu rol no ve documentos.', 'Your role does not see documents.')}</li>}
            {p['documents.view'] && (quotes ?? []).length === 0 && <li className="py-2 text-muted">{tr('Sin cotizaciones.', 'No quotes.')}</li>}
            {((quotes ?? []) as { id: string; document_number: string | null; title: string | null; status: string; total: string | number | null; issue_date: string }[]).map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><Link href={`/documents/${q.id}`} className="font-semibold text-fg hover:text-blue-400">{q.document_number ?? '—'}</Link> <span className="text-xs text-muted">{q.title ?? ''} · {f.date(q.issue_date)}</span>
                  {converted.get(q.id) && <Link href={`/documents/${converted.get(q.id)}`} className="ml-2 text-xs text-blue-400">{tr('→ factura', '→ invoice')}</Link>}</span>
                <span className="flex items-center gap-2"><span className="badge-neutral">{documentStatus(q.status, locale).label}</span><span className="tabular-nums">{money(Math.round(Number(q.total ?? 0) * 100))}</span></span>
              </li>))}
          </ul>
          {p['documents.create'] && !client.archived_at && <Link href={`/documents/new?type=quote&client=${client.id}`} className="btn-secondary btn-sm mt-3">{tr('Crear cotización', 'Create quote')}</Link>}
        </section>
      </div>

      <section className="card p-5" aria-labelledby="client-ar-title" data-testid="client-receivables">
        <h2 id="client-ar-title" className="font-display text-lg font-semibold text-fg">{tr('Cuentas por cobrar', 'Receivables')}</h2>
        {!p['receivables.view'] ? <p className="mt-2 text-sm text-muted">{tr('Los saldos y la antigüedad son visibles para propietario y administradores (cuentas por cobrar).', 'Balances and aging are visible to the owner and admins (receivables).')}</p> : <>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            {[[tr('Saldo total', 'Total balance'), ag?.total_cents], [tr('Vencido', 'Overdue'), ag?.overdue_cents], ['0–30', ag?.b0_30], ['31–60', ag?.b31_60], ['61–90', ag?.b61_90], ['90+', ag?.b90_plus]].map(([l, v]) => (
              <div key={String(l)} className="rounded-xl border border-line bg-elevated/40 p-3"><p className="text-xs text-muted">{l}</p><p className="mt-1 font-semibold tabular-nums text-fg">{money(v ?? 0)}</p></div>))}
          </div>
          <ul className="mt-3 divide-y divide-line text-sm">
            {openInv.length === 0 && <li className="py-2 text-muted">{tr('Sin facturas pendientes.', 'No open invoices.')}</li>}
            {openInv.map((i) => (
              <li key={i.document_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><Link href={`/documents/${i.document_id}`} className="font-semibold text-fg hover:text-blue-400">{i.document_number}</Link>
                  <span className="text-xs text-muted"> · {i.due_date ? `${tr('vence', 'due')} ${f.date(i.due_date)}` : ''}{i.days_past_due > 0 ? ` · ${i.days_past_due} ${tr('días vencida', 'days overdue')}` : ''}</span></span>
                <span className="tabular-nums">{money(i.balance_cents)} <span className="text-xs text-muted">/ {money(i.total_cents)}</span></span>
              </li>))}
          </ul>
          <p className="mt-2 text-xs text-muted">{tr('Datos leídos de Cuentas por cobrar; el CRM no guarda saldos.', 'Data read from Receivables; the CRM stores no balances.')} <Link href="/receivables" className="text-blue-400">{tr('Abrir cuentas por cobrar', 'Open receivables')}</Link></p>
        </>}
      </section>

      <section className="card p-5" aria-labelledby="client-acts-title">
        <h2 id="client-acts-title" className="font-display text-lg font-semibold text-fg">{tr('Actividades y seguimiento', 'Activities and follow-up')}</h2>
        <ActivityList rows={(actRows ?? []) as ActivityRow[]} members={members} locale={locale} tr={tr} f={f} canManage={manage} back={back} />
        {manage && <ActivityForm tr={tr} locale={locale} members={members} selfId={user.id} clientId={client.id} contacts={contacts.filter((c) => !c.archived_at)} back={back} />}
      </section>

      <section className="card p-5" aria-labelledby="client-hist-title">
        <h2 id="client-hist-title" className="font-display text-lg font-semibold text-fg">{tr('Historial de modificaciones', 'Change history')}</h2>
        <CrmHistory rows={(evRows ?? []) as CrmEvent[]} members={members} locale={locale} tr={tr} f={f} stages={stages} />
      </section>
    </div>
  )
}

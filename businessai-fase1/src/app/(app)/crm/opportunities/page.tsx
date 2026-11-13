import Link from 'next/link'
import { randomUUID } from 'node:crypto'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { CrmFlash, CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { crmPage, loadMembers, loadStages, memberName } from '@/lib/crm/page'
import { crmLabel, percent, stageName } from '@/lib/crm/core'
import { searchTerm } from '@/lib/search'
import { saveOpportunity } from '@/app/actions/crm'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE = 25
const SORTS = { close: ['expected_close', true], amount: ['amount_cents', false], updated: ['updated_at', false], name: ['name', true] } as const

type Opp = { id: string; name: string; client_id: string; amount_cents: string | number; probability_bp: number; expected_close: string | null; owner_id: string | null
  stage_id: string; status: string; source: string | null; updated_at: string }

/** Opportunities: search, filters, sorting, pagination and the creation form. */
export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, user, companyId, can, money, available } = await crmPage('/crm/opportunities')
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoCrmAccess tr={tr} reason="role" />
  const status = ['open', 'won', 'lost', 'all'].includes(params.status ?? '') ? params.status! : 'open'
  const sort = (params.sort && params.sort in SORTS ? params.sort : 'close') as keyof typeof SORTS
  const owner = params.owner === 'me' ? user.id : UUID.test(params.owner ?? '') ? params.owner! : null
  const stage = UUID.test(params.stage ?? '') ? params.stage! : null
  const term = searchTerm((params.q ?? '').trim())
  const page = Math.max(1, Math.min(1000, Number.parseInt(params.page ?? '1', 10) || 1))
  const preClient = UUID.test(params.client ?? '') ? params.client! : null
  const [stages, members, { data: clientRows }, { data: br }] = await Promise.all([
    loadStages(supabase, companyId), loadMembers(supabase, companyId, { id: user.id, email: user.email }),
    supabase.from('clients').select('id, name, business_name').eq('company_id', companyId).is('archived_at', null).order('name').limit(500),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name'),
  ])
  let q = supabase.from('crm_opportunities').select('id, name, client_id, amount_cents, probability_bp, expected_close, owner_id, stage_id, status, source, updated_at', { count: 'exact' })
    .eq('company_id', companyId).is('archived_at', null)
  if (status !== 'all') q = q.eq('status', status)
  if (owner) q = q.eq('owner_id', owner)
  if (stage) q = q.eq('stage_id', stage)
  if (preClient) q = q.eq('client_id', preClient)
  if (term) q = q.or(`name.ilike.%${term}%,source.ilike.%${term}%`)
  const [col, asc] = SORTS[sort]
  const { data, count } = await q.order(col, { ascending: asc, nullsFirst: false }).order('id').range((page - 1) * PAGE, page * PAGE - 1)
  const opps = (data ?? []) as Opp[]
  const clients = (clientRows ?? []) as { id: string; name: string; business_name: string | null }[]
  const ids = [...new Set(opps.map((o) => o.client_id))]
  const { data: cl } = ids.length ? await supabase.from('clients').select('id, name').in('id', ids) : { data: [] }
  const cn = new Map(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
  const { data: contactRows } = preClient ? await supabase.from('crm_contacts').select('id, first_name, last_name').eq('client_id', preClient).is('archived_at', null).order('first_name') : { data: [] }
  const contacts = (contactRows ?? []) as { id: string; first_name: string; last_name: string | null }[]
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  const sn = new Map(stages.map((s) => [s.id, s]))
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const href = (n: number) => { const sp = new URLSearchParams(Object.entries(params).filter(([k, v]) => v && !['page', 'done', 'error'].includes(k)) as [string, string][]); if (n > 1) sp.set('page', String(n)); return `/crm/opportunities?${sp}` }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="CRM" title={tr('Oportunidades', 'Opportunities')}
        description={can.viewAll ? tr('Todas las oportunidades de la empresa.', 'All the company\'s opportunities.') : tr('Las oportunidades que creaste o tienes asignadas.', 'The opportunities you created or own.')} />
      <CrmNav tr={tr} current="/crm/opportunities" configure={can.configure} />
      <CrmFlash locale={locale} done={params.done} error={params.error} />

      <section className="card min-w-0 p-5" aria-label={tr('Lista de oportunidades', 'Opportunity list')}>
        <form method="get" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
          <input name="q" defaultValue={params.q ?? ''} maxLength={60} placeholder={tr('Buscar por nombre u origen…', 'Search by name or source…')} aria-label={tr('Buscar', 'Search')} className="field lg:col-span-2" />
          <select name="status" defaultValue={status} aria-label={tr('Estado', 'Status')} className="field">
            {['open', 'won', 'lost'].map((s) => <option key={s} value={s}>{crmLabel(s, locale)}</option>)}<option value="all">{tr('Todas', 'All')}</option></select>
          <select name="stage" defaultValue={stage ?? ''} aria-label={tr('Etapa', 'Stage')} className="field"><option value="">{tr('Todas las etapas', 'All stages')}</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{stageName(s, locale)}</option>)}</select>
          <select name="owner" defaultValue={params.owner ?? ''} aria-label={tr('Responsable', 'Owner')} className="field"><option value="">{tr('Todos los responsables', 'All owners')}</option>
            <option value="me">{tr('Mías', 'Mine')}</option>{can.viewAll && members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select>
          <div className="flex gap-2"><select name="sort" defaultValue={sort} aria-label={tr('Ordenar', 'Sort')} className="field min-w-0 flex-1">
            <option value="close">{tr('Cierre estimado', 'Expected close')}</option><option value="amount">{tr('Valor', 'Value')}</option>
            <option value="updated">{tr('Actualizadas', 'Updated')}</option><option value="name">{tr('Nombre', 'Name')}</option></select>
            {preClient && <input type="hidden" name="client" value={preClient} />}
            <button type="submit" className="btn-secondary">{tr('Filtrar', 'Filter')}</button></div>
        </form>
        <div className="mt-4 overflow-x-auto">
          {opps.length === 0 ? <EmptyState icon="chart" title={tr('No hay oportunidades con estos filtros.', 'No opportunities match these filters.')} /> : (
            <table className="table-premium min-w-[720px] text-sm" data-testid="opp-list">
              <thead><tr><th>{tr('Oportunidad', 'Opportunity')}</th><th>{tr('Etapa', 'Stage')}</th><th className="text-right">{tr('Valor', 'Value')}</th><th className="text-right">%</th><th>{tr('Cierre', 'Close')}</th><th>{tr('Responsable', 'Owner')}</th></tr></thead>
              <tbody>{opps.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/crm/opportunities/${o.id}`} className="font-semibold text-fg hover:text-blue-400">{o.name}</Link><span className="block text-xs text-muted">{cn.get(o.client_id) ?? '—'}{o.source ? ` · ${o.source}` : ''}</span></td>
                  <td><span className={o.status === 'won' ? 'badge-success' : o.status === 'lost' ? 'badge-neutral' : 'badge-accent'}>{sn.get(o.stage_id) ? stageName(sn.get(o.stage_id)!, locale) : '—'}</span></td>
                  <td className="text-right tabular-nums">{money(o.amount_cents)}</td>
                  <td className="text-right tabular-nums">{percent(o.probability_bp)}</td>
                  <td className="whitespace-nowrap">{o.expected_close ? f.date(o.expected_close) : '—'}</td>
                  <td className="text-xs">{memberName(members, o.owner_id)}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
        {pages > 1 && <nav aria-label={tr('Páginas', 'Pages')} className="mt-4 flex items-center justify-between border-t border-line pt-4 text-sm">
          {page > 1 ? <Link className="btn-secondary btn-sm" href={href(page - 1)}>{tr('← Anterior', '← Previous')}</Link> : <span />}
          <span className="text-muted">{tr(`Página ${page} de ${pages}`, `Page ${page} of ${pages}`)}</span>
          {page < pages ? <Link className="btn-secondary btn-sm" href={href(page + 1)}>{tr('Siguiente →', 'Next →')}</Link> : <span />}</nav>}
      </section>

      {can.manage && (
        <section id="new" className="card scroll-mt-24 p-5" aria-labelledby="new-title" data-testid="new-opportunity">
          <h2 id="new-title" className="font-display text-lg font-semibold text-fg">{tr('Nueva oportunidad', 'New opportunity')}</h2>
          {clients.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Primero registra un cliente o prospecto.', 'Register a client or prospect first.')} <Link href="/clients#nuevo-cliente" className="text-blue-400">{tr('Agregar cliente', 'Add client')}</Link></p> : (
            <form action={saveOpportunity} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="idem" value={randomUUID()} /><input type="hidden" name="back" value="/crm/opportunities" />
              <label className="field-label sm:col-span-2">{tr('Nombre *', 'Name *')}<input name="name" required maxLength={160} className="field mt-1" /></label>
              <label className="field-label sm:col-span-2">{tr('Cliente o prospecto *', 'Client or prospect *')}<select name="client_id" required defaultValue={preClient ?? ''} className="field mt-1">
                <option value="" disabled>{tr('Elige…', 'Choose…')}</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.business_name ? ` · ${c.business_name}` : ''}</option>)}</select></label>
              {contacts.length > 0 && <label className="field-label">{tr('Contacto', 'Contact')}<select name="contact_id" defaultValue="" className="field mt-1"><option value="">—</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name ?? ''}</option>)}</select></label>}
              <label className="field-label">{tr('Valor estimado ($)', 'Estimated value ($)')}<input name="amount" inputMode="decimal" placeholder="0.00" className="field mt-1" /></label>
              <label className="field-label">{tr('Probabilidad (%, vacío = la de la etapa)', 'Probability (%, empty = the stage\'s)')}<input name="probability" inputMode="decimal" className="field mt-1" /></label>
              <label className="field-label">{tr('Cierre estimado', 'Expected close')}<input name="expected_close" type="date" className="field mt-1" /></label>
              <label className="field-label">{tr('Etapa inicial', 'Initial stage')}<select name="stage_id" className="field mt-1">
                {stages.filter((s) => s.active && s.outcome === 'open').map((s) => <option key={s.id} value={s.id}>{stageName(s, locale)} · {percent(s.probability_bp)}</option>)}</select></label>
              <label className="field-label">{tr('Responsable', 'Owner')}<select name="owner_id" defaultValue={user.id} className="field mt-1">
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select></label>
              <label className="field-label">{tr('Origen del prospecto', 'Lead source')}<input name="source" maxLength={80} placeholder={tr('Referido, web, feria…', 'Referral, web, fair…')} className="field mt-1" /></label>
              {branches.length > 0 && <label className="field-label">{tr('Sucursal', 'Branch')}<select name="branch_id" defaultValue="" className="field mt-1"><option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>}
              <label className="field-label sm:col-span-2 lg:col-span-4">{tr('Descripción', 'Description')}<textarea name="description" rows={3} maxLength={4000} className="field mt-1" /></label>
              <div className="sm:col-span-2 lg:col-span-4"><SubmitButton pendingLabel={tr('Guardando…', 'Saving…')} className="w-auto">{tr('Crear oportunidad', 'Create opportunity')}</SubmitButton></div>
            </form>
          )}
        </section>
      )}
    </div>
  )
}

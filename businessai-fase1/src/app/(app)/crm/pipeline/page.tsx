import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { CrmFlash, CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { crmPage, loadMembers, loadStages, memberName } from '@/lib/crm/page'
import { percent, stageName, weightedCents } from '@/lib/crm/core'
import { moveOpportunity } from '@/app/actions/crm'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Opp = { id: string; name: string; client_id: string; amount_cents: string | number; probability_bp: number; expected_close: string | null; owner_id: string | null; stage_id: string; status: string; version: number; branch_id: string | null }

/** Visual pipeline: one column per active stage; each card can be moved to another stage (lost asks for a reason). */
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ owner?: string; branch?: string; closed?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, user, companyId, can, money, available } = await crmPage('/crm/pipeline')
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoCrmAccess tr={tr} reason="role" />
  const showClosed = params.closed === '1'
  const owner = params.owner === 'me' ? user.id : UUID.test(params.owner ?? '') ? params.owner! : null
  const branch = UUID.test(params.branch ?? '') ? params.branch! : null
  const [stages, members, { data: br }] = await Promise.all([loadStages(supabase, companyId), loadMembers(supabase, companyId, { id: user.id, email: user.email }),
    supabase.from('branches').select('id, name, code').eq('company_id', companyId).is('archived_at', null).order('name')])
  let q = supabase.from('crm_opportunities').select('id, name, client_id, amount_cents, probability_bp, expected_close, owner_id, stage_id, status, version, branch_id')
    .eq('company_id', companyId).is('archived_at', null).order('expected_close', { ascending: true, nullsFirst: false }).limit(500)
  if (!showClosed) q = q.eq('status', 'open')
  if (owner) q = q.eq('owner_id', owner)
  if (branch) q = q.eq('branch_id', branch)
  const { data } = await q
  const opps = (data ?? []) as Opp[]
  const ids = [...new Set(opps.map((o) => o.client_id))]
  const { data: cl } = ids.length ? await supabase.from('clients').select('id, name').in('id', ids) : { data: [] }
  const cn = new Map(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
  const columns = stages.filter((s) => (s.active && (showClosed || s.outcome === 'open')) || opps.some((o) => o.stage_id === s.id))
  const branches = (br ?? []) as { id: string; name: string; code: string }[]
  const qs = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams()
    const cur = { owner: params.owner ?? null, branch, closed: showClosed ? '1' : null, ...patch }
    for (const [k, v] of Object.entries(cur)) if (v) sp.set(k, v)
    const t = sp.toString(); return `/crm/pipeline${t ? `?${t}` : ''}`
  }
  const back = qs({})

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="CRM" title={tr('Pipeline de ventas', 'Sales pipeline')}
        description={tr('Mueve cada oportunidad a su etapa. Ganado convierte al prospecto en cliente; Perdido exige un motivo.', 'Move each opportunity to its stage. Won turns the prospect into a customer; Lost requires a reason.')}
        actions={can.manage ? <Link href="/crm/opportunities#new" className="btn-primary">{tr('Nueva oportunidad', 'New opportunity')}</Link> : undefined} />
      <CrmNav tr={tr} current="/crm/pipeline" configure={can.configure} />
      <CrmFlash locale={locale} done={params.done} error={params.error} />
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label={tr('Filtros', 'Filters')}>
        <label className="field-label">{tr('Responsable', 'Owner')}<select name="owner" defaultValue={params.owner ?? ''} className="field mt-1 w-auto py-2">
          <option value="">{tr('Todos los visibles', 'All visible')}</option><option value="me">{tr('Mías', 'Mine')}</option>
          {can.viewAll && members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email}</option>)}</select></label>
        {branches.length > 0 && <label className="field-label">{tr('Sucursal', 'Branch')}<select name="branch" defaultValue={branch ?? ''} className="field mt-1 w-auto py-2">
          <option value="">{tr('Todas', 'All')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>}
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-300"><input type="checkbox" name="closed" value="1" defaultChecked={showClosed} /> {tr('Incluir cerradas', 'Include closed')}</label>
        <button type="submit" className="btn-secondary py-2">{tr('Aplicar', 'Apply')}</button>
      </form>

      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-testid="pipeline-board">
        <div className="flex min-w-max gap-4">
          {columns.map((s) => {
            const col = opps.filter((o) => o.stage_id === s.id)
            const total = col.reduce((t, o) => t + BigInt(o.amount_cents), 0n)
            return (
              <section key={s.id} className="flex w-72 shrink-0 flex-col rounded-2xl border border-line bg-card/60 p-3" aria-label={stageName(s, locale)} data-stage={s.key}>
                <header className="mb-3 border-b border-line pb-2">
                  <h2 className="font-semibold text-fg">{stageName(s, locale)} <span className="text-xs font-normal text-muted">· {percent(s.probability_bp)}</span></h2>
                  <p className="text-xs tabular-nums text-muted">{col.length} · {money(total)} · {tr('pond.', 'wtd.')} {money(weightedCents(col))}</p>
                </header>
                <ul className="space-y-3">
                  {col.length === 0 && <li className="rounded-xl border border-dashed border-line p-3 text-center text-xs text-muted">{tr('Sin oportunidades', 'No opportunities')}</li>}
                  {col.map((o) => (
                    <li key={o.id} className="rounded-xl border border-line bg-elevated/60 p-3 text-sm" data-testid="opp-card">
                      <Link href={`/crm/opportunities/${o.id}`} className="font-semibold text-fg hover:text-blue-400">{o.name}</Link>
                      <p className="text-xs text-muted">{cn.get(o.client_id) ?? '—'}</p>
                      <p className="mt-1 flex justify-between tabular-nums"><span className="text-fg">{money(o.amount_cents)}</span><span className="text-xs text-muted">{percent(o.probability_bp)}</span></p>
                      <p className="text-xs text-muted">{o.expected_close ? `${tr('Cierre', 'Close')} ${f.date(o.expected_close)} · ` : ''}{memberName(members, o.owner_id)}</p>
                      {can.manage && (
                        <form action={moveOpportunity} className="mt-2 space-y-1.5 border-t border-line pt-2">
                          <input type="hidden" name="id" value={o.id} /><input type="hidden" name="version" value={o.version} /><input type="hidden" name="back" value={back} />
                          <label className="sr-only" htmlFor={`st-${o.id}`}>{tr('Mover a', 'Move to')}</label>
                          <div className="flex gap-1.5">
                            <select id={`st-${o.id}`} name="stage_id" defaultValue={o.stage_id} className="field min-w-0 flex-1 py-1 text-xs">
                              {stages.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{stageName(x, locale)}</option>)}</select>
                            <button type="submit" className="btn-secondary btn-sm">{tr('Mover', 'Move')}</button>
                          </div>
                          <input name="reason" maxLength={300} placeholder={tr('Motivo (si se pierde)', 'Reason (if lost)')} aria-label={tr('Motivo de pérdida', 'Loss reason')} className="field py-1 text-xs" />
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
      <p className="text-xs text-muted">{tr('Valor ponderado = Σ(valor × probabilidad) / 100, redondeado una vez al centavo. Los totales usan solo las oportunidades que puedes ver.',
        'Weighted value = Σ(value × probability) / 100, rounded once to the cent. Totals use only the opportunities you can see.')} <Link href={qs({ closed: showClosed ? null : '1' })} className="text-blue-400">{showClosed ? tr('Ocultar cerradas', 'Hide closed') : tr('Ver cerradas', 'Show closed')}</Link></p>
    </div>
  )
}

import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { CrmNav, NoCrmAccess } from '@/components/crm-nav'
import { crmPage, loadMembers, memberName } from '@/lib/crm/page'
import { crmLabel, isOverdue, percent, stageName } from '@/lib/crm/core'
import { localDay } from '@/lib/workforce/hours'

export const dynamic = 'force-dynamic'

type Row = { stage_id: string; key: string; name_es: string; name_en: string; stage_position: number; outcome: string; probability_bp: number; opportunities: number; amount_cents: string | number; weighted_cents: string | number }
type Act = { id: string; kind: string; subject: string; due_at: string | null; status: string; client_id: string | null; opportunity_id: string | null; assigned_to: string | null }

/** CRM overview: pipeline from the real opportunities (what the user may see), follow-ups and recent work. */
export default async function CrmPage() {
  const { locale, tr, f, supabase, user, companyId, can, money, available } = await crmPage('/crm')
  if (!available) return <NoCrmAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoCrmAccess tr={tr} reason="role" />
  const now = new Date()
  const today = localDay(now, 'America/Puerto_Rico')
  const monthStart = `${today.slice(0, 7)}-01`
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000).toISOString()
  const [{ data: sum }, { data: acts }, { data: recent }, { data: won }, members] = await Promise.all([
    supabase.rpc('crm_pipeline_summary', { target: companyId, branch: null }),
    supabase.from('crm_activities').select('id, kind, subject, due_at, status, client_id, opportunity_id, assigned_to').eq('company_id', companyId)
      .eq('status', 'pending').not('due_at', 'is', null).lte('due_at', weekAhead).order('due_at').limit(40),
    supabase.from('crm_opportunities').select('id, name, amount_cents, status, updated_at, client_id').eq('company_id', companyId).is('archived_at', null)
      .order('updated_at', { ascending: false }).limit(6),
    supabase.from('crm_opportunities').select('amount_cents').eq('company_id', companyId).eq('status', 'won').gte('closed_at', `${monthStart}T04:00:00Z`).is('archived_at', null),
    loadMembers(supabase, companyId, { id: user.id, email: user.email }),
  ])
  const rows = (sum ?? []) as Row[]
  const open = rows.filter((r) => r.outcome === 'open')
  const openAmount = open.reduce((s, r) => s + BigInt(r.amount_cents), 0n)
  const openWeighted = open.reduce((s, r) => s + BigInt(r.weighted_cents), 0n)
  const openCount = open.reduce((s, r) => s + Number(r.opportunities), 0)
  const wonRows = (won ?? []) as { amount_cents: string | number }[]
  const wonAmount = wonRows.reduce((s, r) => s + BigInt(r.amount_cents), 0n)
  const activities = (acts ?? []) as Act[]
  const overdue = activities.filter((a) => isOverdue(a, now.getTime()))
  const upcoming = activities.filter((a) => !isOverdue(a, now.getTime()))
  const maxAmount = rows.reduce((m, r) => (BigInt(r.amount_cents) > m ? BigInt(r.amount_cents) : m), 0n)
  const ids = [...new Set([...activities.map((a) => a.client_id), ...((recent ?? []) as { client_id: string }[]).map((o) => o.client_id)].filter(Boolean))] as string[]
  const { data: cl } = ids.length ? await supabase.from('clients').select('id, name').in('id', ids) : { data: [] }
  const cn = new Map(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))

  const actItem = (a: Act) => (
    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="min-w-0">
        <span className="badge-neutral mr-2">{crmLabel(a.kind, locale)}</span>
        <Link href={a.opportunity_id ? `/crm/opportunities/${a.opportunity_id}` : a.client_id ? `/clients/${a.client_id}` : '/crm/activities'} className="font-semibold text-fg hover:text-blue-400">{a.subject}</Link>
        <span className="block text-xs text-muted">{a.client_id ? cn.get(a.client_id) ?? '' : ''} · {memberName(members, a.assigned_to)}</span>
      </span>
      <span className={`text-xs tabular-nums ${isOverdue(a, now.getTime()) ? 'text-rose-300' : 'text-muted'}`}>{a.due_at ? f.dateTime(a.due_at) : ''}</span>
    </li>
  )

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="CRM" title={tr('Relaciones con clientes', 'Customer relationships')}
        description={can.viewAll ? tr('Todo el pipeline de la empresa, calculado desde las oportunidades registradas.', 'The company\'s whole pipeline, computed from the recorded opportunities.')
          : tr('Tus oportunidades y seguimientos. Los totales solo incluyen lo que puedes ver.', 'Your opportunities and follow-ups. Totals only include what you can see.')}
        actions={can.manage ? <>
          <Link href="/crm/opportunities#new" className="btn-primary">{tr('Nueva oportunidad', 'New opportunity')}</Link>
          <Link href="/crm/activities#new" className="btn-secondary">{tr('Registrar actividad', 'Log activity')}</Link></> : undefined} />
      <CrmNav tr={tr} current="/crm" configure={can.configure} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="crm-kpis">
        <StatCard label={tr('Pipeline abierto', 'Open pipeline')} value={money(openAmount)} hint={tr(`${openCount} oportunidades`, `${openCount} opportunities`)} icon="chart" tone="gold" />
        <StatCard label={tr('Valor ponderado', 'Weighted value')} value={money(openWeighted)} hint={tr('valor × probabilidad', 'value × probability')} icon="zap" />
        <StatCard label={tr('Ganado este mes', 'Won this month')} value={money(wonAmount)} hint={tr(`${wonRows.length} cerradas`, `${wonRows.length} closed`)} icon="check" tone="success" />
        <StatCard label={tr('Seguimientos atrasados', 'Overdue follow-ups')} value={overdue.length} hint={tr('pendientes y vencidos', 'pending and past due')} icon="alert" tone={overdue.length ? 'warning' : 'neutral'} />
      </div>

      <section className="card p-5" aria-labelledby="stages-title" data-testid="crm-stages">
        <div className="flex items-center justify-between gap-3">
          <h2 id="stages-title" className="font-display text-lg font-semibold text-fg">{tr('Pipeline por etapa', 'Pipeline by stage')}</h2>
          <Link href="/crm/pipeline" className="text-sm font-semibold text-blue-400 hover:text-blue-300">{tr('Ver tablero →', 'Open board →')}</Link>
        </div>
        <ul className="mt-4 space-y-3">
          {rows.map((r) => {
            const pct = maxAmount > 0n ? Number((BigInt(r.amount_cents) * 1000n) / maxAmount) / 10 : 0
            return (
              <li key={r.stage_id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold text-fg">{stageName(r, locale)} <span className="text-xs font-normal text-muted">· {percent(r.probability_bp)} · {r.opportunities}</span></span>
                  <span className="tabular-nums text-slate-300">{money(r.amount_cents)} <span className="text-xs text-muted">({tr('pond.', 'wtd.')} {money(r.weighted_cents)})</span></span>
                </div>
                <div className="mt-1.5 h-2 rounded-full bg-elevated" aria-hidden="true">
                  <div className={`h-2 rounded-full ${r.outcome === 'won' ? 'bg-emerald-400/80' : r.outcome === 'lost' ? 'bg-slate-500/70' : 'bg-gradient-to-r from-electric to-blue-300'}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="fu-title" data-testid="crm-followups">
          <h2 id="fu-title" className="font-display text-lg font-semibold text-fg">{tr('Seguimientos', 'Follow-ups')}</h2>
          {overdue.length === 0 && upcoming.length === 0 ? <p className="mt-3 text-sm text-muted">{tr('Nada pendiente para los próximos 7 días.', 'Nothing pending for the next 7 days.')}</p> : <>
            {overdue.length > 0 && <><h3 className="mt-3 text-xs font-bold uppercase tracking-wide text-rose-300">{tr('Atrasados', 'Overdue')}</h3><ul className="divide-y divide-line">{overdue.map(actItem)}</ul></>}
            {upcoming.length > 0 && <><h3 className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">{tr('Próximos 7 días', 'Next 7 days')}</h3><ul className="divide-y divide-line">{upcoming.map(actItem)}</ul></>}
          </>}
        </section>
        <section className="card p-5" aria-labelledby="recent-title">
          <h2 id="recent-title" className="font-display text-lg font-semibold text-fg">{tr('Actividad reciente en oportunidades', 'Recently updated opportunities')}</h2>
          {(recent ?? []).length === 0 ? <EmptyState icon="chart" title={tr('Todavía no hay oportunidades.', 'No opportunities yet.')} /> : (
            <ul className="mt-2 divide-y divide-line">
              {((recent ?? []) as { id: string; name: string; amount_cents: string | number; status: string; updated_at: string; client_id: string }[]).map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="min-w-0"><Link href={`/crm/opportunities/${o.id}`} className="font-semibold text-fg hover:text-blue-400">{o.name}</Link>
                    <span className="block text-xs text-muted">{cn.get(o.client_id) ?? ''} · {f.date(o.updated_at)}</span></span>
                  <span className="text-right"><span className="block tabular-nums text-fg">{money(o.amount_cents)}</span>
                    <span className={o.status === 'won' ? 'badge-success' : o.status === 'lost' ? 'badge-neutral' : 'badge-accent'}>{crmLabel(o.status, locale)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

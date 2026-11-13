import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatNanos } from '@/lib/intelligence/cost'
import { PageHeader, StatCard } from '@/components/ui/page'

export const dynamic = 'force-dynamic'

type Insights = {
  from: string; to: string; turns: number; by_status: Record<string, number>; verification: Record<string, number>; cost_nanos: string; test_turns: number; unpriced_turns: number
  by_model: { provider: string; model: string; turns: number; cost_nanos: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; avg_latency_ms: number | null; p95_latency_ms: number | null; fallbacks: number; escalations: number }[]
  by_tier: Record<string, number>; by_user: { user_id: string; turns: number; cost_nanos: string }[]; events: Record<string, number>; tools: { tool: string; calls: number; denied_or_failed: number }[]
}
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Intelligence Center: how the company uses the assistant (requests, models,
 * tokens, cost against the monthly budget, latency, verification of figures,
 * tools, injections, limits). Metadata only — never conversation text.
 * Requires assistant.audit (owner, admin). Figures come from SQL aggregates
 * over every turn of the period (0031 assistant_insights).
 */
export default async function AssistantInsightsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const locale = await getLocale()
  const tr = translator(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/assistant/insights')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const sp = await searchParams
  const from = sp.from && DAY.test(sp.from) ? sp.from : `${today.slice(0, 7)}-01`
  const to = sp.to && DAY.test(sp.to) ? sp.to : today
  const [{ data: audit }, ins, quota, members] = await Promise.all([
    supabase.rpc('has_permission', { target: member.companyId, permission: 'assistant.audit' }),
    supabase.rpc('assistant_insights', { target: member.companyId, from_date: from, to_date: to }),
    supabase.rpc('assistant_quota', { target: member.companyId }),
    supabase.rpc('company_members', { target: member.companyId }),
  ])
  const header = <PageHeader eyebrow={tr('Asistente', 'Assistant')} title={tr('Centro de inteligencia', 'Intelligence Center')}
    description={tr('Uso, costo y calidad del asistente en su empresa. Solo metadatos: nunca el texto de las conversaciones.', 'How your company uses the assistant: usage, cost and quality. Metadata only — never conversation text.')}
    actions={<Link href="/assistant" className="btn btn-secondary btn-sm">{tr('Centro de conversaciones', 'Conversation center')}</Link>} />
  if (audit !== true) {
    return <div className="space-y-6">{header}<p className="alert alert-warning" data-testid="insights-denied">{tr('Su rol no permite ver la auditoría del asistente (requiere propietario o administrador).', 'Your role cannot see the assistant audit (owner or administrator only).')}</p></div>
  }
  if (ins.error || !ins.data) {
    return <div className="space-y-6">{header}<p className="alert alert-danger">{/ASSISTANT_INVALID/.test(ins.error?.message ?? '') ? tr('Período no válido (máximo un año).', 'Invalid period (one year at most).') : tr('No se pudieron cargar los datos.', 'The data could not be loaded.')}</p></div>
  }
  const d = ins.data as Insights
  const q = ((quota.data ?? []) as { cost_nanos: string | number | null; budget_nanos: string | number | null; plan: string | null }[])[0]
  const emails = new Map(((members.data ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const int = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-PR')
  const usd = (n: string | number | null | undefined) => formatNanos(BigInt(n ?? 0))
  const budget = q?.budget_nanos != null ? BigInt(q.budget_nanos) : 0n
  const monthCost = q?.cost_nanos != null ? BigInt(q.cost_nanos) : 0n
  const pct = budget > 0n ? Number((monthCost * 1000n) / budget) / 10 : null
  const v = d.verification
  const answered = Object.values(v).reduce((s, n) => s + n, 0)
  const statusLabel: Record<string, string> = { completed: tr('Completadas', 'Completed'), error: tr('Error', 'Error'), refused: tr('Rechazadas', 'Refused'), incomplete: tr('Incompletas', 'Incomplete'), cancelled: tr('Detenidas', 'Stopped'), abandoned: tr('Abandonadas', 'Abandoned'), open: tr('En curso', 'Running') }
  const eventLabel: Record<string, string> = { tool_denied: tr('Herramientas denegadas o con error', 'Tools denied or failed'), flagged: tr('Instrucciones sospechosas detectadas', 'Suspicious instructions flagged'), limit: tr('Solicitudes frenadas por límites', 'Requests stopped by limits'),
    provider_error: tr('Errores del proveedor', 'Provider errors'), refused: tr('Rechazos del modelo', 'Model refusals'), budget_alert: tr('Alertas de presupuesto', 'Budget alerts'), turn_abandoned: tr('Turnos abandonados', 'Abandoned turns'),
    action_executed: tr('Acciones ejecutadas', 'Actions executed'), action_failed: tr('Acciones fallidas', 'Actions failed') }

  return (
    <div className="space-y-6" data-testid="insights">
      {header}
      <form className="card flex flex-wrap items-end gap-3 p-4" method="get">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <button className="btn btn-primary btn-sm">{tr('Aplicar', 'Apply')}</button>
      </form>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={tr('Solicitudes', 'Requests')} value={int.format(d.turns)} hint={`${d.from} → ${d.to}`} icon="sparkle" />
        <StatCard label={tr('Costo estimado del período', 'Estimated cost of the period')} value={usd(d.cost_nanos)} hint={d.test_turns ? tr(`${d.test_turns} con el doble de pruebas (costo 0)`, `${d.test_turns} with the test double (no cost)`) : tr('Precios oficiales del registro de modelos', 'Official prices from the model registry')} icon="wallet" />
        <StatCard label={tr('Presupuesto del mes', 'Budget this month')} value={pct === null ? '—' : `${pct.toFixed(1)} %`} hint={budget > 0n ? `${usd(monthCost.toString())} / ${usd(budget.toString())}` : tr('Sin plan con asistente', 'No plan with the assistant')} icon="chart" tone={pct !== null && pct >= 80 ? 'warning' : 'neutral'} />
        <StatCard label={tr('Cifras verificadas', 'Verified figures')} value={answered ? `${int.format((v.verified ?? 0) + (v.regenerated ?? 0))} / ${int.format(answered)}` : '—'} hint={tr(`${v.fallback ?? 0} mostradas solo como datos verificados`, `${v.fallback ?? 0} shown as verified data only`)} icon="shield" tone="success" />
      </div>
      <section className="card overflow-x-auto p-0">
        <h2 className="section-title px-5 pt-5">{tr('Por modelo', 'By model')}</h2>
        <table className="table-premium mt-3 w-full text-sm" data-testid="insights-models">
          <thead><tr><th className="px-5 text-left">{tr('Modelo', 'Model')}</th><th className="text-right">{tr('Solicitudes', 'Requests')}</th><th className="text-right">{tr('Tokens entrada / salida / caché', 'Tokens in / out / cache')}</th>
            <th className="text-right">{tr('Costo', 'Cost')}</th><th className="text-right">{tr('Latencia media / p95', 'Latency avg / p95')}</th><th className="px-5 text-right">{tr('Respaldos / escalados', 'Fallbacks / escalations')}</th></tr></thead>
          <tbody>
            {d.by_model.length ? d.by_model.map((m) => (
              <tr key={`${m.provider}-${m.model}`}><td className="px-5">{m.model} <span className="text-xs text-slate-500">{m.provider}</span></td><td className="text-right tabular-nums">{int.format(m.turns)}</td>
                <td className="text-right tabular-nums">{int.format(Number(m.input_tokens))} / {int.format(Number(m.output_tokens))} / {int.format(Number(m.cache_read_tokens))}</td>
                <td className="text-right tabular-nums">{usd(m.cost_nanos)}</td><td className="text-right tabular-nums">{m.avg_latency_ms ?? '—'} / {m.p95_latency_ms ?? '—'} ms</td><td className="px-5 text-right tabular-nums">{m.fallbacks} / {m.escalations}</td></tr>
            )) : <tr><td className="px-5 py-4 text-slate-400" colSpan={6}>{tr('Sin solicitudes en el período.', 'No requests in the period.')}</td></tr>}
          </tbody>
        </table>
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-5">
          <h2 className="section-title">{tr('Resultado de las solicitudes', 'Request outcomes')}</h2>
          <ul className="mt-3 space-y-1 text-sm" data-testid="insights-status">{Object.entries(d.by_status).map(([k, n]) => <li key={k} className="flex justify-between"><span>{statusLabel[k] ?? k}</span><span className="tabular-nums">{int.format(n)}</span></li>)}</ul>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">{tr('Nivel de precisión', 'Precision tier')}</h3>
          <ul className="mt-2 space-y-1 text-sm">{Object.entries(d.by_tier).map(([k, n]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular-nums">{int.format(n)}</span></li>)}</ul>
        </section>
        <section className="card p-5">
          <h2 className="section-title">{tr('Seguridad y límites', 'Security and limits')}</h2>
          <ul className="mt-3 space-y-1 text-sm" data-testid="insights-events">{Object.keys(eventLabel).map((k) => <li key={k} className="flex justify-between gap-3"><span>{eventLabel[k]}</span><span className="tabular-nums">{int.format(d.events[k] ?? 0)}</span></li>)}</ul>
        </section>
        <section className="card p-5">
          <h2 className="section-title">{tr('Herramientas', 'Tools')}</h2>
          <ul className="mt-3 space-y-1 text-sm">{d.tools.length ? d.tools.map((x) => <li key={x.tool} className="flex justify-between gap-3"><span className="truncate">{x.tool}</span><span className="tabular-nums">{int.format(x.calls)}{x.denied_or_failed ? ` · ${int.format(x.denied_or_failed)} ${tr('sin éxito', 'unsuccessful')}` : ''}</span></li>) : <li className="text-slate-400">—</li>}</ul>
        </section>
      </div>
      <section className="card overflow-x-auto p-0">
        <h2 className="section-title px-5 pt-5">{tr('Por usuario', 'By user')}</h2>
        <table className="table-premium mt-3 w-full text-sm">
          <thead><tr><th className="px-5 text-left">{tr('Usuario', 'User')}</th><th className="text-right">{tr('Solicitudes', 'Requests')}</th><th className="px-5 text-right">{tr('Costo', 'Cost')}</th></tr></thead>
          <tbody>{d.by_user.map((u) => <tr key={u.user_id}><td className="px-5">{emails.get(u.user_id) || tr('usuario', 'user')}</td><td className="text-right tabular-nums">{int.format(u.turns)}</td><td className="px-5 text-right tabular-nums">{usd(u.cost_nanos)}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  )
}

import Link from 'next/link'
import { PageHeader, StatCard } from '@/components/ui/page'
import { FinanceNav, NoFinanceAccess, QualityBanner } from '@/components/finance-nav'
import { financePage, loadBalance, loadMonthly, loadProjection, loadQuality } from '@/lib/finance/finance-page'
import { addMonths, balanceTotals, compare, qualityNotes } from '@/lib/finance/statements'
import { insights } from '@/lib/finance/insights'
import { toCents } from '@/lib/finance/money'
import type { VsActual } from '@/lib/finance/budget'

export const dynamic = 'force-dynamic'

const TONE: Record<string, { cls: string; es: string; en: string }> = {
  critical: { cls: 'border-red-400/40 bg-red-400/10 text-red-100', es: 'Crítico', en: 'Critical' },
  warning: { cls: 'border-amber-400/40 bg-amber-400/10 text-amber-100', es: 'Atención', en: 'Watch' },
  opportunity: { cls: 'border-electric/40 bg-brand/15 text-blue-100', es: 'Oportunidad', en: 'Opportunity' },
}

/** A KPI card that opens its accounting source. */
function K({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="block rounded-2xl transition hover:ring-1 hover:ring-electric/50">{children}</Link>
}

/** Executive finance dashboard: every figure links to the report or ledger it comes from. */
export default async function FinanceDashboard() {
  const { locale, tr, money, today, supabase, companyId, access, currency } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const month = today.slice(0, 7)
  const year = Number(today.slice(0, 4))
  const [monthly, bs, ar, ap, published, quality, projection] = await Promise.all([
    loadMonthly(supabase, companyId, `${addMonths(month, -11)}-01`, 12),
    loadBalance(supabase, companyId, today),
    supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }),
    supabase.from('bills').select('total_cents, paid_cents, due_date').eq('company_id', companyId).in('status', ['approved', 'scheduled', 'partially_paid']).limit(5000),
    supabase.from('budgets').select('id, name, version').eq('company_id', companyId).eq('status', 'published').eq('scenario', 'base').is('department_id', null).eq('fiscal_year', year).maybeSingle(),
    loadQuality(supabase, companyId, { from: `${year}-01-01`, to: today }),
    loadProjection(supabase, companyId, today),
  ])
  const cur = monthly.find((m) => m.month.slice(0, 7) === month)
  const prev = monthly.find((m) => m.month.slice(0, 7) === addMonths(month, -1))
  const costs = (m: typeof cur) => m ? toCents(m.cost_of_sales_cents) + toCents(m.expense_cents) + toCents(m.tax_cents) : 0n
  const rev = toCents(cur?.revenue_cents ?? 0), revPrev = toCents(prev?.revenue_cents ?? 0)
  const exp = costs(cur), expPrev = costs(prev)
  const ytd = monthly.filter((m) => m.month.startsWith(String(year)))
  const ytdNet = ytd.reduce((s, m) => s + toCents(m.net_cents), 0n)
  const ytdCash = ytd.reduce((s, m) => s + toCents(m.cash_change_cents), 0n)
  const totals = balanceTotals(bs.rows)
  const arRows = ((ar.data ?? []) as { balance_cents: number; days_past_due: number }[]).filter((r) => toCents(r.balance_cents) > 0n)
  const arOpen = arRows.reduce((s, r) => s + toCents(r.balance_cents), 0n)
  const overdue = arRows.filter((r) => r.days_past_due > 0)
  const apRows = ((ap.data ?? []) as { total_cents: number; paid_cents: number; due_date: string | null }[]).map((b) => ({ due: b.due_date, bal: toCents(b.total_cents) - toCents(b.paid_cents) })).filter((b) => b.bal > 0n)
  const apOpen = apRows.reduce((s, b) => s + b.bal, 0n)
  const soonLimit = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)
  const apSoon = apRows.filter((b) => (b.due ?? today) <= soonLimit)
  const budget = published.data as { id: string; name: string; version: number } | null
  const { data: vsData } = budget ? await supabase.rpc('budget_vs_actual', { budget: budget.id, as_of: today }) : { data: null }
  const vs = ((vsData ?? []) as VsActual[]).filter((r) => r.in_total)
  const expBudget = vs.filter((r) => r.line_type === 'expense').reduce((s, r) => s + toCents(r.budget_total_cents), 0n)
  const expActual = vs.filter((r) => r.line_type === 'expense').reduce((s, r) => s + toCents(r.actual_cents), 0n)
  const varianceTotal = vs.reduce((s, r) => s + (r.line_type === 'revenue' ? toCents(r.variance_cents) : -toCents(r.variance_cents)), 0n)
  const consumed = expBudget === 0n ? null : Number((expActual * 1000n) / expBudget) / 10
  const q = qualityNotes(quality, locale, { balanced: totals.balanced })
  const lowCash = projection.scenarios.base.months.find((m) => m.cashEnd < 0n)
  const lbl = (r: VsActual) => (locale === 'en' && r.label_en ? r.label_en : r.label)
  const items = insights({
    cash: totals.cash, projectedLowCash: lowCash ? { month: lowCash.month, cash: lowCash.cashEnd } : null,
    overdueAR: overdue.reduce((s, r) => s + toCents(r.balance_cents), 0n), overdueCount: overdue.length,
    apDueSoon: apSoon.reduce((s, b) => s + b.bal, 0n), apDueSoonCount: apSoon.length, budgetId: budget?.id ?? null,
    criticalLines: vs.filter((r) => r.alert === 'critical' && r.actual_available).map((r) => ({ label: lbl(r), type: r.line_type })),
    favourableLines: vs.filter((r) => r.favorable).map((r) => ({ label: lbl(r), type: r.line_type, variance: toCents(r.variance_cents) })),
    revenueChangePct: compare(rev, revPrev).pct, expenseChangePct: compare(exp, expPrev).pct,
    openMonthsBeforeCurrent: ytd.filter((m) => m.month.slice(0, 7) < month && !m.closed && (toCents(m.revenue_cents) !== 0n || toCents(m.expense_cents) !== 0n)).length,
    provisional: q.notes.some((n) => n.blocking),
  }, locale, currency)
  const max = monthly.reduce((m, r) => { const a = toCents(r.revenue_cents), b = costs(r); return a > m ? a : b > m ? b : m }, 1n)
  const monthLabel = (ym: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { month: 'short', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`))
  const delta = (c: bigint, b: bigint, kind: 'revenue' | 'expense' | 'result') => {
    const x = compare(c, b)
    if (x.pct === null) return tr('sin mes anterior para comparar', 'no previous month to compare')
    const good = kind === 'expense' ? x.diff <= 0n : x.diff >= 0n
    return `${x.pct > 0 ? '+' : ''}${x.pct.toFixed(1)}% ${tr('vs mes anterior', 'vs previous month')} · ${good ? tr('favorable', 'favourable') : tr('desfavorable', 'unfavourable')}`
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Panel financiero', 'Finance dashboard')}
        description={tr('Cifras calculadas desde el libro mayor, cuentas por cobrar y por pagar. Toca un indicador para ver su origen contable.',
          'Figures computed from the ledger, receivables and payables. Tap an indicator to see its accounting source.')} />
      <FinanceNav tr={tr} current="/finance" />
      <QualityBanner tr={tr} notes={q.notes.filter((n) => n.blocking)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <K href="/finance/income-statement?period=month&compare=previous"><StatCard icon="chart" tone="success" label={tr('Ingresos del mes', 'Revenue this month')} value={money(rev)} hint={delta(rev, revPrev, 'revenue')} /></K>
        <K href="/finance/income-statement?period=month&compare=previous"><StatCard icon="receipt" tone="warning" label={tr('Gastos del mes', 'Expenses this month')} value={money(exp)} hint={delta(exp, expPrev, 'expense')} /></K>
        <K href="/finance/income-statement?period=month&compare=previous"><StatCard icon="sparkle" tone="gold" label={tr('Resultado del mes', 'Result this month')} value={money(rev - exp)} hint={`${tr('Año', 'Year')}: ${money(ytdNet)}`} /></K>
        <K href="/finance/cash-flow?period=year"><StatCard icon="wallet" label={tr('Efectivo en libros', 'Book cash')} value={money(totals.cash)} hint={`${tr('Flujo del año', 'Cash flow this year')}: ${money(ytdCash)}`} /></K>
        <K href="/receivables"><StatCard icon="clipboard" label={tr('Por cobrar', 'Receivables')} value={money(arOpen)} hint={tr(`${overdue.length} vencidas`, `${overdue.length} overdue`)} /></K>
        <K href="/payables"><StatCard icon="file" label={tr('Por pagar', 'Payables')} value={money(apOpen)} hint={tr(`${apSoon.length} vencen en 7 días`, `${apSoon.length} due within 7 days`)} /></K>
        <K href={budget ? `/finance/budgets/${budget.id}` : '/finance/budgets'}><StatCard icon="shield" label={tr('Presupuesto de gasto consumido', 'Expense budget consumed')} value={consumed === null ? '—' : `${consumed.toFixed(1)}%`}
          hint={budget ? `${budget.name} v${budget.version}` : tr('Sin presupuesto publicado', 'No published budget')} /></K>
        <K href={budget ? `/finance/budgets/${budget.id}` : '/finance/budgets'}><StatCard icon="alert" tone={varianceTotal >= 0n ? 'success' : 'warning'} label={tr('Variación neta vs presupuesto', 'Net variance vs budget')}
          value={budget ? money(varianceTotal) : '—'} hint={budget ? (varianceTotal >= 0n ? tr('favorable a la fecha', 'favourable to date') : tr('desfavorable a la fecha', 'unfavourable to date')) : tr('Publica un presupuesto', 'Publish a budget')} /></K>
      </div>

      <section aria-labelledby="trend" className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="trend" className="font-display text-lg font-semibold text-fg">{tr('Tendencia de 12 meses', '12-month trend')}</h2>
          <p className="flex gap-3 text-xs text-muted"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-electric" aria-hidden="true" />{tr('Ingresos', 'Revenue')}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400" aria-hidden="true" />{tr('Costos y gastos', 'Costs and expenses')}</span></p>
        </div>
        <ul className="mt-4 flex h-40 items-end gap-1 sm:gap-2">
          {monthly.map((m) => {
            const r = toCents(m.revenue_cents), c = costs(m)
            const ym = m.month.slice(0, 7)
            return (
              <li key={m.month} className="flex h-full flex-1 flex-col justify-end">
                <Link href={`/finance/income-statement?period=month&ref=${ym}-01`} className="flex h-full items-end justify-center gap-0.5"
                  aria-label={`${monthLabel(ym)}: ${tr('ingresos', 'revenue')} ${money(r)}, ${tr('costos y gastos', 'costs and expenses')} ${money(c)}`}>
                  <span className="w-1/2 max-w-3 rounded-t bg-electric" style={{ height: `${Math.max(1, Number((r * 100n) / max))}%` }} />
                  <span className="w-1/2 max-w-3 rounded-t bg-slate-400/70" style={{ height: `${Math.max(1, Number((c * 100n) / max))}%` }} />
                </Link>
                <span className="mt-1 text-center text-[10px] text-muted">{monthLabel(ym)}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="insights" className="space-y-3">
        <h2 id="insights" className="font-display text-lg font-semibold text-fg">{tr('Alertas y oportunidades', 'Alerts and opportunities')}</h2>
        {items.length === 0 ? <p className="card p-4 text-sm text-muted">{tr('Sin alertas: no hay desviaciones ni vencimientos que requieran atención.', 'No alerts: no deviations or due items need attention.')}</p> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {items.map((it, i) => (
              <li key={i}><Link href={it.href} className={`flex items-start gap-3 rounded-xl border p-3 text-sm hover:brightness-110 ${TONE[it.tone].cls}`}>
                <span className="shrink-0 rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">{tr(TONE[it.tone].es, TONE[it.tone].en)}</span>
                <span>{it.text}</span></Link></li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-2 sm:grid-cols-3">
        <Link href="/finance/income-statement" className="btn-secondary">{tr('Estado de resultados', 'Income statement')}</Link>
        <Link href="/finance/balance-sheet" className="btn-secondary">{tr('Balance general', 'Balance sheet')}</Link>
        <Link href="/finance/cash-flow" className="btn-secondary">{tr('Flujo de efectivo', 'Cash flow')}</Link>
      </div>
    </div>
  )
}

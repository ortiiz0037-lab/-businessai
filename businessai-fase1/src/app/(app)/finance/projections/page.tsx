import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { FinanceNav, NoFinanceAccess, ReportMeta } from '@/components/finance-nav'
import { financePage, loadProjection } from '@/lib/finance/finance-page'
import { financeMessage, scenarioLabel } from '@/lib/finance/budget'
import { saveAssumptions } from '@/app/actions/finance'
import type { Scenario } from '@/lib/finance/statements'

export const dynamic = 'force-dynamic'

/** Projections: actual history, editable assumptions and three scenarios. Estimates, never guaranteed. */
export default async function ProjectionsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access, currency, companyName } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const p = await loadProjection(supabase, companyId, today)
  const a = p.assumptions
  const scen: Scenario[] = ['conservative', 'base', 'optimistic']
  const monthLabel = (ym: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`))
  const last = (s: Scenario) => p.scenarios[s].months.at(-1)
  const ends = scen.map((s) => last(s)?.cashEnd ?? 0n)
  const scaleMax = ends.concat(p.scenarios.base.months.map((m) => m.cashEnd)).reduce((m, v) => (v < 0n ? -v : v) > m ? (v < 0n ? -v : v) : m, 1n)
  const qs = 'report=projection'
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Proyecciones', 'Projections')}
        description={tr('Estimaciones a partir del historial, las facturas abiertas, las cuentas por pagar y el presupuesto publicado. No son resultados garantizados.',
          'Estimates from history, open invoices, payables and the published budget. They are not guaranteed results.')}
        actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <FinanceNav tr={tr} current="/finance/projections" />
      <Flash done={sp.done === 'assumptions_saved' ? tr('Supuestos guardados.', 'Assumptions saved.') : null} error={financeMessage(sp.error, locale)} />
      <ReportMeta tr={tr} company={companyName} period={`${monthLabel(p.input.start)} – ${monthLabel(p.scenarios.base.months.at(-1)?.month ?? p.input.start)}`} currency={currency}
        generated={f.dateTime(new Date().toISOString())} final={false} />
      <div role="note" className="alert-warning p-4 text-sm">
        <p className="font-semibold">{tr('Estimación, no un resultado garantizado.', 'Estimate, not a guaranteed result.')}</p>
        <p>{tr('Ingresos y costos del mes: presupuesto publicado (base, toda la empresa) si existe; si no, promedio de los últimos 3 meses con actividad, con el crecimiento anual supuesto. Cobros: facturas abiertas por fecha de vencimiento (vencidas: el primer mes) × % de cobro. Pagos: facturas de proveedor aprobadas por vencimiento. Supone que los ingresos y costos nuevos se cobran y pagan en el mismo mes.',
          'Monthly revenue and costs: the published budget (base, whole company) when there is one; otherwise the average of the last 3 active months, with the assumed annual growth. Collections: open invoices by due date (overdue: the first month) × collection %. Payments: approved vendor bills by due date. New revenue and costs are assumed collected and paid in the same month.')}</p>
        {p.scenarios.base.insufficientHistory && <p className="mt-1 font-semibold">{tr('No hay meses anteriores con actividad: la tendencia es cero.', 'There are no previous months with activity: the trend is zero.')}</p>}
      </div>

      <section aria-labelledby="inputs" className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-2 p-4 text-sm">
          <h2 id="inputs" className="font-display text-lg font-semibold text-fg">{tr('Datos reales usados', 'Actual data used')}</h2>
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-muted">{tr('Efectivo hoy', 'Cash today')}</dt><dd className="text-right tabular-nums text-fg"><Link href="/finance/balance-sheet" className="hover:text-accent">{money(p.input.cashNow)}</Link></dd>
            <dt className="text-muted">{tr('Por cobrar abierto', 'Open receivables')}</dt><dd className="text-right tabular-nums text-fg"><Link href="/receivables" className="hover:text-accent">{money(p.input.receivables.reduce((s, r) => s + r.balance, 0n))}</Link></dd>
            <dt className="text-muted">{tr('Por pagar aprobado', 'Approved payables')}</dt><dd className="text-right tabular-nums text-fg"><Link href="/payables" className="hover:text-accent">{money(p.input.payables.reduce((s, r) => s + r.balance, 0n))}</Link></dd>
            <dt className="text-muted">{tr('Meses de historial', 'Months of history')}</dt><dd className="text-right tabular-nums text-fg">{p.input.history.length}</dd>
            <dt className="text-muted">{tr('Presupuesto publicado', 'Published budget')}</dt>
            <dd className="text-right text-fg">{p.published.length ? p.published.map((b) => <Link key={b.id} href={`/finance/budgets/${b.id}`} className="block hover:text-accent">{b.name} v{b.version}</Link>) : tr('Ninguno', 'None')}</dd>
          </dl>
        </div>
        <form action={saveAssumptions} className="card space-y-3 p-4">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Supuestos editables', 'Editable assumptions')}</h2>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm"><span className="field-label">{tr('Crecimiento anual %', 'Annual growth %')}</span><input name="growth" inputMode="decimal" defaultValue={a.growthPct} className="field" disabled={!access.manage} /></label>
            <label className="text-sm"><span className="field-label">{tr('Cobro de facturas abiertas %', 'Collection of open invoices %')}</span><input name="collection" inputMode="decimal" defaultValue={a.collectionPct} className="field" disabled={!access.manage} /></label>
            <label className="text-sm"><span className="field-label">{tr('Conservador: −ingresos / +costos %', 'Conservative: −revenue / +costs %')}</span><input name="conservative" inputMode="decimal" defaultValue={a.conservativePct} className="field" disabled={!access.manage} /></label>
            <label className="text-sm"><span className="field-label">{tr('Optimista: +ingresos %', 'Optimistic: +revenue %')}</span><input name="optimistic" inputMode="decimal" defaultValue={a.optimisticPct} className="field" disabled={!access.manage} /></label>
            <label className="text-sm"><span className="field-label">{tr('Meses a proyectar', 'Months to project')}</span><input name="horizon" type="number" min={1} max={24} defaultValue={a.horizon} className="field" disabled={!access.manage} /></label>
          </div>
          <p className="text-xs text-muted">{a.saved && a.updatedAt ? `${tr('Guardado', 'Saved')} ${f.dateTime(a.updatedAt)}` : tr('Valores por defecto (no guardados).', 'Default values (not saved).')}</p>
          {access.manage && <SubmitButton className="w-full sm:w-auto">{tr('Guardar supuestos', 'Save assumptions')}</SubmitButton>}
        </form>
      </section>

      <section aria-labelledby="scen" className="space-y-3">
        <h2 id="scen" className="font-display text-lg font-semibold text-fg">{tr('Escenarios', 'Scenarios')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {scen.map((s, i) => {
            const ms = p.scenarios[s].months
            const net = ms.reduce((t, m) => t + m.net, 0n)
            return (
              <div key={s} className={`card p-4 ${s === 'base' ? 'border-electric/50' : ''}`}>
                <p className="text-xs uppercase tracking-wide text-muted">{scenarioLabel(s, locale)} · {tr('estimado', 'estimate')}</p>
                <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">{money(ends[i])}</p>
                <p className="text-xs text-muted">{tr('efectivo estimado al final', 'estimated cash at the end')}</p>
                <p className="mt-2 text-sm tabular-nums text-slate-300">{tr('Resultado estimado', 'Estimated result')}: {money(net)}</p>
              </div>
            )
          })}
        </div>
        <div className="card p-4" aria-hidden="true">
          <p className="mb-2 text-xs text-muted">{tr('Efectivo estimado por mes (escenario base)', 'Estimated cash per month (base scenario)')}</p>
          <div className="flex h-32 items-end gap-1">
            {p.scenarios.base.months.map((m) => {
              const v = m.cashEnd < 0n ? -m.cashEnd : m.cashEnd
              const hgt = Math.max(2, Number((v * 100n) / scaleMax))
              return <div key={m.month} className="flex flex-1 flex-col items-center gap-1"><div className={`w-full rounded-t ${m.cashEnd < 0n ? 'bg-red-400/70' : 'bg-gradient-to-t from-brand to-electric'}`} style={{ height: `${hgt}%` }} />
                <span className="text-[10px] text-muted">{monthLabel(m.month)}</span></div>
            })}
          </div>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{tr('Proyección mensual por escenario', 'Monthly projection by scenario')}</caption>
            <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="px-3 py-2">{tr('Mes', 'Month')}</th><th scope="col" className="px-3 py-2">{tr('Origen', 'Source')}</th>
              <th scope="col" className="px-3 py-2 text-right">{tr('Ingresos', 'Revenue')}</th><th scope="col" className="px-3 py-2 text-right">{tr('Costos', 'Costs')}</th>
              <th scope="col" className="px-3 py-2 text-right">{tr('Cobros CxC', 'AR collections')}</th><th scope="col" className="px-3 py-2 text-right">{tr('Pagos CxP', 'AP payments')}</th>
              {scen.map((s) => <th key={s} scope="col" className="px-3 py-2 text-right">{tr('Efectivo', 'Cash')} · {scenarioLabel(s, locale)}</th>)}</tr></thead>
            <tbody>
              {p.scenarios.base.months.map((m, i) => (
                <tr key={m.month} className="border-t border-line/60">
                  <th scope="row" className="px-3 py-2 text-left font-normal text-fg">{monthLabel(m.month)}</th>
                  <td className="px-3 py-2 text-xs text-muted">{m.source === 'budget' ? tr('Presupuesto', 'Budget') : tr('Tendencia', 'Trend')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(m.revenue)}</td><td className="px-3 py-2 text-right tabular-nums">{money(m.costs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(m.collections)}</td><td className="px-3 py-2 text-right tabular-nums">{money(m.payments)}</td>
                  {scen.map((s) => { const c = p.scenarios[s].months[i].cashEnd; return <td key={s} className={`px-3 py-2 text-right tabular-nums ${c < 0n ? 'text-red-300' : ''}`}>{money(c)}</td> })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Link href={`/finance/export?${qs}&format=xlsx`} className="btn-secondary btn-sm">Excel</Link>
          <Link href={`/finance/export?${qs}&format=csv`} className="btn-secondary btn-sm">CSV</Link>
        </div>
      </section>

      <section aria-labelledby="hist" className="card overflow-x-auto p-0">
        <h2 id="hist" className="px-4 pt-4 font-display text-lg font-semibold text-fg">{tr('Historial real (últimos 12 meses cerrados o pasados)', 'Actual history (last 12 past months)')}</h2>
        <table className="mt-2 w-full min-w-[480px] text-sm">
          <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th scope="col" className="px-4 py-2">{tr('Mes', 'Month')}</th>
            <th scope="col" className="px-4 py-2 text-right">{tr('Ingresos', 'Revenue')}</th><th scope="col" className="px-4 py-2 text-right">{tr('Costos y gastos', 'Costs and expenses')}</th>
            <th scope="col" className="px-4 py-2 text-right">{tr('Resultado', 'Result')}</th></tr></thead>
          <tbody>{p.history.map((m) => (
            <tr key={m.month} className="border-t border-line/60"><th scope="row" className="px-4 py-2 text-left font-normal">
              <Link href={`/finance/income-statement?period=month&ref=${m.month}-01`} className="hover:text-accent">{monthLabel(m.month)}</Link></th>
              <td className="px-4 py-2 text-right tabular-nums">{money(m.revenue)}</td><td className="px-4 py-2 text-right tabular-nums">{money(m.costs)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(m.revenue - m.costs)}</td></tr>))}</tbody>
        </table>
      </section>
    </div>
  )
}

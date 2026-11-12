import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'
import type { QualityNote } from '@/lib/finance/statements'
import type { Comparison } from '@/lib/finance/finance-page'
import type { PeriodKind } from '@/lib/finance/statements'

/** Section tabs of financial statements (scroll horizontally on phones). */
export function FinanceNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/finance', tr('Panel', 'Dashboard')],
    ['/finance/income-statement', tr('Estado de resultados', 'Income statement')],
    ['/finance/balance-sheet', tr('Balance general', 'Balance sheet')],
    ['/finance/cash-flow', tr('Flujo de efectivo', 'Cash flow')],
    ['/finance/budgets', tr('Presupuestos', 'Budgets')],
    ['/finance/projections', tr('Proyecciones', 'Projections')],
  ]
  return (
    <nav aria-label={tr('Finanzas', 'Finance')} className="-mx-4 overflow-x-auto px-4 print:hidden sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href
                ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoFinanceAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Finanzas', 'Finance')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable ? tr('Los estados financieros todavía no están activados en esta base de datos.', 'Financial statements are not enabled in this database yet.')
          : tr('Solo el propietario y los administradores acceden a los estados financieros.', 'Only the owner and admins can open financial statements.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

/** Report heading: company, period, currency, generation date (also printed in the PDF). */
export function ReportMeta({ tr, company, period, currency, generated, final }: { tr: Tr; company: string; period: string; currency: string; generated: string; final: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-line bg-card/60 p-3 text-xs sm:grid-cols-5">
      <div><dt className="text-muted">{tr('Empresa', 'Company')}</dt><dd className="font-semibold text-fg">{company || '—'}</dd></div>
      <div><dt className="text-muted">{tr('Periodo', 'Period')}</dt><dd className="font-semibold text-fg">{period}</dd></div>
      <div><dt className="text-muted">{tr('Moneda', 'Currency')}</dt><dd className="font-semibold text-fg">{currency}</dd></div>
      <div><dt className="text-muted">{tr('Generado', 'Generated')}</dt><dd className="font-semibold text-fg">{generated}</dd></div>
      <div><dt className="text-muted">{tr('Estado', 'Status')}</dt>
        <dd className={final ? 'font-semibold text-green-300' : 'font-semibold text-amber-300'}>{final ? tr('Definitivo', 'Final') : tr('Provisional', 'Provisional')}</dd></div>
    </dl>
  )
}

/** Why the figures are provisional (each note comes from fs_data_quality). */
export function QualityBanner({ tr, notes }: { tr: Tr; notes: QualityNote[] }) {
  if (!notes.length) return null
  const blocking = notes.some((n) => n.blocking)
  return (
    <div role="note" className={`${blocking ? 'alert-warning' : 'rounded-xl border border-line bg-card/60'} p-4 text-sm`}>
      <p className="font-semibold text-fg">{blocking ? tr('Datos incompletos: este informe no es definitivo', 'Incomplete data: this report is not final') : tr('Notas', 'Notes')}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-300">{notes.map((n) => <li key={n.code}>{n.text}</li>)}</ul>
    </div>
  )
}

/** Period selector (month / quarter / year / custom) with comparison. */
export function PeriodForm({ tr, action, kind, refDate, from, to, compare, showCompare = true }: {
  tr: Tr; action: string; kind: PeriodKind; refDate: string; from: string; to: string; compare: Comparison; showCompare?: boolean
}) {
  return (
    <form action={action} className="card grid gap-3 p-4 print:hidden sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
      <label className="text-sm"><span className="field-label">{tr('Periodo', 'Period')}</span>
        <select name="period" defaultValue={kind} className="field">
          <option value="month">{tr('Mes', 'Month')}</option><option value="quarter">{tr('Trimestre', 'Quarter')}</option>
          <option value="year">{tr('Año', 'Year')}</option><option value="custom">{tr('Personalizado', 'Custom')}</option>
        </select></label>
      <label className="text-sm"><span className="field-label">{tr('Fecha de referencia', 'Reference date')}</span><input type="date" name="ref" defaultValue={refDate} className="field" /></label>
      <label className="text-sm"><span className="field-label">{tr('Desde (personalizado)', 'From (custom)')}</span><input type="date" name="from" defaultValue={kind === 'custom' ? from : ''} className="field" /></label>
      <label className="text-sm"><span className="field-label">{tr('Hasta (personalizado)', 'To (custom)')}</span><input type="date" name="to" defaultValue={kind === 'custom' ? to : ''} className="field" /></label>
      {showCompare ? (
        <label className="text-sm"><span className="field-label">{tr('Comparar con', 'Compare with')}</span>
          <select name="compare" defaultValue={compare} className="field">
            <option value="previous">{tr('Periodo anterior', 'Previous period')}</option><option value="last_year">{tr('Mismo periodo del año anterior', 'Same period last year')}</option>
            <option value="none">{tr('Sin comparación', 'No comparison')}</option>
          </select></label>
      ) : <span />}
      <button type="submit" className="btn-primary">{tr('Ver', 'View')}</button>
    </form>
  )
}

/** Change vs the comparison period, with an explicit favourable / unfavourable word (never colour alone). */
export function Delta({ tr, pct, good, diff }: { tr: Tr; pct: number | null; good: boolean | null; diff: string }) {
  const cls = good === null ? 'text-muted' : good ? 'text-green-300' : 'text-red-300'
  return (
    <span className={`text-xs tabular-nums ${cls}`}>
      {diff}{pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`}
      {good !== null && <span className="sr-only"> · {good ? tr('favorable', 'favourable') : tr('desfavorable', 'unfavourable')}</span>}
      {good !== null && <span aria-hidden="true"> {good ? '▲' : '▼'}</span>}
    </span>
  )
}

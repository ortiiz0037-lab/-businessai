import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { NoPayrollAccess, PayrollNav, TaxNotice } from '@/components/payroll-nav'
import { payrollPage } from '@/lib/payroll/page'
import { hoursLabel, payrollLabel } from '@/lib/payroll/core'
import { payrollSummary } from '@/lib/payroll/report'
import { localDay } from '@/lib/workforce/hours'

export const dynamic = 'force-dynamic'
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Payroll reports: by period, by employee, payment history; CSV export. Approved and paid runs only. */
export default async function PayrollReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, can, plan, money } = await payrollPage()
  if (!can.view) return <NoPayrollAccess tr={tr} reason="role" />
  if (!plan.available) return <NoPayrollAccess tr={tr} reason="plan" />
  const today = localDay(new Date(), 'America/Puerto_Rico')
  const from = DAY.test(params.from ?? '') ? params.from! : `${today.slice(0, 4)}-01-01`
  const to = DAY.test(params.to ?? '') && params.to! >= from ? params.to! : today
  const s = await payrollSummary(supabase, companyId, from, to)
  const qs = new URLSearchParams({ from, to })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Nómina', 'Payroll')} title={tr('Informes de nómina', 'Payroll reports')}
        description={tr('Solo nóminas aprobadas o pagadas (las revertidas y los borradores no cuentan).', 'Approved or paid runs only (reversed runs and drafts never count).')} />
      <PayrollNav tr={tr} current="/payroll/reports" manage={can.manage} />
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-3">
        <label className="field-label">{tr('Periodos que cierran desde', 'Periods ending from')}<input name="from" type="date" defaultValue={from} className="field mt-1" /></label>
        <label className="field-label">{tr('Hasta', 'To')}<input name="to" type="date" defaultValue={to} className="field mt-1" /></label>
        <div className="flex items-end gap-2"><button type="submit" className="btn-primary">{tr('Ver', 'Show')}</button>
          <a className="btn-secondary" href={`/api/payroll/export?${qs}`}>{tr('Exportar CSV', 'Export CSV')}</a></div>
      </form>
      <TaxNotice tr={tr} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="report-totals">
        {[[tr('Bruto', 'Gross'), money(s.totals.gross)], [tr('Deducciones', 'Deductions'), money(s.totals.deductions)], [tr('Neto', 'Net'), money(s.totals.net)]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs uppercase tracking-wider text-muted">{l}</p><p className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">{v}</p></div>
        ))}
      </div>

      <section className="card overflow-x-auto" aria-label={tr('Por empleado', 'By employee')}>
        <h2 className="section-title px-5 pt-5">{tr('Por empleado', 'By employee')}</h2>
        {s.employees.length === 0 ? <EmptyState icon="users" title={tr('Sin nóminas aprobadas en el rango.', 'No approved runs in the range.')} /> : (
          <table className="table-premium mt-2 min-w-[760px] text-sm" data-testid="report-employees">
            <thead><tr><th className="px-5">{tr('Empleado', 'Employee')}</th><th className="text-right">{tr('Nóminas', 'Runs')}</th><th className="text-right">{tr('Regular', 'Regular')}</th>
              <th className="text-right">{tr('Extra', 'OT')}</th><th className="text-right">{tr('Bruto', 'Gross')}</th><th className="text-right">{tr('Deducciones', 'Deductions')}</th><th className="px-5 text-right">{tr('Neto', 'Net')}</th></tr></thead>
            <tbody>{s.employees.map((e) => (
              <tr key={e.employee_id}><td className="px-5 font-semibold text-fg">{e.name}</td><td className="text-right tabular-nums">{e.runs}</td>
                <td className="text-right tabular-nums">{hoursLabel(e.regular_minutes)}</td><td className="text-right tabular-nums">{hoursLabel(e.overtime_minutes)}</td>
                <td className="text-right tabular-nums">{money(e.gross)}</td><td className="text-right tabular-nums">{money(e.deductions)}</td><td className="px-5 text-right tabular-nums">{money(e.net)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto" aria-label={tr('Por periodo y pagos', 'By period and payments')}>
        <h2 className="section-title px-5 pt-5">{tr('Por periodo e historial de pagos', 'By period and payment history')}</h2>
        <table className="table-premium mt-2 min-w-[760px] text-sm" data-testid="report-runs">
          <thead><tr><th className="px-5">{tr('Periodo', 'Period')}</th><th>{tr('Tipo', 'Type')}</th><th>{tr('Estado', 'Status')}</th><th>{tr('Pago registrado', 'Payment recorded')}</th>
            <th className="text-right">{tr('Bruto', 'Gross')}</th><th className="px-5 text-right">{tr('Neto', 'Net')}</th></tr></thead>
          <tbody>{s.runs.map((r) => (
            <tr key={r.id}><td className="px-5"><Link href={`/payroll/runs/${r.id}`} className="font-semibold text-fg hover:text-blue-400">{f.date(r.period_start)} – {f.date(r.period_end)}</Link></td>
              <td>{payrollLabel(r.run_type, locale)}</td><td>{payrollLabel(r.status, locale)}</td>
              <td>{r.payment_date ? `${f.date(r.payment_date)}${r.payment_reference ? ` · ${r.payment_reference}` : ''}` : '—'}</td>
              <td className="text-right tabular-nums">{money(r.gross_cents)}</td><td className="px-5 text-right tabular-nums">{money(r.net_cents)}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  )
}

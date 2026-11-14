import Link from 'next/link'
import { randomUUID } from 'node:crypto'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoPayrollAccess, PayrollNav, TaxNotice } from '@/components/payroll-nav'
import { payrollPage } from '@/lib/payroll/page'
import { FREQUENCIES, lastClosedPeriod, payrollLabel, payrollMessage, type Frequency } from '@/lib/payroll/core'
import { addDays, localDay, weekStart } from '@/lib/workforce/hours'
import { createRun } from '@/app/actions/payroll'

export const dynamic = 'force-dynamic'

type Run = { id: string; run_type: string; pay_frequency: string; period_start: string; period_end: string; pay_date: string; status: string
  gross_cents: string | number; net_cents: string | number; employees: number; blocking_issues: number; created_at: string }

/** Pay runs: history and a new run for the last closed period of a frequency. */
export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ f?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, can, plan, available, money } = await payrollPage()
  if (!available) return <NoPayrollAccess tr={tr} reason="unavailable" />
  if (!can.view) return <NoPayrollAccess tr={tr} reason="role" />
  if (!plan.available) return <NoPayrollAccess tr={tr} reason="plan" />
  const freq = ((FREQUENCIES as readonly string[]).includes(params.f ?? '') ? params.f : 'biweekly') as Frequency
  const { data } = await supabase.from('payroll_runs').select('id, run_type, pay_frequency, period_start, period_end, pay_date, status, gross_cents, net_cents, employees, blocking_issues, created_at')
    .eq('company_id', companyId).order('period_start', { ascending: false }).order('created_at', { ascending: false }).limit(60)
  const runs = (data ?? []) as Run[]
  const today = localDay(new Date(), 'America/Puerto_Rico')
  // weekly / biweekly anchored on the last run of that frequency, else on a Monday
  const anchor = runs.find((r) => r.pay_frequency === freq && r.run_type === 'regular')?.period_start ?? weekStart(today, 1)
  const suggested = lastClosedPeriod(freq, today, anchor)
  const st = (s: string) => ({ draft: 'badge-neutral', approved: 'badge-accent', paid: 'badge-success', reversed: 'badge-danger', discarded: 'badge-neutral' } as Record<string, string>)[s] ?? 'badge-neutral'
  const done: Record<string, string> = { discarded: tr('Borrador descartado.', 'Draft discarded.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Nómina', 'Payroll')} title={tr('Nóminas', 'Pay runs')}
        description={tr('Horas desde Personal, montos exactos en centavos y asientos en la contabilidad. Nada se paga desde BusinessAI: el pago solo se registra.',
          'Hours from Workforce, exact amounts in cents and entries in the ledger. Nothing is paid from BusinessAI: the payment is only recorded.')} />
      <PayrollNav tr={tr} current="/payroll" manage={can.manage} />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{payrollMessage(params.error, locale)}</div>}
      <TaxNotice tr={tr} />

      {can.manage && (
        <section className="card p-5" aria-labelledby="new-run-title" data-testid="new-run">
          <h2 id="new-run-title" className="font-display text-lg font-semibold text-fg">{tr('Nueva nómina', 'New pay run')}</h2>
          <nav className="mt-2 flex flex-wrap gap-2 text-sm" aria-label={tr('Frecuencia', 'Frequency')}>
            {FREQUENCIES.map((x) => <Link key={x} href={`/payroll?f=${x}`} className={x === freq ? 'badge-accent' : 'badge-neutral'}>{payrollLabel(x, locale)}</Link>)}
          </nav>
          <form action={createRun} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input type="hidden" name="pay_frequency" value={freq} /><input type="hidden" name="idem" value={randomUUID()} />
            <label className="field-label">{tr('Frecuencia', 'Frequency')}<input readOnly value={payrollLabel(freq, locale)} className="field mt-1" /></label>
            <label className="field-label">{tr('Inicio del periodo', 'Period start')}<input name="period_start" type="date" required defaultValue={suggested.start} className="field mt-1" /></label>
            <label className="field-label">{tr('Cierre del periodo', 'Period end')}<input name="period_end" type="date" required defaultValue={suggested.end} className="field mt-1" /></label>
            <label className="field-label">{tr('Fecha de pago', 'Pay date')}<input name="pay_date" type="date" required defaultValue={addDays(suggested.end, 5)} className="field mt-1" /></label>
            <div className="flex items-end"><SubmitButton pendingLabel={tr('Creando…', 'Creating…')} className="w-full">{tr('Crear borrador', 'Create draft')}</SubmitButton></div>
          </form>
          <p className="mt-2 text-xs text-muted">{tr('Se sugiere el último periodo cerrado. Las fechas deben corresponder a la frecuencia (semanal 7 días, cada dos semanas 14, quincenal 1–15 y 16–fin de mes, mensual el mes completo).',
            'The last closed period is suggested. The dates must match the frequency (weekly 7 days, every two weeks 14, semimonthly 1–15 and 16–end, monthly the whole month).')}</p>
        </section>
      )}

      <section className="card overflow-x-auto" aria-label={tr('Historial de nóminas', 'Payroll history')}>
        {runs.length === 0 ? <EmptyState icon="wallet" title={tr('Todavía no hay nóminas.', 'No pay runs yet.')} /> : (
          <table className="table-premium min-w-[760px] text-sm" data-testid="runs">
            <thead><tr><th>{tr('Periodo', 'Period')}</th><th>{tr('Tipo', 'Type')}</th><th>{tr('Pago', 'Pay date')}</th><th>{tr('Estado', 'Status')}</th>
              <th className="text-right">{tr('Empleados', 'Employees')}</th><th className="text-right">{tr('Bruto', 'Gross')}</th><th className="text-right">{tr('Neto', 'Net')}</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/payroll/runs/${r.id}`} className="font-semibold text-fg hover:text-blue-400">{f.date(r.period_start)} – {f.date(r.period_end)}</Link>
                    <span className="block text-xs text-muted">{payrollLabel(r.pay_frequency, locale)}</span></td>
                  <td>{payrollLabel(r.run_type, locale)}</td>
                  <td className="whitespace-nowrap">{f.date(r.pay_date)}</td>
                  <td><span className={st(r.status)}>{payrollLabel(r.status, locale)}</span>{r.status === 'draft' && r.blocking_issues > 0 && <span className="badge-warning ml-1">{r.blocking_issues}</span>}</td>
                  <td className="text-right tabular-nums">{r.employees}</td>
                  <td className="text-right tabular-nums">{money(r.gross_cents)}</td>
                  <td className="text-right tabular-nums">{money(r.net_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

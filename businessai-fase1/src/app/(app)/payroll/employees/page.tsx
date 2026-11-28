import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoPayrollAccess, PayrollNav } from '@/components/payroll-nav'
import { payrollPage } from '@/lib/payroll/page'
import { FREQUENCIES, payrollLabel, payrollMessage } from '@/lib/payroll/core'
import { centsToInput } from '@/lib/finance/money'
import { localDay } from '@/lib/workforce/hours'
import { assignItem, endItem, setCompensation } from '@/app/actions/payroll'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Comp = { id: string; employee_id: string; effective_from: string; pay_type: string; pay_frequency: string; hourly_rate_cents: string | null; annual_salary_cents: string | null
  overtime_hourly_rate_cents: string | null; reason: string; created_at: string; created_by: string | null }

/** Compensation: current pay per employee, the dated history, and recurring earnings / deductions. Private (payroll.view). */
export default async function PayrollEmployeesPage({ searchParams }: { searchParams: Promise<{ employee?: string; done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, f, supabase, companyId, can, plan, money } = await payrollPage()
  if (!can.view) return <NoPayrollAccess tr={tr} reason="role" />
  if (!plan.available) return <NoPayrollAccess tr={tr} reason="plan" />
  const today = localDay(new Date(), 'America/Puerto_Rico')
  const [{ data: empData }, { data: compData }, { data: itemData }, { data: assignData }] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name, employee_number, status').eq('company_id', companyId).is('archived_at', null).order('first_name').limit(500),
    supabase.from('employee_compensation').select('*').eq('company_id', companyId).order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('payroll_items').select('id, code, name, kind, calc, active').eq('company_id', companyId).eq('active', true).order('kind').order('name'),
    supabase.from('employee_payroll_items').select('id, employee_id, item_id, amount_cents, rate_bp, starts_on, ends_on').eq('company_id', companyId).order('starts_on', { ascending: false }),
  ])
  const emps = (empData ?? []) as { id: string; first_name: string; last_name: string; employee_number: string | null; status: string }[]
  const comps = (compData ?? []) as Comp[]
  const items = (itemData ?? []) as { id: string; code: string; name: string; kind: string; calc: string }[]
  const assigns = (assignData ?? []) as { id: string; employee_id: string; item_id: string; amount_cents: string | null; rate_bp: number | null; starts_on: string; ends_on: string | null }[]
  const current = (eid: string) => comps.find((c) => c.employee_id === eid && c.effective_from <= today)
  const selected = UUID.test(params.employee ?? '') ? emps.find((e) => e.id === params.employee) ?? null : null
  const done: Record<string, string> = { compensation_saved: tr('Compensación registrada en el historial.', 'Compensation recorded in the history.'),
    item_assigned: tr('Concepto asignado.', 'Item assigned.'), item_ended: tr('Concepto terminado.', 'Item ended.') }
  const pay = (c: Comp) => c.pay_type === 'hourly' ? `${money(c.hourly_rate_cents)}/h` : `${money(c.annual_salary_cents)}/${tr('año', 'yr')}`
  const itemLabel = (iid: string) => items.find((i) => i.id === iid)?.name ?? '—'

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Nómina', 'Payroll')} title={tr('Compensación', 'Compensation')}
        description={tr('Tarifas y salarios con fecha efectiva. Privado: solo propietario y administradores (y cada empleado ve la suya).',
          'Rates and salaries with effective dates. Private: owner and admins only (each employee sees their own).')} />
      <PayrollNav tr={tr} current="/payroll/employees" manage={can.manage} />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{payrollMessage(params.error, locale)}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="card overflow-x-auto p-0" aria-label={tr('Empleados', 'Employees')}>
          {emps.length === 0 ? <EmptyState icon="users" title={tr('No hay empleados.', 'No employees.')} /> : (
            <table className="table-premium text-sm" data-testid="comp-list">
              <thead><tr><th className="px-4">{tr('Empleado', 'Employee')}</th><th>{tr('Pago vigente', 'Current pay')}</th><th>{tr('Frecuencia', 'Frequency')}</th></tr></thead>
              <tbody>
                {emps.map((e) => { const c = current(e.id); return (
                  <tr key={e.id} className={selected?.id === e.id ? 'bg-brand/10' : ''}>
                    <td className="px-4"><Link href={`/payroll/employees?employee=${e.id}`} className="font-semibold text-fg hover:text-blue-400">{e.first_name} {e.last_name}</Link>
                      {e.status !== 'active' && <span className="badge-neutral ml-1">{e.status}</span>}</td>
                    <td className="tabular-nums">{c ? pay(c) : <span className="text-warning">{tr('Sin compensación', 'No compensation')}</span>}</td>
                    <td className="text-xs">{c ? payrollLabel(c.pay_frequency, locale) : '—'}</td>
                  </tr>
                ) })}
              </tbody>
            </table>
          )}
        </section>

        {selected ? (
          <section className="card space-y-4 p-5" aria-labelledby="emp-title" data-testid="comp-detail">
            <h2 id="emp-title" className="font-display text-lg font-semibold text-fg">{selected.first_name} {selected.last_name}</h2>
            <h3 className="font-semibold text-fg">{tr('Historial salarial', 'Pay history')}</h3>
            <ul className="divide-y divide-line text-sm" data-testid="comp-history">
              {comps.filter((c) => c.employee_id === selected.id).length === 0 && <li className="py-2 text-muted">{tr('Sin registros.', 'No records.')}</li>}
              {comps.filter((c) => c.employee_id === selected.id).map((c) => (
                <li key={c.id} className="py-2"><strong className="tabular-nums text-fg">{pay(c)}</strong> · {payrollLabel(c.pay_type, locale)} · {payrollLabel(c.pay_frequency, locale)}
                  <span className="block text-xs text-muted">{tr('Desde', 'From')} {f.date(c.effective_from)} · {c.reason} · {tr('registrado', 'recorded')} {f.dateTime(c.created_at)}
                    {c.overtime_hourly_rate_cents ? ` · ${tr('extra', 'overtime')} ${money(c.overtime_hourly_rate_cents)}/h` : ''}</span></li>
              ))}
            </ul>
            {can.manage && (
              <form action={setCompensation} className="grid gap-2 border-t border-line pt-4 sm:grid-cols-2" data-testid="comp-form">
                <input type="hidden" name="employee_id" value={selected.id} />
                <label className="field-label">{tr('Tipo de pago', 'Pay type')}<select name="pay_type" className="field mt-1"><option value="hourly">{payrollLabel('hourly', locale)}</option><option value="salary">{payrollLabel('salary', locale)}</option></select></label>
                <label className="field-label">{tr('Frecuencia de pago', 'Pay frequency')}<select name="pay_frequency" defaultValue={current(selected.id)?.pay_frequency ?? 'biweekly'} className="field mt-1">
                  {FREQUENCIES.map((x) => <option key={x} value={x}>{payrollLabel(x, locale)}</option>)}</select></label>
                <label className="field-label">{tr('Tarifa por hora o salario ANUAL ($)', 'Hourly rate or ANNUAL salary ($)')}<input name="amount" required inputMode="decimal"
                  defaultValue={current(selected.id) ? centsToInput(current(selected.id)!.hourly_rate_cents ?? current(selected.id)!.annual_salary_cents) : ''} className="field mt-1" /></label>
                <label className="field-label">{tr('Fecha efectiva', 'Effective date')}<input name="effective_from" type="date" required defaultValue={today} className="field mt-1" /></label>
                <label className="field-label sm:col-span-2">{tr('Tarifa de horas extra para asalariado no exento ($/h, opcional)', 'Overtime rate for a salaried non-exempt employee ($/h, optional)')}<input name="overtime_rate" inputMode="decimal" className="field mt-1" /></label>
                <label className="field-label sm:col-span-2">{tr('Motivo del cambio *', 'Reason for the change *')}<input name="reason" required minLength={3} maxLength={300} className="field mt-1" /></label>
                <div className="sm:col-span-2"><SubmitButton pendingLabel="…" className="w-auto">{tr('Registrar compensación', 'Record compensation')}</SubmitButton></div>
                <p className="text-xs text-muted sm:col-span-2">{tr('Nada se borra: un cambio es un registro nuevo con su fecha. Una fecha dentro de un periodo ya aprobado se rechaza (usa una nómina de corrección). BusinessAI no calcula la tarifa de horas extra de un asalariado: la defines tú.',
                  'Nothing is deleted: a change is a new record with its date. A date inside an approved period is refused (use a correction run). BusinessAI does not derive a salaried employee\'s overtime rate: you set it.')}</p>
              </form>
            )}
            <h3 className="font-semibold text-fg">{tr('Ingresos y deducciones recurrentes', 'Recurring earnings and deductions')}</h3>
            <ul className="divide-y divide-line text-sm">
              {assigns.filter((a) => a.employee_id === selected.id).length === 0 && <li className="py-2 text-muted">{tr('Ninguno.', 'None.')}</li>}
              {assigns.filter((a) => a.employee_id === selected.id).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{itemLabel(a.item_id)} · <strong className="tabular-nums">{a.rate_bp ? `${a.rate_bp / 100} %` : money(a.amount_cents)}</strong>
                    <span className="text-xs text-muted"> · {tr('desde', 'from')} {f.date(a.starts_on)}{a.ends_on ? ` ${tr('hasta', 'to')} ${f.date(a.ends_on)}` : ''}</span></span>
                  {!a.ends_on && can.manage && (
                    <form action={endItem} className="flex gap-2"><input type="hidden" name="id" value={a.id} /><input type="hidden" name="employee_id" value={selected.id} />
                      <input name="last_day" type="date" required defaultValue={today} aria-label={tr('Último día', 'Last day')} className="field w-36 py-1 text-sm" />
                      <button type="submit" className="btn-secondary btn-sm">{tr('Terminar', 'End')}</button></form>
                  )}
                </li>
              ))}
            </ul>
            {can.manage && items.length > 0 && (
              <form action={assignItem} className="grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="employee_id" value={selected.id} />
                <label className="field-label sm:col-span-2">{tr('Concepto', 'Item')}<select name="item_id" required className="field mt-1">
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name} · {payrollLabel(i.kind, locale)} · {payrollLabel(i.calc, locale)}</option>)}</select></label>
                <label className="field-label">{tr('Monto por periodo ($) — conceptos fijos', 'Amount per period ($) — fixed items')}<input name="amount" inputMode="decimal" className="field mt-1" /></label>
                <label className="field-label">{tr('Porcentaje del bruto — deducciones %', 'Percent of gross — % deductions')}<input name="percent" inputMode="decimal" className="field mt-1" /></label>
                <label className="field-label">{tr('Desde', 'From')}<input name="starts_on" type="date" required defaultValue={today} className="field mt-1" /></label>
                <div className="flex items-end"><SubmitButton pendingLabel="…" className="w-auto">{tr('Asignar', 'Assign')}</SubmitButton></div>
              </form>
            )}
          </section>
        ) : <p className="card p-5 text-sm text-muted">{tr('Elige un empleado para ver o registrar su compensación.', 'Choose an employee to see or record their compensation.')}</p>}
      </div>
    </div>
  )
}

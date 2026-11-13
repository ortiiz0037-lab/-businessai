import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoPayrollAccess, PayrollNav, TaxNotice } from '@/components/payroll-nav'
import { payrollPage } from '@/lib/payroll/page'
import { BLOCKING_ISSUES, hoursLabel, payrollLabel, payrollMessage } from '@/lib/payroll/core'
import { addAdjustment, approveRun, createCorrection, discardRun, prepareRun, recordPayment, removeAdjustment, reverseRun } from '@/app/actions/payroll'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Run = { id: string; run_type: string; corrects_run_id: string | null; pay_frequency: string; period_start: string; period_end: string; pay_date: string; status: string
  version: number; prepared_version: number | null; gross_cents: string; deductions_cents: string; taxes_cents: string; net_cents: string; employees: number; blocking_issues: number; tax_status: string
  prepared_at: string | null; approved_at: string | null; approved_by: string | null; self_approved: boolean | null; paid_at: string | null; payment_date: string | null
  payment_reference: string | null; reversed_at: string | null; reverse_reason: string | null; expense_entry_id: string | null; payment_entry_id: string | null }
type Line = { id: string; employee_id: string; employee_name: string; employee_number: string | null; pay_type: string | null; hourly_rate_cents: string | null
  annual_salary_cents: string | null; overtime_multiplier: string | null; regular_minutes: number; overtime_minutes: number; worked_minutes_verified: number | null
  leave_paid_minutes: number; regular_pay_cents: string; overtime_pay_cents: string; leave_pay_cents: string; salary_pay_cents: string; other_earnings_cents: string
  gross_cents: string; deductions_cents: string; taxes_cents: string; net_cents: string; issues: string[]; blocking: boolean }

/** One pay run: preview, adjustments, approval of the previewed version, payment, reversal, corrections, export. */
export default async function PayrollRunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const { id } = await params
  const q = await searchParams
  const { locale, tr, f, supabase, companyId, can, plan, money } = await payrollPage()
  if (!can.view) return <NoPayrollAccess tr={tr} reason="role" />
  if (!plan.available) return <NoPayrollAccess tr={tr} reason="plan" />
  if (!UUID.test(id)) redirect('/payroll')
  const { data } = await supabase.from('payroll_runs').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!data) redirect('/payroll?error=payroll_run_not_found')
  const run = data as Run
  const [{ data: lineData }, { data: adjData }, { data: itemData }, { data: evData }, { data: empData }, { data: corrData }] = await Promise.all([
    supabase.from('payroll_lines').select('*').eq('run_id', id).order('employee_name'),
    supabase.from('payroll_adjustments').select('id, employee_id, item_id, amount_cents, note').eq('run_id', id).order('created_at'),
    supabase.from('payroll_items').select('id, code, name, kind, calc, active').eq('company_id', companyId).eq('active', true).order('kind').order('name'),
    supabase.from('payroll_events').select('id, action, details, created_at').eq('run_id', id).order('id', { ascending: false }).limit(40),
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).in('status', ['active', 'suspended', 'inactive', 'terminated']).order('first_name').limit(500),
    supabase.from('payroll_runs').select('id, status, gross_cents').eq('corrects_run_id', id),
  ])
  const lines = (lineData ?? []) as Line[]
  const adjustments = (adjData ?? []) as { id: string; employee_id: string; item_id: string; amount_cents: string; note: string | null }[]
  const items = (itemData ?? []) as { id: string; code: string; name: string; kind: string; calc: string }[]
  const emps = (empData ?? []) as { id: string; first_name: string; last_name: string }[]
  const empName = (eid: string) => { const e = emps.find((x) => x.id === eid); return e ? `${e.first_name} ${e.last_name}` : lines.find((l) => l.employee_id === eid)?.employee_name ?? '—' }
  const itemName = (iid: string) => items.find((i) => i.id === iid)?.name ?? '—'
  const draft = run.status === 'draft'
  const done: Record<string, string> = {
    created: tr('Borrador creado. Prepara la nómina para ver la vista previa.', 'Draft created. Prepare the payroll to see the preview.'),
    prepared: tr('Vista previa calculada con las horas verificadas del reloj ponchador.', 'Preview computed with the hours verified against the time clock.'),
    adjustment_added: tr('Ajuste añadido: vuelve a preparar la nómina.', 'Adjustment added: prepare the payroll again.'),
    adjustment_removed: tr('Ajuste eliminado: vuelve a preparar la nómina.', 'Adjustment removed: prepare the payroll again.'),
    approved: tr('Nómina aprobada y registrada en la contabilidad. Ya no se puede modificar.', 'Payroll approved and posted to the ledger. It can no longer be changed.'),
    paid: tr('Pago registrado en la contabilidad (BusinessAI no mueve dinero).', 'Payment recorded in the ledger (BusinessAI moves no money).'),
    reversed: tr('Nómina revertida con asientos espejo. El historial se conserva.', 'Payroll reversed with mirror entries. The history is kept.'),
  }
  const needsPrepare = draft && run.prepared_version !== run.version

  return (
    <div className="space-y-6">
      <Link href="/payroll" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Nóminas', '← Pay runs')}</Link>
      <PageHeader eyebrow={`${tr('Nómina', 'Payroll')} · ${payrollLabel(run.run_type, locale)} · ${payrollLabel(run.pay_frequency, locale)}`}
        title={`${f.date(run.period_start)} – ${f.date(run.period_end)}`}
        description={`${tr('Fecha de pago', 'Pay date')}: ${f.date(run.pay_date)} · ${tr('Estado', 'Status')}: ${payrollLabel(run.status, locale)}${run.corrects_run_id ? ` · ${tr('corrige otra nómina', 'corrects another run')}` : ''}`} />
      <PayrollNav tr={tr} current="/payroll" manage={can.manage} />
      {q.done && done[q.done] && <div role="status" className="alert-success p-4">{done[q.done]}</div>}
      {q.error && <div role="alert" className="alert-danger p-4">{payrollMessage(q.error, locale)}</div>}
      <TaxNotice tr={tr} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="run-totals">
        {[[tr('Empleados', 'Employees'), String(run.employees)], [tr('Bruto', 'Gross'), money(run.gross_cents)], [tr('Deducciones', 'Deductions'), money(run.deductions_cents)],
          [tr('Impuestos', 'Taxes'), tr('No calculados', 'Not calculated')], [tr('Neto', 'Net'), money(run.net_cents)]].map(([l, v]) => (
          <div key={l} className="card p-4"><p className="text-xs uppercase tracking-wider text-muted">{l}</p><p className="mt-1 font-display text-xl font-semibold tabular-nums text-fg">{v}</p></div>
        ))}
      </div>
      {needsPrepare && run.prepared_at && <p className="alert-warning p-4 text-sm" data-testid="stale-preview">{tr('Hubo cambios desde la última preparación: vuelve a preparar la nómina antes de aprobar.', 'There were changes since the last preparation: prepare the payroll again before approving.')}</p>}
      {draft && run.blocking_issues > 0 && <p className="alert-danger p-4 text-sm">{tr(`${run.blocking_issues} empleado(s) con problemas que impiden aprobar.`, `${run.blocking_issues} employee(s) with issues that prevent approval.`)}</p>}

      <section className="card overflow-x-auto" aria-label={tr('Vista previa por empleado', 'Preview by employee')}>
        {lines.length === 0 ? <p className="p-5 text-sm text-muted">{tr('Sin vista previa todavía.', 'No preview yet.')}</p> : (
          <table className="table-premium min-w-[1100px] text-sm" data-testid="run-lines">
            <thead><tr>
              <th>{tr('Empleado', 'Employee')}</th><th>{tr('Pago', 'Pay')}</th><th className="text-right">{tr('Regular', 'Regular')}</th><th className="text-right">{tr('Extra', 'OT')}</th>
              <th className="text-right">{tr('Licencia', 'Leave')}</th><th className="text-right">{tr('Sueldo', 'Wages')}</th><th className="text-right">{tr('Otros ingresos', 'Other')}</th>
              <th className="text-right">{tr('Bruto', 'Gross')}</th><th className="text-right">{tr('Deducciones', 'Deductions')}</th><th className="text-right">{tr('Neto', 'Net')}</th><th>{tr('Revisión', 'Review')}</th>
            </tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap"><span className="font-semibold text-fg">{l.employee_name}</span>{l.employee_number ? <span className="text-xs text-muted"> #{l.employee_number}</span> : null}
                    {(run.status === 'approved' || run.status === 'paid') && <a href={`/api/payroll/payslips/${l.id}`} className="block text-xs text-blue-400">{tr('Recibo (PDF)', 'Pay stub (PDF)')}</a>}</td>
                  <td className="whitespace-nowrap text-xs">{l.pay_type ? payrollLabel(l.pay_type, locale) : '—'}<span className="block text-muted">
                    {l.pay_type === 'hourly' ? `${money(l.hourly_rate_cents)}/h` : l.pay_type === 'salary' ? `${money(l.annual_salary_cents)}/${tr('año', 'yr')}` : ''}</span></td>
                  <td className="text-right tabular-nums">{money(l.regular_pay_cents)}<span className="block text-xs text-muted">{hoursLabel(l.regular_minutes)} h</span></td>
                  <td className="text-right tabular-nums">{money(l.overtime_pay_cents)}<span className="block text-xs text-muted">{hoursLabel(l.overtime_minutes)} h{l.overtime_multiplier ? ` ×${Number(l.overtime_multiplier)}` : ''}</span></td>
                  <td className="text-right tabular-nums">{money(l.leave_pay_cents)}<span className="block text-xs text-muted">{hoursLabel(l.leave_paid_minutes)} h</span></td>
                  <td className="text-right tabular-nums">{money(l.salary_pay_cents)}</td>
                  <td className="text-right tabular-nums">{money(l.other_earnings_cents)}</td>
                  <td className="text-right font-semibold tabular-nums">{money(l.gross_cents)}</td>
                  <td className="text-right tabular-nums">{money(l.deductions_cents)}</td>
                  <td className="text-right font-semibold tabular-nums">{money(l.net_cents)}</td>
                  <td className="text-xs">{l.issues.length === 0 ? <span className="text-success">{tr('Listo', 'Ready')}</span>
                    : l.issues.map((i) => <span key={i} className={`block ${BLOCKING_ISSUES.has(i) ? 'text-danger' : 'text-warning'}`}>{payrollLabel(i, locale)}</span>)}
                    {l.worked_minutes_verified !== null && <span className="block text-muted">{tr('Reloj', 'Clock')}: {hoursLabel(l.worked_minutes_verified)} h ✓</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card space-y-3 p-5" aria-labelledby="adj-title" data-testid="adjustments">
          <h2 id="adj-title" className="font-display text-lg font-semibold text-fg">{tr('Bonificaciones, comisiones y ajustes', 'Bonuses, commissions and adjustments')}</h2>
          <ul className="divide-y divide-line text-sm">
            {adjustments.length === 0 && <li className="py-2 text-muted">{tr('Sin ajustes.', 'No adjustments.')}</li>}
            {adjustments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                <span>{empName(a.employee_id)} · {itemName(a.item_id)} · <strong className="tabular-nums">{money(a.amount_cents)}</strong>{a.note ? <span className="text-xs text-muted"> · {a.note}</span> : null}</span>
                {draft && can.manage && <form action={removeAdjustment}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="run_id" value={id} />
                  <button type="submit" className="btn-secondary btn-sm">{tr('Quitar', 'Remove')}</button></form>}
              </li>
            ))}
          </ul>
          {draft && can.manage && (items.filter((i) => i.calc === 'fixed').length === 0
            ? <p className="text-xs text-muted">{tr('Crea conceptos (bonificación, comisión, deducción) en Configuración.', 'Create items (bonus, commission, deduction) in Settings.')}</p>
            : (
              <form action={addAdjustment} className="grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="run_id" value={id} />
                <label className="field-label">{tr('Empleado', 'Employee')}<select name="employee_id" required className="field mt-1">
                  {(lines.length ? lines.map((l) => ({ id: l.employee_id, name: l.employee_name })) : emps.map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}` }))).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
                <label className="field-label">{tr('Concepto', 'Item')}<select name="item_id" required className="field mt-1">
                  {items.filter((i) => i.calc === 'fixed').map((i) => <option key={i.id} value={i.id}>{i.name} · {payrollLabel(i.kind, locale)}</option>)}</select></label>
                <label className="field-label">{tr('Monto ($)', 'Amount ($)')}<input name="amount" required inputMode="decimal" className="field mt-1" /></label>
                <label className="field-label">{tr('Nota', 'Note')}<input name="note" maxLength={200} className="field mt-1" /></label>
                <div className="sm:col-span-2"><SubmitButton pendingLabel="…" className="w-auto">{tr('Añadir ajuste', 'Add adjustment')}</SubmitButton></div>
              </form>
            ))}
        </section>

        <section className="card space-y-4 p-5" aria-labelledby="actions-title" data-testid="run-actions">
          <h2 id="actions-title" className="font-display text-lg font-semibold text-fg">{tr('Acciones', 'Actions')}</h2>
          {draft && can.manage && (
            <form action={prepareRun}><input type="hidden" name="id" value={id} />
              <SubmitButton pendingLabel={tr('Calculando…', 'Computing…')} className="w-auto">{run.prepared_at ? tr('Volver a preparar (recalcular)', 'Prepare again (recompute)') : tr('Preparar nómina', 'Prepare payroll')}</SubmitButton>
              <p className="mt-1 text-xs text-muted">{tr('Toma las horas de Personal (reglas de horas extra aprobadas) y las verifica contra el reloj ponchador.', 'Takes the hours from Workforce (approved overtime rules) and verifies them against the time clock.')}</p>
            </form>
          )}
          {draft && can.approve && run.prepared_at && !needsPrepare && (
            <form action={approveRun} className="space-y-2">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={run.version} />
              <label className="flex items-start gap-2 text-sm text-slate-300"><input type="checkbox" name="confirm" required className="mt-1" />
                <span>{tr(`Revisé esta vista previa (versión ${run.version}): ${run.employees} empleado(s), bruto ${money(run.gross_cents)}, neto ${money(run.net_cents)}. Al aprobar se bloquea y se registra en la contabilidad.`,
                  `I reviewed this preview (version ${run.version}): ${run.employees} employee(s), gross ${money(run.gross_cents)}, net ${money(run.net_cents)}. Approving locks it and posts it to the ledger.`)}</span></label>
              <button type="submit" className="btn-primary" disabled={run.blocking_issues > 0}>{tr('Aprobar nómina', 'Approve payroll')}</button>
            </form>
          )}
          {draft && can.manage && (
            <form action={discardRun}><input type="hidden" name="id" value={id} /><button type="submit" className="btn-secondary btn-sm">{tr('Descartar borrador', 'Discard draft')}</button></form>
          )}
          {run.status === 'approved' && can.approve && (
            <form action={recordPayment} className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
              <input type="hidden" name="id" value={id} />
              <input name="paid_on" type="date" required defaultValue={run.pay_date} aria-label={tr('Fecha del pago', 'Payment date')} className="field" />
              <input name="reference" maxLength={100} placeholder={tr('Referencia (ej. depósito)', 'Reference (e.g. deposit)')} aria-label={tr('Referencia', 'Reference')} className="field" />
              <button type="submit" className="btn-primary btn-sm">{tr('Registrar pago', 'Record payment')}</button>
            </form>
          )}
          {(run.status === 'approved' || run.status === 'paid') && can.approve && (
            <form action={reverseRun} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo de la reversión', 'Reason for the reversal')} aria-label={tr('Motivo', 'Reason')} className="field w-full" />
              <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" name="confirm" required /> {tr('Revertir con asientos espejo (el historial se conserva)', 'Reverse with mirror entries (history is kept)')}</label>
              <button type="submit" className="btn-danger btn-sm">{tr('Revertir nómina', 'Reverse payroll')}</button>
            </form>
          )}
          {(run.status === 'approved' || run.status === 'paid') && run.run_type === 'regular' && can.manage && (
            <form action={createCorrection}><input type="hidden" name="id" value={id} />
              <button type="submit" className="btn-secondary btn-sm">{tr('Crear nómina de corrección', 'Create a correction run')}</button></form>
          )}
          <p className="text-sm"><a className="btn-secondary btn-sm" href={`/api/payroll/export?run=${id}`}>{tr('Exportar CSV', 'Export CSV')}</a></p>
          <ul className="space-y-1 text-xs text-muted">
            {run.approved_at && <li>{tr('Aprobada', 'Approved')}: {f.dateTime(run.approved_at)}{run.self_approved ? ` · ${tr('aprobada por quien la preparó o cobra en ella', 'approved by its preparer or a payee')}` : ''}</li>}
            {run.paid_at && <li>{tr('Pago registrado', 'Payment recorded')}: {run.payment_date ? f.date(run.payment_date) : ''}{run.payment_reference ? ` · ${run.payment_reference}` : ''}</li>}
            {run.reversed_at && <li>{tr('Revertida', 'Reversed')}: {f.dateTime(run.reversed_at)} · {run.reverse_reason}</li>}
            {(run.expense_entry_id || run.payment_entry_id) && <li><Link href="/accounting/journal?source=payroll" className="text-blue-400">{tr('Ver asientos en el diario', 'See the journal entries')}</Link></li>}
            {((corrData ?? []) as { id: string; status: string }[]).map((c) => <li key={c.id}><Link href={`/payroll/runs/${c.id}`} className="text-blue-400">{tr('Corrección', 'Correction')} · {payrollLabel(c.status, locale)}</Link></li>)}
          </ul>
        </section>
      </div>

      <details className="card p-5">
        <summary className="cursor-pointer font-display text-lg font-semibold text-fg">{tr('Auditoría', 'Audit trail')}</summary>
        <ul className="mt-2 space-y-1 text-xs text-slate-400" data-testid="run-audit">
          {((evData ?? []) as { id: number; action: string; details: Record<string, unknown>; created_at: string }[]).map((e) =>
            <li key={e.id}>{f.dateTime(e.created_at)} · {e.action}{Object.keys(e.details).length ? ` · ${JSON.stringify(e.details).slice(0, 160)}` : ''}</li>)}
        </ul>
      </details>
    </div>
  )
}

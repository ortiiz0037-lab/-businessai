import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { NoPayrollAccess, PayrollNav, TaxNotice } from '@/components/payroll-nav'
import { payrollPage } from '@/lib/payroll/page'
import { payrollLabel, payrollMessage } from '@/lib/payroll/core'
import { leaveLabel, LEAVE_TYPES } from '@/lib/workforce/context'
import { saveItem, saveSettings } from '@/app/actions/payroll'

export const dynamic = 'force-dynamic'

/** Payroll settings: earnings / deductions catalog, ledger accounts, paid leave, second approver, tax rules (disabled). */
export default async function PayrollSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const params = await searchParams
  const { locale, tr, supabase, companyId, can, plan, money } = await payrollPage()
  if (!can.manage) return <NoPayrollAccess tr={tr} reason="role" />
  if (!plan.available) return <NoPayrollAccess tr={tr} reason="plan" />
  const [{ data: itemData }, { data: settings }, { data: accData }, { data: taxData }] = await Promise.all([
    supabase.from('payroll_items').select('id, code, name, kind, calc, default_amount_cents, default_rate_bp, active').eq('company_id', companyId).order('kind').order('name'),
    supabase.from('payroll_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, status').eq('company_id', companyId).eq('status', 'active').order('code'),
    supabase.from('payroll_tax_rules').select('id, jurisdiction, code, name_es, name_en, status, note_es, note_en').order('jurisdiction').order('code'),
  ])
  const items = (itemData ?? []) as { id: string; code: string; name: string; kind: string; calc: string; default_amount_cents: string | null; default_rate_bp: number | null }[]
  const s = settings as { expense_account_id: string; wages_payable_account_id: string; deductions_payable_account_id: string; payment_account_id: string; paid_leave_types: string[]; require_second_approver: boolean } | null
  const accounts = (accData ?? []) as { id: string; code: string; name: string; name_en: string | null; type: string }[]
  const taxes = (taxData ?? []) as { id: string; jurisdiction: string; code: string; name_es: string; name_en: string; status: string; note_es: string; note_en: string }[]
  const acc = (type: string) => accounts.filter((a) => a.type === type)
  const accName = (a: { code: string; name: string; name_en: string | null }) => `${a.code} · ${locale === 'en' ? a.name_en ?? a.name : a.name}`
  const done: Record<string, string> = { item_saved: tr('Concepto creado.', 'Item created.'), settings_saved: tr('Configuración guardada.', 'Settings saved.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Nómina', 'Payroll')} title={tr('Configuración de nómina', 'Payroll settings')} />
      <PayrollNav tr={tr} current="/payroll/settings" manage />
      {params.done && done[params.done] && <div role="status" className="alert-success p-4">{done[params.done]}</div>}
      {params.error && <div role="alert" className="alert-danger p-4">{payrollMessage(params.error, locale)}</div>}

      <section className="card p-5" aria-labelledby="items-title" data-testid="payroll-items">
        <h2 id="items-title" className="font-display text-lg font-semibold text-fg">{tr('Conceptos: bonificaciones, comisiones y deducciones', 'Items: bonuses, commissions and deductions')}</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {items.length === 0 && <li className="py-2 text-muted">{tr('Todavía no hay conceptos.', 'No items yet.')}</li>}
          {items.map((i) => <li key={i.id} className="py-2"><strong className="text-fg">{i.name}</strong> <span className="text-xs text-muted">{i.code} · {payrollLabel(i.kind, locale)} · {payrollLabel(i.calc, locale)}
            {i.default_rate_bp ? ` · ${i.default_rate_bp / 100} %` : i.default_amount_cents ? ` · ${money(i.default_amount_cents)}` : ''}</span></li>)}
        </ul>
        <form action={saveItem} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <label className="field-label">{tr('Código', 'Code')}<input name="code" required pattern="[A-Za-z0-9_]{2,24}" maxLength={24} placeholder="BONO" className="field mt-1" /></label>
          <label className="field-label sm:col-span-2">{tr('Nombre', 'Name')}<input name="name" required maxLength={80} className="field mt-1" /></label>
          <label className="field-label">{tr('Tipo', 'Kind')}<select name="kind" className="field mt-1"><option value="earning">{payrollLabel('earning', locale)}</option><option value="deduction">{payrollLabel('deduction', locale)}</option></select></label>
          <label className="field-label">{tr('Cálculo', 'Calculation')}<select name="calc" className="field mt-1"><option value="fixed">{payrollLabel('fixed', locale)}</option><option value="percent">{payrollLabel('percent', locale)}</option></select></label>
          <label className="field-label">{tr('% (solo deducciones)', '% (deductions only)')}<input name="percent" inputMode="decimal" className="field mt-1" /></label>
          <div className="sm:col-span-3 lg:col-span-6"><SubmitButton pendingLabel="…" className="w-auto">{tr('Crear concepto', 'Create item')}</SubmitButton></div>
        </form>
        <p className="mt-2 text-xs text-muted">{tr('Las deducciones aquí son las que tú configuras (seguros, planes, préstamos, etc.). Ninguna es un impuesto: los impuestos no se calculan.',
          'Deductions here are the ones you configure (insurance, plans, loans, etc.). None of them is a tax: taxes are not calculated.')}</p>
      </section>

      {s ? (
        <section className="card p-5" aria-labelledby="set-title" data-testid="payroll-settings">
          <h2 id="set-title" className="font-display text-lg font-semibold text-fg">{tr('Contabilidad, licencias y aprobación', 'Accounting, leave and approval')}</h2>
          <form action={saveSettings} className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="field-label">{tr('Gasto de nómina', 'Payroll expense')}<select name="expense_account_id" defaultValue={s.expense_account_id} className="field mt-1">{acc('expense').map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}</select></label>
            <label className="field-label">{tr('Salarios por pagar', 'Wages payable')}<select name="wages_account_id" defaultValue={s.wages_payable_account_id} className="field mt-1">{acc('liability').map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}</select></label>
            <label className="field-label">{tr('Deducciones por pagar', 'Deductions payable')}<select name="deductions_account_id" defaultValue={s.deductions_payable_account_id} className="field mt-1">{acc('liability').map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}</select></label>
            <label className="field-label">{tr('Cuenta de pago', 'Payment account')}<select name="payment_account_id" defaultValue={s.payment_account_id} className="field mt-1">{acc('asset').map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}</select></label>
            <fieldset className="sm:col-span-2"><legend className="field-label">{tr('Licencias pagadas (a la tarifa regular, por el tiempo programado)', 'Paid leave (at the regular rate, for the scheduled time)')}</legend>
              <div className="mt-1 flex flex-wrap gap-3">{LEAVE_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1 text-sm text-slate-300"><input type="checkbox" name="paid_leave_types" value={t} defaultChecked={s.paid_leave_types.includes(t)} /> {leaveLabel(t, locale)}</label>))}</div>
              <p className="mt-1 text-xs text-muted">{tr('Ninguna licencia se paga por defecto: decide según tu política y la ley que aplique.', 'No leave is paid by default: decide per your policy and the applicable law.')}</p>
            </fieldset>
            <label className="flex items-center gap-2 text-sm text-slate-300 sm:col-span-2"><input type="checkbox" name="second_approver" defaultChecked={s.require_second_approver} />
              {tr('Exigir un segundo aprobador (quien prepara o cobra en la nómina no puede aprobarla)', 'Require a second approver (whoever prepares or is paid in the run cannot approve it)')}</label>
            <div className="sm:col-span-2">{can.approve ? <SubmitButton pendingLabel="…" className="w-auto">{tr('Guardar configuración', 'Save settings')}</SubmitButton>
              : <p className="text-xs text-muted">{tr('Solo quien aprueba nóminas cambia esta configuración.', 'Only someone who approves payroll changes these settings.')}</p>}</div>
          </form>
        </section>
      ) : <p className="card p-5 text-sm text-muted">{tr('Las cuentas contables de nómina (6100, 2200, 2210 y 1010) se configuran al crear la primera nómina.', 'The payroll ledger accounts (6100, 2200, 2210 and 1010) are set up when the first pay run is created.')}</p>}

      <section className="card p-5" aria-labelledby="tax-title" data-testid="tax-rules">
        <h2 id="tax-title" className="font-display text-lg font-semibold text-fg">{tr('Impuestos y jurisdicciones', 'Taxes and jurisdictions')}</h2>
        <TaxNotice tr={tr} />
        <ul className="mt-3 divide-y divide-line text-sm">
          {taxes.map((t) => <li key={t.id} className="py-2"><span className="badge-neutral">{t.jurisdiction}</span> <strong className="text-fg">{locale === 'en' ? t.name_en : t.name_es}</strong>
            <span className="badge-warning ml-2">{t.status === 'disabled' ? tr('Desactivada', 'Disabled') : t.status}</span>
            <span className="block text-xs text-muted">{locale === 'en' ? t.note_en : t.note_es}</span></li>)}
        </ul>
        <p className="mt-2 text-xs text-muted">{tr('Activar una regla requiere tasas, bases y fuentes verificadas y una aprobación registrada; aun así, esta versión se niega a calcular impuestos hasta que exista un cálculo verificado.',
          'Enabling a rule requires verified rates, bases and sources and a recorded approval; even then, this version refuses to compute taxes until a verified calculation exists.')}</p>
      </section>
    </div>
  )
}

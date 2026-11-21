import Link from 'next/link'
import { notFound } from 'next/navigation'
import PrintButton from '@/components/PrintButton'
import { PageHeader, StatCard } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { FinanceNav, NoFinanceAccess, ReportMeta } from '@/components/finance-nav'
import { financePage } from '@/lib/finance/finance-page'
import { alertLabel, budgetEventLabel, budgetStatusLabel, budgetStatusTone, financeMessage, scenarioLabel, type Budget, type BudgetLine, type VsActual } from '@/lib/finance/budget'
import { compare } from '@/lib/finance/statements'
import { toCents } from '@/lib/finance/money'
import { approveBudget, archiveBudget, fillBudget, newBudgetVersion, publishBudget, setBudgetLine, updateBudget } from '@/app/actions/finance'

export const dynamic = 'force-dynamic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ALERT_CLS: Record<string, string> = { ok: 'badge-success', warning: 'badge-warning', critical: 'badge-danger' }

type SP = { done?: string; error?: string; as_of?: string; edit?: string; compare?: string }

/** One budget version: lines, workflow, budget vs actual, versions and audit trail. */
export default async function BudgetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  if (!UUID.test(id)) notFound()
  const { locale, tr, f, money, today, supabase, companyId, access, who, currency, companyName } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const { data: bd } = await supabase.from('budgets').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const b = bd as Budget | null
  if (!b) notFound()
  const asOf = sp.as_of && DAY.test(sp.as_of) ? sp.as_of : today
  const [{ data: ld }, { data: va }, { data: acc }, { data: cats }, { data: vers }, { data: ev }, name] = await Promise.all([
    supabase.from('budget_lines').select('*').eq('budget_id', b.id).order('month', { nullsFirst: true }),
    supabase.rpc('budget_vs_actual', { budget: b.id, as_of: asOf }),
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, status').eq('company_id', companyId).in('type', ['revenue', 'expense']).order('code'),
    supabase.from('expense_categories').select('id, name, name_en, account_id').eq('company_id', companyId).order('name'),
    supabase.from('budgets').select('id, version, status, created_at').eq('root_id', b.root_id).order('version', { ascending: false }),
    supabase.from('budget_events').select('action, details, actor, created_at').eq('budget_id', b.id).order('id', { ascending: false }).limit(100),
    who(),
  ])
  const lines = (ld ?? []) as BudgetLine[]
  const vs = (va ?? []) as VsActual[]
  const accounts = (acc ?? []) as { id: string; code: string; name: string; name_en: string | null; type: string; status: string }[]
  const categories = (cats ?? []) as { id: string; name: string; name_en: string | null; account_id: string }[]
  const versions = (vers ?? []) as { id: string; version: number; status: string; created_at: string }[]
  const events = (ev ?? []) as { action: string; details: Record<string, unknown>; actor: string | null; created_at: string }[]
  const label = (key: string) => {
    const a = accounts.find((x) => `a:${x.id}` === key); if (a) return `${a.code} ${locale === 'en' && a.name_en ? a.name_en : a.name}`
    const c = categories.find((x) => `c:${x.id}` === key); if (c) return `${tr('Categoría', 'Category')}: ${locale === 'en' && c.name_en ? c.name_en : c.name}`
    return '—'
  }
  const keyOf = (l: Pick<BudgetLine, 'account_id' | 'category_id'>) => l.account_id ? `a:${l.account_id}` : `c:${l.category_id}`
  const targets = [...new Set(lines.map(keyOf))]
  const monthly = b.period_type === 'monthly'
  const draft = b.status === 'draft'
  const edit = sp.edit && /^[ac]:/.test(sp.edit) && UUID.test(sp.edit.slice(2)) ? sp.edit : ''
  const amountFor = (key: string, m: number | null) => { const l = lines.find((x) => keyOf(x) === key && (x.month ?? null) === m); return l ? (Number(toCents(l.amount_cents)) / 100).toFixed(2) : '' }
  const noteFor = (key: string) => lines.find((x) => keyOf(x) === key && x.note)?.note ?? ''
  const monthNames = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))))
  const inTotal = vs.filter((r) => r.in_total)
  const tot = (type: string, k: keyof VsActual) => inTotal.filter((r) => r.line_type === type).reduce((s, r) => s + toCents(r[k] as number), 0n)
  const revB = tot('revenue', 'budget_ytd_cents'), revA = tot('revenue', 'actual_cents'), expB = tot('expense', 'budget_ytd_cents'), expA = tot('expense', 'actual_cents')
  const expTotal = tot('expense', 'budget_total_cents')
  const consumed = compare(expA, expTotal)
  const alerts = vs.filter((r) => r.alert !== 'ok')
  // comparison with another version of the same budget
  const other = sp.compare && UUID.test(sp.compare) ? versions.find((v) => v.id === sp.compare) : undefined
  const { data: od } = other ? await supabase.from('budget_lines').select('*').eq('budget_id', other.id) : { data: null }
  const otherLines = (od ?? []) as BudgetLine[]
  const sumFor = (ls: BudgetLine[], key: string) => ls.filter((l) => keyOf(l) === key).reduce((s, l) => s + toCents(l.amount_cents), 0n)
  const doneText: Record<string, string> = {
    created: tr('Borrador creado.', 'Draft created.'), saved: tr('Cambios guardados.', 'Changes saved.'), line_saved: tr('Línea guardada.', 'Line saved.'),
    filled: tr('Líneas rellenadas con los datos reales.', 'Lines filled from actuals.'), approved: tr('Presupuesto aprobado.', 'Budget approved.'),
    published: tr('Presupuesto publicado (el anterior publicado del mismo año y escenario quedó archivado).', 'Budget published (the previous published one for the same year and scenario was archived).'),
    archived: tr('Presupuesto archivado.', 'Budget archived.'), version_created: tr('Nueva versión creada como borrador.', 'New version created as a draft.'),
  }
  const back = `/finance/budgets/${b.id}`
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Presupuesto', 'Budget')} title={`${b.name} · v${b.version}`}
        description={[String(b.fiscal_year), monthly ? tr('Mensual', 'Monthly') : tr('Anual', 'Annual'), scenarioLabel(b.scenario, locale)].join(' · ')}
        actions={<div className="flex items-center gap-2"><span className={budgetStatusTone(b.status)}>{budgetStatusLabel(b.status, locale)}</span><PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} /></div>} />
      <FinanceNav tr={tr} current="/finance/budgets" />
      <Flash done={sp.done ? doneText[sp.done] : null} error={financeMessage(sp.error, locale)} />
      <ReportMeta tr={tr} company={companyName} period={`${b.fiscal_year} · ${tr('real al', 'actuals to')} ${f.date(asOf)}`} currency={currency} generated={f.dateTime(new Date().toISOString())}
        final={b.status === 'published' || b.status === 'approved'} />
      {b.notes && <p className="card p-4 text-sm text-slate-300"><span className="font-semibold text-fg">{tr('Notas: ', 'Notes: ')}</span>{b.notes}</p>}

      {/* workflow */}
      <section aria-label={tr('Flujo de aprobación', 'Approval workflow')} className="card flex flex-wrap items-end gap-3 p-4 print:hidden">
        {draft && access.approve && <form action={approveBudget} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
          <label className="text-sm"><span className="field-label">{tr('Nota de aprobación', 'Approval note')}</span><input name="note" maxLength={2000} className="field" /></label>
          <SubmitButton className="w-full sm:w-auto">{tr('Aprobar', 'Approve')}</SubmitButton></form>}
        {b.status === 'approved' && access.approve && <form action={publishBudget}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} /><SubmitButton className="w-full sm:w-auto">{tr('Publicar', 'Publish')}</SubmitButton></form>}
        {!draft && access.manage && !versions.some((v) => v.status === 'draft') && <form action={newBudgetVersion} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
          <label className="text-sm"><span className="field-label">{tr('Motivo de la nueva versión', 'Reason for the new version')}</span><input name="note" maxLength={2000} className="field" /></label>
          <SubmitButton className="w-full sm:w-auto">{tr('Nueva versión', 'New version')}</SubmitButton></form>}
        {b.status !== 'archived' && access.manage && (b.status !== 'published' || access.approve) && <form action={archiveBudget} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
          <label className="text-sm"><span className="field-label">{tr('Motivo para archivar', 'Reason to archive')}</span><input name="reason" required minLength={3} maxLength={300} className="field" /></label>
          <SubmitButton className="w-full sm:w-auto">{tr('Archivar', 'Archive')}</SubmitButton></form>}
        {!access.manage && <p className="text-sm text-muted">{tr('Solo lectura: no tienes permiso para gestionar presupuestos.', 'Read only: you cannot manage budgets.')}</p>}
        {draft && access.manage && !access.approve && <p className="text-sm text-muted">{tr('Solo el propietario aprueba y publica.', 'Only the owner approves and publishes.')}</p>}
      </section>

      {/* budget vs actual */}
      <section aria-labelledby="bva" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="bva" className="font-display text-lg font-semibold text-fg">{tr('Presupuesto vs real', 'Budget vs actual')}</h2>
          <form action={back} className="flex items-end gap-2 print:hidden"><label className="text-sm"><span className="field-label">{tr('Real hasta', 'Actuals to')}</span><input type="date" name="as_of" defaultValue={asOf} className="field" /></label>
            <button type="submit" className="btn-secondary btn-sm">{tr('Ver', 'View')}</button></form>
        </div>
        {b.department_id && <div role="note" className="alert-warning p-4 text-sm">{tr('Presupuesto de departamento: el libro mayor no registra departamento, así que el “real” mostrado es el de toda la empresa y no se usa para alertas.',
          'Department budget: the ledger does not record a department, so the “actual” shown is company-wide and not used for alerts.')}</div>}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon="chart" label={tr('Ingresos: real / presupuesto a la fecha', 'Revenue: actual / budget to date')} value={money(revA)} hint={`${tr('de', 'of')} ${money(revB)}`} tone={revA >= revB ? 'success' : 'warning'} />
          <StatCard icon="receipt" label={tr('Gastos: real / presupuesto a la fecha', 'Expenses: actual / budget to date')} value={money(expA)} hint={`${tr('de', 'of')} ${money(expB)}`} tone={expA <= expB ? 'success' : 'warning'} />
          <StatCard icon="wallet" label={tr('Presupuesto de gasto consumido', 'Expense budget consumed')} value={consumed.pct === null ? '—' : `${(consumed.pct + 100).toFixed(1)}%`} hint={`${tr('del año', 'of the year')}: ${money(expTotal)}`} />
          <StatCard icon="alert" tone={alerts.length ? 'warning' : 'success'} label={tr('Alertas', 'Alerts')} value={String(alerts.length)} hint={tr(`gasto ≥${b.expense_warn_pct}% / ≥${b.expense_crit_pct}% · ingreso <${b.revenue_warn_pct}% / <${b.revenue_crit_pct}%`, `expense ≥${b.expense_warn_pct}% / ≥${b.expense_crit_pct}% · revenue <${b.revenue_warn_pct}% / <${b.revenue_crit_pct}%`)} />
        </div>
        {vs.length === 0 ? <p className="card p-4 text-sm text-muted">{tr('Este presupuesto no tiene líneas todavía.', 'This budget has no lines yet.')}</p> : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2">{tr('Línea', 'Line')}</th><th scope="col" className="px-3 py-2 text-right">{tr('Presupuesto año', 'Year budget')}</th>
                <th scope="col" className="px-3 py-2 text-right">{tr('A la fecha', 'To date')}</th><th scope="col" className="px-3 py-2 text-right">{tr('Real', 'Actual')}</th>
                <th scope="col" className="px-3 py-2 text-right">{tr('Variación', 'Variance')}</th><th scope="col" className="px-3 py-2 text-right">{tr('Consumido', 'Consumed')}</th>
                <th scope="col" className="px-3 py-2 text-right">{tr('Proyección al cierre', 'Year-end projection')}</th><th scope="col" className="px-3 py-2">{tr('Estado', 'Status')}</th></tr></thead>
              <tbody>
                {vs.map((r, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-slate-200">
                      {r.account_id ? <Link href={`/accounting/ledger?account=${r.account_id}&from=${b.fiscal_year}-01-01&to=${asOf}`} className="hover:text-accent">{locale === 'en' && r.label_en ? r.label_en : r.label}</Link>
                        : <Link href={`/payables/reports?from=${b.fiscal_year}-01-01&to=${asOf}`} className="hover:text-accent">{tr('Categoría', 'Category')}: {locale === 'en' && r.label_en ? r.label_en : r.label}</Link>}
                      <span className="block text-xs text-muted">{r.line_type === 'revenue' ? tr('Ingreso', 'Revenue') : tr('Gasto', 'Expense')}{r.in_total ? '' : ` · ${tr('incluida en la línea de su cuenta (no suma)', 'included in its account line (not added)')}`}</span>
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.budget_total_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.budget_ytd_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg">{money(r.actual_cents)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${toCents(r.variance_cents) === 0n ? '' : r.favorable ? 'text-green-300' : 'text-red-300'}`}>
                      {money(r.variance_cents)}{r.variance_pct === null ? '' : ` (${Number(r.variance_pct) > 0 ? '+' : ''}${Number(r.variance_pct).toFixed(1)}%)`}
                      <span className="block text-xs">{toCents(r.variance_cents) === 0n ? '' : r.favorable ? tr('favorable', 'favourable') : tr('desfavorable', 'unfavourable')}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.consumed_pct === null ? '—' : `${Number(r.consumed_pct).toFixed(1)}%`}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.projection_cents === null ? '—' : money(r.projection_cents)}</td>
                    <td className="px-3 py-2">{r.actual_available ? <span className={ALERT_CLS[r.alert]}>{alertLabel(r.alert, locale)}</span> : <span className="badge-neutral">{tr('Sin real por depto.', 'No dept. actuals')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-2 print:hidden">
          <a href={`/finance/export?report=budget&id=${b.id}&as_of=${asOf}&format=xlsx`} download className="btn-secondary btn-sm">Excel</a>
          <a href={`/finance/export?report=budget&id=${b.id}&as_of=${asOf}&format=csv`} download className="btn-secondary btn-sm">CSV</a>
        </div>
        <p className="text-xs text-muted">{tr('Real: libro mayor para cuentas; facturas de proveedor aprobadas para categorías. “A la fecha” prorratea el mes en curso por días. La proyección al cierre extrapola el ritmo actual: es una estimación.',
          'Actual: ledger for accounts; approved vendor bills for categories. “To date” prorates the current month by days. The year-end projection extrapolates the current pace: it is an estimate.')}</p>
      </section>

      {/* lines */}
      <section aria-labelledby="lines" className="space-y-3">
        <h2 id="lines" className="font-display text-lg font-semibold text-fg">{tr('Líneas', 'Lines')}</h2>
        {targets.length > 0 && (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2">{tr('Cuenta / categoría', 'Account / category')}</th>
                {monthly && monthNames.map((m) => <th key={m} scope="col" className="px-2 py-2 text-right">{m}</th>)}
                <th scope="col" className="px-3 py-2 text-right">{tr('Total', 'Total')}</th>{other && <th scope="col" className="px-3 py-2 text-right">v{other.version}</th>}
                {draft && access.manage && <th scope="col" className="px-3 py-2 print:hidden"><span className="sr-only">{tr('Editar', 'Edit')}</span></th>}</tr></thead>
              <tbody>
                {targets.map((k) => (
                  <tr key={k} className="border-t border-line/60">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-slate-200">{label(k)}{noteFor(k) && <span className="block text-xs text-muted">{noteFor(k)}</span>}</th>
                    {monthly && monthNames.map((_, i) => <td key={i} className="px-2 py-2 text-right tabular-nums text-xs">{amountFor(k, i + 1) ? money(toCents(lines.find((x) => keyOf(x) === k && x.month === i + 1)!.amount_cents)) : '—'}</td>)}
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(sumFor(lines, k))}</td>
                    {other && <td className="px-3 py-2 text-right tabular-nums text-muted">{money(sumFor(otherLines, k))}</td>}
                    {draft && access.manage && <td className="px-3 py-2 print:hidden"><Link href={`${back}?edit=${k}#editor`} className="text-xs font-semibold text-accent">{tr('Editar', 'Edit')}</Link></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft && access.manage && (
          <form id="editor" action={setBudgetLine} className="card space-y-3 p-4 print:hidden">
            <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
            <h3 className="font-semibold text-fg">{edit ? tr('Editar línea', 'Edit line') : tr('Añadir línea', 'Add line')}</h3>
            <label className="block text-sm"><span className="field-label">{tr('Cuenta de ingreso / gasto o categoría de gasto', 'Revenue / expense account or expense category')}</span>
              <select name="target" required defaultValue={edit} className="field">
                <option value="" disabled>{tr('Elige…', 'Choose…')}</option>
                <optgroup label={tr('Ingresos', 'Revenue')}>{accounts.filter((a) => a.type === 'revenue' && a.status === 'active').map((a) => <option key={a.id} value={`a:${a.id}`}>{a.code} {locale === 'en' && a.name_en ? a.name_en : a.name}</option>)}</optgroup>
                <optgroup label={tr('Gastos', 'Expenses')}>{accounts.filter((a) => a.type === 'expense' && a.status === 'active').map((a) => <option key={a.id} value={`a:${a.id}`}>{a.code} {locale === 'en' && a.name_en ? a.name_en : a.name}</option>)}</optgroup>
                {categories.length > 0 && <optgroup label={tr('Categorías de gasto', 'Expense categories')}>{categories.map((c) => <option key={c.id} value={`c:${c.id}`}>{locale === 'en' && c.name_en ? c.name_en : c.name}</option>)}</optgroup>}
              </select></label>
            {monthly ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {monthNames.map((m, i) => <label key={m} className="text-sm"><span className="field-label">{m}</span><input type="hidden" name="month" value={i + 1} />
                  <input name="amount" inputMode="decimal" defaultValue={edit ? amountFor(edit, i + 1) : ''} placeholder="0.00" className="field tabular-nums" /></label>)}
              </div>
            ) : (
              <label className="block text-sm sm:w-64"><span className="field-label">{tr('Importe del año', 'Amount for the year')}</span><input type="hidden" name="month" value="" />
                <input name="amount" inputMode="decimal" defaultValue={edit ? amountFor(edit, null) : ''} placeholder="0.00" className="field tabular-nums" /></label>
            )}
            <label className="block text-sm"><span className="field-label">{tr('Justificación', 'Justification')}</span><input name="note" maxLength={500} defaultValue={edit ? noteFor(edit) : ''} className="field" /></label>
            <p className="text-xs text-muted">{tr('Un importe vacío borra ese mes de la línea.', 'An empty amount deletes that month of the line.')}</p>
            <SubmitButton className="w-full sm:w-auto">{tr('Guardar línea', 'Save line')}</SubmitButton>
          </form>
        )}
        {draft && access.manage && (
          <div className="grid gap-4 lg:grid-cols-2 print:hidden">
            <form action={fillBudget} className="card space-y-3 p-4">
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
              <h3 className="font-semibold text-fg">{tr('Rellenar con datos reales', 'Fill from actuals')}</h3>
              <p className="text-xs text-muted">{tr('Reemplaza las líneas por cuenta con lo registrado en el libro mayor ese año, más el crecimiento indicado.', 'Replaces the account lines with what the ledger recorded that year, plus the given growth.')}</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm"><span className="field-label">{tr('Año', 'Year')}</span><input name="source_year" type="number" min={2000} max={2100} defaultValue={b.fiscal_year - 1} className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Crecimiento %', 'Growth %')}</span><input name="growth" inputMode="decimal" defaultValue="0" className="field" /></label>
              </div>
              <SubmitButton className="w-full sm:w-auto">{tr('Rellenar', 'Fill')}</SubmitButton>
            </form>
            <form action={updateBudget} className="card space-y-3 p-4">
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} />
              <h3 className="font-semibold text-fg">{tr('Nombre, notas y alertas', 'Name, notes and alerts')}</h3>
              <label className="block text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" defaultValue={b.name} maxLength={120} className="field" /></label>
              <label className="block text-sm"><span className="field-label">{tr('Notas y justificación', 'Notes and justification')}</span><textarea name="notes" defaultValue={b.notes ?? ''} maxLength={2000} rows={2} className="field" /></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm"><span className="field-label">{tr('Gasto: atención al %', 'Expense: watch at %')}</span><input name="expense_warn_pct" type="number" min={1} max={500} defaultValue={b.expense_warn_pct} className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Gasto: crítico al %', 'Expense: critical at %')}</span><input name="expense_crit_pct" type="number" min={1} max={500} defaultValue={b.expense_crit_pct} className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Ingreso: atención bajo %', 'Revenue: watch below %')}</span><input name="revenue_warn_pct" type="number" min={1} max={500} defaultValue={b.revenue_warn_pct} className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Ingreso: crítico bajo %', 'Revenue: critical below %')}</span><input name="revenue_crit_pct" type="number" min={1} max={500} defaultValue={b.revenue_crit_pct} className="field" /></label>
              </div>
              <SubmitButton className="w-full sm:w-auto">{tr('Guardar', 'Save')}</SubmitButton>
            </form>
          </div>
        )}
        {!draft && <p className="text-xs text-muted">{tr('Este presupuesto está bloqueado: para cambiarlo crea una nueva versión (queda como borrador hasta aprobarla).', 'This budget is locked: to change it, create a new version (it stays a draft until approved).')}</p>}
      </section>

      {/* versions */}
      <section aria-labelledby="versions" className="card space-y-2 p-4">
        <h2 id="versions" className="font-display text-lg font-semibold text-fg">{tr('Versiones', 'Versions')}</h2>
        <ul className="divide-y divide-line/60 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link href={`/finance/budgets/${v.id}`} className={v.id === b.id ? 'font-semibold text-fg' : 'text-slate-300 hover:text-accent'}>v{v.version} · {f.date(v.created_at)}</Link>
              <span className="flex items-center gap-2"><span className={budgetStatusTone(v.status)}>{budgetStatusLabel(v.status, locale)}</span>
                {v.id !== b.id && <Link href={`${back}?compare=${v.id}#lines`} className="text-xs font-semibold text-accent print:hidden">{tr('Comparar', 'Compare')}</Link>}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* audit */}
      <section aria-labelledby="events" className="card space-y-2 p-4">
        <h2 id="events" className="font-display text-lg font-semibold text-fg">{tr('Historial', 'History')}</h2>
        <ul className="divide-y divide-line/60 text-sm">
          {events.map((e, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 py-2"><span className="text-fg">{budgetEventLabel(e.action, locale)}{e.action === 'archived' && e.details?.reason ? ` · ${String(e.details.reason)}` : ''}</span>
              <span className="text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}</span></li>
          ))}
        </ul>
        {b.approved_at && <p className="text-xs text-muted">{tr('Aprobado por', 'Approved by')} {name(b.approved_by)} · {f.dateTime(b.approved_at)}{b.approval_note ? ` · ${b.approval_note}` : ''}</p>}
      </section>
    </div>
  )
}

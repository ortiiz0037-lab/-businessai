import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { FinanceNav, NoFinanceAccess } from '@/components/finance-nav'
import { financePage } from '@/lib/finance/finance-page'
import { budgetStatusLabel, budgetStatusTone, financeMessage, scenarioLabel, type Budget } from '@/lib/finance/budget'
import { createBudget } from '@/app/actions/finance'

export const dynamic = 'force-dynamic'
const PAGE = 50

/** Budgets: every version of every budget, newest year first (paginated). */
export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; status?: string; page?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access, today } = await financePage()
  if (!access.view || !access.available) return <NoFinanceAccess tr={tr} unavailable={!access.available} />
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1))
  const status = ['draft', 'approved', 'published', 'archived'].includes(sp.status ?? '') ? sp.status! : null
  let q = supabase.from('budgets').select('*', { count: 'exact' }).eq('company_id', companyId)
  if (status) q = q.eq('status', status)
  const [{ data, count }, { data: deps }] = await Promise.all([
    q.order('fiscal_year', { ascending: false }).order('name').order('version', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1),
    supabase.from('departments').select('id, name').eq('company_id', companyId).is('archived_at', null).order('name'),
  ])
  const budgets = (data ?? []) as Budget[]
  const departments = (deps ?? []) as { id: string; name: string }[]
  const depName = new Map(departments.map((d) => [d.id, d.name]))
  const year = Number(today.slice(0, 4))
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const link = (o: Record<string, string | null>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ status, ...o })) if (v) p.set(k, v); return `/finance/budgets?${p}` }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Presupuestos', 'Budgets')}
        description={tr('Borrador → aprobado (propietario) → publicado. Un presupuesto aprobado no se modifica: los cambios se hacen en una nueva versión.',
          'Draft → approved (owner) → published. An approved budget never changes: changes go into a new version.')} />
      <FinanceNav tr={tr} current="/finance/budgets" />
      <Flash error={financeMessage(sp.error, locale)} />
      <nav aria-label={tr('Filtrar por estado', 'Filter by status')} className="flex flex-wrap gap-2">
        {[null, 'draft', 'approved', 'published', 'archived'].map((s) => (
          <Link key={s ?? 'all'} href={link({ status: s, page: null })} aria-current={status === s ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${status === s ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line text-slate-300'}`}>
            {s ? budgetStatusLabel(s, locale) : tr('Todos', 'All')}</Link>
        ))}
      </nav>
      {budgets.length === 0 ? (
        <div className="card"><EmptyState icon="chart" title={tr('Sin presupuestos', 'No budgets')}
          description={tr('Crea un presupuesto anual o mensual por cuenta contable o categoría de gasto.', 'Create an annual or monthly budget by ledger account or expense category.')} /></div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {budgets.map((b) => (
            <li key={b.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/finance/budgets/${b.id}`} className="font-display text-base font-semibold text-fg hover:text-accent">{b.name}</Link>
                  <p className="text-xs text-muted">{[String(b.fiscal_year), b.period_type === 'monthly' ? tr('Mensual', 'Monthly') : tr('Anual', 'Annual'), scenarioLabel(b.scenario, locale),
                    `v${b.version}`, b.department_id ? depName.get(b.department_id) ?? tr('Departamento', 'Department') : tr('Toda la empresa', 'Whole company')].join(' · ')}</p>
                </div>
                <span className={budgetStatusTone(b.status)}>{budgetStatusLabel(b.status, locale)}</span>
              </div>
              <p className="mt-2 text-xs text-muted">{tr('Creado', 'Created')} {f.date(b.created_at)}{b.published_at ? ` · ${tr('Publicado', 'Published')} ${f.date(b.published_at)}` : ''}</p>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label={tr('Páginas', 'Pages')} className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={link({ page: String(page - 1) })} className="btn-secondary btn-sm">{tr('Anterior', 'Previous')}</Link> : <span />}
          <span className="text-muted">{page} / {pages}</span>
          {page < pages ? <Link href={link({ page: String(page + 1) })} className="btn-secondary btn-sm">{tr('Siguiente', 'Next')}</Link> : <span />}
        </nav>
      )}
      {access.manage && (
        <section aria-labelledby="new-budget" className="card space-y-4 p-5">
          <h2 id="new-budget" className="font-display text-lg font-semibold text-fg">{tr('Nuevo presupuesto', 'New budget')}</h2>
          <form action={createBudget} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={120} className="field" defaultValue={tr(`Presupuesto ${year + 1}`, `Budget ${year + 1}`)} /></label>
            <label className="text-sm"><span className="field-label">{tr('Año fiscal', 'Fiscal year')}</span><input name="fiscal_year" type="number" min={2000} max={2100} required defaultValue={year + 1} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Detalle', 'Detail')}</span>
              <select name="period_type" className="field" defaultValue="monthly"><option value="monthly">{tr('Mensual (12 meses)', 'Monthly (12 months)')}</option><option value="annual">{tr('Anual (un importe por línea)', 'Annual (one amount per line)')}</option></select></label>
            <label className="text-sm"><span className="field-label">{tr('Escenario', 'Scenario')}</span>
              <select name="scenario" className="field" defaultValue="base">{['base', 'conservative', 'optimistic'].map((s) => <option key={s} value={s}>{scenarioLabel(s, locale)}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Departamento (opcional)', 'Department (optional)')}</span>
              <select name="department_id" className="field" defaultValue=""><option value="">{tr('Toda la empresa', 'Whole company')}</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Rellenar con datos reales del año (opcional)', 'Fill from the actuals of year (optional)')}</span>
              <input name="prefill_year" type="number" min={2000} max={2100} placeholder={String(year - 1)} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Crecimiento sobre datos reales (%)', 'Growth over actuals (%)')}</span><input name="prefill_growth" inputMode="decimal" defaultValue="0" className="field" /></label>
            <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Notas y justificación', 'Notes and justification')}</span><textarea name="notes" maxLength={2000} rows={2} className="field" /></label>
            <div className="sm:col-span-2 lg:col-span-3"><SubmitButton className="w-full sm:w-auto">{tr('Crear borrador', 'Create draft')}</SubmitButton></div>
          </form>
          <p className="text-xs text-muted">{tr('Los departamentos son los de Personal. Para presupuestos de departamento no hay datos reales por departamento: el libro mayor no registra departamento.',
            'Departments come from Workforce. Department budgets have no department actuals: the ledger does not record a department.')}</p>
        </section>
      )}
    </div>
  )
}

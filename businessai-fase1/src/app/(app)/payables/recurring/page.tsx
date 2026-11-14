import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { categoryName, FREQUENCIES, frequencyLabel, payablesMessage, type Category, type Vendor } from '@/lib/finance/payables'
import { generateRecurring, saveRecurring, setRecurringStatus } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'

type Template = { id: string; vendor_id: string; category_id: string; description: string; amount_cents: number; frequency: string; start_date: string
  end_date: string | null; next_date: string; due_days: number; auto_submit: boolean; status: 'active' | 'paused' }

/** Recurring expenses: generated only on request, never for future dates, one bill per period. */
export default async function RecurringPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; n?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await payablesPage()
  if (!access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const [{ data }, { data: v }, { data: c }, { data: counts }] = await Promise.all([
    supabase.from('recurring_expenses').select('*').eq('company_id', companyId).order('status').order('next_date'),
    supabase.from('vendors').select('*').eq('company_id', companyId).order('name'),
    supabase.from('expense_categories').select('*').eq('company_id', companyId).order('name'),
    supabase.from('bills').select('recurring_id').eq('company_id', companyId).not('recurring_id', 'is', null),
  ])
  const templates = (data ?? []) as Template[]
  const vendors = (v ?? []) as Vendor[]
  const cats = (c ?? []) as Category[]
  const generated = new Map<string, number>()
  for (const r of (counts ?? []) as { recurring_id: string }[]) generated.set(r.recurring_id, (generated.get(r.recurring_id) ?? 0) + 1)
  const due = templates.filter((t) => t.status === 'active' && t.next_date <= today && (!t.end_date || t.next_date <= t.end_date)).length
  const done: Record<string, string> = { recurring_saved: tr('Plantilla creada.', 'Template created.'), recurring_paused: tr('Plantilla pausada.', 'Template paused.'),
    recurring_resumed: tr('Plantilla reanudada.', 'Template resumed.'), generated: tr(`Se generaron ${p.n ?? 0} gastos (borradores o enviados según la plantilla).`, `${p.n ?? 0} expenses generated (drafts or submitted per template).`) }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Gastos recurrentes', 'Recurring expenses')}
        description={tr('Se generan solo cuando lo pides, nunca con fechas futuras, y un mismo periodo nunca se crea dos veces. Los gastos generados siguen el flujo de aprobación normal.',
          'They are generated only when you ask, never with future dates, and the same period is never created twice. Generated expenses follow the normal approval flow.')} />
      <PayablesNav tr={tr} current="/payables/recurring" full />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />
      {access.manage && (
        <form action={generateRecurring} className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">{due > 0 ? tr(`${due} plantillas tienen periodos pendientes hasta hoy.`, `${due} templates have periods due up to today.`) : tr('No hay periodos pendientes hasta hoy.', 'No periods due up to today.')}</p>
          <SubmitButton className="w-full sm:w-auto">{tr('Generar pendientes', 'Generate due')}</SubmitButton>
        </form>
      )}
      <ul className="space-y-3">
        {templates.map((t) => {
          const cat = cats.find((x) => x.id === t.category_id)
          return (
            <li key={t.id} className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-fg">{t.description} · {money(t.amount_cents)} · {frequencyLabel(t.frequency, locale)}</p>
                <p className="text-xs text-muted">{vendors.find((x) => x.id === t.vendor_id)?.name ?? '—'} · {cat ? categoryName(cat, locale) : '—'} ·
                  {' '}{tr('próximo', 'next')} {f.date(t.next_date)}{t.end_date ? ` · ${tr('hasta', 'until')} ${f.date(t.end_date)}` : ''} · {tr(`${generated.get(t.id) ?? 0} generados`, `${generated.get(t.id) ?? 0} generated`)}
                  {t.auto_submit ? ` · ${tr('se envían a aprobación', 'submitted for approval')}` : ''}</p>
              </div>
              <span className="flex items-center gap-2">
                <span className={t.status === 'active' ? 'badge-success' : 'badge-neutral'}>{t.status === 'active' ? tr('Activa', 'Active') : tr('Pausada', 'Paused')}</span>
                {access.manage && (
                  <form action={setRecurringStatus}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'active' ? 'paused' : 'active'} />
                    <button type="submit" className="btn-secondary btn-sm">{t.status === 'active' ? tr('Pausar', 'Pause') : tr('Reanudar', 'Resume')}</button></form>
                )}
              </span>
            </li>
          )
        })}
        {templates.length === 0 && <li className="card p-5 text-sm text-muted">{tr('Sin plantillas.', 'No templates.')}</li>}
      </ul>
      {access.manage && (
        <details className="card p-5">
          <summary className="cursor-pointer font-semibold text-accent">{tr('Nueva plantilla', 'New template')}</summary>
          <form action={saveRecurring} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm"><span className="field-label">{tr('Proveedor', 'Vendor')}</span>
              <select name="vendor_id" required className="field">{vendors.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Categoría', 'Category')}</span>
              <select name="category_id" required className="field">{cats.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.id}>{categoryName(x, locale)}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Importe', 'Amount')}</span><input name="amount" required inputMode="decimal" placeholder="0.00" className="field text-right" /></label>
            <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Descripción', 'Description')}</span><input name="description" required maxLength={300} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Frecuencia', 'Frequency')}</span>
              <select name="frequency" defaultValue="monthly" className="field">{FREQUENCIES.map((x) => <option key={x} value={x}>{frequencyLabel(x, locale)}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Primer periodo', 'First period')}</span><input type="date" name="start_date" required defaultValue={today} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Último periodo (opcional)', 'Last period (optional)')}</span><input type="date" name="end_date" className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Días para vencer', 'Days until due')}</span><input type="number" name="due_days" min={0} max={365} defaultValue={0} className="field" /></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="auto_submit" /> {tr('Enviar a aprobación al generarse', 'Submit for approval when generated')}</label>
            <div><SubmitButton>{tr('Crear plantilla', 'Create template')}</SubmitButton></div>
          </form>
        </details>
      )}
    </div>
  )
}

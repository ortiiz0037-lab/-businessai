import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { categoryName, payablesMessage, type Category } from '@/lib/finance/payables'
import { accountName, accountTypeLabel } from '@/lib/finance/ledger'
import { centsToInput } from '@/lib/finance/money'
import { saveApprovalSettings, saveCategory, setCategoryStatus } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'

/** Expense categories (each one on a ledger account) and approval rules. */
export default async function PayablesSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, money, supabase, companyId, access } = await payablesPage()
  if (!access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const [{ data: c }, { data: a }, { data: s }, { data: lim }] = await Promise.all([
    supabase.from('expense_categories').select('*').eq('company_id', companyId).order('status').order('name'),
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, status').eq('company_id', companyId).in('type', ['expense', 'asset']).order('code'),
    supabase.from('payables_settings').select('allow_self_approval').eq('company_id', companyId).maybeSingle(),
    supabase.from('approval_limits').select('role, max_cents').eq('company_id', companyId),
  ])
  const cats = (c ?? []) as Category[]
  const accounts = (a ?? []) as { id: string; code: string; name: string; name_en: string | null; type: string; status: string }[]
  const limits = new Map(((lim ?? []) as { role: string; max_cents: number | null }[]).map((r) => [r.role, r.max_cents]))
  const selfOk = (s as { allow_self_approval?: boolean } | null)?.allow_self_approval ?? false
  const acc = (id: string) => { const x = accounts.find((y) => y.id === id); return x ? `${x.code} · ${accountName(x, locale)}` : '—' }
  const accountSelect = (value?: string) => (
    <select name="account_id" required defaultValue={value ?? ''} className="field">
      <option value="" disabled>—</option>
      {accounts.filter((x) => x.status === 'active' || x.id === value).map((x) => <option key={x.id} value={x.id}>{x.code} · {accountName(x, locale)} ({accountTypeLabel(x.type, locale)})</option>)}
    </select>
  )
  const roleRule = (role: 'admin' | 'member') => {
    const has = limits.has(role)
    const max = limits.get(role)
    return has ? (max === null || max === undefined ? tr('sin límite', 'unlimited') : `${tr('hasta', 'up to')} ${money(max)}`) : tr('no aprueba', 'cannot approve')
  }
  const done: Record<string, string> = { category_saved: tr('Categoría guardada.', 'Category saved.'), settings_saved: tr('Reglas de aprobación guardadas.', 'Approval rules saved.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Categorías y aprobación', 'Categories and approval')} />
      <PayablesNav tr={tr} current="/payables/settings" full />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />

      <section className="card space-y-4 p-5" aria-labelledby="approval-title">
        <h2 id="approval-title" className="font-display text-lg font-semibold text-fg">{tr('Reglas de aprobación', 'Approval rules')}</h2>
        <ul className="space-y-1 text-sm text-slate-300">
          <li>{tr('Propietario: sin límite.', 'Owner: unlimited.')}</li>
          <li>{tr('Administradores:', 'Admins:')} {roleRule('admin')}.</li>
          <li>{tr('Miembros:', 'Members:')} {roleRule('member')}.</li>
          <li>{selfOk ? tr('Se permite aprobar los gastos propios.', 'Approving one’s own expenses is allowed.') : tr('Nadie (salvo el propietario) aprueba los gastos que registró o envió.', 'Nobody (except the owner) approves the expenses they recorded or submitted.')}</li>
        </ul>
        {access.settings && (
          <form action={saveApprovalSettings} className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
            {(['admin', 'member'] as const).map((role) => (
              <fieldset key={role} className="space-y-2">
                <legend className="text-sm font-semibold text-fg">{role === 'admin' ? tr('Administradores', 'Admins') : tr('Miembros', 'Members')}</legend>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`${role}_can`} defaultChecked={limits.has(role)} /> {tr('Pueden aprobar', 'Can approve')}</label>
                <label className="block text-sm"><span className="field-label">{tr('Límite por gasto (vacío = sin límite)', 'Limit per expense (empty = unlimited)')}</span>
                  <input name={`${role}_limit`} inputMode="decimal" defaultValue={limits.get(role) != null ? centsToInput(limits.get(role)!) : ''} className="field" /></label>
              </fieldset>
            ))}
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="self_approval" defaultChecked={selfOk} /> {tr('Permitir aprobar los gastos propios (empresas de una sola persona)', 'Allow approving one’s own expenses (one-person businesses)')}</label>
            <div><SubmitButton>{tr('Guardar reglas', 'Save rules')}</SubmitButton></div>
          </form>
        )}
      </section>

      <section className="card overflow-hidden" aria-labelledby="cat-title">
        <h2 id="cat-title" className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Categorías de gasto', 'Expense categories')}</h2>
        <p className="px-5 pt-3 text-xs text-muted">{tr('Cada categoría registra en una cuenta del catálogo contable: los informes por categoría salen de los mismos asientos.', 'Each category posts to a chart-of-accounts account: category reports come from the same entries.')}</p>
        <ul className="divide-y divide-line/60">
          {cats.map((x) => (
            <li key={x.id} className="space-y-2 px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={x.status === 'archived' ? 'text-muted line-through' : 'text-fg'}>{categoryName(x, locale)} <span className="text-xs text-muted">→ {acc(x.account_id)}</span></span>
                {access.manage && (
                  <form action={setCategoryStatus}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="status" value={x.status === 'active' ? 'archived' : 'active'} />
                    <button type="submit" className="btn-secondary btn-sm">{x.status === 'active' ? tr('Archivar', 'Archive') : tr('Reactivar', 'Restore')}</button></form>
                )}
              </div>
              {access.manage && (
                <details><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Editar', 'Edit')}</summary>
                  <form action={saveCategory} className="mt-2 grid gap-2 sm:grid-cols-4"><input type="hidden" name="id" value={x.id} />
                    <input name="name" required maxLength={120} defaultValue={x.name} className="field" aria-label={tr('Nombre', 'Name')} />
                    <input name="name_en" maxLength={120} defaultValue={x.name_en ?? ''} className="field" aria-label={tr('Nombre en inglés', 'English name')} />
                    {accountSelect(x.account_id)}
                    <SubmitButton>{tr('Guardar', 'Save')}</SubmitButton>
                  </form></details>
              )}
            </li>
          ))}
        </ul>
        {access.manage && (
          <form action={saveCategory} className="grid gap-2 border-t border-line p-5 sm:grid-cols-4">
            <input name="name" required maxLength={120} placeholder={tr('Nueva categoría', 'New category')} className="field" aria-label={tr('Nombre', 'Name')} />
            <input name="name_en" maxLength={120} placeholder={tr('Nombre en inglés (opcional)', 'English name (optional)')} className="field" aria-label={tr('Nombre en inglés', 'English name')} />
            {accountSelect()}
            <SubmitButton>{tr('Crear', 'Create')}</SubmitButton>
          </form>
        )}
      </section>
    </div>
  )
}

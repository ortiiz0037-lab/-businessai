import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AccountingNav, Flash, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { STATEMENT_CLASSES, sectionLabel } from '@/lib/finance/statements'
import { ACCOUNT_TYPES, accountName, accountTypeLabel, accountTypePlural, ledgerMessage, type LedgerAccount } from '@/lib/finance/ledger'
import { deleteAccount, saveAccount, setAccountStatus } from '@/app/actions/accounting'

export const dynamic = 'force-dynamic'

/** Chart of accounts: default + custom accounts, grouped by type. */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const [{ data }, { data: used }] = await Promise.all([
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, description, status, system_key').eq('company_id', companyId).order('code'),
    supabase.rpc('ledger_trial_balance', { target: companyId }),
  ])
  // Financial-statement classification (migration 0027). Optional: without 0027 the page works as before.
  const [{ data: cls, error: clsError }, { data: derived }] = await Promise.all([
    supabase.from('ledger_accounts').select('id, statement_class').eq('company_id', companyId),
    supabase.rpc('fs_account_balances', { target: companyId, from_date: '2000-01-01', to_date: '2000-01-01' }),
  ])
  const statementClass = new Map(((cls ?? []) as { id: string; statement_class: string | null }[]).map((r) => [r.id, r.statement_class]))
  const autoClass = new Map(((derived ?? []) as { account_id: string; class: string }[]).map((r) => [r.account_id, r.class]))
  const classes = !clsError
  const accounts = (data ?? []) as LedgerAccount[]
  const withMoves = new Set(((used ?? []) as { account_id: string; debit_cents: number; credit_cents: number }[])
    .filter((r) => Number(r.debit_cents) > 0 || Number(r.credit_cents) > 0).map((r) => r.account_id))
  const done: Record<string, string> = {
    account_created: tr('Cuenta creada.', 'Account created.'), account_saved: tr('Cuenta guardada.', 'Account saved.'),
    account_archived: tr('Cuenta archivada.', 'Account archived.'), account_restored: tr('Cuenta reactivada.', 'Account restored.'),
    account_deleted: tr('Cuenta borrada.', 'Account deleted.'),
  }
  const typeSelect = (value: string, locked: boolean) => (
    <select name="type" defaultValue={value} className="field" disabled={locked} required>
      {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{accountTypeLabel(t, locale)}</option>)}
    </select>
  )

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Catálogo de cuentas', 'Chart of accounts')}
        description={tr('Las cuentas del sistema se usan para los asientos automáticos: se pueden renombrar, no borrar. Una cuenta con movimientos conserva su código y tipo y solo se archiva.',
          'System accounts are used by automatic entries: they can be renamed, not deleted. An account with movements keeps its code and type and can only be archived.')} />
      <AccountingNav tr={tr} current="/accounting/accounts" />
      <Flash done={p.done ? done[p.done] : null} error={ledgerMessage(p.error, locale)} />

      {access.manage && access.initialized && (
        <details className="card p-5">
          <summary className="cursor-pointer font-semibold text-accent">{tr('Nueva cuenta', 'New account')}</summary>
          <form action={saveAccount} className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="text-sm"><span className="field-label">{tr('Código', 'Code')}</span><input name="code" required maxLength={20} pattern="[0-9A-Za-z][0-9A-Za-z.\-]{0,19}" className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Tipo', 'Type')}</span>{typeSelect('expense', false)}</label>
            <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={120} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Nombre en inglés (opcional)', 'English name (optional)')}</span><input name="name_en" maxLength={120} className="field" /></label>
            <label className="text-sm sm:col-span-3"><span className="field-label">{tr('Descripción (opcional)', 'Description (optional)')}</span><input name="description" maxLength={500} className="field" /></label>
            <div className="sm:self-end"><SubmitButton>{tr('Crear cuenta', 'Create account')}</SubmitButton></div>
          </form>
        </details>
      )}

      {!access.initialized && <p className="card p-5 text-sm text-muted">{tr('La contabilidad no está activada todavía.', 'Accounting is not activated yet.')}</p>}

      {ACCOUNT_TYPES.map((t) => {
        const group = accounts.filter((a) => a.type === t)
        if (group.length === 0) return null
        return (
          <section key={t} className="card overflow-hidden" aria-labelledby={`t-${t}`}>
            <h2 id={`t-${t}`} className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{accountTypePlural(t, locale)}</h2>
            <ul className="divide-y divide-line/60">
              {group.map((a) => {
                const moved = withMoves.has(a.id)
                return (
                  <li key={a.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className={`text-sm ${a.status === 'archived' ? 'text-muted line-through' : 'text-fg'}`}>
                        <span className="font-semibold tabular-nums">{a.code}</span> · {accountName(a, locale)}
                        {a.system_key && <span className="badge-accent ml-2">{tr('Sistema', 'System')}</span>}
                        {a.status === 'archived' && <span className="badge-neutral ml-2">{tr('Archivada', 'Archived')}</span>}
                        {moved && <span className="ml-2 text-xs text-muted">{tr('con movimientos', 'with movements')}</span>}
                      </p>
                    </div>
                    {a.description && <p className="mt-1 text-xs text-muted">{a.description}</p>}
                    {access.manage && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Editar', 'Edit')}</summary>
                        <form action={saveAccount} className="mt-3 grid gap-3 sm:grid-cols-4">
                          <input type="hidden" name="id" value={a.id} />
                          {(moved || a.system_key) && <><input type="hidden" name="code" value={a.code} /><input type="hidden" name="type" value={a.type} /></>}
                          <label className="text-sm"><span className="field-label">{tr('Código', 'Code')}</span>
                            <input name={moved || a.system_key ? undefined : 'code'} defaultValue={a.code} disabled={moved || !!a.system_key} required maxLength={20} className="field" /></label>
                          <label className="text-sm"><span className="field-label">{tr('Tipo', 'Type')}</span>{typeSelect(a.type, moved || !!a.system_key)}</label>
                          <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" defaultValue={a.name} required maxLength={120} className="field" /></label>
                          <label className="text-sm"><span className="field-label">{tr('Nombre en inglés', 'English name')}</span><input name="name_en" defaultValue={a.name_en ?? ''} maxLength={120} className="field" /></label>
                          <label className="text-sm sm:col-span-3"><span className="field-label">{tr('Descripción', 'Description')}</span><input name="description" defaultValue={a.description ?? ''} maxLength={500} className="field" /></label>
                          {classes && (
                            <label className="text-sm sm:col-span-3"><span className="field-label">{tr('Clasificación en estados financieros', 'Financial-statement classification')}</span>
                              <select name="statement_class" defaultValue={statementClass.get(a.id) ?? ''} className="field">
                                <option value="">{tr('Automática', 'Automatic')}{autoClass.get(a.id) ? ` (${sectionLabel(autoClass.get(a.id)!, locale)})` : ''}</option>
                                {(STATEMENT_CLASSES[a.type] ?? []).map((c) => <option key={c} value={c}>{sectionLabel(c, locale)}</option>)}
                              </select></label>
                          )}
                          <div className="sm:self-end"><SubmitButton>{tr('Guardar', 'Save')}</SubmitButton></div>
                        </form>
                        {!a.system_key && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <form action={setAccountStatus}>
                              <input type="hidden" name="id" value={a.id} />
                              <input type="hidden" name="status" value={a.status === 'archived' ? 'active' : 'archived'} />
                              <button type="submit" className="btn-secondary btn-sm">{a.status === 'archived' ? tr('Reactivar', 'Restore') : tr('Archivar', 'Archive')}</button>
                            </form>
                            {!moved && (
                              <form action={deleteAccount}>
                                <input type="hidden" name="id" value={a.id} />
                                <button type="submit" className="btn-danger btn-sm">{tr('Borrar (sin movimientos)', 'Delete (no movements)')}</button>
                              </form>
                            )}
                          </div>
                        )}
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

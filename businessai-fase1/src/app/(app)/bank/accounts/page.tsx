import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, type BankAccount } from '@/lib/finance/bank'
import { accountName } from '@/lib/finance/ledger'
import { saveBankAccount, setBankAccountStatus } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

/** Bank accounts: name, bank, last 4 digits, currency and linked ledger account. No credentials. */
export default async function BankAccountsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, supabase, companyId, access } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const [{ data: acc }, { data: ledger }] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id', companyId).order('status').order('name'),
    supabase.from('ledger_accounts').select('id, code, name, name_en, system_key, status').eq('company_id', companyId).eq('type', 'asset').order('code'),
  ])
  const accounts = (acc ?? []) as BankAccount[]
  const assets = ((ledger ?? []) as { id: string; code: string; name: string; name_en: string | null; system_key: string | null; status: string }[])
    .filter((a) => a.status === 'active' && (a.system_key === null || a.system_key === 'cash'))
  const label = (id: string) => { const a = (ledger ?? []).find((x: { id: string }) => x.id === id) as { code: string; name: string; name_en: string | null } | undefined; return a ? `${a.code} · ${accountName(a, locale)}` : '—' }
  const done: Record<string, string> = { account_created: tr('Cuenta bancaria creada.', 'Bank account created.'), account_saved: tr('Cuenta guardada.', 'Account saved.'),
    account_archived: tr('Cuenta archivada.', 'Account archived.'), account_restored: tr('Cuenta reactivada.', 'Account restored.') }
  const form = (a?: BankAccount) => (
    <form action={saveBankAccount} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {a && <input type="hidden" name="id" value={a.id} />}
      <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={120} defaultValue={a?.name ?? ''} className="field" /></label>
      <label className="text-sm"><span className="field-label">{tr('Banco', 'Bank')}</span><input name="bank_name" maxLength={120} defaultValue={a?.bank_name ?? ''} className="field" /></label>
      <label className="text-sm"><span className="field-label">{tr('Últimos 4 dígitos', 'Last 4 digits')}</span>
        <input name="last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={a?.last4 ?? ''} className="field" autoComplete="off" /></label>
      <label className="text-sm"><span className="field-label">{tr('Cuenta contable', 'Ledger account')}</span>
        <select name="ledger_account_id" required defaultValue={a?.ledger_account_id ?? ''} className="field">
          <option value="" disabled>—</option>{assets.map((x) => <option key={x.id} value={x.id}>{x.code} · {accountName(x, locale)}</option>)}
        </select></label>
      <div className="sm:self-end"><SubmitButton>{a ? tr('Guardar', 'Save') : tr('Crear', 'Create')}</SubmitButton></div>
    </form>
  )
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Cuentas bancarias', 'Bank accounts')}
        description={tr('Solo los últimos 4 dígitos: BusinessAI nunca guarda números completos, usuarios ni contraseñas bancarias. Moneda: la base de la empresa (USD).',
          'Only the last 4 digits: BusinessAI never stores full numbers, bank usernames or passwords. Currency: the company base (USD).')} />
      <BankNav tr={tr} current="/bank/accounts" />
      <Flash done={sp.done ? done[sp.done] : null} error={bankMessage(sp.error, locale)} />
      {access.manage && <section className="card space-y-3 p-5"><h2 className="font-display text-lg font-semibold text-fg">{tr('Nueva cuenta', 'New account')}</h2>{form()}
        <p className="text-xs text-muted">{tr('Si los cobros de clientes entran a esta cuenta, elige «Depositado en» al registrarlos; sin eso van a 1000 Efectivo.', 'If client payments land in this account, choose “Deposited into” when recording them; otherwise they go to 1000 Cash.')}</p></section>}
      <ul className="space-y-3">
        {accounts.map((a) => (
          <li key={a.id} className="card space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><Link href={`/bank/accounts/${a.id}`} className="font-semibold text-fg hover:text-accent">{a.name}</Link>
                <span className="block text-xs text-muted">{[a.bank_name, a.last4 ? `••${a.last4}` : null, a.currency, label(a.ledger_account_id)].filter(Boolean).join(' · ')}</span></span>
              <span className={a.status === 'active' ? 'badge-success' : 'badge-neutral'}>{a.status === 'active' ? tr('Activa', 'Active') : tr('Archivada', 'Archived')}</span>
            </div>
            {access.manage && (
              <details><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Editar o archivar', 'Edit or archive')}</summary>
                <div className="mt-3 space-y-3">{form(a)}
                  <form action={setBankAccountStatus}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="status" value={a.status === 'active' ? 'archived' : 'active'} />
                    <button type="submit" className="btn-secondary btn-sm">{a.status === 'active' ? tr('Archivar', 'Archive') : tr('Reactivar', 'Restore')}</button></form>
                </div></details>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

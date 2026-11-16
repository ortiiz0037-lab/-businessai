import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { ConnectBankButton } from '@/components/banking/connect-bank-button'
import { bankPage } from '@/lib/finance/bank-page'
import { bankingStatus } from '@/lib/banking/config'
import { bankingMessage, CONNECTION_STATUS, ENVIRONMENT_LABEL } from '@/lib/banking/messages'
import { connectTestBank, disconnectConnection, linkProviderAccount, syncNow } from '@/app/actions/banking'
import type { BankAccount } from '@/lib/finance/bank'

export const dynamic = 'force-dynamic'

type Conn = { id: string; provider: string; environment: string; institution_name: string | null; status: string; error_code: string | null; last_sync_at: string | null; last_success_at: string | null; created_at: string; disconnected_at: string | null }
type ProviderAccount = { id: string; connection_id: string; name: string; mask: string | null; type: string | null; subtype: string | null; bank_account_id: string | null }
type Run = { id: string; connection_id: string; trigger: string; status: string; added: number; duplicates: number; removed: number; pending_skipped: number; error_code: string | null; started_at: string }

/** Bank connections through the financial data provider: status, accounts (masked), sync history. */
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; added?: string; dup?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const cfg = bankingStatus()
  const [{ data: c, error }, { data: pa }, { data: runs }, { data: acc }] = await Promise.all([
    supabase.from('bank_connections').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
    supabase.from('bank_provider_accounts').select('*').eq('company_id', companyId).order('name'),
    supabase.from('bank_sync_runs').select('*').eq('company_id', companyId).order('started_at', { ascending: false }).limit(20),
    supabase.from('bank_accounts').select('*').eq('company_id', companyId).eq('status', 'active').order('name'),
  ])
  const L = (o: { es: string; en: string } | undefined, fb: string) => (o ? o[locale] : fb)
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Conexiones bancarias', 'Bank connections')} />
        <BankNav tr={tr} current="/bank/connections" />
        <div className="card p-6 text-sm text-muted">{bankingMessage('unavailable', locale)}</div>
      </div>
    )
  }
  const connections = (c ?? []) as Conn[]
  const providerAccounts = (pa ?? []) as ProviderAccount[]
  const history = (runs ?? []) as Run[]
  const accounts = (acc ?? []) as BankAccount[]
  const errors = Object.fromEntries(['not_configured', 'forbidden', 'provider_error', 'bank_connection_invalid', 'bank_server_auth', 'save'].map((k) => [k, bankingMessage(k, locale)!]))
  errors.link = tr('No se pudo abrir la ventana segura del proveedor. Revise su conexión.', 'The provider\'s secure window could not be opened. Check your connection.')
  const done: Record<string, string> = {
    connected: tr('Banco conectado. Vincule cada cuenta con una cuenta bancaria de BusinessAI para sincronizarla.', 'Bank connected. Link each account to a BusinessAI bank account to sync it.'),
    linked: tr('Cuenta vinculada. La próxima sincronización trae su historial.', 'Account linked. The next sync brings its history.'),
    unlinked: tr('Cuenta desvinculada: ya no se sincroniza (sus movimientos se conservan).', 'Account unlinked: no longer synced (its lines are kept).'),
    synced: tr(`Sincronizado: ${sp.added ?? 0} movimientos nuevos, ${sp.dup ?? 0} ya existentes (no duplicados).`, `Synced: ${sp.added ?? 0} new lines, ${sp.dup ?? 0} already present (no duplicates).`),
    disconnected: tr('Conexión eliminada en el proveedor y aquí. El acceso guardado se borró; los movimientos y el historial se conservan.', 'Connection removed at the provider and here. The stored access was erased; lines and history are kept.'),
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Conexiones bancarias', 'Bank connections')}
        description={tr('Las credenciales se escriben solo en la ventana segura del proveedor (Plaid). BusinessAI nunca ve ni guarda contraseñas bancarias; solo un acceso cifrado que puede revocarse.',
          'Credentials are entered only in the provider\'s secure window (Plaid). BusinessAI never sees or stores bank passwords; only an encrypted access that can be revoked.')} />
      <BankNav tr={tr} current="/bank/connections" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={bankingMessage(sp.error, locale)} />

      <section className="card space-y-3 p-5" aria-labelledby="provider-title" data-testid="banking-provider">
        <h2 id="provider-title" className="font-display text-lg font-semibold text-fg">{tr('Proveedor', 'Provider')}</h2>
        {cfg.configured ? (
          <>
            <p className="text-sm text-muted">Plaid · {L(ENVIRONMENT_LABEL[cfg.environment], cfg.environment)}{cfg.webhooks ? '' : tr(' · sin webhooks (sincronización manual)', ' · no webhooks (manual sync)')}</p>
            {cfg.environment !== 'production' && (
              <p role="note" className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100" data-testid="test-environment-banner">
                {tr('Entorno de PRUEBA: las cuentas y movimientos son datos de prueba, no de un banco real.', 'TEST environment: accounts and transactions are test data, not from a real bank.')}
              </p>
            )}
            {access.manage && (
              <div className="flex flex-wrap gap-3">
                {cfg.environment !== 'test_double' && <ConnectBankButton label={tr('Conectar banco', 'Connect bank')} busyLabel={tr('Abriendo…', 'Opening…')} errors={errors} />}
                {cfg.environment !== 'production' && (
                  <form action={connectTestBank}><SubmitButton className="w-full sm:w-auto" pendingLabel={tr('Conectando…', 'Connecting…')}>{tr('Crear conexión de prueba', 'Create test connection')}</SubmitButton></form>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted" data-testid="banking-not-configured">
            {tr('La conexión bancaria no está configurada en este servidor. Puede seguir importando estados de cuenta (CSV) y registrando pagos a mano. El administrador del sistema debe configurar el proveedor (ver docs/BANKING.md).',
              'Bank connections are not configured on this server. You can still import statements (CSV) and record payments by hand. The system administrator must configure the provider (see docs/BANKING.md).')}
          </p>
        )}
      </section>

      {connections.length === 0 ? (
        <div className="card"><EmptyState icon="building" title={tr('Sin conexiones', 'No connections')}
          description={tr('Conecte un banco para recibir los movimientos automáticamente. También puede importar un estado de cuenta.', 'Connect a bank to receive transactions automatically. You can also import a statement.')}
          action={<Link href="/bank/import" className="btn-secondary">{tr('Importar estado', 'Import statement')}</Link>} /></div>
      ) : (
        <ul className="space-y-4">
          {connections.map((cn) => {
            const st = CONNECTION_STATUS[cn.status]
            const mine = providerAccounts.filter((a) => a.connection_id === cn.id)
            const live = cn.status !== 'disconnected'
            return (
              <li key={cn.id} className="card space-y-4 p-5" data-testid="bank-connection" data-status={cn.status}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-semibold text-fg">{cn.institution_name ?? tr('Banco', 'Bank')}</p>
                    <p className="text-xs text-muted">{L(ENVIRONMENT_LABEL[cn.environment], cn.environment)} · {tr('conectado el', 'connected on')} {f.date(cn.created_at.slice(0, 10))}
                      {cn.last_success_at ? ` · ${tr('última sincronización', 'last sync')} ${f.date(cn.last_success_at.slice(0, 10))}` : ''}</p>
                  </div>
                  <StateChip tone={st?.tone ?? 'pending'}>{L(st, cn.status)}</StateChip>
                </div>
                {cn.error_code && live && <p role="alert" className="text-sm text-red-200">{tr('Código del proveedor', 'Provider code')}: <code>{cn.error_code}</code>. {['login_required', 'pending_disconnect', 'revoked'].includes(cn.status) ? tr('Use «Reconectar» para volver a autorizar el acceso.', 'Use "Reconnect" to authorize access again.') : ''}</p>}
                <ul className="divide-y divide-line/60 rounded-xl border border-line">
                  {mine.map((a) => (
                    <li key={a.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="provider-account">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-fg">{a.name}</p>
                        <p className="text-xs text-muted">{[a.mask ? `••${a.mask}` : null, a.subtype ?? a.type].filter(Boolean).join(' · ')}</p>
                      </div>
                      {access.manage && live ? (
                        <form action={linkProviderAccount} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <input type="hidden" name="provider_account_id" value={a.id} />
                          <label className="sr-only" htmlFor={`link-${a.id}`}>{tr('Cuenta de BusinessAI', 'BusinessAI account')}</label>
                          <select id={`link-${a.id}`} name="bank_account_id" defaultValue={a.bank_account_id ?? ''} className="field min-w-0 sm:w-56">
                            <option value="">{tr('No sincronizar', 'Do not sync')}</option>
                            {accounts.map((b) => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ••${b.last4}` : ''}</option>)}
                          </select>
                          <SubmitButton className="btn-sm w-full sm:w-auto">{tr('Guardar', 'Save')}</SubmitButton>
                        </form>
                      ) : (
                        <span className="text-xs text-muted">{a.bank_account_id ? accounts.find((b) => b.id === a.bank_account_id)?.name : tr('No sincronizada', 'Not synced')}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {accounts.length === 0 && access.manage && <p className="text-xs text-muted">{tr('Primero cree una cuenta bancaria en', 'First create a bank account in')} <Link href="/bank/accounts" className="text-accent hover:underline">{tr('Cuentas', 'Accounts')}</Link>.</p>}
                {access.manage && live && (
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={syncNow}><input type="hidden" name="connection_id" value={cn.id} /><SubmitButton className="btn-sm" pendingLabel={tr('Sincronizando…', 'Syncing…')}>{tr('Sincronizar ahora', 'Sync now')}</SubmitButton></form>
                    {cn.environment !== 'test_double' && ['login_required', 'pending_disconnect', 'revoked', 'error'].includes(cn.status) &&
                      <ConnectBankButton connectionId={cn.id} secondary label={tr('Reconectar', 'Reconnect')} busyLabel={tr('Abriendo…', 'Opening…')} errors={errors} />}
                    <details className="w-full sm:w-auto">
                      <summary className="cursor-pointer text-sm font-semibold text-red-200">{tr('Desconectar', 'Disconnect')}</summary>
                      <form action={disconnectConnection} className="mt-2 space-y-2 rounded-xl border border-red-400/30 p-3">
                        <input type="hidden" name="connection_id" value={cn.id} />
                        <p className="text-xs text-muted">{tr('Se revoca el acceso en el proveedor y se borra el acceso cifrado. Los movimientos importados, emparejamientos y conciliaciones se conservan.',
                          'Access is revoked at the provider and the encrypted access is erased. Imported lines, matches and reconciliations are kept.')}</p>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" className="h-4 w-4" />{tr('Confirmo la desconexión', 'I confirm the disconnection')}</label>
                        <SubmitButton className="btn-sm">{tr('Desconectar', 'Disconnect')}</SubmitButton>
                      </form>
                    </details>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {history.length > 0 && (
        <section className="card overflow-hidden" aria-labelledby="runs-title">
          <h2 id="runs-title" className="px-5 pt-5 font-display text-lg font-semibold text-fg">{tr('Historial de sincronización', 'Sync history')}</h2>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-[620px] text-sm" data-testid="sync-history">
              <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr>
                <th className="px-4 py-2">{tr('Fecha', 'Date')}</th><th className="px-4 py-2">{tr('Origen', 'Trigger')}</th><th className="px-4 py-2">{tr('Resultado', 'Result')}</th>
                <th className="px-4 py-2 text-right">{tr('Nuevos', 'New')}</th><th className="px-4 py-2 text-right">{tr('Repetidos', 'Repeated')}</th><th className="px-4 py-2 text-right">{tr('Retirados', 'Removed')}</th></tr></thead>
              <tbody className="divide-y divide-line/60">
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 text-muted">{f.date(r.started_at.slice(0, 10))} {r.started_at.slice(11, 16)}</td>
                    <td className="px-4 py-2">{({ manual: tr('Manual', 'Manual'), webhook: 'Webhook', initial: tr('Inicial', 'Initial') } as Record<string, string>)[r.trigger] ?? r.trigger}</td>
                    <td className="px-4 py-2">{r.status === 'succeeded' ? <StateChip tone="ok">{tr('Correcto', 'Succeeded')}</StateChip> : <StateChip tone="issue">{r.error_code ?? tr('Error', 'Error')}</StateChip>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.added}</td><td className="px-4 py-2 text-right tabular-nums">{r.duplicates}</td><td className="px-4 py-2 text-right tabular-nums">{r.removed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

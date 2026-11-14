import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { AccountingNav, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { ACCOUNT_TYPES, accountName, accountTypeLabel, accountTypePlural, isoDay, sourceLabel, type LedgerAccount } from '@/lib/finance/ledger'

export const dynamic = 'force-dynamic'

type Activity = { entry_id: string | null; entry_number: number | null; entry_date: string; description: string; reference: string | null; source: string
  reverses_entry_id: string | null; memo: string | null; debit_cents: number | null; credit_cents: number | null; balance_cents: number }

/** General ledger of one account: opening balance, movements and running balance. */
export default async function AccountLedgerPage({ searchParams }: { searchParams: Promise<{ account?: string; from?: string; to?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const from = isoDay(p.from) ?? `${today.slice(0, 4)}-01-01`
  const to = isoDay(p.to) ?? today
  const { data } = await supabase.from('ledger_accounts').select('id, code, name, name_en, type, status, system_key, description').eq('company_id', companyId).order('code')
  const accounts = (data ?? []) as LedgerAccount[]
  const account = accounts.find((a) => a.id === p.account) ?? null
  const { data: act } = account
    ? await supabase.rpc('ledger_account_activity', { account: account.id, from_date: from, to_date: to })
    : { data: [] }
  const rows = (act ?? []) as Activity[]
  const opening = rows.find((r) => r.source === 'opening')
  const moves = rows.filter((r) => r.source !== 'opening')
  const closing = moves.length ? moves[moves.length - 1].balance_cents : opening?.balance_cents ?? 0

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Libro mayor por cuenta', 'Account ledger')}
        description={tr('Saldo inicial, cada movimiento y el saldo acumulado, del lado normal de la cuenta.', 'Opening balance, each movement and the running balance, on the account’s normal side.')} />
      <AccountingNav tr={tr} current="/accounting/ledger" />
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-4 sm:items-end">
        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Cuenta', 'Account')}</span>
          <select name="account" defaultValue={account?.id ?? ''} className="field" required>
            <option value="">—</option>
            {ACCOUNT_TYPES.map((t) => (
              <optgroup key={t} label={accountTypePlural(t, locale)}>
                {accounts.filter((a) => a.type === t).map((a) => <option key={a.id} value={a.id}>{a.code} · {accountName(a, locale)}{a.status === 'archived' ? ` (${tr('archivada', 'archived')})` : ''}</option>)}
              </optgroup>
            ))}
          </select></label>
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <button type="submit" className="btn-secondary sm:col-start-4">{tr('Ver', 'Show')}</button>
      </form>

      {!account
        ? <div className="card"><EmptyState icon="chart" title={tr('Elige una cuenta', 'Choose an account')} /></div>
        : (
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-5">
              <div>
                <h2 className="font-display text-lg font-semibold text-fg">{account.code} · {accountName(account, locale)}</h2>
                <p className="text-sm text-muted">{accountTypeLabel(account.type, locale)} · {f.date(from)} – {f.date(to)}</p>
              </div>
              <p className="text-right text-sm text-muted">{tr('Saldo final', 'Closing balance')}<span className="block text-xl font-bold tabular-nums text-fg">{money(closing)}</span></p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr><th className="px-4 py-2">{tr('Fecha', 'Date')}</th><th className="px-4 py-2">{tr('Asiento', 'Entry')}</th><th className="px-4 py-2">{tr('Descripción', 'Description')}</th>
                    <th className="px-4 py-2 text-right">{tr('Débito', 'Debit')}</th><th className="px-4 py-2 text-right">{tr('Crédito', 'Credit')}</th><th className="px-4 py-2 text-right">{tr('Saldo', 'Balance')}</th></tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  <tr className="bg-white/[0.02]"><td className="px-4 py-2 text-muted">{f.date(from)}</td><td className="px-4 py-2" /><td className="px-4 py-2 font-semibold text-slate-300">{tr('Saldo inicial', 'Opening balance')}</td>
                    <td /><td /><td className="px-4 py-2 text-right font-semibold tabular-nums">{money(opening?.balance_cents ?? 0)}</td></tr>
                  {moves.map((r, i) => (
                    <tr key={`${r.entry_id}-${i}`}>
                      <td className="px-4 py-2 text-muted">{f.date(r.entry_date)}</td>
                      <td className="px-4 py-2"><Link href={`/accounting/journal?from=${r.entry_date}&to=${r.entry_date}#e-${r.entry_id}`} className="text-accent">#{r.entry_number}</Link></td>
                      <td className="px-4 py-2 text-slate-300">{r.description}<span className="block text-xs text-muted">{sourceLabel(r.source, locale)}{r.memo ? ` · ${r.memo}` : ''}</span></td>
                      <td className="px-4 py-2 text-right tabular-nums">{Number(r.debit_cents) > 0 ? money(r.debit_cents) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{Number(r.credit_cents) > 0 ? money(r.credit_cents) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-fg">{money(r.balance_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moves.length === 0 && <p className="p-5 text-sm text-muted">{tr('Sin movimientos en este periodo.', 'No movements in this period.')}</p>}
          </section>
        )}
    </div>
  )
}

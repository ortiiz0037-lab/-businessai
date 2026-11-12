import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, StatCard } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, reasonLabel, type BankAccount, type BankLine, type Suggestion } from '@/lib/finance/bank'
import { isoDay } from '@/lib/finance/ledger'
import { sumCents } from '@/lib/finance/money'
import { autoMatch } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'
const STATUSES = ['unmatched', 'matched', 'excluded']

/** Statement lines of one bank account with their state and the best suggestion. */
export default async function BankAccountLinesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; from?: string; to?: string; done?: string; error?: string; n?: string; d?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, today, supabase, companyId, access } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: acc } = await supabase.from('bank_accounts').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const account = acc as BankAccount | null
  if (!account) notFound()
  const status = STATUSES.includes(sp.status ?? '') ? sp.status! : ''
  const from = isoDay(sp.from) ?? `${today.slice(0, 4)}-01-01`
  const to = isoDay(sp.to) ?? today
  let q = supabase.from('bank_lines').select('*').eq('bank_account_id', id).gte('txn_date', from).lte('txn_date', to)
  q = status ? q.eq('status', status) : q.neq('status', 'excluded')
  const [{ data: lineData }, { data: sugData }, { data: openBook }] = await Promise.all([
    q.order('txn_date', { ascending: false }).order('line_no').limit(500),
    supabase.rpc('bank_suggestions', { account: id }),
    supabase.rpc('bank_open_journal_lines', { account: id, from_date: null, to_date: null }),
  ])
  const lines = (lineData ?? []) as BankLine[]
  const best = new Map<string, Suggestion>()
  for (const s of (sugData ?? []) as Suggestion[]) { const p = best.get(s.bank_line_id); if (!p || s.confidence > p.confidence) best.set(s.bank_line_id, s) }
  const pending = lines.filter((l) => l.status === 'unmatched')
  const done: Record<string, string> = {
    imported: tr(`Estado importado: ${sp.n ?? 0} movimientos nuevos, ${sp.d ?? 0} duplicados omitidos.`, `Statement imported: ${sp.n ?? 0} new lines, ${sp.d ?? 0} duplicates skipped.`),
    already_imported: tr('Ese archivo ya se había importado en esta cuenta: no se añadió nada.', 'That file was already imported into this account: nothing was added.'),
    auto_matched: tr(`Emparejamiento automático: ${sp.n ?? 0} coincidencias exactas confirmadas. Las ambiguas quedan para revisión.`, `Auto-match: ${sp.n ?? 0} exact matches confirmed. Ambiguous ones are left for review.`),
  }
  const qs = (s: string) => new URLSearchParams({ ...(s ? { status: s } : {}), from, to }).toString()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={account.name} description={[account.bank_name, account.last4 ? `••${account.last4}` : null, account.currency].filter(Boolean).join(' · ')}
        actions={access.manage && account.status === 'active' ? <>
          <form action={autoMatch}><input type="hidden" name="bank_account_id" value={id} /><SubmitButton className="w-full sm:w-auto">{tr('Emparejar exactos', 'Match exact ones')}</SubmitButton></form>
          <Link href={`/bank/import?account=${id}`} className="btn-secondary">{tr('Importar', 'Import')}</Link></> : undefined} />
      <BankNav tr={tr} current="/bank/accounts" />
      <Flash done={sp.done ? done[sp.done] : null} error={bankMessage(sp.error, locale)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard icon="alert" tone="warning" label={tr('Pendientes en el periodo', 'Pending in period')} value={String(pending.length)} hint={money(sumCents(pending.map((l) => l.amount_cents)))} />
        <StatCard icon="check" tone="success" label={tr('Emparejados', 'Matched')} value={String(lines.filter((l) => l.status === 'matched').length)} />
        <StatCard icon="file" label={tr('Partidas en libros sin banco', 'Book items not in bank')} value={String(((openBook ?? []) as unknown[]).length)} hint={tr('Depósitos en tránsito, cheques pendientes…', 'Deposits in transit, outstanding checks…')} />
      </div>
      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-4 sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Estado', 'Status')}</span>
          <select name="status" defaultValue={status} className="field"><option value="">{tr('Todos (sin excluidos)', 'All (no excluded)')}</option>
            <option value="unmatched">{tr('Pendientes', 'Pending')}</option><option value="matched">{tr('Emparejados', 'Matched')}</option><option value="excluded">{tr('Excluidos', 'Excluded')}</option></select></label>
        <button type="submit" className="btn-secondary">{tr('Filtrar', 'Filter')}</button>
      </form>
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">{tr('Fecha', 'Date')}</th><th className="px-4 py-3">{tr('Descripción', 'Description')}</th>
              <th className="px-4 py-3 text-right">{tr('Importe', 'Amount')}</th><th className="px-4 py-3">{tr('Estado', 'Status')}</th><th className="px-4 py-3">{tr('Sugerencia', 'Suggestion')}</th></tr></thead>
            <tbody className="divide-y divide-line/60">
              {lines.map((l) => {
                const s = best.get(l.id)
                return (
                  <tr key={l.id} className="hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{f.date(l.txn_date)}</td>
                    <td className="px-4 py-2"><Link href={`/bank/lines/${l.id}`} className="text-fg hover:text-accent">{l.description}</Link>{l.reference && <span className="block text-xs text-muted">{l.reference}</span>}</td>
                    <td className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums ${l.amount_cents < 0 ? 'text-slate-300' : 'text-green-300'}`}>{money(l.amount_cents)}</td>
                    <td className="px-4 py-2">{l.reconciliation_id ? <StateChip tone="ok">{tr('Conciliado', 'Reconciled')}</StateChip>
                      : l.status === 'matched' ? <StateChip tone="ok">{tr('Emparejado', 'Matched')}</StateChip>
                      : l.status === 'excluded' ? <span className="badge-neutral">{tr('Excluido', 'Excluded')}</span> : <StateChip tone="pending">{tr('Pendiente', 'Pending')}</StateChip>}</td>
                    <td className="px-4 py-2 text-xs">{l.status === 'unmatched' && s ? <Link href={`/bank/lines/${l.id}`} className={s.ambiguous ? 'text-amber-300' : 'text-accent'}>
                      {s.confidence > 0 ? `${s.confidence}% · ` : ''}{reasonLabel(s.reason, locale)}{s.ambiguous ? ` · ${tr('ambigua', 'ambiguous')}` : ''}</Link> : ''}</td>
                  </tr>
                )
              })}
              {lines.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-muted">{tr('Sin movimientos con estos filtros.', 'No lines with these filters.')} {access.manage && <Link href={`/bank/import?account=${id}`} className="text-accent">{tr('Importar un estado', 'Import a statement')}</Link>}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-xs text-muted print:hidden"><a href={`/bank/export?kind=lines&account=${id}&from=${from}&to=${to}`} className="text-accent">{tr('Exportar CSV', 'Export CSV')}</a> · <Link href={`/bank/accounts/${id}?${qs('unmatched')}`} className="text-accent">{tr('Solo pendientes', 'Pending only')}</Link></p>
    </div>
  )
}

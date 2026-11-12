import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AccountingNav, Flash, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { accountName, isoDay, ledgerMessage, sourceLabel, type EntryRow, type LedgerAccount, type LineRow } from '@/lib/finance/ledger'
import { reverseEntry } from '@/app/actions/accounting'

export const dynamic = 'force-dynamic'
const PAGE = 25
const SOURCES = ['manual', 'invoice', 'invoice_void', 'payment', 'reversal']

/** Journal: every entry with its lines, newest first; reversals of manual entries. */
export default async function JournalPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; source?: string; page?: string; done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const from = isoDay(p.from) ?? `${today.slice(0, 8)}01`
  const to = isoDay(p.to) ?? today
  const source = SOURCES.includes(p.source ?? '') ? p.source! : ''
  const page = Math.max(1, Math.min(1000, Number.parseInt(p.page ?? '1', 10) || 1))

  let q = supabase.from('journal_entries').select('*', { count: 'exact' }).eq('company_id', companyId)
    .gte('entry_date', from).lte('entry_date', to)
  if (source) q = q.eq('source', source)
  const { data, count } = await q.order('entry_date', { ascending: false }).order('entry_number', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1)
  const entries = (data ?? []) as EntryRow[]
  const ids = entries.map((e) => e.id)
  const [{ data: lineData }, { data: acctData }, { data: revData }, { data: members }] = await Promise.all([
    ids.length ? supabase.from('journal_lines').select('entry_id, line_no, account_id, debit_cents, credit_cents, memo').in('entry_id', ids).order('line_no') : Promise.resolve({ data: [] }),
    supabase.from('ledger_accounts').select('id, code, name, name_en').eq('company_id', companyId),
    ids.length ? supabase.from('journal_entries').select('id, entry_number, reverses_entry_id').in('reverses_entry_id', ids) : Promise.resolve({ data: [] }),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const lines = (lineData ?? []) as LineRow[]
  const accounts = new Map(((acctData ?? []) as Pick<LedgerAccount, 'id' | 'code' | 'name' | 'name_en'>[]).map((a) => [a.id, a]))
  const reversedBy = new Map(((revData ?? []) as { id: string; entry_number: number; reverses_entry_id: string }[]).map((r) => [r.reverses_entry_id, r.entry_number]))
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const qs = (extra: Record<string, string>) => new URLSearchParams({ from, to, ...(source ? { source } : {}), ...extra }).toString()
  const back = `/accounting/journal?${qs({ page: String(page) })}`
  const done: Record<string, string> = { posted: tr('Asiento publicado.', 'Entry posted.'), reversed: tr('Reversión publicada; el asiento original se conserva.', 'Reversal posted; the original entry is kept.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Libro diario', 'Journal')}
        description={tr('Cada asiento cuadra exactamente y queda inalterable. Origen, usuario y fecha contable en cada uno.', 'Every entry balances exactly and stays unaltered. Source, user and accounting date on each.')}
        actions={access.post ? <Link href="/accounting/journal/new" className="btn-primary">{tr('Nuevo asiento', 'New entry')}</Link> : undefined} />
      <AccountingNav tr={tr} current="/accounting/journal" />
      <Flash done={p.done ? done[p.done] : null} error={ledgerMessage(p.error, locale)} />

      <form method="get" className="card grid gap-3 p-4 sm:grid-cols-4 sm:items-end">
        <label className="text-sm"><span className="field-label">{tr('Desde', 'From')}</span><input type="date" name="from" defaultValue={from} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Hasta', 'To')}</span><input type="date" name="to" defaultValue={to} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Origen', 'Source')}</span>
          <select name="source" defaultValue={source} className="field">
            <option value="">{tr('Todos', 'All')}</option>
            {SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s, locale)}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-secondary">{tr('Filtrar', 'Filter')}</button>
      </form>

      {entries.length === 0
        ? <div className="card"><EmptyState icon="file" title={tr('Sin asientos en este periodo', 'No entries in this period')} /></div>
        : (
          <ol className="space-y-4">
            {entries.map((e) => {
              const ls = lines.filter((l) => l.entry_id === e.id)
              const rev = reversedBy.get(e.id)
              return (
                <li key={e.id} id={`e-${e.id}`} className="card overflow-hidden">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-fg">#{e.entry_number} · {f.date(e.entry_date)} · <span className="text-accent">{sourceLabel(e.source, locale)}</span></p>
                      <p className="mt-1 break-words text-sm text-slate-300">{e.description}{e.reference ? ` · ${tr('Ref.', 'Ref.')} ${e.reference}` : ''}</p>
                      <p className="mt-1 text-xs text-muted">
                        {e.created_by ? `${who.get(e.created_by) || tr('usuario', 'user')} · ` : tr('Sistema · ', 'System · ')}{f.dateTime(e.created_at)} · {e.currency}
                      </p>
                      {e.reverses_entry_id && <p className="mt-1 text-xs text-amber-300">{tr('Revierte un asiento anterior. Motivo:', 'Reverses an earlier entry. Reason:')} {e.reversal_reason}</p>}
                      {rev && <p className="mt-1 text-xs text-amber-300">{tr(`Revertido por el asiento #${rev}.`, `Reversed by entry #${rev}.`)}</p>}
                    </div>
                    <span className="font-semibold tabular-nums text-fg">{money(e.total_cents)}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-muted">
                        <tr><th className="px-4 py-2">{tr('Cuenta', 'Account')}</th><th className="px-4 py-2">{tr('Detalle', 'Memo')}</th><th className="px-4 py-2 text-right">{tr('Débito', 'Debit')}</th><th className="px-4 py-2 text-right">{tr('Crédito', 'Credit')}</th></tr>
                      </thead>
                      <tbody className="divide-y divide-line/60">
                        {ls.map((l) => {
                          const a = accounts.get(l.account_id)
                          return (
                            <tr key={l.line_no}>
                              <td className="px-4 py-2 text-fg"><Link href={`/accounting/ledger?account=${l.account_id}`} className="hover:text-accent">{a ? `${a.code} · ${accountName(a, locale)}` : '—'}</Link></td>
                              <td className="px-4 py-2 text-muted">{l.memo ?? ''}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{Number(l.debit_cents) > 0 ? money(l.debit_cents) : ''}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{Number(l.credit_cents) > 0 ? money(l.credit_cents) : ''}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {access.post && e.source === 'manual' && !rev && (
                    <details className="border-t border-line p-4">
                      <summary className="cursor-pointer text-sm font-semibold text-accent">{tr('Revertir este asiento', 'Reverse this entry')}</summary>
                      <form action={reverseEntry} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="back" value={back} />
                        <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Motivo (obligatorio)', 'Reason (required)')}</span>
                          <input name="reason" required minLength={3} maxLength={300} className="field" /></label>
                        <label className="text-sm"><span className="field-label">{tr('Fecha de la reversión', 'Reversal date')}</span>
                          <input type="date" name="reversal_date" defaultValue={today >= e.entry_date ? today : e.entry_date} className="field" /></label>
                        <p className="text-xs text-muted sm:col-span-2">{tr('Se publica un asiento espejo que apunta a este; el original no cambia.', 'A mirror entry pointing to this one is posted; the original does not change.')}</p>
                        <SubmitButton className="w-full">{tr('Publicar reversión', 'Post reversal')}</SubmitButton>
                      </form>
                    </details>
                  )}
                  {e.source !== 'manual' && e.source !== 'reversal' && !rev && e.source_id && (
                    <p className="border-t border-line px-4 py-3 text-xs text-muted">
                      {tr('Asiento automático de un documento: se corrige desde el documento (anulación).', 'Automatic entry from a document: corrected from the document (void).')}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        )}

      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label={tr('Páginas', 'Pages')}>
          {page > 1 ? <Link className="btn-secondary" href={`/accounting/journal?${qs({ page: String(page - 1) })}`}>{tr('Anterior', 'Previous')}</Link> : <span />}
          <span className="text-muted">{page} / {pages}</span>
          {page < pages ? <Link className="btn-secondary" href={`/accounting/journal?${qs({ page: String(page + 1) })}`}>{tr('Siguiente', 'Next')}</Link> : <span />}
        </nav>
      )}
    </div>
  )
}

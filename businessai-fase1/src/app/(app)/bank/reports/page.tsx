import Link from 'next/link'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankEventLabel, bankMessage, type BankAccount, type BankLine, type Reconciliation, type RecSummary } from '@/lib/finance/bank'
import { revertImport } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

type Import = { id: string; bank_account_id: string; file_name: string; row_count: number; imported_count: number; duplicate_count: number; first_date: string | null; last_date: string | null; status: string; revert_reason: string | null; created_by: string | null; created_at: string }

/** Reports: reconciliations by account and period, unmatched lines, differences, imports, closes and reopens; CSV exports. */
export default async function BankReportsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access, who } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const [{ data: acc }, { data: recData }, { data: unm }, { data: imp }, { data: ev }, name] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id', companyId),
    supabase.from('bank_reconciliations').select('*').eq('company_id', companyId).order('period_end', { ascending: false }).limit(100),
    supabase.from('bank_lines').select('*').eq('company_id', companyId).eq('status', 'unmatched').order('txn_date').limit(200),
    supabase.from('bank_imports').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(100),
    supabase.from('bank_events').select('*').eq('company_id', companyId).eq('entity', 'bank_reconciliations').in('action', ['closed', 'reopened', 'adjusted']).order('id', { ascending: false }).limit(100),
    who(),
  ])
  const accName = new Map(((acc ?? []) as BankAccount[]).map((a) => [a.id, a.name]))
  const recs = (recData ?? []) as Reconciliation[]
  const sums = await Promise.all(recs.map((r) => supabase.rpc('bank_reconciliation_summary', { rec: r.id })))
  const summary = new Map(recs.map((r, i) => [r.id, ((sums[i].data ?? []) as RecSummary[])[0]]))
  const diffs = recs.filter((r) => r.status === 'open' && summary.get(r.id) && (summary.get(r.id)!.difference_cents !== 0 || summary.get(r.id)!.statement_difference_cents !== 0 || summary.get(r.id)!.unmatched_bank_count > 0))
  const exportLink = (kind: string, label: string) => <a href={`/bank/export?kind=${kind}`} className="btn-secondary btn-sm">{label}</a>
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Informes bancarios', 'Bank reports')} actions={<PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} />} />
      <BankNav tr={tr} current="/bank/reports" />
      <Flash done={sp.done === 'import_reverted' ? tr('Importación revertida: sus movimientos quedan excluidos (no se borran).', 'Import reverted: its lines are excluded (not deleted).') : null} error={bankMessage(sp.error, locale)} />
      <div className="flex flex-wrap gap-2 print:hidden">{exportLink('reconciliations', tr('CSV conciliaciones', 'Reconciliations CSV'))}{exportLink('unmatched', tr('CSV sin emparejar', 'Unmatched CSV'))}
        {exportLink('lines', tr('CSV movimientos', 'Lines CSV'))}{exportLink('imports', tr('CSV importaciones', 'Imports CSV'))}{exportLink('events', tr('CSV auditoría', 'Audit CSV'))}</div>

      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Conciliaciones por cuenta y periodo', 'Reconciliations by account and period')}</h2>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">{tr('Cuenta', 'Account')}</th><th className="px-4 py-2">{tr('Periodo', 'Period')}</th>
            <th className="px-4 py-2 text-right">{tr('Saldo final', 'Closing')}</th><th className="px-4 py-2 text-right">{tr('Libros', 'Books')}</th><th className="px-4 py-2 text-right">{tr('Diferencia', 'Difference')}</th><th className="px-4 py-2">{tr('Estado', 'Status')}</th></tr></thead>
          <tbody className="divide-y divide-line/60">{recs.map((r) => { const s = summary.get(r.id); return (
            <tr key={r.id}><td className="px-4 py-2"><Link href={`/bank/reconciliations/${r.id}`} className="text-fg hover:text-accent">{accName.get(r.bank_account_id)}</Link></td>
              <td className="px-4 py-2 text-muted">{f.date(r.period_start)} – {f.date(r.period_end)}</td><td className="px-4 py-2 text-right tabular-nums">{money(r.statement_closing_cents)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(s?.ledger_balance_cents)}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${s && s.difference_cents !== 0 ? 'text-red-300' : 'text-green-300'}`}>{money(s?.difference_cents)}</td>
              <td className="px-4 py-2">{r.status === 'closed' ? <StateChip tone="ok">{tr('Cerrada', 'Closed')}</StateChip> : <StateChip tone="pending">{tr('Abierta', 'Open')}</StateChip>}</td></tr>) })}
            {recs.length === 0 && <tr><td colSpan={6} className="px-4 py-4 text-muted">{tr('Sin conciliaciones.', 'No reconciliations.')}</td></tr>}</tbody>
        </table></div>
      </section>

      <section className="card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Diferencias detectadas', 'Differences found')}</h2>
        {diffs.length === 0 ? <p className="text-sm text-muted">{tr('Ninguna en conciliaciones abiertas.', 'None in open reconciliations.')}</p> : (
          <ul className="space-y-1 text-sm">{diffs.map((r) => { const s = summary.get(r.id)!; return (
            <li key={r.id}><Link href={`/bank/reconciliations/${r.id}`} className="text-accent">{accName.get(r.bank_account_id)} · {f.date(r.period_end)}</Link>
              <span className="text-muted"> · {tr('estado', 'statement')} {money(s.statement_difference_cents)} · {tr('sin emparejar', 'unmatched')} {s.unmatched_bank_count} · {tr('diferencia', 'difference')} {money(s.difference_cents)}</span></li>) })}</ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Movimientos sin emparejar', 'Unmatched lines')}</h2>
        <ul className="divide-y divide-line/60 text-sm">{((unm ?? []) as BankLine[]).map((l) => (
          <li key={l.id}><Link href={`/bank/lines/${l.id}`} className="flex justify-between gap-2 px-5 py-2 hover:bg-white/[0.03]"><span>{accName.get(l.bank_account_id)} · {f.date(l.txn_date)} · {l.description}</span><span className="tabular-nums">{money(l.amount_cents)}</span></Link></li>))}
          {((unm ?? []) as unknown[]).length === 0 && <li className="px-5 py-3 text-muted">{tr('Ninguno.', 'None.')}</li>}</ul>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Historial de importaciones', 'Import history')}</h2>
        <ul className="divide-y divide-line/60 text-sm">{((imp ?? []) as Import[]).map((i) => (
          <li key={i.id} className="space-y-1 px-5 py-3">
            <div className="flex flex-wrap justify-between gap-2"><span className={i.status === 'reverted' ? 'text-muted line-through' : 'text-fg'}>{i.file_name} · {accName.get(i.bank_account_id)}</span>
              <span className="text-xs text-muted">{tr(`${i.imported_count} nuevos · ${i.duplicate_count} duplicados · ${i.row_count} filas`, `${i.imported_count} new · ${i.duplicate_count} duplicates · ${i.row_count} rows`)}</span></div>
            <p className="text-xs text-muted">{name(i.created_by)} · {f.dateTime(i.created_at)}{i.first_date ? ` · ${f.date(i.first_date)} – ${f.date(i.last_date ?? i.first_date)}` : ''}{i.revert_reason ? ` · ${tr('revertida', 'reverted')}: ${i.revert_reason}` : ''}</p>
            {access.manage && i.status === 'completed' && (
              <details><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Revertir importación', 'Revert import')}</summary>
                <form action={revertImport} className="mt-2 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="import_id" value={i.id} />
                  <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo (p. ej. columnas mal asignadas)', 'Reason (e.g. wrong column mapping)')} className="field" />
                  <SubmitButton className="w-full sm:w-auto">{tr('Revertir', 'Revert')}</SubmitButton></form></details>
            )}
          </li>))}</ul>
      </section>

      <section className="card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Cierres, ajustes y reaperturas', 'Closes, adjustments and reopens')}</h2>
        <ul className="space-y-1 text-sm">{((ev ?? []) as { id: number; bank_account_id: string | null; entity_id: string; action: string; details: Record<string, unknown>; actor: string | null; created_at: string }[]).map((e) => (
          <li key={e.id}><Link href={`/bank/reconciliations/${e.entity_id}`} className="text-fg hover:text-accent">{bankEventLabel(e.action, locale)}</Link>
            <span className="text-xs text-muted"> · {accName.get(e.bank_account_id ?? '')} · {name(e.actor)} · {f.dateTime(e.created_at)}{typeof e.details?.reason === 'string' ? ` · ${e.details.reason}` : ''}</span></li>))}</ul>
      </section>
    </div>
  )
}

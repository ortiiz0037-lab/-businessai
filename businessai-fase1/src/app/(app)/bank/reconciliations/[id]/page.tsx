import Link from 'next/link'
import { notFound } from 'next/navigation'
import PrintButton from '@/components/PrintButton'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankEventLabel, bankMessage, type BankAccount, type BankLine, type OpenJournalLine, type Reconciliation, type RecSummary } from '@/lib/finance/bank'
import { accountName, sourceLabel } from '@/lib/finance/ledger'
import { centsToInput } from '@/lib/finance/money'
import { adjustReconciliation, closeReconciliation, reopenReconciliation, updateReconciliation } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

/** One reconciliation: statement vs ledger, pending items, differences, adjustment, close / reopen. */
export default async function ReconciliationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access, who } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: r0 } = await supabase.from('bank_reconciliations').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const rec = r0 as Reconciliation | null
  if (!rec) notFound()
  const [{ data: acc }, { data: sum }, { data: unmatched }, { data: book }, { data: ev }, { data: ledger }, name] = await Promise.all([
    supabase.from('bank_accounts').select('*').eq('id', rec.bank_account_id).maybeSingle(),
    supabase.rpc('bank_reconciliation_summary', { rec: id }),
    supabase.from('bank_lines').select('*').eq('bank_account_id', rec.bank_account_id).eq('status', 'unmatched').gte('txn_date', rec.period_start).lte('txn_date', rec.period_end).order('txn_date'),
    supabase.rpc('bank_open_journal_lines', { account: rec.bank_account_id, from_date: null, to_date: rec.period_end }),
    supabase.from('bank_events').select('*').eq('entity', 'bank_reconciliations').eq('entity_id', id).order('id', { ascending: false }),
    supabase.from('ledger_accounts').select('id, code, name, name_en, status').eq('company_id', companyId).eq('status', 'active').order('code'),
    who(),
  ])
  const account = acc as BankAccount
  const s = ((sum ?? []) as RecSummary[])[0]
  const pend = (unmatched ?? []) as BankLine[]
  const uncleared = (book ?? []) as OpenJournalLine[]
  const closed = rec.status === 'closed'
  const ready = s && s.continuity_ok && s.statement_difference_cents === 0 && s.unmatched_bank_count === 0 && s.difference_cents === 0
  const row = (label: string, v: number | null | undefined, strong = false, tone = '') =>
    <div className="flex justify-between gap-3 py-1.5"><dt className="text-slate-300">{label}</dt><dd className={`tabular-nums ${strong ? 'font-bold text-fg' : 'text-slate-200'} ${tone}`}>{money(v ?? 0)}</dd></div>
  const done: Record<string, string> = { created: tr('Conciliación creada.', 'Reconciliation created.'), updated: tr('Saldos corregidos (queda en el historial).', 'Balances corrected (kept in the history).'),
    adjusted: tr('Ajuste autorizado registrado con asiento balanceado.', 'Authorised adjustment posted with a balanced entry.'), closed: tr('Conciliación cerrada: sus movimientos quedan bloqueados.', 'Reconciliation closed: its lines are locked.'),
    reopened: tr('Conciliación reabierta; el motivo quedó registrado.', 'Reconciliation reopened; the reason was recorded.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={account?.name ?? tr('Bancos', 'Banking')} title={<>{tr('Conciliación', 'Reconciliation')} {f.date(rec.period_start)} – {f.date(rec.period_end)}</>}
        actions={<>{closed ? <StateChip tone="ok">{tr('Cerrada', 'Closed')}</StateChip> : ready ? <StateChip tone="ok">{tr('Lista para cerrar', 'Ready to close')}</StateChip> : <StateChip tone="issue">{tr('Con diferencias', 'Has differences')}</StateChip>}
          <PrintButton label={tr('Imprimir / PDF', 'Print / PDF')} /></>} />
      <BankNav tr={tr} current="/bank/reconciliations" />
      <Flash done={sp.done ? done[sp.done] : null} error={bankMessage(sp.error, locale)} />
      {s && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card p-5">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Estado del banco', 'Bank statement')}</h2>
            <dl className="mt-3 divide-y divide-line/50 text-sm">
              {row(tr('Saldo inicial', 'Opening balance'), s.statement_opening_cents)}
              {row(tr('+ Movimientos importados del periodo', '+ Imported lines of the period'), s.statement_lines_cents)}
              {row(tr('Saldo final del estado', 'Statement closing balance'), s.statement_closing_cents, true)}
              {row(tr('Diferencia del estado (faltan / sobran movimientos)', 'Statement difference (missing / extra lines)'), s.statement_difference_cents, false, s.statement_difference_cents === 0 ? 'text-green-300' : 'text-red-300')}
            </dl>
            {!s.continuity_ok && <p className="mt-3 text-sm text-red-300">{tr(`El saldo inicial no coincide con el cierre anterior (${money(s.previous_closing_cents)}).`, `The opening balance does not equal the previous closing (${money(s.previous_closing_cents)}).`)}</p>}
          </section>
          <section className="card p-5">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Banco contra libros', 'Bank vs books')}</h2>
            <dl className="mt-3 divide-y divide-line/50 text-sm">
              {row(tr('Saldo final del estado', 'Statement closing balance'), s.statement_closing_cents)}
              {row(tr(`+ Partidas en libros sin banco (${s.uncleared_book_count})`, `+ Book items not in bank (${s.uncleared_book_count})`), s.uncleared_book_cents)}
              {row(tr('− Movimientos del banco registrados después del periodo', '− Bank items booked after the period'), s.bank_booked_later_cents)}
              {row(tr('Saldo bancario ajustado', 'Adjusted bank balance'), s.adjusted_bank_cents, true)}
              {row(tr('Saldo en libros al cierre', 'Book balance at period end'), s.ledger_balance_cents, true)}
              {row(tr('Diferencia sin conciliar', 'Unreconciled difference'), s.difference_cents, true, s.difference_cents === 0 ? 'text-green-300' : 'text-red-300')}
            </dl>
          </section>
        </div>
      )}

      {!closed && (
        <section className="card space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Para cerrar', 'To close')}</h2>
          <ul className="space-y-1 text-sm">
            <li className={s?.continuity_ok ? 'text-green-300' : 'text-red-300'}>{s?.continuity_ok ? '✓' : '✗'} {tr('Continuidad con la conciliación anterior', 'Continuity with the previous reconciliation')}</li>
            <li className={s?.statement_difference_cents === 0 ? 'text-green-300' : 'text-red-300'}>{s?.statement_difference_cents === 0 ? '✓' : '✗'} {tr('Estado completo (saldo inicial + movimientos = saldo final)', 'Statement complete (opening + lines = closing)')}</li>
            <li className={s?.unmatched_bank_count === 0 ? 'text-green-300' : 'text-red-300'}>{s?.unmatched_bank_count === 0 ? '✓' : '✗'} {tr(`Movimientos sin emparejar: ${s?.unmatched_bank_count ?? 0}`, `Unmatched lines: ${s?.unmatched_bank_count ?? 0}`)}</li>
            <li className={s?.difference_cents === 0 ? 'text-green-300' : 'text-red-300'}>{s?.difference_cents === 0 ? '✓' : '✗'} {tr('Diferencia cero', 'Zero difference')}</li>
          </ul>
          {access.reconcile && <form action={closeReconciliation}><input type="hidden" name="id" value={id} /><SubmitButton className="w-full sm:w-auto">{tr('Cerrar conciliación', 'Close reconciliation')}</SubmitButton></form>}
          {access.reconcile && (
            <details><summary className="cursor-pointer text-sm font-semibold text-accent">{tr('Corregir saldos del estado', 'Correct statement balances')}</summary>
              <form action={updateReconciliation} className="mt-2 grid gap-2 sm:grid-cols-3"><input type="hidden" name="id" value={id} />
                <input name="opening" required inputMode="decimal" defaultValue={centsToInput(rec.statement_opening_cents)} className="field text-right" aria-label={tr('Saldo inicial', 'Opening')} />
                <input name="closing" required inputMode="decimal" defaultValue={centsToInput(rec.statement_closing_cents)} className="field text-right" aria-label={tr('Saldo final', 'Closing')} />
                <SubmitButton>{tr('Guardar', 'Save')}</SubmitButton></form></details>
          )}
          {access.adjust && s && s.difference_cents !== 0 && s.unmatched_bank_count === 0 && s.statement_difference_cents === 0 && !rec.adjustment_entry_id && (
            <details className="rounded-xl border border-amber-400/30 p-3"><summary className="cursor-pointer text-sm font-semibold text-amber-300">{tr(`Autorizar ajuste de ${money(s.difference_cents)}`, `Authorise an adjustment of ${money(s.difference_cents)}`)}</summary>
              <form action={adjustReconciliation} className="mt-2 grid gap-2 sm:grid-cols-3"><input type="hidden" name="id" value={id} />
                <select name="counter_account_id" required defaultValue="" className="field"><option value="" disabled>{tr('Cuenta contrapartida', 'Counter account')}</option>
                  {((ledger ?? []) as { id: string; code: string; name: string; name_en: string | null }[]).filter((a) => a.id !== account.ledger_account_id).map((a) => <option key={a.id} value={a.id}>{a.code} · {accountName(a, locale)}</option>)}</select>
                <input name="reason" required minLength={10} maxLength={300} placeholder={tr('Motivo documentado (mín. 10 caracteres)', 'Documented reason (min. 10 characters)')} className="field sm:col-span-2" />
                <p className="text-xs text-muted sm:col-span-3">{tr('Se registra un asiento balanceado con fecha del cierre del periodo. Solo el propietario lo autoriza y queda en la auditoría.', 'A balanced entry dated at period end is posted. Only the owner authorises it and it is audited.')}</p>
                <SubmitButton>{tr('Registrar ajuste', 'Post adjustment')}</SubmitButton></form></details>
          )}
        </section>
      )}
      {closed && access.reopen && (
        <details className="card p-5"><summary className="cursor-pointer text-sm font-semibold text-accent">{tr('Reabrir conciliación', 'Reopen reconciliation')}</summary>
          <form action={reopenReconciliation} className="mt-3 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="id" value={id} />
            <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" /><SubmitButton className="w-full sm:w-auto">{tr('Reabrir', 'Reopen')}</SubmitButton></form></details>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Movimientos del banco sin emparejar', 'Unmatched bank lines')}</h2>
          <ul className="divide-y divide-line/60 text-sm">{pend.map((l) => (
            <li key={l.id}><Link href={`/bank/lines/${l.id}`} className="flex justify-between gap-2 px-5 py-2 hover:bg-white/[0.03]"><span>{f.date(l.txn_date)} · {l.description}</span><span className="tabular-nums">{money(l.amount_cents)}</span></Link></li>))}
            {pend.length === 0 && <li className="px-5 py-3 text-muted">{tr('Ninguno.', 'None.')}</li>}</ul>
        </section>
        <section className="card overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Partidas en libros aún no en el banco', 'Book items not yet in the bank')}</h2>
          <ul className="divide-y divide-line/60 text-sm">{uncleared.map((j) => (
            <li key={j.journal_line_id} className="flex justify-between gap-2 px-5 py-2"><span>{f.date(j.entry_date)} · #{j.entry_number} {j.description}<span className="text-xs text-muted"> · {sourceLabel(j.source, locale)}</span></span><span className="tabular-nums">{money(j.amount_cents)}</span></li>))}
            {uncleared.length === 0 && <li className="px-5 py-3 text-muted">{tr('Ninguna.', 'None.')}</li>}</ul>
        </section>
      </div>
      <section className="card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Historial', 'History')}</h2>
        <ul className="space-y-1 text-sm">{((ev ?? []) as { id: number; action: string; details: Record<string, unknown>; actor: string | null; created_at: string }[]).map((e) => (
          <li key={e.id}><span className="text-fg">{bankEventLabel(e.action, locale)}</span><span className="text-xs text-muted"> · {name(e.actor)} · {f.dateTime(e.created_at)}{typeof e.details?.reason === 'string' ? ` · ${e.details.reason}` : ''}</span></li>))}</ul>
        {rec.adjustment_reason && <p className="text-xs text-amber-300">{tr('Ajuste:', 'Adjustment:')} {rec.adjustment_reason}</p>}
      </section>
    </div>
  )
}

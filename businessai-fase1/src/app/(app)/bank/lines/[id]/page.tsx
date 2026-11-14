import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess, StateChip } from '@/components/bank-nav'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, reasonLabel, type BankAccount, type BankLine, type OpenJournalLine, type Suggestion } from '@/lib/finance/bank'
import { accountName, sourceLabel } from '@/lib/finance/ledger'
import { matchLines, postBankLine, unmatch } from '@/app/actions/bank'

export const dynamic = 'force-dynamic'

/** One bank line: suggestions with confidence, manual (multiple) matching, posting fees / unknown items, current match. */
export default async function BankLinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access, who } = await bankPage()
  if (!access.view) return <NoBankAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: l } = await supabase.from('bank_lines').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const line = l as BankLine | null
  if (!line) notFound()
  const { data: acc } = await supabase.from('bank_accounts').select('*').eq('id', line.bank_account_id).maybeSingle()
  const account = acc as BankAccount
  const lo = new Date(Date.parse(`${line.txn_date}T12:00:00Z`) - 45 * 86_400_000).toISOString().slice(0, 10)
  const hi = new Date(Date.parse(`${line.txn_date}T12:00:00Z`) + 45 * 86_400_000).toISOString().slice(0, 10)
  const [{ data: sug }, { data: book }, { data: others }, { data: items }, { data: ledger }, name] = await Promise.all([
    supabase.rpc('bank_suggestions', { account: line.bank_account_id }),
    supabase.rpc('bank_open_journal_lines', { account: line.bank_account_id, from_date: lo, to_date: hi }),
    supabase.from('bank_lines').select('id, txn_date, description, amount_cents').eq('bank_account_id', line.bank_account_id).eq('status', 'unmatched').neq('id', id).gte('txn_date', lo).lte('txn_date', hi).order('txn_date').limit(100),
    supabase.from('bank_match_items').select('group_id, journal_line_id, bank_line_id, amount_cents, active').eq('bank_line_id', id),
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, status').eq('company_id', companyId).eq('status', 'active').order('code'),
    who(),
  ])
  const suggestions = ((sug ?? []) as Suggestion[]).filter((s) => s.bank_line_id === id).sort((a, b) => b.confidence - a.confidence)
  const open = (book ?? []) as OpenJournalLine[]
  const byId = new Map(open.map((j) => [j.journal_line_id, j]))
  const activeGroup = ((items ?? []) as { group_id: string; active: boolean }[]).find((i) => i.active)?.group_id ?? null
  const groups = [...new Set(((items ?? []) as { group_id: string }[]).map((i) => i.group_id))]
  const { data: groupData } = groups.length ? await supabase.from('bank_match_groups').select('*').in('id', groups).order('created_at', { ascending: false }) : { data: [] }
  const { data: groupItems } = activeGroup ? await supabase.from('bank_match_items').select('journal_line_id, bank_line_id, amount_cents').eq('group_id', activeGroup).eq('active', true) : { data: [] }
  const matchedJl = ((groupItems ?? []) as { journal_line_id: number | null }[]).map((x) => x.journal_line_id).filter((x): x is number => x !== null)
  const { data: matchedEntries } = matchedJl.length ? await supabase.from('journal_lines').select('id, entry_id, debit_cents, credit_cents, journal_entries(entry_number, entry_date, description, source)').in('id', matchedJl) : { data: [] }
  const back = `/bank/lines/${id}`
  const counterAccounts = ((ledger ?? []) as { id: string; code: string; name: string; name_en: string | null; type: string }[]).filter((a) => a.id !== account.ledger_account_id)
  const done: Record<string, string> = { matched: tr('Emparejado.', 'Matched.'), unmatched: tr('Emparejamiento deshecho (queda en el historial).', 'Match undone (kept in the history).'),
    posted: tr('Asiento balanceado registrado y emparejado.', 'Balanced entry posted and matched.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={account.name} title={<span className="tabular-nums">{money(line.amount_cents)}</span>} description={<>{f.date(line.txn_date)} · {line.description}{line.reference ? ` · ${line.reference}` : ''}</>}
        actions={line.reconciliation_id ? <StateChip tone="ok">{tr('Conciliado', 'Reconciled')}</StateChip> : line.status === 'matched' ? <StateChip tone="ok">{tr('Emparejado', 'Matched')}</StateChip>
          : line.status === 'excluded' ? <span className="badge-neutral">{tr('Excluido', 'Excluded')}</span> : <StateChip tone="pending">{tr('Pendiente', 'Pending')}</StateChip>} />
      <BankNav tr={tr} current="/bank/accounts" />
      <Flash done={sp.done ? done[sp.done] : null} error={bankMessage(sp.error, locale)} />
      <p className="text-sm"><Link href={`/bank/accounts/${account.id}`} className="text-accent">← {tr('Movimientos de la cuenta', 'Account lines')}</Link></p>

      {line.status === 'matched' && activeGroup && (
        <section className="card space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Emparejado con', 'Matched with')}</h2>
          <ul className="space-y-1 text-sm">{((matchedEntries ?? []) as unknown as { id: number; debit_cents: number; credit_cents: number; journal_entries: { entry_number: number; entry_date: string; description: string; source: string } }[]).map((m) => (
            <li key={m.id}><span className="text-fg">#{m.journal_entries.entry_number} · {f.date(m.journal_entries.entry_date)} · {m.journal_entries.description}</span>
              <span className="text-muted"> · {sourceLabel(m.journal_entries.source, locale)} · {money(m.debit_cents - m.credit_cents)}</span></li>))}</ul>
          {access.manage && !line.reconciliation_id && (
            <details><summary className="cursor-pointer text-sm font-semibold text-accent">{tr('Deshacer emparejamiento', 'Undo match')}</summary>
              <form action={unmatch} className="mt-2 flex flex-col gap-2 sm:flex-row"><input type="hidden" name="group_id" value={activeGroup} /><input type="hidden" name="back" value={back} />
                <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" /><SubmitButton className="w-full sm:w-auto">{tr('Deshacer', 'Undo')}</SubmitButton></form></details>
          )}
          {line.reconciliation_id && <p className="text-xs text-muted">{tr('Bloqueado: pertenece a una conciliación cerrada.', 'Locked: it belongs to a closed reconciliation.')}</p>}
        </section>
      )}

      {line.status === 'unmatched' && access.manage && (
        <>
          <section className="card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Sugerencias', 'Suggestions')}</h2>
            {suggestions.length === 0 && <p className="text-sm text-muted">{tr('Ninguna partida del libro coincide. Empareja a mano o registra el movimiento abajo.', 'No ledger item matches. Match by hand or post the line below.')}</p>}
            <ul className="space-y-2">
              {suggestions.map((s, i) => (
                <li key={i} className="flex flex-col gap-2 rounded-xl border border-line/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="text-fg">{s.confidence > 0 ? <span className={`mr-2 font-bold ${s.confidence >= 95 ? 'text-green-300' : 'text-amber-300'}`}>{s.confidence}%</span> : null}{reasonLabel(s.reason, locale)}
                      {s.ambiguous && <span className="ml-2 badge-warning">{tr('Ambigua: confirma a mano', 'Ambiguous: confirm by hand')}</span>}</p>
                    {s.journal_line_ids.map((j) => { const b = byId.get(j); return b ? <p key={j} className="text-xs text-muted">#{b.entry_number} · {f.date(b.entry_date)} · {b.description} · {sourceLabel(b.source, locale)} · {money(b.amount_cents)}</p> : null })}
                  </div>
                  {s.journal_line_ids.length > 0 && (
                    <form action={matchLines}><input type="hidden" name="bank_line" value={id} />{s.journal_line_ids.map((j) => <input key={j} type="hidden" name="journal_line" value={j} />)}
                      <input type="hidden" name="method" value="suggestion" /><input type="hidden" name="confidence" value={s.confidence} /><input type="hidden" name="back" value={back} />
                      <button type="submit" className="btn-primary btn-sm">{tr('Confirmar', 'Confirm')}</button></form>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Emparejar a mano', 'Match by hand')}</h2>
            <p className="text-xs text-muted">{tr('Marca una o varias partidas del libro (y, si hace falta, otros movimientos del banco). Las sumas deben coincidir exactamente.', 'Tick one or more ledger items (and other bank lines if needed). The sums must match exactly.')}</p>
            <form action={matchLines} className="space-y-3">
              <input type="hidden" name="bank_line" value={id} /><input type="hidden" name="back" value={back} />
              <fieldset className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-line/70 p-3">
                <legend className="px-1 text-xs font-bold uppercase tracking-wide text-muted">{tr('Partidas del libro (±45 días)', 'Ledger items (±45 days)')}</legend>
                {open.map((j) => (
                  <label key={j.journal_line_id} className="flex items-start gap-2 text-sm"><input type="checkbox" name="journal_line" value={j.journal_line_id} className="mt-1" />
                    <span><span className="tabular-nums text-fg">{money(j.amount_cents)}</span> · {f.date(j.entry_date)} · #{j.entry_number} {j.description}<span className="text-xs text-muted"> · {sourceLabel(j.source, locale)}{j.reference ? ` · ${j.reference}` : ''}</span></span></label>
                ))}
                {open.length === 0 && <p className="text-sm text-muted">{tr('Sin partidas abiertas en esa ventana.', 'No open items in that window.')}</p>}
              </fieldset>
              {((others ?? []) as unknown[]).length > 0 && (
                <fieldset className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line/70 p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-wide text-muted">{tr('Otros movimientos del banco a incluir', 'Other bank lines to include')}</legend>
                  {((others ?? []) as { id: string; txn_date: string; description: string; amount_cents: number }[]).map((o) => (
                    <label key={o.id} className="flex items-start gap-2 text-sm"><input type="checkbox" name="bank_line" value={o.id} className="mt-1" /><span><span className="tabular-nums">{money(o.amount_cents)}</span> · {f.date(o.txn_date)} · {o.description}</span></label>
                  ))}
                </fieldset>
              )}
              <input name="note" maxLength={300} placeholder={tr('Nota (opcional)', 'Note (optional)')} className="field" />
              <SubmitButton className="w-full sm:w-auto">{tr('Emparejar seleccionadas', 'Match selected')}</SubmitButton>
            </form>
          </section>

          {access.post && (
            <section className="card space-y-3 p-5">
              <h2 className="font-display text-lg font-semibold text-fg">{tr('No está en los libros: registrar', 'Not in the books: post it')}</h2>
              <p className="text-xs text-muted">{tr('Comisiones, intereses, transferencias entre cuentas o movimientos desconocidos: se registra un asiento balanceado entre esta cuenta y la elegida, y queda emparejado. No modifica ingresos ni gastos ya registrados.',
                'Fees, interest, transfers between accounts or unknown items: a balanced entry between this account and the chosen one is posted and matched. It does not change revenue or expenses already recorded.')}</p>
              <form action={postBankLine} className="grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="bank_line_id" value={id} /><input type="hidden" name="back" value={back} />
                <label className="text-sm"><span className="field-label">{tr('Cuenta contrapartida', 'Counter account')}</span>
                  <select name="counter_account_id" required defaultValue={counterAccounts.find((a) => a.code === '6500')?.id ?? ''} className="field">
                    <option value="" disabled>—</option>{counterAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {accountName(a, locale)}</option>)}</select></label>
                <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Descripción del asiento', 'Entry description')}</span>
                  <input name="description" required minLength={3} maxLength={300} defaultValue={line.description} className="field" /></label>
                <div><SubmitButton>{tr('Registrar y emparejar', 'Post and match')}</SubmitButton></div>
              </form>
            </section>
          )}
        </>
      )}

      <section className="card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold text-fg">{tr('Detalle e historial', 'Detail and history')}</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(line.raw ?? {}).map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="break-words text-slate-200">{v}</dd></div>)}</dl>
        <ul className="space-y-1 pt-2 text-sm">{((groupData ?? []) as { id: string; method: string; confidence: number | null; created_by: string | null; created_at: string; voided_at: string | null; void_reason: string | null }[]).map((g) => (
          <li key={g.id} className={g.voided_at ? 'text-muted line-through' : 'text-fg'}>{tr('Emparejado', 'Matched')} ({g.method}{g.confidence !== null ? ` ${g.confidence}%` : ''}) · {name(g.created_by)} · {f.dateTime(g.created_at)}
            {g.voided_at && <span className="block text-xs no-underline">{tr('Deshecho', 'Undone')} · {g.void_reason}</span>}</li>))}</ul>
      </section>
    </div>
  )
}

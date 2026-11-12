import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { AttachmentUploader } from '@/components/attachment-uploader'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { canApproveAmount, categoryName, daysUntil, eventLabel, methodLabel, PAY_METHODS, payablesMessage, statusLabel, statusTone,
  type Bill, type Category } from '@/lib/finance/payables'
import { accountName, sourceLabel } from '@/lib/finance/ledger'
import { centsToInput, toCents } from '@/lib/finance/money'
import { approveBill, deleteDraft, payBill, rejectBill, removeAttachment, scheduleBill, submitBill, voidBill, voidPayment } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'

type Payment = { id: string; paid_on: string; amount_cents: number; account_id: string; method: string | null; reference: string | null; created_by: string | null;
  created_at: string; voided_at: string | null; voided_by: string | null; void_reason: string | null }
type Attachment = { id: string; file_name: string; content_type: string; size_bytes: number; uploaded_by: string | null; created_at: string }
type Event = { id: number; action: string; details: Record<string, unknown>; actor: string | null; created_at: string }

/** One expense / vendor bill: lines, approval, payments, attachments, ledger entries and history. */
export default async function BillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, p] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, today, supabase, user, companyId, access } = await payablesPage()
  if (!access.create && !access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: b } = await supabase.from('bills').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const bill = b as Bill | null
  if (!bill) notFound()
  const [{ data: vendor }, { data: lineData }, { data: cats }, { data: payData }, { data: attData }, { data: evData }, { data: members }, { data: accts }, { data: entries }, { data: settings }] = await Promise.all([
    supabase.from('vendors').select('id, name').eq('id', bill.vendor_id).maybeSingle(),
    supabase.from('bill_lines').select('line_no, category_id, description, amount_cents').eq('bill_id', id).order('line_no'),
    supabase.from('expense_categories').select('id, name, name_en, account_id, status').eq('company_id', companyId),
    supabase.from('bill_payments').select('*').eq('bill_id', id).order('created_at'),
    supabase.from('bill_attachments').select('id, file_name, content_type, size_bytes, uploaded_by, created_at').eq('bill_id', id).order('created_at'),
    supabase.from('payables_events').select('id, action, details, actor, created_at').eq('entity', 'bills').eq('entity_id', id).order('id', { ascending: false }),
    supabase.rpc('company_members', { target: companyId }),
    supabase.from('ledger_accounts').select('id, code, name, name_en, type, status, system_key').eq('company_id', companyId).eq('type', 'asset').eq('status', 'active').order('code'),
    supabase.from('journal_entries').select('id, entry_number, entry_date, source, total_cents').eq('company_id', companyId).in('source', ['bill', 'bill_void']).eq('source_id', id),
    supabase.from('payables_settings').select('allow_self_approval').eq('company_id', companyId).maybeSingle(),
  ])
  const { data: role } = await supabase.rpc('payables_role', { target: companyId })
  const categories = new Map(((cats ?? []) as Category[]).map((c) => [c.id, c]))
  const payments = (payData ?? []) as Payment[]
  const attachments = (attData ?? []) as Attachment[]
  const events = (evData ?? []) as Event[]
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const name = (uid: string | null) => (uid ? who.get(uid) || tr('usuario', 'user') : tr('Sistema', 'System'))
  // Cash or the company's own asset accounts (bank…); the database checks it again.
  const payAccounts = ((accts ?? []) as { id: string; code: string; name: string; name_en: string | null; system_key: string | null }[])
    .filter((a) => a.system_key === null || a.system_key === 'cash')
  const accountLabel = (aid: string) => { const a = payAccounts.find((x) => x.id === aid); return a ? `${a.code} · ${accountName(a, locale)}` : '—' }
  // Ledger entries of this bill and of its payments.
  const { data: payEntries } = payments.length
    ? await supabase.from('journal_entries').select('id, entry_number, entry_date, source, total_cents').eq('company_id', companyId)
        .in('source', ['bill_payment', 'bill_payment_void']).in('source_id', payments.map((x) => x.id))
    : { data: [] }
  const ledger = [...((entries ?? []) as { id: string; entry_number: number; entry_date: string; source: string; total_cents: number }[]),
    ...((payEntries ?? []) as { id: string; entry_number: number; entry_date: string; source: string; total_cents: number }[])]
    .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).sort((a, c) => a.entry_number - c.entry_number)

  const open = toCents(bill.total_cents) - toCents(bill.paid_cents)
  const mine = bill.created_by === user.id
  const canEdit = bill.status === 'draft' && (access.manage || mine)
  const selfBlocked = (bill.created_by === user.id || bill.submitted_by === user.id) && role !== 'owner' && !(settings as { allow_self_approval?: boolean } | null)?.allow_self_approval
  const canApprove = bill.status === 'pending_approval' && canApproveAmount(access, bill.total_cents) && !selfBlocked
  const payable = ['approved', 'scheduled', 'partially_paid'].includes(bill.status) && access.pay
  const due = daysUntil(bill.due_date, today)
  const done: Record<string, string> = {
    saved: tr('Borrador guardado.', 'Draft saved.'), submitted: tr('Enviado a aprobación.', 'Submitted for approval.'),
    approved: tr('Aprobado y registrado en el libro mayor.', 'Approved and posted to the ledger.'), rejected: tr('Devuelto a borrador.', 'Returned to draft.'),
    scheduled: tr('Pago programado.', 'Payment scheduled.'), unscheduled: tr('Programación quitada.', 'Schedule removed.'),
    paid: tr('Pago registrado; cuentas por pagar reducidas.', 'Payment recorded; accounts payable reduced.'), payment_voided: tr('Pago anulado con reversión.', 'Payment voided with a reversal.'),
    voided: tr('Gasto anulado.', 'Expense voided.'), attachment_removed: tr('Adjunto quitado.', 'Attachment removed.'),
  }
  const back = `/payables/${id}`

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={<>{(vendor as { name?: string } | null)?.name ?? '—'} · {money(bill.total_cents)}</>}
        description={bill.description}
        actions={<span className={statusTone(bill.status)}>{statusLabel(bill.status, locale)}</span>} />
      <PayablesNav tr={tr} current="/payables" full={access.view} />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <section className="card overflow-hidden">
            <dl className="grid gap-4 border-b border-line p-5 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">{tr('Fecha', 'Date')}</dt><dd className="text-fg">{f.date(bill.bill_date)}</dd></div>
              <div><dt className="text-muted">{tr('Vence', 'Due')}</dt><dd className={due !== null && due < 0 && open > 0n && bill.status !== 'voided' ? 'text-red-300' : 'text-fg'}>{bill.due_date ? f.date(bill.due_date) : '—'}</dd></div>
              <div><dt className="text-muted">{tr('Factura del proveedor', 'Vendor invoice')}</dt><dd className="text-fg">{bill.vendor_invoice_number ?? '—'}</dd></div>
              <div><dt className="text-muted">{tr('Pagado', 'Paid')}</dt><dd className="tabular-nums text-fg">{money(bill.paid_cents)}</dd></div>
              <div><dt className="text-muted">{tr('Saldo', 'Balance')}</dt><dd className="font-semibold tabular-nums text-fg">{bill.status === 'voided' ? '—' : money(open)}</dd></div>
              {bill.scheduled_for && <div><dt className="text-muted">{tr('Pago programado', 'Scheduled payment')}</dt><dd className="text-fg">{f.date(bill.scheduled_for)}</dd></div>}
            </dl>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-2">{tr('Categoría', 'Category')}</th><th className="px-5 py-2">{tr('Detalle', 'Detail')}</th><th className="px-5 py-2 text-right">{tr('Importe', 'Amount')}</th></tr></thead>
                <tbody className="divide-y divide-line/60">
                  {((lineData ?? []) as { line_no: number; category_id: string; description: string | null; amount_cents: number }[]).map((l) => {
                    const c = categories.get(l.category_id)
                    return <tr key={l.line_no}><td className="px-5 py-2 text-fg">{c ? categoryName(c, locale) : '—'}</td><td className="px-5 py-2 text-muted">{l.description ?? ''}</td><td className="px-5 py-2 text-right tabular-nums">{money(l.amount_cents)}</td></tr>
                  })}
                </tbody>
              </table>
            </div>
            {bill.notes && <p className="border-t border-line p-5 text-sm text-muted">{bill.notes}</p>}
            {bill.rejection_reason && bill.status === 'draft' && <p className="border-t border-line p-5 text-sm text-amber-300">{tr('Devuelto:', 'Returned:')} {bill.rejection_reason}</p>}
            {bill.void_reason && <p className="border-t border-line p-5 text-sm text-red-300">{tr('Anulado:', 'Voided:')} {bill.void_reason}</p>}
          </section>

          <section className="card space-y-4 p-5" aria-labelledby="pay-title">
            <h2 id="pay-title" className="font-display text-lg font-semibold text-fg">{tr('Pagos', 'Payments')}</h2>
            {payments.length === 0 && <p className="text-sm text-muted">{tr('Sin pagos.', 'No payments.')}</p>}
            <ul className="divide-y divide-line/60">
              {payments.map((x) => (
                <li key={x.id} className="space-y-2 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={x.voided_at ? 'text-muted line-through' : 'text-fg'}>{f.date(x.paid_on)} · {methodLabel(x.method, locale)} · {accountLabel(x.account_id)}{x.reference ? ` · ${x.reference}` : ''}</span>
                    <span className="font-semibold tabular-nums">{money(x.amount_cents)}</span>
                  </div>
                  {x.voided_at
                    ? <p className="text-xs text-red-300">{tr('Anulado', 'Voided')} · {name(x.voided_by)} · {x.void_reason}</p>
                    : access.pay && (
                      <details><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Anular pago', 'Void payment')}</summary>
                        <form action={voidPayment} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                          <input type="hidden" name="payment_id" value={x.id} /><input type="hidden" name="back" value={back} />
                          <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" />
                          <SubmitButton className="w-full sm:w-auto">{tr('Anular con reversión', 'Void with reversal')}</SubmitButton>
                        </form></details>
                    )}
                </li>
              ))}
            </ul>
            {payable && open > 0n && (
              <form action={payBill} className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="idempotency_key" value={randomUUID()} />
                <label className="text-sm"><span className="field-label">{tr('Importe', 'Amount')}</span>
                  <input name="amount" required inputMode="decimal" defaultValue={centsToInput(open)} className="field text-right tabular-nums" /></label>
                <label className="text-sm"><span className="field-label">{tr('Fecha del pago', 'Payment date')}</span>
                  <input type="date" name="paid_on" required defaultValue={today} className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Pagado desde', 'Paid from')}</span>
                  <select name="account_id" required className="field">{payAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {accountName(a, locale)}</option>)}</select></label>
                <label className="text-sm"><span className="field-label">{tr('Método', 'Method')}</span>
                  <select name="method" className="field">{PAY_METHODS.map((m) => <option key={m} value={m}>{methodLabel(m, locale)}</option>)}</select></label>
                <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Referencia (cheque, confirmación)', 'Reference (check, confirmation)')}</span>
                  <input name="reference" maxLength={100} className="field" /></label>
                <div className="sm:col-span-2"><SubmitButton>{tr('Registrar pago', 'Record payment')}</SubmitButton></div>
              </form>
            )}
          </section>

          <section className="card space-y-3 p-5" aria-labelledby="att-title">
            <h2 id="att-title" className="font-display text-lg font-semibold text-fg">{tr('Adjuntos (recibos y facturas)', 'Attachments (receipts and invoices)')}</h2>
            {attachments.length === 0 && <p className="text-sm text-muted">{tr('Sin adjuntos.', 'No attachments.')}</p>}
            <ul className="space-y-2">
              {attachments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <a href={`/payables/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-accent">{a.file_name}</a>
                  <span className="text-xs text-muted">{Math.max(1, Math.round(a.size_bytes / 1024))} KB · {name(a.uploaded_by)} · {f.dateTime(a.created_at)}</span>
                  {bill.status === 'draft' && (access.manage || mine) && (
                    <form action={removeAttachment}><input type="hidden" name="id" value={id} /><input type="hidden" name="attachment_id" value={a.id} />
                      <button type="submit" className="btn-danger btn-sm">{tr('Quitar', 'Remove')}</button></form>
                  )}
                </li>
              ))}
            </ul>
            {bill.status !== 'voided' && (access.manage || mine || access.view) && (
              <AttachmentUploader companyId={companyId} billId={id} copy={{
                label: tr('Subir PDF o imagen', 'Upload PDF or image'), uploading: tr('Subiendo…', 'Uploading…'), done: tr('Adjunto guardado.', 'Attachment saved.'),
                fallback: payablesMessage('save', locale) ?? '', errors: {
                  attachment_type: payablesMessage('attachment_type', locale) ?? '', attachment_size: payablesMessage('attachment_size', locale) ?? '',
                  forbidden: payablesMessage('forbidden', locale) ?? '', bill_voided: payablesMessage('bill_voided', locale) ?? '',
                  attachment_file_missing: payablesMessage('attachment_file_missing', locale) ?? '' } }} />
            )}
            <p className="text-xs text-muted">{tr('Privados de tu empresa. Desde que el gasto se envía, sus adjuntos se conservan como evidencia.', 'Private to your company. Once the expense is submitted, its attachments are kept as evidence.')}</p>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card space-y-3 p-5" aria-labelledby="actions-title">
            <h2 id="actions-title" className="font-display text-lg font-semibold text-fg">{tr('Acciones', 'Actions')}</h2>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Link href={`/payables/${id}/edit`} className="btn-secondary btn-sm">{tr('Editar', 'Edit')}</Link>
                <form action={submitBill}><input type="hidden" name="id" value={id} /><button type="submit" className="btn-primary btn-sm">{tr('Enviar a aprobación', 'Submit for approval')}</button></form>
                <form action={deleteDraft}><input type="hidden" name="id" value={id} /><button type="submit" className="btn-danger btn-sm">{tr('Eliminar borrador', 'Delete draft')}</button></form>
              </div>
            )}
            {bill.status === 'pending_approval' && (
              <>
                {canApprove
                  ? <form action={approveBill}><input type="hidden" name="id" value={id} /><SubmitButton>{tr('Aprobar y registrar', 'Approve and post')}</SubmitButton></form>
                  : <p className="text-sm text-muted">{selfBlocked ? payablesMessage('self_approval_forbidden', locale)
                      : access.approvalLimit === -1 ? payablesMessage('approval_forbidden', locale) : payablesMessage('approval_limit_exceeded', locale)}</p>}
                {access.approvalLimit !== -1 && (
                  <details><summary className="cursor-pointer text-sm font-semibold text-accent">{tr('Devolver a borrador', 'Return to draft')}</summary>
                    <form action={rejectBill} className="mt-2 space-y-2"><input type="hidden" name="id" value={id} />
                      <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" />
                      <SubmitButton>{tr('Devolver', 'Return')}</SubmitButton></form></details>
                )}
              </>
            )}
            {access.pay && ['approved', 'scheduled', 'partially_paid'].includes(bill.status) && (
              <form action={scheduleBill} className="flex flex-col gap-2 sm:flex-row sm:items-end"><input type="hidden" name="id" value={id} />
                <label className="flex-1 text-sm"><span className="field-label">{tr('Programar pago para', 'Schedule payment on')}</span>
                  <input type="date" name="pay_on" min={today} defaultValue={bill.scheduled_for ?? ''} className="field" /></label>
                <button type="submit" className="btn-secondary">{tr('Guardar', 'Save')}</button></form>
            )}
            {bill.status !== 'voided' && Number(bill.paid_cents) === 0 && (access.manage || (bill.status === 'draft' && mine)) && (
              <details><summary className="cursor-pointer text-sm font-semibold text-red-300">{tr('Anular gasto', 'Void expense')}</summary>
                <form action={voidBill} className="mt-2 space-y-2"><input type="hidden" name="id" value={id} />
                  <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" />
                  <p className="text-xs text-muted">{tr('Si estaba aprobado se publica una reversión; el asiento original se conserva.', 'If it was approved a reversal is posted; the original entry is kept.')}</p>
                  <SubmitButton>{tr('Anular', 'Void')}</SubmitButton></form></details>
            )}
            {bill.status === 'paid' && <p className="text-sm text-green-300">{tr('Pagado por completo.', 'Fully paid.')}</p>}
          </section>

          {access.view && ledger.length > 0 && (
            <section className="card space-y-2 p-5" aria-labelledby="ledger-title">
              <h2 id="ledger-title" className="font-display text-lg font-semibold text-fg">{tr('Asientos contables', 'Ledger entries')}</h2>
              <ul className="space-y-1 text-sm">
                {ledger.map((e) => (
                  <li key={e.id}><Link href={`/accounting/journal?from=${e.entry_date}&to=${e.entry_date}#e-${e.id}`} className="text-accent">#{e.entry_number}</Link>
                    <span className="text-muted"> · {f.date(e.entry_date)} · {sourceLabel(e.source, locale)} · {money(e.total_cents)}</span></li>
                ))}
              </ul>
            </section>
          )}

          <section className="card space-y-2 p-5" aria-labelledby="history-title">
            <h2 id="history-title" className="font-display text-lg font-semibold text-fg">{tr('Historial', 'History')}</h2>
            <ul className="space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id}><span className="text-fg">{eventLabel(e.action, locale)}</span>
                  <span className="block text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}{typeof e.details?.reason === 'string' ? ` · ${e.details.reason}` : ''}</span></li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

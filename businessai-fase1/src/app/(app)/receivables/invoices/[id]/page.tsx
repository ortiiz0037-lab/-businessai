import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { arMessage, arStatusLabel, arStatusTone, bucketLabel, COLLECTION_STATUSES, collectionLabel, eventLabelAR, offsetLabel, promiseLabel,
  reminderLabel, renderReminder, type InvoiceBalance, type Promise_, type Reminder } from '@/lib/finance/receivables'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { centsToInput } from '@/lib/finance/money'
import { emailConfigured } from '@/lib/email/resend'
import { addCollectionNote, addPromise, cancelPromise, markReminder, sendReminder, setCollectionStatus, voidClientPayment } from '@/app/actions/receivables'

export const dynamic = 'force-dynamic'

type Payment = { id: string; amount: number | string; payment_method: string | null; reference: string | null; paid_at: string; voided_at?: string | null; voided_by?: string | null; void_reason?: string | null }

/** Collection file of one invoice: balance, payments (voids), status, notes, promises, reminders and history. */
export default async function InvoiceCollectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, today, supabase, companyId, access, who } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: balData } = await supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null })
  const b = ((balData ?? []) as InvoiceBalance[]).find((r) => r.document_id === id)
  if (!b) notFound()
  const [{ data: client }, { data: payData }, { data: notes }, { data: promData }, { data: remData }, { data: evData }, { data: settings }, { data: co }, name] = await Promise.all([
    b.client_id ? supabase.from('clients').select('id, name, email').eq('id', b.client_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('payments').select('*').eq('document_id', id).order('paid_at'),
    supabase.from('collection_notes').select('*').eq('document_id', id).order('created_at', { ascending: false }),
    supabase.from('payment_promises').select('*').eq('document_id', id).order('created_at', { ascending: false }),
    supabase.from('collection_reminders').select('*').eq('document_id', id).order('scheduled_for', { ascending: false }),
    supabase.from('receivables_events').select('*').eq('document_id', id).order('id', { ascending: false }).limit(50),
    supabase.from('collection_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    who(),
  ])
  const c = client as { id: string; name: string; email: string | null } | null
  const payments = (payData ?? []) as Payment[]
  const promises = (promData ?? []) as Promise_[]
  const reminders = (remData ?? []) as Reminder[]
  const events = (evData ?? []) as { id: number; action: string; details: Record<string, unknown>; actor: string | null; created_at: string }[]
  const s = settings as { message_es?: string | null; message_en?: string | null; sender_name?: string | null; language?: 'es' | 'en' } | null
  const lang = s?.language ?? locale
  const preview = renderReminder({ locale: lang, template: lang === 'en' ? s?.message_en : s?.message_es, client: c?.name ?? '', invoice: b.document_number,
    balanceCents: b.balance_cents, due: f.date(b.due_date ?? b.issue_date), company: s?.sender_name || (co as { name?: string } | null)?.name || '' })
  const back = `/receivables/invoices/${id}`
  const canEmail = emailConfigured()
  const open = Number(b.balance_cents) > 0
  const done: Record<string, string> = { status: tr('Estado de cobro actualizado.', 'Collection status updated.'), note: tr('Nota añadida.', 'Note added.'),
    promise: tr('Promesa registrada.', 'Promise recorded.'), promise_cancelled: tr('Promesa cancelada.', 'Promise cancelled.'),
    payment_voided: tr('Pago anulado con reversión; el balance se restableció.', 'Payment voided with a reversal; the balance was restored.'),
    reminder_sent: tr('Recordatorio enviado por email.', 'Reminder sent by email.'), reminder_marked: tr('Registrado como contactado por otro medio.', 'Recorded as contacted another way.'),
    reminder_cancelled: tr('Recordatorio cancelado.', 'Reminder cancelled.') }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Cuentas por cobrar', 'Receivables')} title={<>{b.document_number} · {money(b.balance_cents)}</>}
        description={<>{c ? <Link href={`/receivables/clients/${c.id}`} className="text-accent">{c.name}</Link> : tr('Sin cliente', 'No client')} · {tr('total', 'total')} {money(b.total_cents)} · {tr('pagado', 'paid')} {money(b.paid_cents)}</>}
        actions={<><span className={arStatusTone(b.ar_status)}>{arStatusLabel(b.ar_status, locale)}</span><Link href={`/documents/${id}`} className="btn-secondary btn-sm">{tr('Ver factura', 'View invoice')}</Link></>} />
      <ReceivablesNav tr={tr} current="/receivables" />
      <Flash done={sp.done ? done[sp.done] : null} error={arMessage(sp.error, locale)} />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <section className="card grid gap-4 p-5 text-sm sm:grid-cols-4">
            <div><p className="text-muted">{tr('Emitida', 'Issued')}</p><p className="text-fg">{f.date(b.issue_date)}</p></div>
            <div><p className="text-muted">{tr('Vence', 'Due')}</p><p className={b.days_past_due > 0 && open ? 'text-red-300' : 'text-fg'}>{f.date(b.due_date ?? b.issue_date)}</p></div>
            <div><p className="text-muted">{tr('Días vencida', 'Days overdue')}</p><p className="text-fg">{open && b.days_past_due > 0 ? b.days_past_due : '—'}</p></div>
            <div><p className="text-muted">{tr('Antigüedad', 'Aging')}</p><p className="text-fg">{b.bucket ? bucketLabel(b.bucket, locale) : '—'}</p></div>
          </section>

          <section className="card space-y-3 p-5" aria-labelledby="pay-title">
            <h2 id="pay-title" className="font-display text-lg font-semibold text-fg">{tr('Pagos', 'Payments')}</h2>
            {payments.length === 0 ? <p className="text-sm text-muted">{tr('Sin pagos.', 'No payments.')} {open && <Link href={`/documents/${id}`} className="text-accent">{tr('Registrar un pago en la factura', 'Record a payment on the invoice')}</Link>}</p> : (
              <ul className="divide-y divide-line/60">
                {payments.map((p) => (
                  <li key={p.id} className="space-y-2 py-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className={p.voided_at ? 'text-muted line-through' : 'text-fg'}>{f.date(p.paid_at)} · {paymentMethodLabel(p.payment_method, locale)}{p.reference ? ` · ${p.reference}` : ''}</span>
                      <span className="font-semibold tabular-nums">{money(Math.round(Number(p.amount) * 100))}</span>
                    </div>
                    {p.voided_at ? <p className="text-xs text-red-300">{tr('Anulado', 'Voided')} · {name(p.voided_by ?? null)} · {f.dateTime(p.voided_at)} · {p.void_reason}</p>
                      : access.voidPayments && (
                        <details><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Anular pago (cheque devuelto, error)', 'Void payment (bounced check, error)')}</summary>
                          <form action={voidClientPayment} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                            <input type="hidden" name="payment_id" value={p.id} /><input type="hidden" name="back" value={back} />
                            <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" />
                            <SubmitButton className="w-full sm:w-auto">{tr('Anular con reversión', 'Void with reversal')}</SubmitButton>
                          </form>
                          <p className="mt-1 text-xs text-muted">{tr('El pago se conserva como historial; se publica una reversión y el balance vuelve a la factura.', 'The payment is kept as history; a reversal is posted and the balance returns to the invoice.')}</p>
                        </details>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card space-y-3 p-5" aria-labelledby="notes-title">
            <h2 id="notes-title" className="font-display text-lg font-semibold text-fg">{tr('Notas internas', 'Internal notes')}</h2>
            {access.manage && (
              <form action={addCollectionNote} className="space-y-2">
                <input type="hidden" name="document_id" value={id} /><input type="hidden" name="back" value={back} />
                <textarea name="body" required maxLength={2000} rows={2} placeholder={tr('Llamada, acuerdo, detalle… (no la ve el cliente)', 'Call, agreement, detail… (the client does not see it)')} className="field" />
                <SubmitButton className="w-full sm:w-auto">{tr('Añadir nota', 'Add note')}</SubmitButton>
              </form>
            )}
            <ul className="space-y-2 text-sm">
              {((notes ?? []) as { id: number; body: string; created_by: string | null; created_at: string }[]).map((n) => (
                <li key={n.id} className="rounded-xl border border-line/70 p-3"><p className="whitespace-pre-wrap text-slate-200">{n.body}</p><p className="mt-1 text-xs text-muted">{name(n.created_by)} · {f.dateTime(n.created_at)}</p></li>
              ))}
            </ul>
          </section>

          <section className="card space-y-3 p-5" aria-labelledby="rem-title">
            <h2 id="rem-title" className="font-display text-lg font-semibold text-fg">{tr('Recordatorios', 'Reminders')}</h2>
            {!canEmail && <p className="alert-info p-3 text-xs">{tr('El envío por email no está configurado todavía: los recordatorios quedan preparados con su texto y puedes registrarlos como contactados por otro medio.',
              'Email sending is not configured yet: reminders are prepared with their text and you can record them as contacted another way.')}</p>}
            {reminders.length === 0 ? <p className="text-sm text-muted">{tr('Ninguno preparado. Se preparan al actualizar el seguimiento, según los días configurados.', 'None prepared. They are prepared when the follow-up is refreshed, on the configured days.')}</p> : (
              <ul className="divide-y divide-line/60 text-sm">
                {reminders.map((r) => (
                  <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <span><span className="text-fg">{f.date(r.scheduled_for)} · {offsetLabel(r.offset_days, locale)}</span>
                      <span className="block text-xs text-muted">{reminderLabel(r.status, locale)}{r.to_email ? ` · ${r.to_email}` : ''}{r.last_error ? ` · ${r.last_error}` : ''}</span></span>
                    {access.manage && ['pending', 'failed', 'no_email'].includes(r.status) && (
                      <span className="flex flex-wrap gap-2">
                        {r.to_email && canEmail && <form action={sendReminder}><input type="hidden" name="reminder_id" value={r.id} /><input type="hidden" name="back" value={back} />
                          <button type="submit" className="btn-primary btn-sm">{tr('Enviar email', 'Send email')}</button></form>}
                        <form action={markReminder}><input type="hidden" name="reminder_id" value={r.id} /><input type="hidden" name="status" value="sent_manual" /><input type="hidden" name="back" value={back} />
                          <button type="submit" className="btn-secondary btn-sm">{tr('Contactado por otro medio', 'Contacted another way')}</button></form>
                        <form action={markReminder}><input type="hidden" name="reminder_id" value={r.id} /><input type="hidden" name="status" value="cancelled" /><input type="hidden" name="back" value={back} />
                          <button type="submit" className="btn-secondary btn-sm">{tr('Cancelar', 'Cancel')}</button></form>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details className="rounded-xl border border-line/70 p-3"><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Vista previa del mensaje', 'Message preview')}</summary>
              <p className="mt-2 text-xs font-semibold text-fg">{preview.subject}</p><pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-slate-300">{preview.text}</pre></details>
          </section>
        </div>

        <aside className="space-y-6">
          {access.manage && (
            <section className="card space-y-3 p-5" aria-labelledby="status-title">
              <h2 id="status-title" className="font-display text-lg font-semibold text-fg">{tr('Estado de cobro', 'Collection status')}</h2>
              <form action={setCollectionStatus} className="flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="document_id" value={id} /><input type="hidden" name="back" value={back} />
                <select name="status" defaultValue={b.collection_status} className="field">{COLLECTION_STATUSES.map((x) => <option key={x} value={x}>{collectionLabel(x, locale)}</option>)}</select>
                <button type="submit" className="btn-secondary">{tr('Guardar', 'Save')}</button>
              </form>
              <p className="text-xs text-muted">{tr('En disputa o en pausa: no se preparan recordatorios.', 'Disputed or on hold: no reminders are prepared.')}</p>
            </section>
          )}
          <section className="card space-y-3 p-5" aria-labelledby="prom-title">
            <h2 id="prom-title" className="font-display text-lg font-semibold text-fg">{tr('Promesas de pago', 'Payment promises')}</h2>
            {access.manage && open && ['issued', 'overdue', 'partially_paid'].includes(b.ar_status) && (
              <form action={addPromise} className="grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="document_id" value={id} /><input type="hidden" name="back" value={back} />
                <label className="text-sm"><span className="field-label">{tr('Fecha prometida', 'Promised date')}</span><input type="date" name="promised_date" min={today} required className="field" /></label>
                <label className="text-sm"><span className="field-label">{tr('Importe', 'Amount')}</span><input name="amount" inputMode="decimal" required defaultValue={centsToInput(b.balance_cents)} className="field text-right" /></label>
                <input name="note" maxLength={500} placeholder={tr('Nota (opcional)', 'Note (optional)')} className="field sm:col-span-2" />
                <div className="sm:col-span-2"><SubmitButton>{tr('Registrar promesa', 'Record promise')}</SubmitButton></div>
              </form>
            )}
            <ul className="space-y-2 text-sm">
              {promises.map((p) => (
                <li key={p.id} className="rounded-xl border border-line/70 p-3">
                  <p className="text-fg">{money(p.amount_cents)} · {f.date(p.promised_date)} · <span className={p.status === 'kept' ? 'text-green-300' : p.status === 'broken' ? 'text-red-300' : 'text-slate-300'}>{promiseLabel(p.status, locale)}</span></p>
                  <p className="text-xs text-muted">{name(p.created_by)} · {f.dateTime(p.created_at)}{p.note ? ` · ${p.note}` : ''}{p.cancel_reason ? ` · ${p.cancel_reason}` : ''}</p>
                  {access.manage && p.status === 'pending' && (
                    <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-accent">{tr('Cancelar promesa', 'Cancel promise')}</summary>
                      <form action={cancelPromise} className="mt-2 flex flex-col gap-2"><input type="hidden" name="promise_id" value={p.id} /><input type="hidden" name="back" value={back} />
                        <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo', 'Reason')} className="field" />
                        <SubmitButton>{tr('Cancelar', 'Cancel')}</SubmitButton></form></details>
                  )}
                </li>
              ))}
              {promises.length === 0 && <li className="text-muted">{tr('Ninguna.', 'None.')}</li>}
            </ul>
            <p className="text-xs text-muted">{tr('Se marca cumplida sola cuando los pagos posteriores cubren el importe; incumplida si pasa la fecha.', 'Marked kept automatically when later payments cover the amount; broken when the date passes.')}</p>
          </section>
          <section className="card space-y-2 p-5" aria-labelledby="hist-title">
            <h2 id="hist-title" className="font-display text-lg font-semibold text-fg">{tr('Historial de cobro', 'Collection history')}</h2>
            <ul className="space-y-2 text-sm">
              {events.map((e) => <li key={e.id}><span className="text-fg">{eventLabelAR(e.action, locale)}</span>
                <span className="block text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}{typeof e.details?.reason === 'string' ? ` · ${e.details.reason}` : ''}{typeof e.details?.status === 'string' ? ` · ${collectionLabel(e.details.status, locale)}` : ''}</span></li>)}
              {events.length === 0 && <li className="text-muted">{tr('Sin actividad.', 'No activity.')}</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

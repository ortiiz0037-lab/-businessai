import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, StatCard } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { arMessage, arStatusLabel, arStatusTone, eventLabelAR, promiseLabel, type AgingRow, type InvoiceBalance, type Promise_ } from '@/lib/finance/receivables'
import { paymentMethodLabel } from '@/lib/documents/payments'
import { sumCents, toCents } from '@/lib/finance/money'
import { addCollectionNote } from '@/app/actions/receivables'

export const dynamic = 'force-dynamic'

/** Full receivables history of one client: invoices, payments (voids included), notes, promises and events. */
export default async function ClientReceivablesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access, who } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: client } = await supabase.from('clients').select('id, name, email, phone').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!client) notFound()
  const [{ data: balData }, { data: agingData }, { data: notes }, { data: promData }, { data: evData }, name] = await Promise.all([
    supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }),
    supabase.rpc('ar_aging', { target: companyId, as_of: null }),
    supabase.from('collection_notes').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('payment_promises').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('receivables_events').select('*').eq('client_id', id).order('id', { ascending: false }).limit(50),
    who(),
  ])
  const invoices = ((balData ?? []) as InvoiceBalance[]).filter((b) => b.client_id === id).sort((a, b) => b.issue_date.localeCompare(a.issue_date))
  const aging = ((agingData ?? []) as AgingRow[]).find((a) => a.client_id === id)
  const { data: payData } = invoices.length
    ? await supabase.from('payments').select('*').in('document_id', invoices.map((i) => i.document_id)).order('paid_at', { ascending: false })
    : { data: [] }
  const payments = (payData ?? []) as { id: string; document_id: string; amount: number | string; payment_method: string | null; paid_at: string; voided_at?: string | null; void_reason?: string | null }[]
  const number = new Map(invoices.map((i) => [i.document_id, i.document_number]))
  const promises = (promData ?? []) as Promise_[]
  const kept = promises.filter((p) => p.status === 'kept').length
  const broken = promises.filter((p) => p.status === 'broken').length
  const back = `/receivables/clients/${id}`
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Cuentas por cobrar', 'Receivables')} title={client.name} description={[client.email, client.phone].filter(Boolean).join(' · ') || undefined}
        actions={<Link href={`/clients/${id}`} className="btn-secondary btn-sm">{tr('Ficha del cliente', 'Client record')}</Link>} />
      <ReceivablesNav tr={tr} current="/receivables" />
      <Flash done={sp.done === 'note' ? tr('Nota añadida.', 'Note added.') : null} error={arMessage(sp.error, locale)} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="receipt" tone="gold" label={tr('Balance', 'Balance')} value={money(aging?.total_cents ?? 0)} />
        <StatCard icon="alert" tone="warning" label={tr('Vencido', 'Overdue')} value={money(aging?.overdue_cents ?? 0)} hint={aging?.oldest_days && aging.oldest_days > 0 ? tr(`más antiguo: ${aging.oldest_days} días`, `oldest: ${aging.oldest_days} days`) : undefined} />
        <StatCard icon="wallet" tone="success" label={tr('Cobrado (histórico)', 'Collected (all time)')} value={money(sumCents(payments.filter((p) => !p.voided_at).map((p) => Math.round(Number(p.amount) * 100))))} />
        <StatCard icon="check" label={tr('Promesas cumplidas / incumplidas', 'Promises kept / broken')} value={`${kept} / ${broken}`} />
      </div>
      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Facturas', 'Invoices')}</h2>
        <ul className="divide-y divide-line/60">
          {invoices.map((i) => (
            <li key={i.document_id}><Link href={`/receivables/invoices/${i.document_id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-white/[0.03]">
              <span>{i.document_number} · {f.date(i.issue_date)} · {tr('vence', 'due')} {f.date(i.due_date ?? i.issue_date)}</span>
              <span className="flex items-center gap-2"><span className={arStatusTone(i.ar_status)}>{arStatusLabel(i.ar_status, locale)}</span>
                <span className="tabular-nums">{money(i.total_cents)}</span>{toCents(i.balance_cents) > 0n && <span className="tabular-nums text-amber-300">{tr('saldo', 'bal.')} {money(i.balance_cents)}</span>}</span>
            </Link></li>
          ))}
          {invoices.length === 0 && <li className="px-5 py-4 text-sm text-muted">{tr('Sin facturas emitidas.', 'No issued invoices.')}</li>}
        </ul>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Pagos', 'Payments')}</h2>
          <ul className="divide-y divide-line/60 text-sm">
            {payments.map((p) => (
              <li key={p.id} className={`px-5 py-3 ${p.voided_at ? 'opacity-70' : ''}`}>
                <div className="flex justify-between gap-2"><span className={p.voided_at ? 'line-through' : ''}>{f.date(p.paid_at)} · {number.get(p.document_id)} · {paymentMethodLabel(p.payment_method, locale)}</span>
                  <span className="tabular-nums">{money(Math.round(Number(p.amount) * 100))}</span></div>
                {p.voided_at && <p className="text-xs text-red-300">{tr('Anulado', 'Voided')} · {p.void_reason}</p>}
              </li>
            ))}
            {payments.length === 0 && <li className="px-5 py-4 text-muted">{tr('Sin pagos.', 'No payments.')}</li>}
          </ul>
        </section>
        <section className="card space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Notas internas', 'Internal notes')}</h2>
          {access.manage && (
            <form action={addCollectionNote} className="space-y-2"><input type="hidden" name="client_id" value={id} /><input type="hidden" name="back" value={back} />
              <textarea name="body" required maxLength={2000} rows={2} className="field" placeholder={tr('Nota sobre el cliente', 'Note about the client')} />
              <SubmitButton className="w-full sm:w-auto">{tr('Añadir nota', 'Add note')}</SubmitButton></form>
          )}
          <ul className="space-y-2 text-sm">
            {((notes ?? []) as { id: number; body: string; document_id: string | null; created_by: string | null; created_at: string }[]).map((n) => (
              <li key={n.id} className="rounded-xl border border-line/70 p-3"><p className="whitespace-pre-wrap text-slate-200">{n.body}</p>
                <p className="mt-1 text-xs text-muted">{name(n.created_by)} · {f.dateTime(n.created_at)}{n.document_id ? ` · ${number.get(n.document_id) ?? ''}` : ''}</p></li>
            ))}
          </ul>
        </section>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-2 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Promesas de pago', 'Payment promises')}</h2>
          <ul className="space-y-1 text-sm">{promises.map((p) => <li key={p.id}>{number.get(p.document_id)} · {money(p.amount_cents)} · {f.date(p.promised_date)} · {promiseLabel(p.status, locale)}</li>)}
            {promises.length === 0 && <li className="text-muted">{tr('Ninguna.', 'None.')}</li>}</ul>
        </section>
        <section className="card space-y-2 p-5">
          <h2 className="font-display text-lg font-semibold text-fg">{tr('Historial de cobro', 'Collection history')}</h2>
          <ul className="space-y-2 text-sm">{((evData ?? []) as { id: number; action: string; document_id: string | null; actor: string | null; created_at: string }[]).map((e) => (
            <li key={e.id}><span className="text-fg">{eventLabelAR(e.action, locale)}</span><span className="block text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}{e.document_id ? ` · ${number.get(e.document_id) ?? ''}` : ''}</span></li>))}</ul>
        </section>
      </div>
    </div>
  )
}

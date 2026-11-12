import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { AgingBars, NoReceivablesAccess, ReceivablesNav } from '@/components/receivables-nav'
import { receivablesPage } from '@/lib/finance/receivables-page'
import { AR_STATUSES, arMessage, arStatusLabel, arStatusTone, BUCKETS, bucketLabel, collectionLabel, promiseLabel, reminderLabel,
  type InvoiceBalance, type Promise_, type Reminder } from '@/lib/finance/receivables'
import { sumCents, toCents } from '@/lib/finance/money'
import { refreshCollections } from '@/app/actions/receivables'

export const dynamic = 'force-dynamic'

/** Receivables dashboard: open, overdue, partially paid and collected; who owes; what to follow up. */
export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ status?: string; done?: string; error?: string; p?: string; r?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await receivablesPage()
  if (!access.view) return <NoReceivablesAccess tr={tr} unavailable={!access.available} />
  const monthStart = `${today.slice(0, 8)}01`
  const [{ data: balData, error }, { data: clientData }, { data: payData }, { data: promData }, { data: remData }] = await Promise.all([
    supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }),
    supabase.from('clients').select('id, name').eq('company_id', companyId),
    supabase.from('payments').select('*').eq('company_id', companyId).gte('paid_at', `${monthStart}T00:00:00-04:00`),
    supabase.from('payment_promises').select('*').eq('company_id', companyId).eq('status', 'pending').order('promised_date'),
    supabase.from('collection_reminders').select('*').eq('company_id', companyId).in('status', ['pending', 'failed', 'no_email']).order('scheduled_for'),
  ])
  if (error) return <NoReceivablesAccess tr={tr} unavailable />
  const rows = (balData ?? []) as InvoiceBalance[]
  const clients = new Map(((clientData ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
  const open = rows.filter((r) => toCents(r.balance_cents) > 0n)
  const overdue = open.filter((r) => r.days_past_due > 0)
  const partial = open.filter((r) => toCents(r.paid_cents) > 0n)
  const collected = sumCents(((payData ?? []) as { amount: number | string; voided_at?: string | null }[]).filter((p) => !p.voided_at).map((p) => Math.round(Number(p.amount) * 100)))
  const clientsOverdue = new Set(overdue.map((r) => r.client_id)).size
  const status = (AR_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status! : ''
  const list = (status ? rows.filter((r) => r.ar_status === status) : open).sort((a, b) => b.days_past_due - a.days_past_due).slice(0, 100)
  const promises = (promData ?? []) as Promise_[]
  const reminders = (remData ?? []) as Reminder[]
  const byDoc = new Map(rows.map((r) => [r.document_id, r]))
  const tone: Record<string, string> = { '0_30': 'bg-accent', '31_60': 'bg-amber-400', '61_90': 'bg-orange-500', '90_plus': 'bg-red-500' }
  const done: Record<string, string> = { refreshed: tr(`Seguimiento actualizado: ${sp.p ?? 0} promesas resueltas, ${sp.r ?? 0} recordatorios preparados.`, `Follow-up refreshed: ${sp.p ?? 0} promises resolved, ${sp.r ?? 0} reminders prepared.`) }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Cuentas por cobrar', 'Accounts receivable')}
        description={tr('Calculado de las facturas y los pagos, y conciliado con el libro mayor: no hay un registro paralelo.', 'Computed from invoices and payments, reconciled with the ledger: there is no parallel record.')}
        actions={access.manage ? <form action={refreshCollections}><SubmitButton className="w-full sm:w-auto">{tr('Actualizar seguimiento', 'Refresh follow-up')}</SubmitButton></form> : undefined} />
      <ReceivablesNav tr={tr} current="/receivables" />
      <Flash done={sp.done ? done[sp.done] : null} error={arMessage(sp.error, locale)} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="receipt" tone="gold" label={tr('Por cobrar', 'Receivable')} value={money(sumCents(open.map((r) => r.balance_cents)))} hint={tr(`${open.length} facturas con balance`, `${open.length} invoices with a balance`)} />
        <StatCard icon="alert" tone="warning" label={tr('Vencido', 'Overdue')} value={money(sumCents(overdue.map((r) => r.balance_cents)))} hint={tr(`${overdue.length} facturas · ${clientsOverdue} clientes`, `${overdue.length} invoices · ${clientsOverdue} clients`)} />
        <StatCard icon="clock" label={tr('Parcialmente pagadas', 'Partially paid')} value={String(partial.length)} hint={money(sumCents(partial.map((r) => r.balance_cents)))} />
        <StatCard icon="wallet" tone="success" label={tr('Cobrado este mes', 'Collected this month')} value={money(collected)} hint={tr('Pagos no anulados', 'Payments not voided')} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <section className="card space-y-4 p-5" aria-labelledby="aging-title">
          <div className="flex items-center justify-between gap-2">
            <h2 id="aging-title" className="font-display text-lg font-semibold text-fg">{tr('Antigüedad', 'Aging')}</h2>
            <Link href="/receivables/aging" className="text-sm font-semibold text-accent">{tr('Por cliente', 'By client')}</Link>
          </div>
          <AgingBars rows={BUCKETS.map((b) => {
            const cents = sumCents(open.filter((r) => r.bucket === b).map((r) => r.balance_cents))
            return { label: bucketLabel(b, locale), cents, value: money(cents), tone: tone[b] }
          })} />
          <p className="text-xs text-muted">{tr('Días desde el vencimiento (o la emisión si no hay vencimiento). 0–30 incluye lo que aún no vence.', 'Days since the due date (or issue date when there is none). 0–30 includes what is not due yet.')}</p>
        </section>

        <section className="card space-y-3 p-5" aria-labelledby="follow-title">
          <h2 id="follow-title" className="font-display text-lg font-semibold text-fg">{tr('Seguimiento', 'Follow-up')}</h2>
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted">{tr('Promesas pendientes', 'Pending promises')}</h3>
          {promises.length === 0 ? <p className="text-sm text-muted">{tr('Ninguna.', 'None.')}</p> : (
            <ul className="space-y-1 text-sm">{promises.slice(0, 8).map((p) => (
              <li key={p.id}><Link href={`/receivables/invoices/${p.document_id}`} className="text-accent">{byDoc.get(p.document_id)?.document_number ?? '—'}</Link>
                <span className="text-muted"> · {clients.get(p.client_id) ?? '—'} · {money(p.amount_cents)} · {f.date(p.promised_date)} · {promiseLabel(p.status, locale)}</span></li>
            ))}</ul>
          )}
          <h3 className="pt-2 text-xs font-bold uppercase tracking-wide text-muted">{tr('Recordatorios por atender', 'Reminders to handle')}</h3>
          {reminders.length === 0 ? <p className="text-sm text-muted">{tr('Ninguno.', 'None.')}</p> : (
            <ul className="space-y-1 text-sm">{reminders.slice(0, 8).map((r) => (
              <li key={r.id}><Link href={`/receivables/invoices/${r.document_id}`} className="text-accent">{byDoc.get(r.document_id)?.document_number ?? '—'}</Link>
                <span className="text-muted"> · {clients.get(r.client_id) ?? '—'} · {f.date(r.scheduled_for)} · {reminderLabel(r.status, locale)}</span></li>
            ))}</ul>
          )}
        </section>
      </div>

      <section className="card overflow-hidden" aria-labelledby="list-title">
        <div className="flex flex-col gap-3 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="list-title" className="font-display text-lg font-semibold text-fg">{status ? arStatusLabel(status, locale) : tr('Facturas con balance', 'Invoices with a balance')}</h2>
          <nav className="-mx-1 flex flex-wrap gap-2" aria-label={tr('Filtrar', 'Filter')}>
            {['', ...AR_STATUSES].map((s) => (
              <Link key={s || 'open'} href={s ? `/receivables?status=${s}` : '/receivables'} aria-current={status === s ? 'page' : undefined}
                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${status === s ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line text-slate-300'}`}>
                {s ? arStatusLabel(s, locale) : tr('Con balance', 'With balance')}</Link>
            ))}
          </nav>
        </div>
        {list.length === 0 ? <EmptyState icon="check" title={tr('Nada pendiente con este filtro', 'Nothing pending with this filter')} /> : (
          <ul className="divide-y divide-line/60">
            {list.map((r) => (
              <li key={r.document_id}>
                <Link href={`/receivables/invoices/${r.document_id}`} className="flex flex-col gap-2 px-5 py-3 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-fg">{r.document_number} · {(r.client_id && clients.get(r.client_id)) || tr('Sin cliente', 'No client')}</span>
                    <span className="block text-xs text-muted">{tr('Vence', 'Due')} {f.date(r.due_date ?? r.issue_date)}{r.days_past_due > 0 ? ` · ${tr(`${r.days_past_due} días vencida`, `${r.days_past_due} days overdue`)}` : ''}
                      {r.collection_status !== 'open' ? ` · ${collectionLabel(r.collection_status, locale)}` : ''}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {r.bucket && <span className="badge-neutral">{bucketLabel(r.bucket, locale)}</span>}
                    <span className={arStatusTone(r.ar_status)}>{arStatusLabel(r.ar_status, locale)}</span>
                    <span className="text-right font-semibold tabular-nums text-fg">{money(r.balance_cents)}<span className="block text-xs font-normal text-muted">{tr('de', 'of')} {money(r.total_cents)}</span></span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

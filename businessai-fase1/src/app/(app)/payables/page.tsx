import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { BILL_STATUSES, daysUntil, payablesMessage, statusLabel, statusTone, type Bill } from '@/lib/finance/payables'
import { sumCents, toCents } from '@/lib/finance/money'
import { searchTerm } from '@/lib/search'
import { initPayables } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'
const PAGE = 30
const OPEN = ['approved', 'scheduled', 'partially_paid']

/** Expenses and vendor bills: what is owed, what is due, what waits for approval. */
export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string; done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await payablesPage()
  if (!access.create && !access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const done: Record<string, string> = { initialized: tr('Módulo de gastos activado con categorías predeterminadas.', 'Expenses module activated with default categories.'),
    deleted: tr('Borrador eliminado.', 'Draft deleted.') }

  if (!access.initialized) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Gastos y cuentas por pagar', 'Expenses and payables')} />
        <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />
        <section className="card max-w-2xl space-y-4 p-6">
          <p className="text-sm leading-6 text-muted">{tr('Al activarlo se crean categorías de gasto ligadas al catálogo de cuentas y se activa la contabilidad si aún no lo está. Cada gasto aprobado y cada pago se registran en el libro mayor.',
            'Activating it creates expense categories linked to the chart of accounts and activates accounting if needed. Every approved expense and every payment is posted to the ledger.')}</p>
          {access.manage
            ? <form action={initPayables}><SubmitButton className="w-full sm:w-auto">{tr('Activar gastos', 'Activate expenses')}</SubmitButton></form>
            : <p className="text-sm text-muted">{tr('Pide al propietario o a un administrador que lo active.', 'Ask the owner or an admin to activate it.')}</p>}
        </section>
      </div>
    )
  }

  const status = (BILL_STATUSES as readonly string[]).includes(p.status ?? '') ? p.status! : ''
  const page = Math.max(1, Math.min(1000, Number.parseInt(p.page ?? '1', 10) || 1))
  const term = searchTerm(p.q)
  const [{ data: openData }, { data: vendorData }, pendingCount] = await Promise.all([
    supabase.from('bills').select('id, total_cents, paid_cents, due_date, status').eq('company_id', companyId).in('status', OPEN),
    supabase.from('vendors').select('id, name').eq('company_id', companyId),
    supabase.from('bills').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending_approval'),
  ])
  const vendors = new Map(((vendorData ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]))
  const open = (openData ?? []) as Pick<Bill, 'id' | 'total_cents' | 'paid_cents' | 'due_date' | 'status'>[]
  const balance = (b: Pick<Bill, 'total_cents' | 'paid_cents'>) => toCents(b.total_cents) - toCents(b.paid_cents)
  const overdue = open.filter((b) => (daysUntil(b.due_date, today) ?? 0) < 0)
  const dueSoon = open.filter((b) => { const d = daysUntil(b.due_date, today); return d !== null && d >= 0 && d <= 7 })
  const matchingVendors = term ? [...vendors].filter(([, n]) => n.toLowerCase().includes(term.toLowerCase())).map(([id]) => id) : []

  let q = supabase.from('bills').select('*', { count: 'exact' }).eq('company_id', companyId)
  if (status) q = q.eq('status', status)
  if (term) q = q.or([`description.ilike.%${term}%`, `vendor_invoice_number.ilike.%${term}%`, ...(matchingVendors.length ? [`vendor_id.in.(${matchingVendors.join(',')})`] : [])].join(','))
  const { data, count } = await q.order('bill_date', { ascending: false }).order('created_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1)
  const bills = (data ?? []) as Bill[]
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(status ? { status } : {}), ...(term ? { q: term } : {}), ...extra }).toString()

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Finanzas', 'Finance')} title={tr('Gastos y cuentas por pagar', 'Expenses and payables')}
        description={access.view ? undefined : tr('Ves los gastos que registraste tú.', 'You see the expenses you recorded.')}
        actions={access.create ? <Link href="/payables/new" className="btn-primary">{tr('Nuevo gasto', 'New expense')}</Link> : undefined} />
      <PayablesNav tr={tr} current="/payables" full={access.view} />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />

      {access.view && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon="wallet" tone="gold" label={tr('Por pagar', 'Payable')} value={money(sumCents(open.map(balance)))} hint={tr(`${open.length} gastos aprobados con saldo`, `${open.length} approved expenses with a balance`)} />
          <StatCard icon="alert" tone="warning" label={tr('Vencido', 'Overdue')} value={money(sumCents(overdue.map(balance)))} hint={tr(`${overdue.length} vencidos`, `${overdue.length} overdue`)} />
          <StatCard icon="clock" label={tr('Vence en 7 días', 'Due in 7 days')} value={money(sumCents(dueSoon.map(balance)))} hint={tr(`${dueSoon.length} gastos`, `${dueSoon.length} expenses`)} />
          <StatCard icon="check" label={tr('Pendientes de aprobación', 'Pending approval')} value={String(pendingCount.count ?? 0)} />
        </div>
      )}

      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm"><span className="field-label">{tr('Buscar', 'Search')}</span>
          <input name="q" defaultValue={term} placeholder={tr('Descripción, proveedor o n.º de factura', 'Description, vendor or invoice no.')} className="field" /></label>
        <label className="text-sm"><span className="field-label">{tr('Estado', 'Status')}</span>
          <select name="status" defaultValue={status} className="field">
            <option value="">{tr('Todos', 'All')}</option>
            {BILL_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s, locale)}</option>)}
          </select></label>
        <button type="submit" className="btn-secondary">{tr('Filtrar', 'Filter')}</button>
      </form>

      {bills.length === 0
        ? <div className="card"><EmptyState icon="receipt" title={tr('No hay gastos con estos filtros', 'No expenses with these filters')}
            action={access.create ? <Link href="/payables/new" className="btn-primary">{tr('Registrar un gasto', 'Record an expense')}</Link> : undefined} /></div>
        : (
          <ul className="card divide-y divide-line/60 overflow-hidden">
            {bills.map((b) => {
              const d = daysUntil(b.due_date, today)
              const late = OPEN.includes(b.status) && d !== null && d < 0
              return (
                <li key={b.id}>
                  <Link href={`/payables/${b.id}`} className="flex flex-col gap-2 px-5 py-4 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{vendors.get(b.vendor_id) ?? '—'} · {b.description}</span>
                      <span className="block text-xs text-muted">
                        {f.date(b.bill_date)}{b.vendor_invoice_number ? ` · ${b.vendor_invoice_number}` : ''}
                        {b.due_date && OPEN.includes(b.status) ? ` · ${tr('vence', 'due')} ${f.date(b.due_date)}` : ''}
                        {b.recurring_id ? ` · ${tr('recurrente', 'recurring')}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {late && <span className="badge-danger">{tr('Vencido', 'Overdue')}</span>}
                      <span className={statusTone(b.status)}>{statusLabel(b.status, locale)}</span>
                      <span className="text-right font-semibold tabular-nums text-fg">{money(b.total_cents)}
                        {Number(b.paid_cents) > 0 && b.status !== 'paid' && <span className="block text-xs font-normal text-muted">{tr('saldo', 'balance')} {money(balance(b))}</span>}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label={tr('Páginas', 'Pages')}>
          {page > 1 ? <Link className="btn-secondary" href={`/payables?${qs({ page: String(page - 1) })}`}>{tr('Anterior', 'Previous')}</Link> : <span />}
          <span className="text-muted">{page} / {pages}</span>
          {page < pages ? <Link className="btn-secondary" href={`/payables?${qs({ page: String(page + 1) })}`}>{tr('Siguiente', 'Next')}</Link> : <span />}
        </nav>
      )}
    </div>
  )
}

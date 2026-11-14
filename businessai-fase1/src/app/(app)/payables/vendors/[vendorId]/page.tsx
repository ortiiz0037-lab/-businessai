import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, StatCard } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { methodLabel, payablesMessage, statusLabel, statusTone, type Bill, type Vendor } from '@/lib/finance/payables'
import { sumCents, toCents } from '@/lib/finance/money'
import { saveVendor, setVendorStatus } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'

/** One vendor: details, bills, payments and totals (its history). */
export default async function VendorPage({ params, searchParams }: { params: Promise<{ vendorId: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ vendorId }, p] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access } = await payablesPage()
  if (!access.create && !access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(vendorId)) notFound()
  const { data: v } = await supabase.from('vendors').select('*').eq('id', vendorId).eq('company_id', companyId).maybeSingle()
  const vendor = v as Vendor | null
  if (!vendor) notFound()
  const { data: billData } = await supabase.from('bills').select('*').eq('vendor_id', vendorId).order('bill_date', { ascending: false }).limit(200)
  const bills = (billData ?? []) as Bill[]
  const { data: payData } = access.view && bills.length
    ? await supabase.from('bill_payments').select('id, bill_id, paid_on, amount_cents, method, reference, voided_at').in('bill_id', bills.map((b) => b.id)).order('paid_on', { ascending: false })
    : { data: [] }
  const payments = (payData ?? []) as { id: string; bill_id: string; paid_on: string; amount_cents: number; method: string | null; reference: string | null; voided_at: string | null }[]
  const live = bills.filter((b) => !['draft', 'pending_approval', 'voided'].includes(b.status))
  const back = `/payables/vendors/${vendorId}`
  const done: Record<string, string> = { vendor_saved: tr('Proveedor guardado.', 'Vendor saved.'), vendor_archived: tr('Proveedor archivado.', 'Vendor archived.'), vendor_restored: tr('Proveedor reactivado.', 'Vendor restored.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Proveedores', 'Vendors')} title={vendor.name} description={[vendor.tax_id, vendor.email, vendor.phone, vendor.address].filter(Boolean).join(' · ') || undefined}
        actions={access.create && vendor.status === 'active' ? <Link href={`/payables/new?vendor=${vendor.id}`} className="btn-primary">{tr('Nuevo gasto', 'New expense')}</Link> : undefined} />
      <PayablesNav tr={tr} current="/payables/vendors" full={access.view} />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />
      {access.view && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard icon="receipt" label={tr('Gastos aprobados', 'Approved expenses')} value={money(sumCents(live.map((b) => b.total_cents)))} hint={tr(`${live.length} facturas`, `${live.length} bills`)} />
          <StatCard icon="wallet" tone="success" label={tr('Pagado', 'Paid')} value={money(sumCents(live.map((b) => b.paid_cents)))} />
          <StatCard icon="alert" tone="warning" label={tr('Por pagar', 'Payable')} value={money(sumCents(live.map((b) => toCents(b.total_cents) - toCents(b.paid_cents))))} />
        </div>
      )}
      <section className="card overflow-hidden">
        <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Gastos y facturas', 'Expenses and bills')}</h2>
        {bills.length === 0 ? <p className="p-5 text-sm text-muted">{tr('Sin gastos.', 'No expenses.')}</p> : (
          <ul className="divide-y divide-line/60">
            {bills.map((b) => (
              <li key={b.id}><Link href={`/payables/${b.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-white/[0.03]">
                <span>{f.date(b.bill_date)} · {b.description}{b.vendor_invoice_number ? ` · ${b.vendor_invoice_number}` : ''}</span>
                <span className="flex items-center gap-3"><span className={statusTone(b.status)}>{statusLabel(b.status, locale)}</span><span className="tabular-nums">{money(b.total_cents)}</span></span>
              </Link></li>
            ))}
          </ul>
        )}
      </section>
      {access.view && (
        <section className="card overflow-hidden">
          <h2 className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Pagos', 'Payments')}</h2>
          {payments.length === 0 ? <p className="p-5 text-sm text-muted">{tr('Sin pagos.', 'No payments.')}</p> : (
            <ul className="divide-y divide-line/60">
              {payments.map((x) => (
                <li key={x.id} className={`flex flex-wrap justify-between gap-2 px-5 py-3 text-sm ${x.voided_at ? 'text-muted line-through' : ''}`}>
                  <span>{f.date(x.paid_on)} · {methodLabel(x.method, locale)}{x.reference ? ` · ${x.reference}` : ''}</span><span className="tabular-nums">{money(x.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {access.manage && (
        <details className="card p-5">
          <summary className="cursor-pointer font-semibold text-accent">{tr('Editar proveedor', 'Edit vendor')}</summary>
          <form action={saveVendor} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input type="hidden" name="id" value={vendor.id} /><input type="hidden" name="back" value={back} />
            <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={160} defaultValue={vendor.name} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Identificación fiscal', 'Tax ID')}</span><input name="tax_id" maxLength={40} defaultValue={vendor.tax_id ?? ''} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Correo', 'Email')}</span><input type="email" name="email" maxLength={200} defaultValue={vendor.email ?? ''} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Teléfono', 'Phone')}</span><input name="phone" maxLength={40} defaultValue={vendor.phone ?? ''} className="field" /></label>
            <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Dirección', 'Address')}</span><input name="address" maxLength={400} defaultValue={vendor.address ?? ''} className="field" /></label>
            <label className="text-sm sm:col-span-2 lg:col-span-3"><span className="field-label">{tr('Notas', 'Notes')}</span><input name="notes" maxLength={1000} defaultValue={vendor.notes ?? ''} className="field" /></label>
            <div><SubmitButton>{tr('Guardar', 'Save')}</SubmitButton></div>
          </form>
          <form action={setVendorStatus} className="mt-4"><input type="hidden" name="id" value={vendor.id} /><input type="hidden" name="back" value={back} />
            <input type="hidden" name="status" value={vendor.status === 'active' ? 'archived' : 'active'} />
            <button type="submit" className="btn-secondary btn-sm">{vendor.status === 'active' ? tr('Archivar proveedor', 'Archive vendor') : tr('Reactivar proveedor', 'Restore vendor')}</button></form>
        </details>
      )}
    </div>
  )
}

import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { payablesMessage, type Vendor } from '@/lib/finance/payables'
import { saveVendor } from '@/app/actions/payables'

export const dynamic = 'force-dynamic'

/** Vendors of the company with what is owed to each. */
export default async function VendorsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, money, supabase, companyId, access } = await payablesPage()
  if (!access.create && !access.view) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const [{ data }, { data: open }] = await Promise.all([
    supabase.from('vendors').select('*').eq('company_id', companyId).order('status').order('name'),
    access.view ? supabase.from('bills').select('vendor_id, total_cents, paid_cents').eq('company_id', companyId).in('status', ['approved', 'scheduled', 'partially_paid']) : Promise.resolve({ data: [] }),
  ])
  const vendors = (data ?? []) as Vendor[]
  const owed = new Map<string, bigint>()
  for (const b of (open ?? []) as { vendor_id: string; total_cents: number; paid_cents: number }[]) owed.set(b.vendor_id, (owed.get(b.vendor_id) ?? 0n) + BigInt(b.total_cents) - BigInt(b.paid_cents))
  const done: Record<string, string> = { vendor_created: tr('Proveedor registrado.', 'Vendor registered.') }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Proveedores', 'Vendors')} />
      <PayablesNav tr={tr} current="/payables/vendors" full={access.view} />
      <Flash done={p.done ? done[p.done] : null} error={payablesMessage(p.error, locale)} />
      {access.create && access.initialized && (
        <details className="card p-5">
          <summary className="cursor-pointer font-semibold text-accent">{tr('Nuevo proveedor', 'New vendor')}</summary>
          <form action={saveVendor} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm"><span className="field-label">{tr('Nombre', 'Name')}</span><input name="name" required maxLength={160} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Identificación fiscal', 'Tax ID')}</span><input name="tax_id" maxLength={40} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Correo', 'Email')}</span><input type="email" name="email" maxLength={200} className="field" /></label>
            <label className="text-sm"><span className="field-label">{tr('Teléfono', 'Phone')}</span><input name="phone" maxLength={40} className="field" /></label>
            <label className="text-sm sm:col-span-2"><span className="field-label">{tr('Dirección', 'Address')}</span><input name="address" maxLength={400} className="field" /></label>
            <label className="text-sm sm:col-span-2 lg:col-span-3"><span className="field-label">{tr('Notas', 'Notes')}</span><input name="notes" maxLength={1000} className="field" /></label>
            <div><SubmitButton>{tr('Registrar', 'Register')}</SubmitButton></div>
          </form>
        </details>
      )}
      {vendors.length === 0
        ? <div className="card"><EmptyState icon="building" title={tr('Sin proveedores todavía', 'No vendors yet')} /></div>
        : (
          <ul className="card divide-y divide-line/60 overflow-hidden">
            {vendors.map((v) => (
              <li key={v.id}>
                <Link href={`/payables/vendors/${v.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 transition hover:bg-white/[0.03]">
                  <span className="min-w-0"><span className={`block font-semibold ${v.status === 'archived' ? 'text-muted line-through' : 'text-fg'}`}>{v.name}</span>
                    <span className="block text-xs text-muted">{[v.tax_id, v.email, v.phone].filter(Boolean).join(' · ') || '—'}</span></span>
                  {access.view && <span className="text-right text-sm tabular-nums text-fg">{money(owed.get(v.id) ?? 0n)}<span className="block text-xs text-muted">{tr('por pagar', 'payable')}</span></span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

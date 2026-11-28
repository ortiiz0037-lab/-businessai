import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { BillForm } from '@/components/bill-form'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { payablesMessage, type Category, type Vendor } from '@/lib/finance/payables'

export const dynamic = 'force-dynamic'

/** New expense / vendor bill (draft, submit, or submit and approve). */
export default async function NewBillPage({ searchParams }: { searchParams: Promise<{ error?: string; vendor?: string }> }) {
  const p = await searchParams
  const { locale, tr, today, supabase, companyId, access } = await payablesPage()
  if (!access.create || !access.initialized) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  const [{ data: v }, { data: c }] = await Promise.all([
    supabase.from('vendors').select('*').eq('company_id', companyId).order('name'),
    supabase.from('expense_categories').select('*').eq('company_id', companyId).order('name'),
  ])
  const vendors = (v ?? []) as Vendor[]
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Nuevo gasto o factura de proveedor', 'New expense or vendor bill')} />
      <PayablesNav tr={tr} current="/payables" full={access.view} />
      <Flash error={payablesMessage(p.error, locale)} />
      {vendors.filter((x) => x.status === 'active').length === 0
        ? <p className="card p-5 text-sm text-muted">{tr('Primero registra un proveedor.', 'Register a vendor first.')} <Link href="/payables/vendors" className="text-accent">{tr('Ir a proveedores', 'Go to vendors')}</Link></p>
        : <BillForm tr={tr} locale={locale} today={today} vendors={vendors} categories={(c ?? []) as Category[]}
            initial={p.vendor ? { vendor_id: p.vendor } : undefined} canApprove={access.approvalLimit !== -1} />}
    </div>
  )
}

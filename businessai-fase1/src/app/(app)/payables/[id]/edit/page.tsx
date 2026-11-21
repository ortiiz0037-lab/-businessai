import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { BillForm } from '@/components/bill-form'
import { NoPayablesAccess, PayablesNav } from '@/components/payables-nav'
import { payablesPage } from '@/lib/finance/payables-page'
import { payablesMessage, type Bill, type Category, type Vendor } from '@/lib/finance/payables'

export const dynamic = 'force-dynamic'

/** Edit a draft (the database refuses any other status). */
export default async function EditBillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, p] = await Promise.all([params, searchParams])
  const { locale, tr, today, supabase, companyId, access } = await payablesPage()
  if (!access.create) return <NoPayablesAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [{ data: b }, { data: lines }, { data: v }, { data: c }] = await Promise.all([
    supabase.from('bills').select('*').eq('id', id).eq('company_id', companyId).maybeSingle(),
    supabase.from('bill_lines').select('category_id, description, amount_cents, line_no').eq('bill_id', id).order('line_no'),
    supabase.from('vendors').select('*').eq('company_id', companyId).order('name'),
    supabase.from('expense_categories').select('*').eq('company_id', companyId).order('name'),
  ])
  const bill = b as Bill | null
  if (!bill) notFound()
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Gastos', 'Expenses')} title={tr('Editar borrador', 'Edit draft')} />
      <PayablesNav tr={tr} current="/payables" full={access.view} />
      <Flash error={payablesMessage(p.error, locale)} />
      {bill.status !== 'draft'
        ? <p className="card p-5 text-sm text-muted">{payablesMessage('bill_locked', locale)}</p>
        : <BillForm tr={tr} locale={locale} today={today} vendors={(v ?? []) as Vendor[]} categories={(c ?? []) as Category[]} canApprove={access.approvalLimit !== -1}
            initial={{ ...bill, lines: (lines ?? []) as { category_id: string; description: string | null; amount_cents: number }[] }} />}
    </div>
  )
}

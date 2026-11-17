/**
 * Data for applying deposits (S6): open invoices with their real balance
 * (voided payments excluded) and the client payments recorded into a bank
 * account that are not linked to a deposit yet. Read with the user's session
 * (RLS); the matching engine only suggests from these.
 */
import { fetchAllPages as selectAll } from '@/lib/supabase/paged'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OpenInvoice, RecordedPayment } from '@/lib/banking/matching'

export type DepositLine = { id: string; bank_account_id: string; txn_date: string; description: string; reference: string | null; amount_cents: number; status: string; branch_id: string | null; reconciliation_id: string | null }
export type Allocation = { id: string; bank_line_id: string; payment_id: string; amount_cents: number; kind: 'new_payment' | 'existing_payment'; confidence: number | null; reasons: string[]
  created_by: string | null; created_at: string; voided_at: string | null; voided_by: string | null; void_reason: string | null }

const cents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100)

export async function openInvoices(supabase: SupabaseClient, companyId: string): Promise<OpenInvoice[]> {
  const { data } = await supabase.from('documents').select('id, document_number, client_id, total, issue_date, due_date, status, clients(name)')
    .eq('company_id', companyId).eq('document_type', 'invoice').in('status', ['sent', 'overdue']).order('issue_date').limit(500)
  const docs = (data ?? []) as unknown as { id: string; document_number: string | null; client_id: string | null; total: number; issue_date: string; due_date: string | null; clients: { name: string } | { name: string }[] | null }[]
  if (!docs.length) return []
  const paid = new Map<string, number>()
  for (let i = 0; i < docs.length; i += 100) {
    const { rows: pays } = await selectAll((a, b) => supabase.from('payments').select('document_id, amount, voided_at').in('document_id', docs.slice(i, i + 100).map((d) => d.id)).order('id').range(a, b))
    for (const p of (pays ?? []) as { document_id: string; amount: number; voided_at?: string | null }[]) if (!p.voided_at) paid.set(p.document_id, (paid.get(p.document_id) ?? 0) + cents(p.amount))
  }
  return docs.map((d) => ({
    id: d.id, number: d.document_number, client_id: d.client_id, client_name: (Array.isArray(d.clients) ? d.clients[0]?.name : d.clients?.name) ?? null,
    balance_cents: cents(d.total) - (paid.get(d.id) ?? 0), issue_date: d.issue_date, due_date: d.due_date,
  })).filter((d) => d.balance_cents > 0)
}

/** Payments deposited into this bank's ledger account, not voided, not yet linked to a deposit (last 180 days). */
export async function linkablePayments(supabase: SupabaseClient, companyId: string, ledgerAccountId: string): Promise<RecordedPayment[]> {
  const since = new Date(Date.now() - 180 * 86400000).toISOString()
  const [{ data }, { data: linked }] = await Promise.all([
    supabase.from('payments').select('id, amount, paid_at, reference, document_id, payment_method, voided_at, documents(document_number, clients(name))')
      .eq('company_id', companyId).eq('deposit_account_id', ledgerAccountId).gte('paid_at', since).order('paid_at', { ascending: false }).limit(300),
    selectAll((a, b) => supabase.from('bank_line_allocations').select('payment_id').eq('company_id', companyId).is('voided_at', null).order('id').range(a, b)).then((r) => ({ data: r.rows, error: r.error })),
  ])
  const taken = new Set(((linked ?? []) as { payment_id: string }[]).map((x) => x.payment_id))
  type Row = { id: string; amount: number; paid_at: string; reference: string | null; document_id: string; payment_method: string | null; voided_at: string | null
    documents: { document_number: string | null; clients: { name: string } | { name: string }[] | null } | null }
  return ((data ?? []) as unknown as Row[]).filter((p) => !p.voided_at && !taken.has(p.id)).map((p) => {
    const cl = p.documents?.clients
    return { id: p.id, amount_cents: cents(p.amount), paid_at: p.paid_at, reference: p.reference, document_id: p.document_id, document_number: p.documents?.document_number ?? null,
      client_name: (Array.isArray(cl) ? cl[0]?.name : cl?.name) ?? null, method: p.payment_method }
  })
}

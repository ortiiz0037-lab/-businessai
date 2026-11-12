import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { toCsv } from '@/lib/finance/bank'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const cents = (c: number | null | undefined) => {
  if (c === null || c === undefined) return ''
  const n = BigInt(c); const a = n < 0n ? -n : n
  return `${n < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

/** CSV exports of banking data, read with the user's own session (RLS: bank.view). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') ?? ''
  const account = url.searchParams.get('account')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const co = member.companyId
  const { data: accts } = await supabase.from('bank_accounts').select('id, name').eq('company_id', co)
  const accName = new Map(((accts ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))
  let rows: unknown[][] = []
  if (kind === 'lines' || kind === 'unmatched') {
    let q = supabase.from('bank_lines').select('bank_account_id, txn_date, description, reference, amount_cents, balance_cents, status, reconciliation_id').eq('company_id', co).neq('status', 'excluded')
    if (account && UUID.test(account)) q = q.eq('bank_account_id', account)
    if (from && DAY.test(from)) q = q.gte('txn_date', from)
    if (to && DAY.test(to)) q = q.lte('txn_date', to)
    if (kind === 'unmatched') q = q.eq('status', 'unmatched')
    const { data } = await q.order('txn_date').limit(10000)
    rows = [['account', 'date', 'description', 'reference', 'amount', 'balance', 'status', 'reconciled'],
      ...((data ?? []) as { bank_account_id: string; txn_date: string; description: string; reference: string | null; amount_cents: number; balance_cents: number | null; status: string; reconciliation_id: string | null }[])
        .map((l) => [accName.get(l.bank_account_id) ?? '', l.txn_date, l.description, l.reference ?? '', cents(l.amount_cents), cents(l.balance_cents), l.status, l.reconciliation_id ? 'yes' : 'no'])]
  } else if (kind === 'reconciliations') {
    const { data } = await supabase.from('bank_reconciliations').select('id, bank_account_id, period_start, period_end, statement_opening_cents, statement_closing_cents, status, adjustment_reason, closed_at, reopened_at, reopen_reason').eq('company_id', co).order('period_end')
    const list = (data ?? []) as { id: string; bank_account_id: string; period_start: string; period_end: string; statement_opening_cents: number; statement_closing_cents: number; status: string; adjustment_reason: string | null; closed_at: string | null; reopened_at: string | null; reopen_reason: string | null }[]
    const sums = await Promise.all(list.map((r) => supabase.rpc('bank_reconciliation_summary', { rec: r.id })))
    rows = [['account', 'from', 'to', 'opening', 'closing', 'book_balance', 'uncleared_book', 'difference', 'unmatched_lines', 'status', 'adjustment', 'closed_at', 'reopened_at', 'reopen_reason'],
      ...list.map((r, i) => { const s = ((sums[i].data ?? []) as { ledger_balance_cents: number; uncleared_book_cents: number; difference_cents: number; unmatched_bank_count: number }[])[0]
        return [accName.get(r.bank_account_id) ?? '', r.period_start, r.period_end, cents(r.statement_opening_cents), cents(r.statement_closing_cents), cents(s?.ledger_balance_cents), cents(s?.uncleared_book_cents),
          cents(s?.difference_cents), s?.unmatched_bank_count ?? '', r.status, r.adjustment_reason ?? '', r.closed_at ?? '', r.reopened_at ?? '', r.reopen_reason ?? ''] })]
  } else if (kind === 'imports') {
    const { data } = await supabase.from('bank_imports').select('bank_account_id, file_name, file_sha256, row_count, imported_count, duplicate_count, first_date, last_date, status, revert_reason, created_at').eq('company_id', co).order('created_at')
    rows = [['account', 'file', 'sha256', 'rows', 'imported', 'duplicates', 'first_date', 'last_date', 'status', 'revert_reason', 'imported_at'],
      ...((data ?? []) as Record<string, unknown>[]).map((x) => [accName.get(String(x.bank_account_id)) ?? '', x.file_name, x.file_sha256, x.row_count, x.imported_count, x.duplicate_count, x.first_date, x.last_date, x.status, x.revert_reason ?? '', x.created_at])]
  } else if (kind === 'events') {
    const { data } = await supabase.from('bank_events').select('bank_account_id, entity, action, details, created_at').eq('company_id', co).order('id').limit(10000)
    rows = [['account', 'entity', 'action', 'details', 'at'],
      ...((data ?? []) as { bank_account_id: string | null; entity: string; action: string; details: unknown; created_at: string }[]).map((e) => [accName.get(e.bank_account_id ?? '') ?? '', e.entity, e.action, JSON.stringify(e.details), e.created_at])]
  } else {
    return new NextResponse('Not found', { status: 404 })
  }
  return new NextResponse(toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="businessai-bank-${kind}.csv"`, 'Cache-Control': 'no-store' } })
}

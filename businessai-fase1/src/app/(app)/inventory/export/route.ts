import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { toCsv } from '@/lib/finance/bank'
import { trackedProducts, productCode, productLabel } from '@/lib/inventory/page'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** CSV of inventory movements in a period, read with the user's session (RLS: inventory.view and branch scope). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from'), to = url.searchParams.get('to')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const co = member.companyId
  let q = supabase.from('inventory_movements').select('id, occurred_at, kind, quantity, item_id, variant_id, branch_id, reason, document_id, source_type, corrects_id').eq('company_id', co)
  if (from && DAY.test(from)) q = q.gte('occurred_at', `${from}T00:00:00-04:00`)
  if (to && DAY.test(to)) q = q.lte('occurred_at', `${to}T23:59:59-04:00`)
  const [{ data, error }, products, { data: br }] = await Promise.all([q.order('id').limit(50000), trackedProducts(supabase, co), supabase.from('branches').select('id, name').eq('company_id', co)])
  if (error) return new NextResponse('Not available', { status: 404 })
  const bname = new Map(((br ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]))
  const rows: unknown[][] = [['id', 'date', 'kind', 'product', 'code', 'branch', 'quantity', 'reason', 'source', 'corrects']]
  for (const m of (data ?? []) as { id: number; occurred_at: string; kind: string; quantity: number; item_id: string; variant_id: string | null; branch_id: string; reason: string | null; source_type: string | null; corrects_id: number | null }[]) {
    rows.push([m.id, m.occurred_at, m.kind, productLabel(products, m.item_id, m.variant_id), productCode(products, m.item_id, m.variant_id), bname.get(m.branch_id) ?? '', m.quantity, m.reason ?? '', m.source_type ?? '', m.corrects_id ?? ''])
  }
  return new NextResponse(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="inventario-movimientos-${from ?? 'todo'}-${to ?? ''}.csv"`, 'cache-control': 'no-store' } })
}

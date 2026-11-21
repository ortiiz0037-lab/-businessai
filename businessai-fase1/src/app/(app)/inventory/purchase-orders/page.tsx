import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches } from '@/lib/inventory/page'
import { inventoryMessage, statusLabel, statusTone } from '@/lib/inventory/labels'

export const dynamic = 'force-dynamic'

/** Purchase orders: drafts, approvals, issued orders waiting for goods, partial and full receipts. */
export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; done?: string; error?: string; n?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const statuses = ['draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled']
  const status = statuses.includes(sp.status ?? '') ? sp.status! : ''
  let q = supabase.from('purchase_orders').select('id, number, status, source, branch_id, vendor_id, expected_date, created_at, vendors(name), purchase_order_lines(qty_ordered, qty_received, unit_cost_cents)').eq('company_id', companyId)
  if (status) q = q.eq('status', status)
  const [branches, { data }] = await Promise.all([myBranches(supabase, companyId), q.order('created_at', { ascending: false }).limit(200)])
  const rows = (data ?? []) as unknown as { id: string; number: string; status: string; source: string; branch_id: string; expected_date: string | null; created_at: string; vendors: { name: string } | null
    purchase_order_lines: { qty_ordered: number; qty_received: number; unit_cost_cents: number }[] }[]
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  const done: Record<string, string> = { drafts: tr(`${sp.n ?? 0} borradores de orden de compra creados desde la reposición. Revísalos y envíalos a aprobación.`, `${sp.n ?? 0} draft purchase orders created from replenishment. Review them and send them for approval.`) }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Compras y recepción', 'Purchasing and receiving')}
        description={tr('Orden de compra → aprobación → recepción (parcial o total, por escaneo) → vínculo con la factura del proveedor en Gastos. Nunca se crea un gasto o pago duplicado.',
          'Purchase order → approval → receiving (partial or full, by scanning) → link to the vendor bill in Expenses. No expense or payment is ever duplicated.')}
        actions={access.operate ? <Link href="/inventory/purchase-orders/new" className="btn-primary">{tr('Nueva orden de compra', 'New purchase order')}</Link> : undefined} />
      <InventoryNav tr={tr} current="/inventory/purchase-orders" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr('Estado', 'Status')}>
        {['', ...statuses].map((s) => <Link key={s} href={s ? `/inventory/purchase-orders?status=${s}` : '/inventory/purchase-orders'} aria-current={s === status ? 'page' : undefined}
          className={`rounded-xl border px-3 py-1.5 ${s === status ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line text-slate-300'}`}>{s ? statusLabel(s, locale) : tr('Todas', 'All')}</Link>)}
      </nav>
      {rows.length === 0 ? <div className="card"><EmptyState icon="file" title={tr('Sin órdenes', 'No orders')} description={tr('Crea una orden de compra o genera borradores desde Reposición.', 'Create a purchase order or generate drafts from Replenishment.')} /></div> : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="po-list">{rows.map((p) => {
          const ordered = p.purchase_order_lines.reduce((s, l) => s + Number(l.qty_ordered), 0), received = p.purchase_order_lines.reduce((s, l) => s + Number(l.qty_received), 0)
          const total = p.purchase_order_lines.reduce((s, l) => s + Number(l.qty_ordered) * Number(l.unit_cost_cents), 0)
          return (
            <li key={p.id}><Link href={`/inventory/purchase-orders/${p.id}`} className="card block space-y-2 p-4 transition hover:border-electric/40" data-testid="po-item">
              <div className="flex items-start justify-between gap-2"><span className="font-semibold text-fg">{p.number} · {p.vendors?.name ?? '—'}</span><StateChip tone={statusTone(p.status)}>{statusLabel(p.status, locale)}</StateChip></div>
              <p className="text-xs text-muted">{bname.get(p.branch_id) ?? '—'} · {f.date(p.created_at.slice(0, 10))}{p.expected_date ? ` · ${tr('esperada', 'expected')} ${f.date(p.expected_date)}` : ''}{p.source === 'replenishment' ? ` · ${tr('desde reposición', 'from replenishment')}` : ''}</p>
              <p className="text-sm">{tr('Recibido', 'Received')} {received} / {ordered}{access.approve ? ` · ${money(total)}` : ''}</p>
            </Link></li>)
        })}</ul>
      )}
    </div>
  )
}

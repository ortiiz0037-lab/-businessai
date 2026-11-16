import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage } from '@/lib/inventory/page'
import { inventoryMessage, statusLabel } from '@/lib/inventory/labels'

export const dynamic = 'force-dynamic'

/** Branch transfers: requested → approved → prepared → in transit → received (with differences). */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [{ data }, { data: br }] = await Promise.all([
    supabase.from('inventory_transfers').select('id, number, status, from_branch_id, to_branch_id, requested_at, inventory_transfer_lines(qty_requested)').eq('company_id', companyId).order('requested_at', { ascending: false }).limit(200),
    supabase.from('branches').select('id, name').eq('company_id', companyId),
  ])
  const rows = (data ?? []) as unknown as { id: string; number: string; status: string; from_branch_id: string; to_branch_id: string; requested_at: string; inventory_transfer_lines: { qty_requested: number }[] }[]
  const bname = new Map(((br ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]))
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Transferencias entre sucursales', 'Branch transfers')}
        description={tr('La sucursal destino no suma existencias hasta confirmar la recepción. Queda quién despachó y quién recibió.', 'The destination branch does not add stock until the receipt is confirmed. Who dispatched and who received is kept.')}
        actions={access.operate ? <Link href="/inventory/transfers/new" className="btn-primary">{tr('Nueva transferencia', 'New transfer')}</Link> : undefined} />
      <InventoryNav tr={tr} current="/inventory/transfers" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      {rows.length === 0 ? <div className="card"><EmptyState icon="archive" title={tr('Sin transferencias', 'No transfers')} description={tr('Solicita mercancía de otra sucursal.', 'Request goods from another branch.')} /></div> : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="transfer-list">{rows.map((t) => (
          <li key={t.id}><Link href={`/inventory/transfers/${t.id}`} className="card block space-y-2 p-4 transition hover:border-electric/40">
            <div className="flex items-start justify-between gap-2"><span className="font-semibold text-fg">{t.number}</span><StateChip tone={t.status === 'received' ? 'ok' : t.status === 'cancelled' ? 'issue' : 'pending'}>{statusLabel(t.status, locale)}</StateChip></div>
            <p className="text-sm">{bname.get(t.from_branch_id)} → {bname.get(t.to_branch_id)}</p>
            <p className="text-xs text-muted">{f.date(t.requested_at.slice(0, 10))} · {t.inventory_transfer_lines.length} {tr('líneas', 'lines')}</p>
          </Link></li>))}</ul>
      )}
    </div>
  )
}

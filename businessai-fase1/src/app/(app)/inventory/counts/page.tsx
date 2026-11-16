import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { inventoryPage, myBranches } from '@/lib/inventory/page'
import { inventoryMessage, statusLabel } from '@/lib/inventory/labels'
import { startCount } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'

/** Physical counts: full or partial, by scanning or typing; differences become movements only when approved. */
export default async function CountsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  const [branches, { data }, { data: locs }] = await Promise.all([
    myBranches(supabase, companyId),
    supabase.from('inventory_counts').select('id, number, branch_id, scope, status, started_at, inventory_count_lines(difference_qty)').eq('company_id', companyId).order('started_at', { ascending: false }).limit(100),
    supabase.from('inventory_locations').select('id, branch_id, code, name').eq('company_id', companyId).is('archived_at', null).order('code'),
  ])
  const rows = (data ?? []) as unknown as { id: string; number: string; branch_id: string; scope: string; status: string; started_at: string; inventory_count_lines: { difference_qty: number | null }[] }[]
  const bname = new Map(branches.map((b) => [b.id, b.name]))
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Inventario', 'Inventory')} title={tr('Conteos físicos', 'Physical counts')}
        description={tr('Cuenta escaneando o escribiendo. Al enviar se compara con lo registrado; las diferencias solo ajustan las existencias cuando un aprobador lo confirma.', 'Count by scanning or typing. Submitting compares with the records; differences only adjust stock when an approver confirms.')} />
      <InventoryNav tr={tr} current="/inventory/counts" />
      <Flash error={inventoryMessage(sp.error, locale)} />
      {access.operate && (
        <form action={startCount} className="card grid gap-3 p-5 sm:grid-cols-4 sm:items-end" data-testid="count-start">
          <label className="text-sm"><span className="field-label">{tr('Sucursal', 'Branch')}</span><select name="branch_id" required className="field">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="text-sm"><span className="field-label">{tr('Ubicación (opcional)', 'Location (optional)')}</span>
            <select name="location_id" className="field"><option value="">{tr('Toda la sucursal', 'Whole branch')}</option>{((locs ?? []) as { id: string; code: string; name: string }[]).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
          <label className="text-sm"><span className="field-label">{tr('Alcance', 'Scope')}</span>
            <select name="scope" className="field"><option value="partial">{tr('Parcial (solo lo contado)', 'Partial (only what is counted)')}</option><option value="full">{tr('Completo (lo no contado = 0)', 'Full (not counted = 0)')}</option></select></label>
          <SubmitButton className="w-full sm:w-auto">{tr('Empezar conteo', 'Start count')}</SubmitButton>
        </form>
      )}
      {rows.length === 0 ? <div className="card"><EmptyState icon="clipboard" title={tr('Sin conteos', 'No counts')} description={tr('Empieza un conteo para comparar lo físico con lo registrado.', 'Start a count to compare what is physically there with the records.')} /></div> : (
        <ul className="grid gap-3 md:grid-cols-2">{rows.map((c) => { const diffs = c.inventory_count_lines.filter((l) => Number(l.difference_qty ?? 0) !== 0).length; return (
          <li key={c.id}><Link href={`/inventory/counts/${c.id}`} className="card block space-y-1 p-4 transition hover:border-electric/40" data-testid="count-item">
            <div className="flex items-start justify-between gap-2"><span className="font-semibold text-fg">{c.number} · {bname.get(c.branch_id) ?? '—'}</span>
              <StateChip tone={c.status === 'approved' ? 'ok' : c.status === 'cancelled' ? 'issue' : 'pending'}>{statusLabel(c.status, locale)}</StateChip></div>
            <p className="text-xs text-muted">{c.scope === 'full' ? tr('Completo', 'Full') : tr('Parcial', 'Partial')} · {f.date(c.started_at.slice(0, 10))} · {c.inventory_count_lines.length} {tr('líneas', 'lines')}{diffs ? ` · ${diffs} ${tr('con diferencia', 'with differences')}` : ''}</p>
          </Link></li>) })}</ul>
      )}
    </div>
  )
}

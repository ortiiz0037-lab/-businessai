import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { StateChip } from '@/components/bank-nav'
import { NoPosAccess, PosNav } from '@/components/pos/nav'
import { posBranches, posPage, prDay } from '@/lib/pos/page'
import { posStatus, posTone } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

/** Sales history (every source), filtered by period, branch, source and status. */
export default async function PosSales({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from! : prDay(-6), to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to! : prDay()
  const branches = await posBranches(supabase, companyId)
  let q = supabase.from('pos_sales').select('id, number, source, external_id, branch_id, total_cents, refunded_cents, status, inventory_status, occurred_at, cashier_ref')
    .eq('company_id', companyId).gte('occurred_at', `${from}T04:00:00Z`).lt('occurred_at', new Date(Date.parse(`${to}T04:00:00Z`) + 86400000).toISOString())
    .order('occurred_at', { ascending: false }).limit(300)
  if (sp.branch && branches.some((b) => b.id === sp.branch)) q = q.eq('branch_id', sp.branch)
  if (sp.source === 'native' || sp.source === 'external' || sp.source === 'import') q = q.eq('source', sp.source)
  if (sp.status && ['completed', 'partially_refunded', 'refunded', 'voided'].includes(sp.status)) q = q.eq('status', sp.status)
  if (sp.q) q = q.ilike('number', `%${sp.q.replace(/[%_]/g, '')}%`)
  const { data } = await q
  const rows = (data ?? []) as { id: string; number: string; source: string; external_id: string | null; branch_id: string; total_cents: number; refunded_cents: number; status: string; inventory_status: string; occurred_at: string; cashier_ref: string | null }[]
  const bn = new Map(branches.map((b) => [b.id, b.name]))
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Ventas', 'Sales')} description={tr('Cada venta conserva los importes con que se vendió.', 'Each sale keeps the amounts it was sold at.')} />
      <PosNav tr={tr} current="/pos/sales" />
      <form className="card grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6" method="get">
        <label className="text-xs text-muted">{tr('Desde', 'From')}<input type="date" name="from" defaultValue={from} className="field mt-1 h-11 w-full" /></label>
        <label className="text-xs text-muted">{tr('Hasta', 'To')}<input type="date" name="to" defaultValue={to} className="field mt-1 h-11 w-full" /></label>
        <label className="text-xs text-muted">{tr('Sucursal', 'Branch')}<select name="branch" defaultValue={sp.branch ?? ''} className="field mt-1 h-11 w-full"><option value="">{tr('Todas', 'All')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="text-xs text-muted">{tr('Origen', 'Source')}<select name="source" defaultValue={sp.source ?? ''} className="field mt-1 h-11 w-full"><option value="">{tr('Todos', 'All')}</option><option value="native">BusinessAI</option><option value="external">{tr('Integración', 'Integration')}</option><option value="import">{tr('Archivo / puente', 'File / bridge')}</option></select></label>
        <label className="text-xs text-muted">{tr('Estado', 'Status')}<select name="status" defaultValue={sp.status ?? ''} className="field mt-1 h-11 w-full"><option value="">{tr('Todos', 'All')}</option>{['completed', 'partially_refunded', 'refunded', 'voided'].map((s) => <option key={s} value={s}>{posStatus(s, locale)}</option>)}</select></label>
        <div className="flex items-end gap-2"><input name="q" defaultValue={sp.q ?? ''} placeholder="POS-…" className="field h-11 min-w-0 flex-1" /><button className="btn-secondary min-h-11">{tr('Filtrar', 'Filter')}</button></div>
      </form>
      <section className="card min-w-0 overflow-hidden">
        {rows.length === 0 ? <EmptyState icon="receipt" title={tr('Sin ventas en el periodo', 'No sales in the period')} /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm" data-testid="pos-sales-table">
            <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="p-3">{tr('Venta', 'Sale')}</th><th className="p-3">{tr('Fecha', 'Date')}</th><th className="p-3">{tr('Sucursal', 'Branch')}</th><th className="p-3">{tr('Estado', 'Status')}</th><th className="p-3 text-right">{tr('Total', 'Total')}</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className="border-b border-line/50">
                <td className="p-3"><Link href={`/pos/sales/${s.id}`} className="font-semibold text-accent hover:underline">{s.number}</Link>{s.external_id && <span className="block text-xs text-muted">{s.external_id}</span>}</td>
                <td className="p-3 text-muted">{f.date(s.occurred_at.slice(0, 10))}</td><td className="p-3">{bn.get(s.branch_id) ?? '—'}</td>
                <td className="p-3"><StateChip tone={posTone(s.status)}>{posStatus(s.status, locale)}</StateChip>{s.inventory_status === 'blocked' && <span className="ml-1"><StateChip tone="issue">{posStatus('blocked', locale)}</StateChip></span>}</td>
                <td className="p-3 text-right font-semibold tabular-nums">{money(s.total_cents)}{s.refunded_cents > 0 && <span className="block text-xs text-amber-200">−{money(s.refunded_cents)}</span>}</td>
              </tr>))}</tbody></table></div>)}
      </section>
    </div>
  )
}

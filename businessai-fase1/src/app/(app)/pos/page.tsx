import Link from 'next/link'
import { PageHeader, StatCard, EmptyState } from '@/components/ui/page'
import { StateChip } from '@/components/bank-nav'
import { NoPosAccess, PosNav } from '@/components/pos/nav'
import { posPage, prDay } from '@/lib/pos/page'
import { posStatus, posTone } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

/** POS overview: today's confirmed sales (from pos_report), open shifts, what needs attention. */
export default async function PosHome() {
  const { locale, tr, f, money, supabase, user, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const today = prDay()
  const [{ data: rep }, { data: shifts }, { data: recent }] = await Promise.all([
    supabase.rpc('pos_report', { target: companyId, p_from: today, p_to: today, branch: null }),
    supabase.from('pos_shifts').select('id, number, cashier_id, status, opened_at').eq('company_id', companyId).in('status', ['open', 'pending_review']).order('opened_at', { ascending: false }),
    supabase.from('pos_sales').select('id, number, source, total_cents, status, occurred_at').eq('company_id', companyId).order('occurred_at', { ascending: false }).limit(8),
  ])
  const r = (rep ?? { totals: {}, sync: {} }) as { totals: Record<string, number>; sync: Record<string, number> }
  const list = (shifts ?? []) as { id: string; number: string; cashier_id: string; status: string; opened_at: string }[]
  const mine = list.find((s) => s.cashier_id === user.id && s.status === 'open')
  const sales = (recent ?? []) as { id: string; number: string; source: string; total_cents: number; status: string; occurred_at: string }[]
  const attention = (r.sync?.needs_review ?? 0) + (r.sync?.failed ?? 0) + (r.sync?.inventory_blocked ?? 0) + list.filter((s) => s.status === 'pending_review').length
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Operaciones', 'Operations')} title={tr('Punto de venta', 'Point of sale')}
        description={tr('Ventas de la caja de BusinessAI y de los sistemas conectados en un solo registro: inventario, pagos y contabilidad al confirmar cada venta.',
          'Sales from the BusinessAI register and connected systems in one record: stock, payments and accounting when each sale is confirmed.')}
        actions={access.sell ? <Link href="/pos/register" className="btn-primary min-h-11">{mine ? tr('Seguir vendiendo', 'Keep selling') : tr('Abrir caja', 'Open register')}</Link> : undefined} />
      <PosNav tr={tr} current="/pos" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="receipt" label={tr('Ventas de hoy', 'Sales today')} value={String(r.totals?.sales ?? 0)} hint={tr('Confirmadas (sin anuladas)', 'Confirmed (voids excluded)')} />
        <StatCard icon="wallet" tone="gold" label={tr('Neto de hoy', 'Net today')} value={<span data-testid="pos-net-today">{money(r.totals?.net_cents ?? 0)}</span>} hint={tr('Total menos devoluciones', 'Total minus refunds')} />
        <StatCard icon="clock" label={tr('Turnos abiertos', 'Open shifts')} value={String(list.filter((s) => s.status === 'open').length)} />
        <StatCard icon="alert" tone="warning" label={tr('Requiere atención', 'Needs attention')} value={String(attention)} hint={tr('Diferencias, sincronización e inventario', 'Differences, sync and stock')} />
      </div>
      <section className="card min-w-0 p-5" aria-labelledby="recent-title">
        <div className="flex items-center justify-between"><h2 id="recent-title" className="font-display text-lg font-semibold text-fg">{tr('Últimas ventas', 'Latest sales')}</h2>
          <Link href="/pos/sales" className="text-sm text-accent hover:underline">{tr('Ver todas', 'See all')}</Link></div>
        {sales.length === 0 ? <EmptyState icon="receipt" title={tr('Sin ventas todavía', 'No sales yet')} description={tr('Abre tu turno y registra la primera venta, o conecta tu sistema actual.', 'Open your shift and record the first sale, or connect your current system.')} /> : (
          <ul className="mt-3 divide-y divide-line/60 text-sm">{sales.map((s) => (
            <li key={s.id}><Link href={`/pos/sales/${s.id}`} className="flex items-center justify-between gap-2 py-2.5">
              <span className="min-w-0"><span className="block font-semibold text-fg">{s.number}</span><span className="text-xs text-muted">{f.date(s.occurred_at.slice(0, 10))} · {s.source === 'native' ? 'BusinessAI' : tr('Externa', 'External')}</span></span>
              <span className="flex shrink-0 items-center gap-2"><StateChip tone={posTone(s.status)}>{posStatus(s.status, locale)}</StateChip><span className="font-semibold tabular-nums">{money(s.total_cents)}</span></span>
            </Link></li>))}</ul>)}
      </section>
    </div>
  )
}

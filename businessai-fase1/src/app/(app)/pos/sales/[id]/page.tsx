import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import PrintButton from '@/components/PrintButton'
import { StateChip } from '@/components/bank-nav'
import { NoPosAccess, Flash } from '@/components/pos/nav'
import { postBlockedInventory, refundSale, voidSale } from '@/app/actions/pos'
import { posPage } from '@/lib/pos/page'
import { methodLabel, posMessage, posStatus, posTone } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

const DONE: Record<string, [string, string]> = { voided: ['Venta anulada.', 'Sale voided.'], refunded: ['Devolución registrada.', 'Refund recorded.'], stock_posted: ['Inventario aplicado.', 'Stock posted.'] }

/** A sale: printable receipt (amounts as sold), payments, refunds; void / refund / blocked stock. */
export default async function PosSale({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: sale } = await supabase.from('pos_sales').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!sale) notFound()
  const s = sale as Record<string, string & number> & { status: string; source: string; inventory_status: string }
  const [{ data: lines }, { data: pays }, { data: refunds }, { data: branch }, { data: reg }, { data: settings }, { data: profile }, { data: client }] = await Promise.all([
    supabase.from('pos_sale_lines').select('id, line_no, name, sku, quantity, unit_price_cents, gross_cents, discount_cents, tax_name, tax_rate, tax_cents, total_cents, refunded_qty').eq('sale_id', id).order('line_no'),
    supabase.from('pos_payments').select('id, method, amount_cents, tendered_cents, change_cents, reference, status, refunded_cents, card_brand, card_last4, provider').eq('sale_id', id),
    supabase.from('pos_refunds').select('id, number, amount_cents, method, reason, occurred_at, restock').eq('sale_id', id).order('occurred_at'),
    supabase.from('branches').select('name, address').eq('id', s.branch_id).maybeSingle(),
    s.register_id ? supabase.from('pos_registers').select('name, code').eq('id', s.register_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('pos_settings').select('receipt_header, receipt_footer').eq('company_id', companyId).maybeSingle(),
    supabase.from('company_profiles').select('display_name, legal_name, phone, address').eq('company_id', companyId).maybeSingle(),
    s.client_id ? supabase.from('clients').select('name').eq('id', s.client_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const ls = (lines ?? []) as { id: number; line_no: number; name: string; sku: string | null; quantity: number; unit_price_cents: number; gross_cents: number; discount_cents: number; tax_name: string | null; tax_rate: number; tax_cents: number; total_cents: number; refunded_qty: number }[]
  const ps = (pays ?? []) as { id: string; method: string; amount_cents: number; tendered_cents: number | null; change_cents: number; reference: string | null; status: string; refunded_cents: number; card_brand: string | null; card_last4: string | null }[]
  const rf = (refunds ?? []) as { id: string; number: string; amount_cents: number; method: string; reason: string; occurred_at: string; restock: boolean }[]
  const st = settings as { receipt_header: string | null; receipt_footer: string | null } | null
  const pr = profile as { display_name?: string | null; legal_name?: string | null; phone?: string | null; address?: string | null } | null
  const canRefund = access.sell && ['completed', 'partially_refunded'].includes(s.status)
  const canVoid = access.sell && s.source === 'native' && s.status === 'completed' && Number(s.refunded_cents) === 0
  const back = `/pos/sales/${id}`
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/pos/sales" className="text-sm text-accent hover:underline">← {tr('Ventas', 'Sales')}</Link>
        <PrintButton label={tr('Imprimir recibo', 'Print receipt')} />
      </div>
      <Flash done={sp.done && DONE[sp.done] ? tr(...DONE[sp.done]) : null} error={posMessage(sp.error, locale)} />
      <article className="card mx-auto max-w-md p-6 print:max-w-none print:border-0 print:p-0" data-testid="pos-receipt">
        <header className="text-center">
          <p className="font-display text-lg font-semibold text-fg">{pr?.display_name ?? pr?.legal_name ?? ''}</p>
          <p className="text-xs text-muted">{(branch as { name: string } | null)?.name}{pr?.phone ? ` · ${pr.phone}` : ''}</p>
          {st?.receipt_header && <p className="mt-1 text-xs text-muted">{st.receipt_header}</p>}
          <p className="mt-3 text-sm font-semibold text-fg" data-testid="receipt-number">{s.number}</p>
          <p className="text-xs text-muted">{f.date(String(s.occurred_at).slice(0, 10))} {new Date(s.occurred_at).toLocaleTimeString(locale === 'en' ? 'en-US' : 'es-PR', { timeZone: 'America/Puerto_Rico', hour: '2-digit', minute: '2-digit' })}
            {reg ? ` · ${(reg as { name: string }).name}` : ''}{s.cashier_ref ? ` · ${s.cashier_ref}` : ''}</p>
          {client && <p className="text-xs text-muted">{tr('Cliente', 'Client')}: {(client as { name: string }).name}</p>}
          <p className="mt-2"><StateChip tone={posTone(s.status)}>{posStatus(s.status, locale)}</StateChip>{s.inventory_status === 'blocked' && <span className="ml-1"><StateChip tone="issue">{posStatus('blocked', locale)}</StateChip></span>}</p>
        </header>
        <table className="mt-4 w-full text-sm">
          <tbody>{ls.map((l) => (
            <tr key={l.id} className="border-b border-line/40 align-top">
              <td className="py-1.5 pr-2"><span className="text-fg">{l.name}</span><span className="block text-xs text-muted">{Number(l.quantity)} × {money(l.unit_price_cents)}{l.discount_cents > 0 ? ` · −${money(l.discount_cents)}` : ''}{l.refunded_qty > 0 ? ` · ${tr('devuelto', 'refunded')} ${Number(l.refunded_qty)}` : ''}</span></td>
              <td className="py-1.5 text-right tabular-nums">{money(l.gross_cents - l.discount_cents)}</td>
            </tr>))}</tbody>
        </table>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted">{tr('Subtotal', 'Subtotal')}</dt><dd className="tabular-nums">{money(s.subtotal_cents)}</dd></div>
          {Number(s.discount_cents) > 0 && <div className="flex justify-between"><dt className="text-muted">{tr('Descuentos', 'Discounts')}</dt><dd className="tabular-nums">−{money(s.discount_cents)}</dd></div>}
          {[...new Map(ls.map((l) => [`${l.tax_name ?? ''}|${l.tax_rate}`, l])).keys()].map((k) => {
            const [n, r] = k.split('|'); const t = ls.filter((l) => `${l.tax_name ?? ''}|${l.tax_rate}` === k).reduce((a, l) => a + Number(l.tax_cents), 0)
            return t > 0 ? <div key={k} className="flex justify-between"><dt className="text-muted">{n || tr('Impuesto', 'Tax')} ({Number(r)}%)</dt><dd className="tabular-nums">{money(t)}</dd></div> : null
          })}
          <div className="flex justify-between text-lg font-bold text-fg"><dt>{tr('Total', 'Total')}</dt><dd className="tabular-nums" data-testid="receipt-total">{money(s.total_cents)}</dd></div>
          {ps.map((p) => (
            <div key={p.id} className="flex justify-between text-xs text-muted"><dt>{methodLabel(p.method, locale)}{p.card_last4 ? ` ···${p.card_last4}` : ''}{p.reference ? ` · ${p.reference}` : ''}{p.status !== 'captured' ? ` (${posStatus(p.status === 'voided' ? 'voided' : p.status === 'refunded' ? 'refunded' : 'partially_refunded', locale)})` : ''}</dt>
              <dd className="tabular-nums">{money(p.tendered_cents ?? p.amount_cents)}{p.change_cents > 0 ? ` · ${tr('cambio', 'change')} ${money(p.change_cents)}` : ''}</dd></div>))}
          {Number(s.refunded_cents) > 0 && <div className="flex justify-between text-sm text-amber-200"><dt>{tr('Devuelto', 'Refunded')}</dt><dd className="tabular-nums">−{money(s.refunded_cents)}</dd></div>}
        </dl>
        {st?.receipt_footer && <p className="mt-4 text-center text-xs text-muted">{st.receipt_footer}</p>}
      </article>

      {rf.length > 0 && (
        <section className="card mx-auto max-w-md p-5 print:hidden"><h2 className="font-semibold text-fg">{tr('Devoluciones', 'Refunds')}</h2>
          <ul className="mt-2 divide-y divide-line/50 text-sm">{rf.map((r) => <li key={r.id} className="flex justify-between gap-2 py-2"><span><span className="font-semibold">{r.number}</span> · {methodLabel(r.method, locale)}<span className="block text-xs text-muted">{r.reason}{r.restock ? '' : ` · ${tr('sin reingreso al inventario', 'not restocked')}`}</span></span><span className="tabular-nums">−{money(r.amount_cents)}</span></li>)}</ul>
        </section>)}

      {s.inventory_status === 'blocked' && access.approve && (
        <form action={postBlockedInventory} className="card mx-auto max-w-md space-y-2 p-5 print:hidden">
          <input type="hidden" name="sale_id" value={id} /><input type="hidden" name="back" value={back} />
          <p className="text-sm text-muted">{tr('Esta venta externa no descontó inventario porque no había existencias disponibles: ', 'This external sale did not take stock because none was available: ')}{s.inventory_error}</p>
          <button className="btn-secondary min-h-11">{tr('Aplicar inventario ahora', 'Post stock now')}</button>
        </form>)}

      {canRefund && (
        <form action={refundSale} className="card mx-auto max-w-md space-y-3 p-5 print:hidden" data-testid="refund-form">
          <h2 className="font-semibold text-fg">{tr('Devolución', 'Refund')}</h2>
          <input type="hidden" name="sale_id" value={id} /><input type="hidden" name="back" value={back} />
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          {ls.filter((l) => Number(l.quantity) > Number(l.refunded_qty)).map((l) => (
            <label key={l.id} className="flex items-center justify-between gap-2 text-sm">{l.name} <span className="text-xs text-muted">({tr('máx.', 'max')} {Number(l.quantity) - Number(l.refunded_qty)})</span>
              <input name={`qty_${l.id}`} inputMode="decimal" defaultValue="" className="field h-11 w-20 text-right" /></label>))}
          <label className="block text-xs text-muted">{tr('Devolver con', 'Refund with')}
            <select name="method" className="field mt-1 h-11 w-full">{['cash', 'ath_movil', 'card_external', 'transfer', 'check', 'store_credit', 'other'].map((m) => <option key={m} value={m}>{methodLabel(m, locale)}</option>)}</select></label>
          <input name="reference" placeholder={tr('Referencia (ATH, terminal, cheque…)', 'Reference (ATH, terminal, check…)')} className="field h-11 w-full" />
          <input name="reason" required minLength={3} placeholder={tr('Motivo', 'Reason')} className="field h-11 w-full" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="restock" defaultChecked /> {tr('Regresa al inventario (no dañado)', 'Back to stock (not damaged)')}</label>
          {!access.approve && <input name="approval_code" inputMode="numeric" placeholder={tr('Código del supervisor', 'Supervisor code')} className="field h-11 w-full font-mono" />}
          <button className="btn-primary min-h-11 w-full">{tr('Registrar devolución', 'Record refund')}</button>
          <p className="text-[11px] text-muted">{tr('Una devolución a tarjeta se hace en la terminal del procesador; aquí se registra su referencia.', 'A card refund is made on the processor terminal; its reference is recorded here.')}</p>
        </form>)}

      {canVoid && (
        <form action={voidSale} className="card mx-auto max-w-md space-y-3 p-5 print:hidden" data-testid="void-form">
          <h2 className="font-semibold text-fg">{tr('Anular venta', 'Void sale')}</h2>
          <p className="text-xs text-muted">{tr('Solo durante el turno en que se hizo. Repone el inventario y revierte el asiento; queda registrada.', 'Only during the shift it was made in. Restores stock and reverses the entry; it stays on record.')}</p>
          <input type="hidden" name="sale_id" value={id} /><input type="hidden" name="back" value={back} />
          <input name="reason" required minLength={3} placeholder={tr('Motivo', 'Reason')} className="field h-11 w-full" />
          {!access.approve && <input name="approval_code" inputMode="numeric" placeholder={tr('Código del supervisor', 'Supervisor code')} className="field h-11 w-full font-mono" />}
          <button className="btn-secondary min-h-11 w-full border-red-400/40 text-red-200">{tr('Anular', 'Void')}</button>
        </form>)}
    </div>
  )
}

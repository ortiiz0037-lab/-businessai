import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { InventoryNav, NoInventoryAccess } from '@/components/inventory/nav'
import { CountScanner } from '@/components/inventory/scanners'
import { inventoryPage, productCode, productLabel, stockOptions, trackedProducts } from '@/lib/inventory/page'
import { inventoryMessage, qtyText, statusLabel, ZERO_KEY } from '@/lib/inventory/labels'
import { errorMap, scanCopy } from '@/lib/inventory/copy'
import { countSetLine, countStep } from '@/app/actions/inventory'

export const dynamic = 'force-dynamic'
type CLine = { id: number; item_id: string; variant_key: string; counted_qty: number; scans: number; expected_qty: number | null; difference_qty: number | null; updated_at: string }

/** One count: scan (each read adds one) or type quantities; submit to compare; an approver posts the differences. */
export default async function CountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, supabase, companyId, access } = await inventoryPage()
  if (!access.view || !access.available) return <NoInventoryAccess tr={tr} unavailable={!access.available} />
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data: c } = await supabase.from('inventory_counts').select('*, branches(name)').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!c) notFound()
  const count = c as { id: string; number: string; scope: string; status: string; branch_id: string; started_at: string; submitted_at: string | null; approved_at: string | null; branches: { name: string } | null }
  const [products, { data: ls }] = await Promise.all([trackedProducts(supabase, companyId), supabase.from('inventory_count_lines').select('*').eq('count_id', id).order('updated_at', { ascending: false })])
  const lines = (ls ?? []) as CLine[]
  const open = count.status === 'open'
  const submitted = count.status !== 'open'
  const done: Record<string, string> = { started: tr('Conteo abierto: escanea o escribe cantidades.', 'Count open: scan or type quantities.'), counted: tr('Cantidad guardada.', 'Quantity saved.'),
    submit: tr('Conteo enviado: revisa las diferencias.', 'Count submitted: review the differences.'), approve: tr('Conteo aprobado: las existencias ahora coinciden con lo contado.', 'Count approved: stock now matches what was counted.'),
    reopen: tr('Conteo reabierto.', 'Count reopened.'), cancel: tr('Conteo cancelado.', 'Count cancelled.') }
  const vk = (l: CLine) => (l.variant_key === ZERO_KEY ? null : l.variant_key)
  return (
    <div className="space-y-6">
      <Link href="/inventory/counts" className="text-sm font-semibold text-muted hover:text-fg">{tr('← Conteos', '← Counts')}</Link>
      <PageHeader eyebrow={tr('Conteo físico', 'Physical count')} title={`${count.number} · ${count.branches?.name ?? '—'}`}
        description={`${count.scope === 'full' ? tr('Completo: lo que tenga existencias y no se cuente se contará como 0.', 'Full: anything with stock that is not counted is counted as 0.') : tr('Parcial: solo lo contado.', 'Partial: only what is counted.')} · ${f.date(count.started_at.slice(0, 10))}`} />
      <InventoryNav tr={tr} current="/inventory/counts" />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={inventoryMessage(sp.error, locale)} />
      <div className="flex flex-wrap items-center gap-3">
        <StateChip tone={count.status === 'approved' ? 'ok' : count.status === 'cancelled' ? 'issue' : 'pending'}><span data-testid="count-status">{statusLabel(count.status, locale)}</span></StateChip>
        {open && access.operate && <form action={countStep}><input type="hidden" name="count_id" value={id} /><input type="hidden" name="action" value="submit" /><SubmitButton className="w-full sm:w-auto">{tr('Enviar conteo', 'Submit count')}</SubmitButton></form>}
        {count.status === 'submitted' && access.approve && <>
          <form action={countStep}><input type="hidden" name="count_id" value={id} /><input type="hidden" name="action" value="approve" /><SubmitButton className="w-full sm:w-auto">{tr('Aprobar y ajustar existencias', 'Approve and adjust stock')}</SubmitButton></form>
          <form action={countStep}><input type="hidden" name="count_id" value={id} /><input type="hidden" name="action" value="reopen" /><button className="btn-secondary">{tr('Reabrir', 'Reopen')}</button></form></>}
        {['open', 'submitted'].includes(count.status) && access.operate && <form action={countStep}><input type="hidden" name="count_id" value={id} /><input type="hidden" name="action" value="cancel" /><button className="btn-secondary">{tr('Cancelar', 'Cancel')}</button></form>}
      </div>
      {open && access.operate && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card p-5"><h2 className="mb-3 font-display text-lg font-semibold text-fg">{tr('Contar escaneando', 'Count by scanning')}</h2>
            <CountScanner countId={id} copy={scanCopy(tr)} labels={{ added: tr('{name}: {n} contados', '{name}: {n} counted'), unknown: tr('Código desconocido.', 'Unknown code.'),
              notTracked: tr('no controla inventario', 'does not track stock'), errors: errorMap(locale) }} /></section>
          <form action={countSetLine} className="card grid gap-3 p-5" data-testid="count-set">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Escribir una cantidad', 'Type a quantity')}</h2>
            <input type="hidden" name="count_id" value={id} />
            <label className="text-sm"><span className="field-label">{tr('Producto', 'Product')}</span><select name="line" required className="field">{stockOptions(products).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            <label className="text-sm"><span className="field-label">{tr('Cantidad contada', 'Counted quantity')}</span><input name="qty" required inputMode="decimal" className="field" /></label>
            <SubmitButton className="w-full sm:w-auto">{tr('Guardar', 'Save')}</SubmitButton>
          </form>
        </div>
      )}
      <section className="card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm" data-testid="count-lines">
          <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">{tr('Producto', 'Product')}</th><th className="px-3 py-3 text-right">{tr('Contado', 'Counted')}</th>
            <th className="px-3 py-3 text-right">{tr('Escaneos', 'Scans')}</th>{submitted && <><th className="px-3 py-3 text-right">{tr('Registrado', 'Recorded')}</th><th className="px-3 py-3 text-right">{tr('Diferencia', 'Difference')}</th></>}</tr></thead>
          <tbody className="divide-y divide-line/60">{lines.map((l) => (
            <tr key={l.id} data-testid="count-line"><td className="px-4 py-2"><span className="text-fg">{productLabel(products, l.item_id, vk(l))}</span><span className="block text-xs text-muted">{productCode(products, l.item_id, vk(l))}</span></td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums" data-testid="counted">{qtyText(l.counted_qty)}</td><td className="px-3 py-2 text-right tabular-nums">{l.scans}</td>
              {submitted && <><td className="px-3 py-2 text-right tabular-nums">{l.expected_qty === null ? '—' : qtyText(l.expected_qty)}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${Number(l.difference_qty) < 0 ? 'text-red-200' : Number(l.difference_qty) > 0 ? 'text-green-200' : ''}`} data-testid="difference">{l.difference_qty === null ? '—' : `${Number(l.difference_qty) > 0 ? '+' : ''}${qtyText(l.difference_qty)}`}</td></>}
            </tr>))}</tbody>
        </table></div>
      </section>
    </div>
  )
}

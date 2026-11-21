import { randomUUID } from 'node:crypto'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { StateChip } from '@/components/bank-nav'
import { NoPosAccess, PosNav, Flash } from '@/components/pos/nav'
import { ApprovalCodeIssuer } from '@/components/pos/approval-code'
import { cashMove, closeShift, reviewShift } from '@/app/actions/pos'
import { posBranches, posPage } from '@/lib/pos/page'
import { posMessage, posStatus, posTone } from '@/lib/pos/labels'

export const dynamic = 'force-dynamic'

const DENOMS: [string, string][] = [['10000', '$100'], ['5000', '$50'], ['2000', '$20'], ['1000', '$10'], ['500', '$5'], ['100', '$1'], ['25', '25¢'], ['10', '10¢'], ['5', '5¢'], ['1', '1¢']]
const DONE: Record<string, [string, string]> = { cash: ['Movimiento de efectivo registrado.', 'Cash movement recorded.'], shift_closed: ['Turno cerrado.', 'Shift closed.'], reviewed: ['Diferencia revisada.', 'Difference reviewed.'] }

/** Cash drawer: my shift (paid in / out, drops, blind count and close), shifts to review, history. */
export default async function PosShifts({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, user, companyId, access } = await posPage()
  if (!access.view || !access.available) return <NoPosAccess tr={tr} unavailable={!access.available} />
  const branches = await posBranches(supabase, companyId)
  const [{ data: shifts }, { data: regs }] = await Promise.all([
    supabase.from('pos_shifts').select('id, number, register_id, branch_id, cashier_id, status, opened_at, closed_at, opening_float_cents, expected_cash_cents, counted_cash_cents, difference_cents, close_note, review_note')
      .eq('company_id', companyId).order('opened_at', { ascending: false }).limit(60),
    supabase.from('pos_registers').select('id, name').eq('company_id', companyId),
  ])
  const list = (shifts ?? []) as { id: string; number: string; register_id: string; branch_id: string; cashier_id: string; status: string; opened_at: string; closed_at: string | null; opening_float_cents: number; expected_cash_cents: number | null; counted_cash_cents: number | null; difference_cents: number | null; close_note: string | null; review_note: string | null }[]
  const rn = new Map(((regs ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]))
  const mine = list.find((s) => s.cashier_id === user.id && s.status === 'open')
  const { data: moves } = mine ? await supabase.from('pos_cash_movements').select('id, kind, amount_cents, reason, created_at').eq('shift_id', mine.id).order('id') : { data: [] }
  const mv = (moves ?? []) as { id: number; kind: string; amount_cents: number; reason: string | null; created_at: string }[]
  const KIND: Record<string, [string, string]> = { opening_float: ['Fondo inicial', 'Opening float'], paid_in: ['Entrada', 'Paid in'], paid_out: ['Salida', 'Paid out'], drop: ['Retiro a caja fuerte', 'Drop to safe'],
    sale: ['Venta en efectivo', 'Cash sale'], refund: ['Devolución en efectivo', 'Cash refund'], void: ['Anulación', 'Void'] }
  const pending = list.filter((s) => s.status === 'pending_review')
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Punto de venta', 'Point of sale')} title={tr('Caja y turnos', 'Cash & shifts')}
        description={tr('El efectivo esperado sale de los movimientos registrados; el contado se guarda tal cual y toda diferencia se revisa.', 'Expected cash comes from recorded movements; the count is stored as counted and every difference is reviewed.')} />
      <PosNav tr={tr} current="/pos/shifts" />
      <Flash done={sp.done && DONE[sp.done] ? tr(...DONE[sp.done]) : null} error={posMessage(sp.error, locale)} />
      {mine && (
        <section className="grid gap-4 lg:grid-cols-2" data-testid="my-shift">
          <div className="card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Mi turno', 'My shift')} {mine.number} · {rn.get(mine.register_id)}</h2>
            <ul className="divide-y divide-line/50 text-sm">{mv.map((m) => <li key={m.id} className="flex justify-between gap-2 py-1.5"><span>{tr(...(KIND[m.kind] ?? [m.kind, m.kind]))}{m.reason ? <span className="block text-xs text-muted">{m.reason}</span> : null}</span><span className="tabular-nums">{money(m.amount_cents)}</span></li>)}</ul>
            <form action={cashMove} className="grid grid-cols-2 gap-2 border-t border-line pt-3">
              <input type="hidden" name="shift_id" value={mine.id} /><input type="hidden" name="back" value="/pos/shifts" /><input type="hidden" name="idempotency_key" value={randomUUID()} />
              <select name="kind" className="field h-11"><option value="paid_in">{tr('Entrada de efectivo', 'Paid in')}</option><option value="paid_out">{tr('Salida de efectivo', 'Paid out')}</option><option value="drop">{tr('Retiro a caja fuerte', 'Drop to safe')}</option></select>
              <input name="amount" inputMode="decimal" placeholder="0.00" className="field h-11 text-right" required />
              <input name="reason" placeholder={tr('Motivo', 'Reason')} className="field col-span-2 h-11" required minLength={3} />
              {!access.approve && <input name="approval_code" inputMode="numeric" placeholder={tr('Código del supervisor (salidas y retiros)', 'Supervisor code (paid out and drops)')} className="field col-span-2 h-11 font-mono" />}
              <button className="btn-secondary col-span-2 min-h-11">{tr('Registrar', 'Record')}</button>
            </form>
          </div>
          <form action={closeShift} className="card space-y-3 p-5" data-testid="close-shift">
            <h2 className="font-display text-lg font-semibold text-fg">{tr('Arqueo y cierre', 'Count and close')}</h2>
            <p className="text-xs text-muted">{tr('Cuenta el efectivo sin mirar el esperado. Lo que escribas se guarda tal cual.', 'Count the cash without looking at the expected amount. What you type is stored as is.')}</p>
            <input type="hidden" name="shift_id" value={mine.id} /><input type="hidden" name="back" value="/pos/shifts" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{DENOMS.map(([c, l]) => <label key={c} className="text-xs text-muted">{l}<input name={`d_${c}`} inputMode="numeric" className="field mt-1 h-11 w-full text-right" /></label>)}</div>
            <label className="block text-xs text-muted">{tr('…o el total contado', '…or the counted total')}<input name="counted" inputMode="decimal" className="field mt-1 h-11 w-full text-right" data-testid="counted" /></label>
            <input name="note" placeholder={tr('Nota (obligatoria si hay diferencia)', 'Note (required if there is a difference)')} className="field h-11 w-full" />
            <button className="btn-primary min-h-12 w-full">{tr('Cerrar turno', 'Close shift')}</button>
          </form>
        </section>
      )}
      {access.approve && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="card p-5"><h2 className="font-display text-lg font-semibold text-fg">{tr('Diferencias por revisar', 'Differences to review')}</h2>
            {pending.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('Nada pendiente.', 'Nothing pending.')}</p> : pending.map((s) => (
              <form key={s.id} action={reviewShift} className="mt-3 space-y-2 rounded-xl border border-line p-3 text-sm">
                <input type="hidden" name="shift_id" value={s.id} /><input type="hidden" name="back" value="/pos/shifts" />
                <p><strong>{s.number}</strong> · {rn.get(s.register_id)} · {tr('esperado', 'expected')} {money(s.expected_cash_cents)} · {tr('contado', 'counted')} {money(s.counted_cash_cents)} ·{' '}
                  <span className={Number(s.difference_cents) < 0 ? 'text-red-200' : 'text-green-200'}>{money(s.difference_cents)}</span></p>
                {s.close_note && <p className="text-xs text-muted">{s.close_note}</p>}
                <input name="note" required minLength={3} placeholder={tr('Nota de revisión', 'Review note')} className="field h-11 w-full" />
                <button className="btn-secondary min-h-11">{tr('Revisar y contabilizar', 'Review and post')}</button>
              </form>))}
          </div>
          <ApprovalCodeIssuer locale={locale} branches={branches} />
        </section>
      )}
      <section className="card min-w-0 overflow-hidden"><h2 className="p-5 pb-0 font-display text-lg font-semibold text-fg">{tr('Historial de cierres', 'Closing history')}</h2>
        {list.length === 0 ? <EmptyState icon="clock" title={tr('Sin turnos', 'No shifts')} /> : (
          <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[620px] text-sm"><thead><tr className="border-b border-line text-left text-xs text-muted"><th className="p-3">{tr('Turno', 'Shift')}</th><th className="p-3">{tr('Caja', 'Register')}</th><th className="p-3">{tr('Apertura', 'Opened')}</th><th className="p-3">{tr('Estado', 'Status')}</th><th className="p-3 text-right">{tr('Diferencia', 'Difference')}</th></tr></thead>
            <tbody>{list.map((s) => <tr key={s.id} className="border-b border-line/50"><td className="p-3 font-semibold">{s.number}</td><td className="p-3">{rn.get(s.register_id)}</td><td className="p-3 text-muted">{f.date(s.opened_at.slice(0, 10))}</td>
              <td className="p-3"><StateChip tone={posTone(s.status)}>{posStatus(s.status, locale)}</StateChip></td><td className="p-3 text-right tabular-nums">{s.difference_cents === null ? '—' : money(s.difference_cents)}</td></tr>)}</tbody></table></div>)}
      </section>
    </div>
  )
}

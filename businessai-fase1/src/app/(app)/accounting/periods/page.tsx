import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { AccountingNav, Flash, NoAccountingAccess } from '@/components/accounting-nav'
import { accountingPage } from '@/lib/finance/page'
import { ledgerMessage, sourceLabel } from '@/lib/finance/ledger'
import { closePeriod, reopenPeriod } from '@/app/actions/accounting'

export const dynamic = 'force-dynamic'

type Period = { period_month: string; status: 'open' | 'closed'; closed_at: string | null; closed_by: string | null; reopened_at: string | null; reopened_by: string | null; reopen_reason: string | null }
type Event = { id: number; entity: string; entity_id: string | null; action: string; details: Record<string, unknown>; actor: string | null; created_at: string }

/** Accounting periods (close / reopen) and the full accounting history. */
export default async function PeriodsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const p = await searchParams
  const { locale, tr, f, money, today, supabase, companyId, access } = await accountingPage()
  if (!access.view) return <NoAccountingAccess tr={tr} unavailable={!access.available} />
  const [{ data: per }, { data: ev }, { data: members }] = await Promise.all([
    supabase.from('accounting_periods').select('*').eq('company_id', companyId),
    supabase.from('ledger_events').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(60),
    supabase.rpc('company_members', { target: companyId }),
  ])
  const periods = new Map(((per ?? []) as Period[]).map((r) => [r.period_month.slice(0, 7), r]))
  const events = (ev ?? []) as Event[]
  const who = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? '']))
  const name = (id: string | null) => (id ? who.get(id) || tr('usuario', 'user') : tr('Sistema', 'System'))
  // The current month and the 12 before it.
  const [y, m] = today.split('-').map(Number)
  const months = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    return d.toISOString().slice(0, 7)
  })
  const current = today.slice(0, 7)
  const done: Record<string, string> = { closed: tr('Mes cerrado.', 'Month closed.'), reopened: tr('Mes reabierto; quedó registrado el motivo.', 'Month reopened; the reason was recorded.') }
  const actionLabel = (e: Event) => {
    const es: Record<string, string> = { posted: 'Asiento publicado', reversed: 'Reversión publicada', closed: 'Mes cerrado', reopened: 'Mes reabierto', initialized: 'Contabilidad activada',
      history_imported: 'Historial importado', created: 'Cuenta creada', updated: 'Cuenta modificada', archived: 'Cuenta archivada', restored: 'Cuenta reactivada', deleted: 'Cuenta borrada' }
    const en: Record<string, string> = { posted: 'Entry posted', reversed: 'Reversal posted', closed: 'Month closed', reopened: 'Month reopened', initialized: 'Accounting activated',
      history_imported: 'History imported', created: 'Account created', updated: 'Account changed', archived: 'Account archived', restored: 'Account restored', deleted: 'Account deleted' }
    return (locale === 'en' ? en : es)[e.action] ?? e.action
  }
  const detail = (e: Event) => {
    const d = e.details ?? {}
    if (e.entity === 'journal_entries') return `${sourceLabel(String(d.source ?? ''), locale)} · ${money(d.total_cents as number)} · ${d.date ?? ''}`
    if (e.entity === 'ledger_accounts') return `${d.code ?? ''} · ${d.name ?? ''}${d.previous_name && d.previous_name !== d.name ? ` (${tr('antes', 'was')} ${d.previous_name})` : ''}`
    if (e.entity === 'accounting_periods') return `${e.entity_id ?? ''}${d.reason ? ` · ${d.reason}` : ''}`
    if (e.action === 'history_imported') return tr(`${d.entries ?? 0} asientos`, `${d.entries ?? 0} entries`)
    return ''
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Contabilidad', 'Accounting')} title={tr('Periodos e historial', 'Periods and history')}
        description={tr('Un mes cerrado no admite asientos con fecha en él, ni siquiera automáticos. Cierran el propietario y los administradores; solo el propietario reabre, con un motivo.',
          'A closed month takes no entries dated in it, not even automatic ones. The owner and admins close; only the owner reopens, with a reason.')} />
      <AccountingNav tr={tr} current="/accounting/periods" />
      <Flash done={p.done ? done[p.done] : null} error={ledgerMessage(p.error, locale)} />

      <section className="card overflow-hidden" aria-labelledby="periods-title">
        <h2 id="periods-title" className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Periodos contables', 'Accounting periods')}</h2>
        <ul className="divide-y divide-line/60">
          {months.map((key) => {
            const r = periods.get(key)
            const closed = r?.status === 'closed'
            return (
              <li key={key} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <p className="font-semibold text-fg">{f.monthLong(key)} {closed ? <span className="badge-warning ml-2">{tr('Cerrado', 'Closed')}</span> : <span className="badge-success ml-2">{tr('Abierto', 'Open')}</span>}</p>
                  {closed && r?.closed_at && <p className="text-xs text-muted">{tr('Cerrado por', 'Closed by')} {name(r.closed_by)} · {f.dateTime(r.closed_at)}</p>}
                  {!closed && r?.reopened_at && <p className="text-xs text-muted">{tr('Reabierto por', 'Reopened by')} {name(r.reopened_by)} · {f.dateTime(r.reopened_at)} · {r.reopen_reason}</p>}
                </div>
                {!closed && key < current && access.close && access.initialized && (
                  <form action={closePeriod}><input type="hidden" name="month" value={key} />
                    <button type="submit" className="btn-secondary btn-sm">{tr('Cerrar mes', 'Close month')}</button></form>
                )}
                {closed && access.reopen && (
                  <form action={reopenPeriod} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="month" value={key} />
                    <label className="text-sm"><span className="sr-only">{tr('Motivo', 'Reason')}</span>
                      <input name="reason" required minLength={3} maxLength={300} placeholder={tr('Motivo para reabrir', 'Reason to reopen')} className="field" /></label>
                    <SubmitButton className="w-full sm:w-auto">{tr('Reabrir', 'Reopen')}</SubmitButton>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="card overflow-hidden" aria-labelledby="history-title">
        <h2 id="history-title" className="border-b border-line px-5 py-3 font-display text-lg font-semibold text-fg">{tr('Historial contable', 'Accounting history')}</h2>
        {events.length === 0
          ? <p className="p-5 text-sm text-muted">{tr('Sin actividad todavía.', 'No activity yet.')}</p>
          : (
            <ul className="divide-y divide-line/60">
              {events.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0"><span className="font-semibold text-fg">{actionLabel(e)}</span> <span className="text-muted">· {detail(e)}</span></span>
                  <span className="shrink-0 text-xs text-muted">{name(e.actor)} · {f.dateTime(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        <p className="border-t border-line px-5 py-3 text-xs text-muted">{tr('Este historial no se puede editar ni borrar.', 'This history cannot be edited or deleted.')}</p>
      </section>
    </div>
  )
}

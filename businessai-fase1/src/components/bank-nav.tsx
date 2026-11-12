import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of bank reconciliation (scroll horizontally on phones). */
export function BankNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/bank', tr('Resumen', 'Overview')],
    ['/bank/accounts', tr('Cuentas', 'Accounts')],
    ['/bank/import', tr('Importar estado', 'Import statement')],
    ['/bank/reconciliations', tr('Conciliaciones', 'Reconciliations')],
    ['/bank/reports', tr('Informes', 'Reports')],
  ]
  return (
    <nav aria-label={tr('Bancos', 'Banking')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href
                ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoBankAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Bancos', 'Banking')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable ? tr('La conciliación bancaria todavía no está activada en esta base de datos.', 'Bank reconciliation is not enabled in this database yet.')
          : tr('Solo el propietario y los administradores acceden a bancos.', 'Only the owner and admins can open banking.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

/** Reconciled / pending / discrepancy chip (colour + text, never colour alone). */
export function StateChip({ tone, children }: { tone: 'ok' | 'pending' | 'issue'; children: React.ReactNode }) {
  const cls = { ok: 'border-green-400/40 bg-green-400/10 text-green-200', pending: 'border-amber-400/40 bg-amber-400/10 text-amber-200', issue: 'border-red-400/40 bg-red-400/10 text-red-200' }[tone]
  const dot = { ok: 'bg-green-400', pending: 'bg-amber-400', issue: 'bg-red-400' }[tone]
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}><span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />{children}</span>
}

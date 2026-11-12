import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of the accounting module (scroll horizontally on phones). */
export function AccountingNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/accounting', tr('Resumen', 'Overview')],
    ['/accounting/journal', tr('Libro diario', 'Journal')],
    ['/accounting/ledger', tr('Mayor por cuenta', 'Account ledger')],
    ['/accounting/trial-balance', tr('Balance de comprobación', 'Trial balance')],
    ['/accounting/accounts', tr('Catálogo de cuentas', 'Chart of accounts')],
    ['/accounting/periods', tr('Periodos e historial', 'Periods and history')],
  ]
  return (
    <nav aria-label={tr('Contabilidad', 'Accounting')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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

export function NoAccountingAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Contabilidad', 'Accounting')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable
          ? tr('La contabilidad todavía no está activada en esta base de datos.', 'Accounting is not enabled in this database yet.')
          : tr('Solo el propietario y los administradores acceden a la contabilidad.', 'Only the owner and admins can open accounting.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

/** Status / error banner from the query string. */
export function Flash({ done, error }: { done?: string | null; error?: string | null }) {
  return (
    <>
      {done && <div role="status" className="alert-success p-4">{done}</div>}
      {error && <div role="alert" className="alert-danger p-4">{error}</div>}
    </>
  )
}

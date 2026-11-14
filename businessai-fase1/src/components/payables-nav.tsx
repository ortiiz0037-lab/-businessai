import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of the expenses module (scroll horizontally on phones). */
export function PayablesNav({ tr, current, full }: { tr: Tr; current: string; full: boolean }) {
  const items = [
    ['/payables', tr('Gastos y facturas', 'Expenses and bills')],
    ['/payables/vendors', tr('Proveedores', 'Vendors')],
    ...(full ? [
      ['/payables/recurring', tr('Recurrentes', 'Recurring')],
      ['/payables/reports', tr('Informes', 'Reports')],
      ['/payables/settings', tr('Categorías y aprobación', 'Categories and approval')],
    ] : []),
  ]
  return (
    <nav aria-label={tr('Gastos', 'Expenses')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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

export function NoPayablesAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Gastos', 'Expenses')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable
          ? tr('El módulo de gastos todavía no está activado en esta base de datos.', 'The expenses module is not enabled in this database yet.')
          : tr('No tienes acceso a esta sección.', 'You do not have access to this section.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

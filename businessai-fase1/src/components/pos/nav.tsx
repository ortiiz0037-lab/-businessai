import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of the point of sale (scroll horizontally on phones). */
export function PosNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/pos', tr('Resumen', 'Overview')],
    ['/pos/register', tr('Vender', 'Sell')],
    ['/pos/sales', tr('Ventas', 'Sales')],
    ['/pos/shifts', tr('Caja y turnos', 'Cash & shifts')],
    ['/pos/reports', tr('Informes', 'Reports')],
    ['/pos/integrations', tr('Integraciones', 'Integrations')],
    ['/pos/settings', tr('Ajustes', 'Settings')],
  ]
  return (
    <nav aria-label={tr('Punto de venta', 'Point of sale')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href
                ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>{label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoPosAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Punto de venta', 'Point of sale')}</h1>
      <p className="mt-2 text-sm text-muted">{unavailable ? tr('El punto de venta todavía no está activado en esta base de datos (migración 0044).', 'The point of sale is not enabled in this database yet (migration 0044).')
        : tr('Tu rol no tiene acceso al punto de venta.', 'Your role has no access to the point of sale.')}</p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

/** ?done= / ?error= banner of the POS pages */
export function Flash({ done, error }: { done?: string | null; error?: string | null }) {
  if (!done && !error) return null
  return <p role={error ? 'alert' : 'status'} className={error ? 'alert-danger' : 'alert-info'} data-testid={error ? 'pos-error' : 'pos-done'}>{error ?? done}</p>
}

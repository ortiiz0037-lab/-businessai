import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of inventory (scroll horizontally on phones). */
export function InventoryNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/inventory', tr('Resumen', 'Overview')],
    ['/inventory/scan', tr('Escáner', 'Scanner')],
    ['/inventory/stock', tr('Existencias', 'Stock')],
    ['/inventory/movements', tr('Movimientos', 'Movements')],
    ['/inventory/purchase-orders', tr('Compras y recepción', 'Purchasing')],
    ['/inventory/transfers', tr('Transferencias', 'Transfers')],
    ['/inventory/counts', tr('Conteos', 'Counts')],
    ['/inventory/replenishment', tr('Reposición', 'Replenishment')],
    ['/inventory/reports', tr('Informes', 'Reports')],
    ['/inventory/settings', tr('Ajustes', 'Settings')],
  ]
  return (
    <nav aria-label={tr('Inventario', 'Inventory')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href
                ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>{label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoInventoryAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Inventario', 'Inventory')}</h1>
      <p className="mt-2 text-sm text-muted">{unavailable ? tr('El inventario todavía no está activado en esta base de datos (migración 0043).', 'Inventory is not enabled in this database yet (migration 0043).')
        : tr('Tu rol no tiene acceso al inventario.', 'Your role has no access to inventory.')}</p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

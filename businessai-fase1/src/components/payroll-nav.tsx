import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of payroll (scrolls horizontally on phones). */
export function PayrollNav({ tr, current, manage }: { tr: Tr; current: string; manage: boolean }) {
  const items = [
    ['/payroll', tr('Nóminas', 'Pay runs')],
    ['/payroll/employees', tr('Compensación', 'Compensation')],
    ['/payroll/reports', tr('Informes', 'Reports')],
    ...(manage ? [['/payroll/settings', tr('Configuración', 'Settings')]] : []),
  ]
  return (
    <nav aria-label={tr('Nómina', 'Payroll')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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

export function NoPayrollAccess({ tr, reason }: { tr: Tr; reason: 'role' | 'plan' | 'unavailable' }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center" data-testid="payroll-denied">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Nómina', 'Payroll')}</h1>
      <p className="mt-2 text-sm text-muted">
        {reason === 'plan' ? tr('Tu plan no incluye nómina (disponible en Pro y Premium).', 'Your plan does not include payroll (available on Pro and Premium).')
          : reason === 'unavailable' ? tr('La nómina todavía no está activada en esta base de datos.', 'Payroll is not enabled in this database yet.')
          : tr('Solo el propietario y los administradores ven la nómina y los salarios.', 'Only the owner and admins see payroll and pay.')}
      </p>
      {reason === 'plan' && <Link href="/billing" className="btn-primary mt-5">{tr('Ver planes', 'See plans')}</Link>}
    </div>
  )
}

export function TaxNotice({ tr }: { tr: Tr }) {
  return (
    <div role="note" className="alert-warning p-4 text-sm" data-testid="tax-notice">
      <p className="font-semibold">{tr('Impuestos y retenciones: NO calculados.', 'Taxes and withholdings: NOT calculated.')}</p>
      <p className="mt-1">{tr('Las reglas de Puerto Rico y federales están desactivadas hasta contar con reglas verificadas y aprobadas. El neto mostrado es el bruto menos las deducciones que configuraste; no incluye impuestos ni es asesoría legal o contributiva.',
        'Puerto Rico and federal rules stay disabled until verified and approved rules exist. The net shown is gross minus the deductions you configured; it includes no taxes and is not legal or tax advice.')}</p>
    </div>
  )
}

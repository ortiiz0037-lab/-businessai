import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of the workforce module (scrolls horizontally on phones). */
export function WorkforceNav({ tr, current, manages }: { tr: Tr; current: string; manages: boolean }) {
  const items = [
    ['/workforce', tr('En vivo', 'Live')],
    ['/workforce/employees', tr('Empleados', 'Employees')],
    ['/workforce/schedule', tr('Horarios', 'Schedules')],
    ['/workforce/requests', tr('Solicitudes', 'Requests')],
    ['/workforce/reports', tr('Informes', 'Reports')],
    ...(manages ? [['/workforce/settings', tr('Reglas', 'Rules')]] : []),
  ]
  return (
    <nav aria-label={tr('Personal', 'Workforce')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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

export function NoWorkforceAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Personal', 'Workforce')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable
          ? tr('El módulo de personal todavía no está activado en esta base de datos.', 'The workforce module is not enabled in this database yet.')
          : tr('Solo el propietario, los administradores y los supervisores de departamento acceden a esta sección. Si eres empleado, usa el reloj ponchador.',
            'Only the owner, admins and department supervisors can open this section. If you are an employee, use the time clock.')}
      </p>
      <Link href="/clock" className="btn-primary mt-5">{tr('Ir al reloj ponchador', 'Go to the time clock')}</Link>
    </div>
  )
}

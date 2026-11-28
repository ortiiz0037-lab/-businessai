import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of Document Studio (scroll horizontally on phones). */
export function StudioNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/studio', tr('Documentos', 'Documents')],
    ['/studio/new', tr('Nuevo', 'New')],
    ['/studio/templates', tr('Plantillas', 'Templates')],
    ['/studio/brand', tr('Identidad', 'Identity')],
  ]
  return (
    <nav aria-label="Document Studio" className="-mx-4 overflow-x-auto px-4 print:hidden sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} aria-current={current === href ? 'page' : undefined}
              className={`inline-flex rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${current === href ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line bg-card text-slate-300 hover:border-electric/40'}`}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function NoStudioAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">Document Studio</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable ? tr('Document Studio todavía no está activado en esta base de datos.', 'Document Studio is not enabled in this database yet.')
          : tr('No tienes acceso a Document Studio en esta empresa.', 'You do not have access to Document Studio in this company.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

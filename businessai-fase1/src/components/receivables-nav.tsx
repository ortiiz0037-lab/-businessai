import Link from 'next/link'
import type { Tr } from '@/lib/i18n/t'

/** Section tabs of the receivables module (scroll horizontally on phones). */
export function ReceivablesNav({ tr, current }: { tr: Tr; current: string }) {
  const items = [
    ['/receivables', tr('Cobros', 'Collections')],
    ['/receivables/aging', tr('Antigüedad de saldos', 'Aging')],
    ['/receivables/reports', tr('Informes', 'Reports')],
    ['/receivables/settings', tr('Recordatorios', 'Reminders')],
  ]
  return (
    <nav aria-label={tr('Cuentas por cobrar', 'Receivables')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
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

export function NoReceivablesAccess({ tr, unavailable }: { tr: Tr; unavailable: boolean }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-2xl font-semibold text-fg">{tr('Cuentas por cobrar', 'Receivables')}</h1>
      <p className="mt-2 text-sm text-muted">
        {unavailable ? tr('Cuentas por cobrar todavía no está activado en esta base de datos.', 'Receivables is not enabled in this database yet.')
          : tr('Solo el propietario y los administradores acceden a cuentas por cobrar.', 'Only the owner and admins can open receivables.')}
      </p>
      <Link href="/dashboard" className="btn-primary mt-5">{tr('Volver al inicio', 'Back to home')}</Link>
    </div>
  )
}

/** Aging bars (0–30 / 31–60 / 61–90 / 90+) drawn with widths, no chart library. */
export function AgingBars({ rows }: { rows: { label: string; cents: number | bigint; value: string; tone: string }[] }) {
  const max = rows.reduce((m, r) => (BigInt(r.cents) > m ? BigInt(r.cents) : m), 0n)
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const pct = max > 0n ? Number((BigInt(r.cents) * 1000n) / max) / 10 : 0
        return (
          <li key={r.label} className="space-y-1">
            <div className="flex justify-between gap-2 text-sm"><span className="text-slate-300">{r.label}</span><span className="font-semibold tabular-nums text-fg">{r.value}</span></div>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.05]" aria-hidden="true">
              <div className={`h-full rounded-full ${r.tone}`} style={{ width: `${pct}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

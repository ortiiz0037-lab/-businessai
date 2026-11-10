import type { IconName } from '@/components/ui/icon'

/** Document status → Spanish label and badge style (one place for the whole app). */
const STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: 'Borrador', className: 'badge-neutral' },
  sent: { label: 'Enviado', className: 'badge-accent' },
  paid: { label: 'Pagado', className: 'badge-success' },
  overdue: { label: 'Vencido', className: 'badge-danger' },
  cancelled: { label: 'Cancelado', className: 'badge-neutral opacity-70' },
}

export function documentStatus(status: string | null | undefined) {
  return STATUS[status ?? ''] ?? { label: status || 'Pendiente', className: 'badge-warning' }
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = documentStatus(status)
  return <span className={s.className}>{s.label}</span>
}

/** Icon for each document type. */
export function documentIcon(type: string | null | undefined): IconName {
  switch (type) {
    case 'invoice': return 'receipt'
    case 'quote': return 'clipboard'
    case 'receipt': return 'wallet'
    case 'work_order': return 'settings'
    case 'letter': return 'mail'
    case 'payment_reminder': return 'clock'
    default: return 'file'
  }
}

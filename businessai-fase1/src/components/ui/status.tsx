import type { IconName } from '@/components/ui/icon'
import type { Locale } from '@/lib/i18n/app'

/**
 * Document status → label (Spanish / English) and badge style (one place for
 * the whole app). Includes the statuses derived from payments (partial) and
 * the quote answers (accepted / rejected); cancelled documents are voided.
 */
const STATUS: Record<string, { es: string; en: string; className: string }> = {
  draft: { es: 'Borrador', en: 'Draft', className: 'badge-neutral' },
  sent: { es: 'Enviado', en: 'Sent', className: 'badge-accent' },
  partial: { es: 'Pago parcial', en: 'Partly paid', className: 'badge-warning' },
  paid: { es: 'Pagado', en: 'Paid', className: 'badge-success' },
  overdue: { es: 'Vencido', en: 'Overdue', className: 'badge-danger' },
  accepted: { es: 'Aceptada', en: 'Accepted', className: 'badge-success' },
  rejected: { es: 'Rechazada', en: 'Rejected', className: 'badge-danger' },
  cancelled: { es: 'Anulado', en: 'Voided', className: 'badge-neutral opacity-70' },
}

export function documentStatus(status: string | null | undefined, locale: Locale = 'es') {
  const s = STATUS[status ?? '']
  if (!s) return { label: status || (locale === 'en' ? 'Pending' : 'Pendiente'), className: 'badge-warning' }
  return { label: s[locale], className: s.className }
}

export function StatusBadge({ status, locale = 'es' }: { status: string | null | undefined; locale?: Locale }) {
  const s = documentStatus(status, locale)
  return <span className={s.className}>{s.label}</span>
}

/** Document type names. */
const TYPE_NAME: Record<string, { es: string; en: string }> = {
  invoice: { es: 'Factura', en: 'Invoice' },
  quote: { es: 'Cotización', en: 'Quote' },
  receipt: { es: 'Recibo', en: 'Receipt' },
  work_order: { es: 'Orden de trabajo', en: 'Work order' },
  letter: { es: 'Carta', en: 'Letter' },
  payment_reminder: { es: 'Recordatorio de pago', en: 'Payment reminder' },
  contract: { es: 'Contrato', en: 'Contract' },
  report: { es: 'Informe', en: 'Report' },
}

export function documentTypeName(type: string | null | undefined, locale: Locale = 'es'): string {
  return TYPE_NAME[type ?? '']?.[locale] ?? (locale === 'en' ? 'Document' : 'Documento')
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

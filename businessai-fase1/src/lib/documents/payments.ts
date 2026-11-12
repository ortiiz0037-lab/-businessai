/** Payment form: methods, validation and the stored payment date. */

export const PAYMENT_METHODS = ['cash', 'check', 'card', 'transfer', 'ath_movil', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

const LABELS: Record<string, { es: string; en: string }> = {
  cash: { es: 'Efectivo', en: 'Cash' },
  check: { es: 'Cheque', en: 'Check' },
  card: { es: 'Tarjeta', en: 'Card' },
  transfer: { es: 'Transferencia', en: 'Bank transfer' },
  ath_movil: { es: 'ATH Móvil', en: 'ATH Móvil' },
  other: { es: 'Otro', en: 'Other' },
  manual: { es: 'Registro manual', en: 'Manual entry' },
  stripe: { es: 'Stripe', en: 'Stripe' },
}

export function paymentMethodLabel(method: string | null | undefined, locale: 'es' | 'en' = 'es'): string {
  if (!method) return locale === 'en' ? 'No method' : 'Sin método'
  return LABELS[method]?.[locale] ?? method
}

export type PaymentInput =
  | { ok: true; amount: number; method: PaymentMethod; date: string; paidAt: string; reference: string | null }
  | { ok: false; error: 'amount' | 'over_balance' | 'method' | 'date' | 'before_issue' | 'reference' }

/**
 * Amount in dollars (up to 2 decimals, > 0, ≤ open balance), a known method,
 * a date not after today, not before 2000 and not before the invoice's issue
 * date (one day of tolerance, as the database: an issue date taken from the
 * server's UTC day can be one day ahead of Puerto Rico), an optional reference
 * (≤ 120 characters). The payment is stored at noon Puerto Rico time
 * (UTC−4, no daylight saving) so the calendar day never shifts.
 */
export function parsePaymentInput(
  input: { amount: string; method: string; date: string; reference: string },
  balance: number,
  today: string,
  issueDate: string | null = null,
): PaymentInput {
  const raw = input.amount.trim().replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, error: 'amount' }
  const amount = Math.round(Number(raw) * 100) / 100
  if (!(amount > 0)) return { ok: false, error: 'amount' }
  if (amount > Math.round(balance * 100) / 100) return { ok: false, error: 'over_balance' }
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) return { ok: false, error: 'method' }
  const date = input.date.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || date > today || date < '2000-01-01') {
    return { ok: false, error: 'date' }
  }
  if (issueDate && /^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    const earliest = new Date(Date.parse(`${issueDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    if (date < earliest) return { ok: false, error: 'before_issue' }
  }
  const reference = input.reference.trim()
  if (reference.length > 120) return { ok: false, error: 'reference' }
  return { ok: true, amount, method: input.method as PaymentMethod, date, paidAt: `${date}T12:00:00-04:00`, reference: reference || null }
}

export const PAYMENT_ERROR_MESSAGE: Record<string, string> = {
  amount: 'Escribe una cantidad válida mayor que cero (por ejemplo 125.50).',
  over_balance: 'La cantidad supera el balance pendiente de la factura.',
  method: 'Elige el método de pago.',
  date: 'La fecha del pago no puede ser posterior a hoy.',
  before_issue: 'La fecha del pago no puede ser anterior a la fecha de emisión de la factura.',
  payment_date_invalid: 'La fecha del pago debe estar entre la emisión de la factura y hoy.',
  payment_retry: 'Otro pago se registró al mismo tiempo en esta factura. Revisa el balance e inténtalo de nuevo.',
  reference: 'La referencia no puede superar 120 caracteres.',
  payment_not_allowed: 'Esta factura no admite pagos (está en borrador, anulada o ya pagada).',
  payment_exceeds_balance: 'La cantidad supera el balance pendiente de la factura.',
  not_found: 'No encontramos esa factura en tu empresa.',
  forbidden: 'Tu rol no permite registrar pagos.',
  save: 'No se pudo registrar el pago. Inténtalo nuevamente.',
}

export const PAYMENT_ERROR_MESSAGE_EN: Record<string, string> = {
  amount: 'Enter a valid amount greater than zero (for example 125.50).',
  over_balance: 'The amount is more than the invoice\'s open balance.',
  method: 'Choose the payment method.',
  date: 'The payment date cannot be later than today.',
  before_issue: 'The payment date cannot be earlier than the invoice\'s issue date.',
  payment_date_invalid: 'The payment date must be between the invoice\'s issue date and today.',
  payment_retry: 'Another payment was recorded on this invoice at the same time. Check the balance and try again.',
  reference: 'The reference cannot be longer than 120 characters.',
  payment_not_allowed: 'This invoice does not accept payments (it is a draft, voided or already paid).',
  payment_exceeds_balance: 'The amount is more than the invoice\'s open balance.',
  not_found: 'We could not find that invoice in your company.',
  forbidden: 'Your role cannot record payments.',
  save: 'The payment could not be recorded. Please try again.',
}

/**
 * Payments that count (migration 0025 can void a payment: the row stays,
 * marked voided, and no longer counts toward the balance). Rows read with
 * select('*') work with and without 0025.
 */
export function activePayments<T extends object>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).filter((p) => !(p as { voided_at?: string | null }).voided_at)
}

/** Message for a payment error code in the user's language. */
export function paymentErrorMessage(code: string, locale: 'es' | 'en' = 'es'): string | null {
  const table = locale === 'en' ? PAYMENT_ERROR_MESSAGE_EN : PAYMENT_ERROR_MESSAGE
  return table[code] ?? null
}

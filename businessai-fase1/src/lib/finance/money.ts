/**
 * Money in INTEGER CENTS. Amounts typed by people are parsed as text into
 * cents (never through floating point), added as BigInt and formatted from
 * the integer parts. Ledger amounts (0023) are bigint cents end to end.
 */
import { intlTag, type Locale } from '@/lib/i18n/app'

/** Largest amount a ledger line accepts (database check: < 10^15 cents). */
export const MAX_CENTS = 999_999_999_999_999n

/**
 * '1,234.56' | '1234.5' | '12' → cents (bigint). Up to two decimals, no
 * sign, at most 13 integer digits. A comma before exactly three digits is a
 * thousands separator; a comma before one or two final digits is a decimal
 * separator (es-PR / es-ES style). Anything else → null.
 */
export function parseCents(input: string | null | undefined): bigint | null {
  let s = String(input ?? '').trim().replace(/\s+/g, '').replace(/^\$/, '')
  if (s === '') return null
  // '1.234,56' or '1234,5' → decimal comma
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '')
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')
  return cents > MAX_CENTS ? null : cents
}

/** Cents from the database (bigint arrives as a JSON number or string). */
export function toCents(v: number | string | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === '') return 0n
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('CENTS_NOT_INTEGER')
    return BigInt(v)
  }
  if (!/^-?\d+$/.test(v.trim())) throw new Error('CENTS_NOT_INTEGER')
  return BigInt(v.trim())
}

export function sumCents(values: (number | string | bigint | null | undefined)[]): bigint {
  return values.reduce<bigint>((s, v) => s + toCents(v), 0n)
}

/** Cents → '$1,234.56' / '1.234,56 $' by locale, built from integer parts. */
export function formatCents(value: number | string | bigint | null | undefined, locale: Locale, currency = 'USD'): string {
  const c = toCents(value)
  const neg = c < 0n
  const abs = neg ? -c : c
  const whole = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0')
  const tag = intlTag(locale)
  const parts = new Intl.NumberFormat(tag, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(whole)
  const decimal = new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'
  let out = ''
  let placed = false
  parts.forEach((p, i) => {
    out += p.value
    const next = parts[i + 1]
    if (!placed && (p.type === 'integer' || p.type === 'group') && (!next || (next.type !== 'integer' && next.type !== 'group'))) {
      out += decimal + frac
      placed = true
    }
  })
  return neg ? `-${out}` : out
}

/** Cents → '1234.56' for form inputs. */
export function centsToInput(value: number | string | bigint | null | undefined): string {
  const c = toCents(value)
  const abs = c < 0n ? -c : c
  return `${c < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

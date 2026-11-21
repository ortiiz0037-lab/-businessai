import type { Locale } from '@/lib/i18n/app'

/**
 * Inline bilingual text for the app pages: tr('Guardar', 'Save'). Keeps both
 * languages side by side in the page that shows them, so a new string can
 * never be added in one language only without it being visible in review
 * (tests/i18n-pages.test.ts checks every internal page uses it).
 */
export type Tr = (es: string, en: string) => string
export const translator = (locale: Locale): Tr => (es, en) => (locale === 'en' ? en : es)

/** Pick the message of `code` in a { es, en } table, or the fallback code. */
export function pick<T extends string>(table: { es: Record<T, string>; en: Record<T, string> }, locale: Locale, code: string | null | undefined, fallback: T): string {
  const t = table[locale] as Record<string, string>
  return (code && t[code]) || t[fallback]
}

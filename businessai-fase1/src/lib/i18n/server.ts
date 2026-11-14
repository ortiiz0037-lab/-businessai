import { cookies, headers } from 'next/headers'
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n/app'

/** Pure: cookie first, then the browser's preferred language, else Spanish. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (cookieValue === 'es' || cookieValue === 'en') return cookieValue
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('en') ? 'en' : 'es'
}

/** Locale of the current request (server components and actions). */
export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()])
  return resolveLocale(c.get(LOCALE_COOKIE)?.value, h.get('accept-language'))
}

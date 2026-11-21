'use client'
import { useEffect } from 'react'

/** Sets <html lang> to the app language (the root layout stays static). */
export function HtmlLang({ locale }: { locale: 'es' | 'en' }) {
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  return null
}

/** Client-side language: the ba_locale cookie, else the browser, else Spanish. */
export function clientLocale(): 'es' | 'en' {
  if (typeof document === 'undefined') return 'es'
  const m = /(?:^|;\s*)ba_locale=(es|en)/.exec(document.cookie)
  if (m) return m[1] as 'es' | 'en'
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'es'
}

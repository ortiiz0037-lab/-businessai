'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { COMPANY_COOKIE, listMemberships } from '@/lib/active-company'
import { LOCALE_COOKIE } from '@/lib/i18n/app'

const YEAR = 60 * 60 * 24 * 365
const cookieOptions = { path: '/', maxAge: YEAR, sameSite: 'lax' as const, httpOnly: true, secure: process.env.NODE_ENV === 'production' }

/** Only same-site relative paths (no open redirect). */
function safeReturn(value: FormDataEntryValue | null): string {
  const v = typeof value === 'string' ? value : ''
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/dashboard'
}

export async function setLocale(formData: FormData) {
  const locale = formData.get('locale')
  if (locale === 'es' || locale === 'en') {
    ;(await cookies()).set(LOCALE_COOKIE, locale, cookieOptions)
  }
  redirect(safeReturn(formData.get('returnTo')))
}

/** Switches the active company — only to a company the user really belongs to. */
export async function setActiveCompany(formData: FormData) {
  const companyId = formData.get('companyId')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (typeof companyId === 'string') {
    const options = await listMemberships(supabase, user.id)
    if (options.some((o) => o.companyId === companyId)) {
      ;(await cookies()).set(COMPANY_COOKIE, companyId, cookieOptions)
    }
  }
  redirect('/dashboard')
}

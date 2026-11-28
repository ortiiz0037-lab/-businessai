'use server'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'

/** Hides the getting-started card for the active company (a preference, not data). */
export async function hideOnboarding(formData: FormData) {
  const company = String(formData.get('company') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(company)) return
  ;(await cookies()).set('ba_onboarding_hidden', company, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' })
  revalidatePath('/dashboard')
}

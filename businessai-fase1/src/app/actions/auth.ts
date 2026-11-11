'use server'
import { cookies, headers } from 'next/headers'
import { resolveAppOrigin } from '@/lib/app-origin'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SELECTED_PLAN_COOKIE, isPlanKey } from '@/lib/billing/catalog'
import { fieldErrors, newPasswordSchema, resetRequestSchema, safeNext, signInSchema, signUpSchema, type FormState } from '@/lib/validators'

export async function signUp(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const { fullName, email, password } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { data: { full_name: fullName } },
  })
  if (error) return { error: 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.' }
  // Plan chosen on /precios: kept until the company is created (then /billing selects it).
  const plan = formData.get('plan')
  if (isPlanKey(plan)) {
    ;(await cookies()).set(SELECTED_PLAN_COOKIE, plan, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 7 * 86_400,
    })
  }
  if (data.session) redirect('/onboarding')
  return { message: 'Te enviamos un correo para confirmar tu cuenta. Ábrelo para continuar.' }
}

export async function signIn(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) return { error: 'Correo o contraseña incorrectos.' }
  redirect(safeNext(formData.get('next')))
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

/** Public URL of this deployment (NEXT_PUBLIC_APP_URL, else the request host). */
async function appOrigin(): Promise<string | null> {
  const h = await headers()
  return resolveAppOrigin(process.env, h.get('host'))
}

/**
 * Sends the password-reset email. The answer is the same whether the email
 * has an account or not (no account enumeration).
 */
export async function requestPasswordReset(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetRequestSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const origin = await appOrigin()
  if (!origin) {
    console.error('PASSWORD_RESET_ORIGIN_MISSING: set NEXT_PUBLIC_APP_URL')
    return { error: 'No se pudo enviar el enlace en este momento. Inténtalo más tarde.' }
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  })
  if (error && error.status !== 429) console.error('PASSWORD_RESET_REQUEST_ERROR', { status: error.status, code: error.code })
  if (error?.status === 429) return { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }
  return { message: 'Si existe una cuenta con ese correo, te enviamos un enlace para crear una nueva contraseña.' }
}

/** Sets a new password for the user who opened the reset link (session required). */
export async function updatePassword(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = newPasswordSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'El enlace expiró. Solicita uno nuevo desde «¿Olvidaste tu contraseña?».' }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    console.error('PASSWORD_UPDATE_ERROR', { status: error.status, code: error.code })
    return { error: error.code === 'same_password' ? 'La nueva contraseña debe ser distinta de la anterior.' : 'No se pudo cambiar la contraseña. Inténtalo de nuevo.' }
  }
  redirect('/dashboard?password=updated')
}

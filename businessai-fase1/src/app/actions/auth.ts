'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fieldErrors, safeNext, signInSchema, signUpSchema, type FormState } from '@/lib/validators'

export async function signUp(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const { fullName, email, password } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { data: { full_name: fullName } },
  })
  if (error) return { error: 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.' }
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

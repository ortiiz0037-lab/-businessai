'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { companySchema, fieldErrors, type FormState } from '@/lib/validators'

export async function createCompany(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  // MVP: una empresa por usuario (la BD ya permite varias para el futuro).
  const { data: existing } = await supabase.from('memberships').select('id').eq('user_id', user.id).limit(1)
  if (existing?.length) redirect('/dashboard')
  const { error } = await supabase.rpc('create_company', { company_name: parsed.data.name })
  if (error) return { error: 'No se pudo crear la empresa. Inténtalo de nuevo.' }
  redirect('/dashboard')
}

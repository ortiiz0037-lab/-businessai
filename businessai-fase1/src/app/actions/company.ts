'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SELECTED_PLAN_COOKIE, isPlanKey } from '@/lib/billing/catalog'
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
  // Next step of sign-up: choose a plan and enter a card to start the trial.
  // The plan chosen on /precios (if any) arrives preselected.
  const store = await cookies()
  const plan = store.get(SELECTED_PLAN_COOKIE)?.value
  store.delete(SELECTED_PLAN_COOKIE)
  redirect(isPlanKey(plan) ? `/billing?welcome=1&plan=${plan}#plan-${plan}` : '/billing?welcome=1')
}

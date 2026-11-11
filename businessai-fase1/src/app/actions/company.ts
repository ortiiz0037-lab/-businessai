'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SELECTED_PLAN_COOKIE, isPlanKey } from '@/lib/billing/catalog'
import { COMPANY_COOKIE } from '@/lib/active-company'
import { companySchema, fieldErrors, type FormState } from '@/lib/validators'

export async function createCompany(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  // An account can own several companies; each one has its own data,
  // members and subscription (create_company makes the user its owner).
  const { data: companyId, error } = await supabase.rpc('create_company', { company_name: parsed.data.name })
  if (error || typeof companyId !== 'string') return { error: 'No se pudo crear la empresa. Inténtalo de nuevo.' }
  const store = await cookies()
  // The new company becomes the active one (the cookie is re-validated
  // against the memberships on every request, lib/active-company.ts).
  store.set(COMPANY_COOKIE, companyId, {
    path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production',
  })
  // Next step: choose a plan and enter a card to start the trial.
  // The plan chosen on /precios (if any) arrives preselected.
  const plan = store.get(SELECTED_PLAN_COOKIE)?.value
  store.delete(SELECTED_PLAN_COOKIE)
  redirect(isPlanKey(plan) ? `/billing?welcome=1&plan=${plan}#plan-${plan}` : '/billing?welcome=1')
}

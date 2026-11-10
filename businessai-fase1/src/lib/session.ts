import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'

type Membership = { role: string; company: { id: string; name: string } | null } | null

/** Usuario verificado con el servidor de Auth + su empresa activa (RLS filtra por sí solo). */
export const getSession = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const active = await getActiveMembership(supabase, user.id)
  const membership: Membership = active
    ? { role: active.role, company: { id: active.companyId, name: active.companyName ?? '' } }
    : null
  return { user, membership }
})

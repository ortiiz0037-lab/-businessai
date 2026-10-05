import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

type Membership = { role: string; company: { id: string; name: string } | null } | null

/** Usuario verificado con el servidor de Auth + su empresa (RLS filtra por sí solo). */
export const getSession = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('memberships')
    .select('role, company:companies(id, name)')
    .eq('user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  return { user, membership: data as unknown as Membership }
})

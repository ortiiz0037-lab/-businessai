import { createClient } from '@supabase/supabase-js'
import { getServiceRoleConfig } from '@/lib/env'

/**
 * Service-role client: bypasses RLS. SERVER ONLY, and only for billing
 * writes (company_subscriptions, stripe_events) that users must not make.
 */
export function createAdminClient() {
  const { url, key } = getServiceRoleConfig()
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

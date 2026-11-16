/**
 * A Supabase client WITHOUT a user session (SERVER ONLY), for provider
 * webhooks. It can only call the bank functions that verify the server's
 * HMAC signature (0042); RLS hides every table from it.
 */
import { createClient } from '@supabase/supabase-js'

export function createAnonServerClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { safeNext } from '@/lib/validators'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = safeNext(searchParams.get('next'), '/onboarding')
  const code = searchParams.get('code')
  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  } else if (code) {
    // Links that use the PKCE flow (e.g. the default password-reset email).
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }
  // A reset link opened in another browser cannot finish the PKCE exchange:
  // send the person back to ask for a new link instead of a generic error.
  if (next === '/reset-password') return NextResponse.redirect(`${origin}/forgot-password?error=link`)
  return NextResponse.redirect(`${origin}/login?error=confirm`)
}

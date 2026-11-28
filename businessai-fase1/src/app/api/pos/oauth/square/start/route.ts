import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { readPosConfig } from '@/lib/pos/config'
import { squareAuthorizeUrl } from '@/lib/pos/adapters/square'

export const runtime = 'nodejs'

/** Starts Square OAuth for a signed-in POS manager; the state is bound to an httpOnly cookie. */
export async function GET(request: Request) {
  const cfg = readPosConfig()
  const back = new URL('/pos/integrations', request.url)
  if (cfg.square.configured !== true) { back.searchParams.set('error', 'not_configured'); return NextResponse.redirect(back) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/pos/integrations', request.url))
  const state = randomBytes(24).toString('base64url')
  ;(await cookies()).set('ba_pos_oauth', state, { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/api/pos/oauth', maxAge: 600 })
  return NextResponse.redirect(squareAuthorizeUrl(cfg.square.oauthURL, cfg.square.appId, state))
}

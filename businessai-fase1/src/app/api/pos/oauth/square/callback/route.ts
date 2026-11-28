import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { readPosConfig } from '@/lib/pos/config'
import { encryptPosToken } from '@/lib/pos/crypto'
import { PosSigner } from '@/lib/pos/signer'
import { squareExchangeCode, SquareClient } from '@/lib/pos/adapters/square'

export const runtime = 'nodejs'

/**
 * Square OAuth callback: checks the state cookie, exchanges the code, encrypts the token and stores the
 * connection through the server-signed pos_integration_connect (the user must hold pos.manage).
 * Locations are listed for mapping; no token is logged or returned to the browser.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const back = new URL('/pos/integrations', request.url)
  const fail = (e: string) => { back.searchParams.set('error', e); return NextResponse.redirect(back) }
  const cfg = readPosConfig()
  if (cfg.square.configured !== true || !cfg.core) return fail('not_configured')
  const jar = await cookies()
  const expected = jar.get('ba_pos_oauth')?.value ?? '', got = url.searchParams.get('state') ?? ''
  jar.delete('ba_pos_oauth')
  if (!expected || expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return fail('pos_integration_invalid')
  const code = url.searchParams.get('code')
  if (!code) return fail('pos_integration_invalid')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))
  const m = await getActiveMembership(supabase, user.id)
  if (!m) return fail('forbidden')
  let tok
  try { tok = await squareExchangeCode(cfg.square.oauthURL, cfg.square.appId, cfg.square.secret, code) } catch { return fail('pos_integration_invalid') }
  const locations = await new SquareClient(cfg.square.baseURL, tok.accessToken).locations().catch(() => [])
  const enc = encryptPosToken(JSON.stringify({ access_token: tok.accessToken, refresh_token: tok.refreshToken }), cfg.core.tokenKeys)
  const payload = JSON.stringify({ provider: 'square', environment: cfg.square.environment, external_account_id: tok.merchantId, display_name: 'Square',
    token_ciphertext: enc.ciphertext, key_version: enc.keyVersion, expires_at: tok.expiresAt, settings: { locations: locations.map((l) => ({ id: l.id, name: l.name })) } })
  const s = new PosSigner(cfg.core.serverKeys[0]).connect(user.id, m.companyId, payload)
  const { error } = await supabase.rpc('pos_integration_connect', { target: m.companyId, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
  if (error) return fail(/TAKEN/.test(error.message) ? 'pos_integration_taken' : /FORBIDDEN/.test(error.message) ? 'forbidden' : 'save')
  back.searchParams.set('done', 'square')
  return NextResponse.redirect(back)
}

import { NextResponse } from 'next/server'
import { readBankingConfig } from '@/lib/banking/config'
import { createAnonServerClient } from '@/lib/banking/anon'
import { handlePlaidWebhook } from '@/lib/banking/webhook'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Plaid webhook. Public machine route (src/lib/supabase/proxy.ts): it is
 * authenticated by the Plaid-Verification JWT, verified before anything else,
 * and writes only through the server-signed bank functions (0042).
 */
export async function POST(request: Request) {
  const result = await handlePlaidWebhook({
    rawBody: await request.text(),
    verification: request.headers.get('plaid-verification'),
    cfg: readBankingConfig(),
    supabase: createAnonServerClient(),
  })
  return NextResponse.json(result.body, { status: result.status })
}

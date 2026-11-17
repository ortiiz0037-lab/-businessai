import { NextResponse } from 'next/server'
import { createAnonServerClient } from '@/lib/banking/anon'
import { readPosConfig } from '@/lib/pos/config'
import { handlePosWebhook } from '@/lib/pos/sync'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POS provider webhooks (square, clover, shopify, lightspeed_x). Public machine routes
 * (src/lib/supabase/proxy.ts): the provider's signature is verified on the RAW body before anything
 * else, and the database is written only through the server-signed, idempotent 0044 functions.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const result = await handlePosWebhook({ provider, rawBody: await request.text(), headers: request.headers, url: request.url,
    cfg: readPosConfig(), supabase: createAnonServerClient() })
  return NextResponse.json(result.body, { status: result.status })
}

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAnonServerClient } from '@/lib/banking/anon'
import { readPosConfig } from '@/lib/pos/config'
import { recoverDue } from '@/lib/pos/sync'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Recovery job (scheduler with POS_CRON_SECRET): failed / missed events are fetched again. */
export async function POST(request: Request) {
  const cfg = readPosConfig()
  const secret = cfg.cronSecret ?? ''
  const got = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (secret.length < 32 || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) return NextResponse.json({ ok: false }, { status: 401 })
  const r = await recoverDue(createAnonServerClient(), cfg)
  return NextResponse.json(r, { status: r.ok ? 200 : 503 })
}

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAnonServerClient } from '@/lib/banking/anon'
import { readPosConfig } from '@/lib/pos/config'
import { PosSigner } from '@/lib/pos/signer'
import { PosSync } from '@/lib/pos/sync'
import type { NormalizedSale } from '@/lib/pos/types'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * The local bridge next to a traditional register posts exported sales here
 * (contract: src/lib/pos/legacy.ts). Authenticated by its bearer token (only its SHA-256 is kept);
 * the sales go through the same signed, validated, idempotent ingestion as provider syncs.
 */
export async function POST(request: Request) {
  const cfg = readPosConfig()
  if (!cfg.core || !cfg.bridge) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 })
  const m = /^Bearer (bapos_[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')
  if (!m) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const raw = await request.text()
  if (raw.length > 2 * 1024 * 1024) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  let sales: NormalizedSale[]
  try { const b = JSON.parse(raw) as { sales?: unknown }; if (!Array.isArray(b.sales) || b.sales.length > 500) throw new Error(); sales = b.sales as NormalizedSale[] }
  catch { return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 }) }
  const supabase = createAnonServerClient()
  const sha = createHash('sha256').update(m[1], 'utf8').digest('hex')
  const s = new PosSigner(cfg.core.serverKeys[0]).bridge(sha)
  const { data: integration, error } = await supabase.rpc('pos_bridge_resolve', { token_sha: sha, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
  if (error || !integration) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const r = await new PosSync(supabase, cfg).ingest(String(integration), sales, 'bridge')
    return NextResponse.json({ ok: true, counts: r.counts, results: r.results.map((x) => ({ external_id: x.external_id, outcome: x.outcome, error: x.error })) })
  } catch { return NextResponse.json({ ok: false, error: 'database_error' }, { status: 500 }) }
}

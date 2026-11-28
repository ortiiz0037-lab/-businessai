/**
 * Handling of a provider webhook (SERVER ONLY, no user): verify Plaid's
 * signature, record the event through the signed, idempotent
 * bank_webhook_record (0042) and, when the provider says new transactions
 * are available, sync that connection. Nothing from the body is echoed back
 * or logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type { BankingConfig } from '@/lib/banking/config'
import { BankSigner } from '@/lib/banking/signer'
import { plaidFor, syncConnection } from '@/lib/banking/sync'
import { verifyPlaidWebhook } from '@/lib/banking/webhook-verify'

export type WebhookResult = { status: number; body: { ok: boolean; error?: string } }
const MAX_BODY = 64 * 1024

export async function handlePlaidWebhook(input: { rawBody: string; verification: string | null; cfg: BankingConfig; supabase: SupabaseClient; fetcher?: typeof fetch }): Promise<WebhookResult> {
  const { cfg } = input
  if (!cfg.configured) return { status: 503, body: { ok: false, error: 'not_configured' } }
  if (input.rawBody.length > MAX_BODY) return { status: 413, body: { ok: false, error: 'too_large' } }
  const plaid = plaidFor(cfg, input.fetcher)
  const v = await verifyPlaidWebhook(input.verification, input.rawBody, async (kid) => (await plaid.verificationKey(kid)).key)
  if (!v.ok) return { status: 401, body: { ok: false, error: 'invalid_signature' } }
  let body: Record<string, unknown>
  try { body = JSON.parse(input.rawBody) } catch { return { status: 400, body: { ok: false, error: 'invalid_body' } } }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, 200) : null)
  const err = body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>).error_code : null
  // only what the database needs: never account data
  const payload = JSON.stringify({ item_id: str('item_id'), webhook_type: str('webhook_type'), webhook_code: str('webhook_code'), error_code: typeof err === 'string' ? err.slice(0, 100) : null })
  const eventKey = createHash('sha256').update(input.rawBody, 'utf8').digest('hex')
  const signer = new BankSigner(cfg.serverKeys[0])
  const s = signer.webhook('plaid', eventKey, payload)
  const { data, error } = await input.supabase.rpc('bank_webhook_record', { provider: 'plaid', event_key: eventKey, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
  if (error) return { status: 500, body: { ok: false, error: 'database_error' } }
  const r = data as { already: boolean; outcome?: string; connection_id?: string | null }
  if (!r.already && r.outcome === 'sync_requested' && r.connection_id) {
    await syncConnection(input.supabase, cfg, r.connection_id, 'webhook', input.fetcher)
  }
  return { status: 200, body: { ok: true } }
}

/**
 * Synchronization of external sales (SERVER ONLY, no user for webhooks / recovery):
 *   1. the route verifies the provider's signature on the RAW body (adapters/*.verifyWebhook);
 *   2. each event is recorded through the signed, idempotent pos_webhook_record (0044) — a retried
 *      delivery returns {already:true} and nothing else happens;
 *   3. the order is fetched from the provider when the webhook carries only ids (Square, Clover) or
 *      taken from the body (Shopify, Lightspeed), normalized and sent with its event id to the signed
 *      pos_ingest_batch, which validates it, ignores older versions (out of order), never duplicates
 *      a sale or an outflow, and records the outcome (applied / needs_review / failed + retry time).
 *   4. recovery: pos_sync_due lists failed events whose retry time has come; they are fetched again.
 * Webhooks are never trusted to arrive exactly once: the database is idempotent, and the recovery
 * job plus a periodic search (Square) cover missed deliveries. Nothing from a body is logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PosConfig } from '@/lib/pos/config'
import { decryptPosToken } from '@/lib/pos/crypto'
import { PosSigner } from '@/lib/pos/signer'
import { squareAdapter, normalizeSquareOrder, normalizeSquareReturn, SquareClient } from '@/lib/pos/adapters/square'
import { shopifyAdapter, normalizeShopifyOrder } from '@/lib/pos/adapters/shopify'
import { cloverAdapter, normalizeCloverOrder, CloverClient } from '@/lib/pos/adapters/clover'
import { lightspeedAdapter, normalizeLightspeedReturn, normalizeLightspeedSale } from '@/lib/pos/adapters/lightspeed'
import type { HeaderBag, PosAdapter } from '@/lib/pos/adapters/common'
import type { NormalizedSale, WebhookEvent } from '@/lib/pos/types'

export const ADAPTERS: Record<string, PosAdapter> = { square: squareAdapter, shopify: shopifyAdapter, clover: cloverAdapter, lightspeed_x: lightspeedAdapter }
export type WebhookResult = { status: number; body: { ok: boolean; error?: string; events?: number } }
const MAX_BODY = 512 * 1024

type Ctx = { company_id: string; provider: string; status: string; external_account_id: string | null; token_ciphertext: string | null; settings: Record<string, unknown> }

export class PosSync {
  private readonly signer: PosSigner
  constructor(private readonly supabase: SupabaseClient, private readonly cfg: PosConfig, private readonly fetcher: typeof fetch = fetch) {
    if (!cfg.core) throw new Error('POS_NOT_CONFIGURED')
    this.signer = new PosSigner(cfg.core.serverKeys[0])
  }

  async context(integration: string): Promise<Ctx | null> {
    const s = this.signer.context(integration)
    const { data, error } = await this.supabase.rpc('pos_integration_context', { integration, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    return error ? null : (data as Ctx)
  }
  private token(ctx: Ctx): string | null {
    if (!ctx.token_ciphertext || !this.cfg.core) return null
    try {
      const plain = decryptPosToken(ctx.token_ciphertext, this.cfg.core.tokenKeys)
      // OAuth connections keep {access_token, refresh_token}; manual tokens are the bare string
      return plain.startsWith('{') ? (JSON.parse(plain) as { access_token?: string }).access_token ?? null : plain
    } catch { return null }
  }

  async record(provider: string, ev: WebhookEvent) {
    const payload = JSON.stringify({ account_id: ev.accountId, event_type: ev.eventType, object_type: ev.objectType, object_id: ev.objectId, version: ev.version })
    const s = this.signer.webhook(provider, ev.eventKey.slice(0, 200), payload)
    const { data, error } = await this.supabase.rpc('pos_webhook_record', { provider, event_key: ev.eventKey.slice(0, 200), payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (error) throw new Error('DB')
    return data as { already: boolean; event_id?: number; integration_id?: string | null; status?: string }
  }

  async ingest(integration: string, sales: (NormalizedSale & { event_id?: string })[], trigger: 'webhook' | 'manual' | 'scheduled' | 'recovery' | 'bridge', failure?: string) {
    const payload = JSON.stringify({ trigger, status: failure ? 'failed' : 'succeeded', error_code: failure ?? null, sales })
    const s = this.signer.ingest(integration, payload)
    const { data, error } = await this.supabase.rpc('pos_ingest_batch', { integration, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (error) throw new Error('DB')
    return data as { run: string; counts: Record<string, number>; results: { external_id: string; outcome: string; error: string | null; sale_id: string | null }[] }
  }

  /** fetch + normalize one order of an event (null: not a sale to import, or the provider failed) */
  async fetchSale(ctx: Ctx, provider: string, objectId: string, body?: unknown): Promise<NormalizedSale | { error: string } | null> {
    if (provider === 'shopify') return body ? normalizeShopifyOrder(body) : { error: 'no_body' }
    if (provider === 'lightspeed_x') {
      if (!body) return { error: 'no_body' }
      const ret = normalizeLightspeedReturn(body)
      if (ret) return { error: `return_of:${ret.sourceSaleId}` }   // applied with the original sale when it is next synced
      return normalizeLightspeedSale(body)
    }
    const token = this.token(ctx)
    if (!token) return { error: 'token' }
    if (provider === 'square') {
      if (this.cfg.square.configured !== true) return { error: 'not_configured' }
      const client = new SquareClient(this.cfg.square.baseURL, token, this.fetcher)
      try {
        const order = await client.order(objectId)
        const ret = normalizeSquareReturn(order)
        if (ret) {   // a return: the refund belongs to the original sale, sent with it
          const src = normalizeSquareOrder(await client.order(ret.sourceOrderId))
          if (!src) return null
          return { ...src, version: String(Math.max(Number(src.version), Number(ret.version))), refunds: [...(src.refunds ?? []), ret.refund] }
        }
        return normalizeSquareOrder(order)
      } catch (e) { return { error: (e as Error).message.slice(0, 80) } }
    }
    if (provider === 'clover') {
      if (!this.cfg.clover || !ctx.external_account_id) return { error: 'not_configured' }
      try { return normalizeCloverOrder(await new CloverClient(this.cfg.clover.baseURL, token, this.fetcher).order(ctx.external_account_id, objectId), ctx.external_account_id) }
      catch (e) { return { error: (e as Error).message.slice(0, 80) } }
    }
    return { error: 'unsupported' }
  }
}

/** the whole webhook path for one provider */
export async function handlePosWebhook(input: { provider: string; rawBody: string; headers: HeaderBag; url: string; cfg: PosConfig; supabase: SupabaseClient; fetcher?: typeof fetch }): Promise<WebhookResult> {
  const { provider, cfg } = input
  const adapter = ADAPTERS[provider]
  if (!adapter) return { status: 404, body: { ok: false, error: 'unknown_provider' } }
  if (!cfg.core) return { status: 503, body: { ok: false, error: 'not_configured' } }
  if (input.rawBody.length > MAX_BODY) return { status: 413, body: { ok: false, error: 'too_large' } }
  const secret = provider === 'square' ? (cfg.square.configured ? cfg.square.webhookKey : null) : provider === 'shopify' ? cfg.shopifySecret
    : provider === 'clover' ? cfg.clover?.authCode ?? null : cfg.lightspeedSecret
  if (!secret) return { status: 503, body: { ok: false, error: 'not_configured' } }
  const url = provider === 'square' && cfg.square.configured ? cfg.square.webhookURL ?? input.url : input.url
  if (!adapter.verifyWebhook({ headers: input.headers, rawBody: input.rawBody, secret, url })) return { status: 401, body: { ok: false, error: 'invalid_signature' } }
  const events = adapter.parseWebhook(input.rawBody, input.headers)
  if (!events.length) return { status: 200, body: { ok: true, events: 0 } }   // verified but nothing to do (e.g. a test ping)
  const sync = new PosSync(input.supabase, cfg, input.fetcher)
  let body: unknown = undefined
  try { body = provider === 'lightspeed_x' ? JSON.parse(new URLSearchParams(input.rawBody).get('payload') ?? 'null') : provider === 'shopify' ? JSON.parse(input.rawBody) : undefined } catch { body = undefined }
  for (const ev of events) {
    let rec
    try { rec = await sync.record(provider, ev) } catch { return { status: 500, body: { ok: false, error: 'database_error' } } }
    if (rec.already || !rec.integration_id || rec.status !== 'received') continue
    const ctx = await sync.context(rec.integration_id)
    if (!ctx) continue
    const sale = await sync.fetchSale(ctx, provider, ev.objectId, body)
    if (sale && 'error' in sale) continue   // stays 'received': the recovery job fetches it again
    if (!sale) continue
    try { await sync.ingest(rec.integration_id, [{ ...sale, event_id: String(rec.event_id) }], 'webhook') } catch { return { status: 500, body: { ok: false, error: 'database_error' } } }
  }
  // 200 once recorded: the provider must not retry what the database already holds
  return { status: 200, body: { ok: true, events: events.length } }
}

/** recovery job: failed / stuck events whose time has come are fetched again (Square, Clover) */
export async function recoverDue(supabase: SupabaseClient, cfg: PosConfig, fetcher?: typeof fetch) {
  if (!cfg.core) return { ok: false as const, reason: 'not_configured' }
  const signer = new PosSigner(cfg.core.serverKeys[0])
  const s = signer.due()
  const { data, error } = await supabase.rpc('pos_sync_due', { key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac, max_rows: 100 })
  if (error) return { ok: false as const, reason: 'database_error' }
  const due = (data ?? []) as { event_id: number; integration_id: string; provider: string; object_id: string }[]
  const sync = new PosSync(supabase, cfg, fetcher)
  let applied = 0, skipped = 0
  for (const d of due) {
    if (d.provider !== 'square' && d.provider !== 'clover') { skipped++; continue }   // body-only providers: their own retries / polling
    const ctx = await sync.context(d.integration_id)
    const sale = ctx ? await sync.fetchSale(ctx, d.provider, d.object_id) : null
    if (!sale || 'error' in sale) { skipped++; continue }
    await sync.ingest(d.integration_id, [{ ...sale, event_id: String(d.event_id) }], 'recovery')
    applied++
  }
  return { ok: true as const, due: due.length, applied, skipped }
}

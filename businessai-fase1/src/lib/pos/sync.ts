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
import { squareAdapter, normalizeSquareOrder, normalizeSquareReturn, SquareClient, SquareError, squareRefreshToken } from '@/lib/pos/adapters/square'
import { encryptPosToken } from '@/lib/pos/crypto'
import { shopifyAdapter, normalizeShopifyOrder, shopifyBase, ShopifyClient, shopifyGqlToRest } from '@/lib/pos/adapters/shopify'
import { cloverAdapter, normalizeCloverOrder, CloverClient } from '@/lib/pos/adapters/clover'
import { lightspeedAdapter, lightspeedBase, LightspeedClient, normalizeLightspeedReturn, normalizeLightspeedSale } from '@/lib/pos/adapters/lightspeed'
import type { HeaderBag, PosAdapter } from '@/lib/pos/adapters/common'
import type { NormalizedSale, WebhookEvent } from '@/lib/pos/types'

/** the later of two instants (ISO text is not comparable as text: '…00.123Z' < '…00Z' alphabetically) */
export function laterIso(current: string, candidate: string | null | undefined): string {
  if (!candidate) return current
  const a = Date.parse(current), b = Date.parse(candidate)
  if (Number.isNaN(b)) return current
  return Number.isNaN(a) || b > a ? candidate : current   // the provider's own text (keeps its precision)
}

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
  private tokens(ctx: Ctx): { access: string; refresh: string | null } | null {
    if (!ctx.token_ciphertext || !this.cfg.core) return null
    try {
      const plain = decryptPosToken(ctx.token_ciphertext, this.cfg.core.tokenKeys)
      // OAuth connections keep {access_token, refresh_token}; manual tokens are the bare string
      if (!plain.startsWith('{')) return { access: plain, refresh: null }
      const j = JSON.parse(plain) as { access_token?: string; refresh_token?: string | null }
      return j.access_token ? { access: j.access_token, refresh: j.refresh_token ?? null } : null
    } catch { return null }
  }
  private token(ctx: Ctx): string | null { return this.tokens(ctx)?.access ?? null }

  /** Square: renew an expired access token with the refresh token and store it (signed, 0045); returns the new token */
  async renewSquare(integration: string, ctx: Ctx): Promise<string | null> {
    const t = this.tokens(ctx)
    if (!t?.refresh || this.cfg.square.configured !== true || !this.cfg.core) return null
    let fresh
    try { fresh = await squareRefreshToken(this.cfg.square.oauthURL, this.cfg.square.appId, this.cfg.square.secret, t.refresh, this.fetcher) } catch { return null }
    const enc = encryptPosToken(JSON.stringify({ access_token: fresh.accessToken, refresh_token: fresh.refreshToken }), this.cfg.core.tokenKeys)
    const payload = JSON.stringify({ token_ciphertext: enc.ciphertext, key_version: enc.keyVersion, expires_at: fresh.expiresAt })
    const s = this.signer.token(integration, payload)
    const { error } = await this.supabase.rpc('pos_integration_token_update', { integration, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (error) return null
    ctx.token_ciphertext = enc.ciphertext
    return fresh.accessToken
  }

  /** a Square call with one renewal on 401 (expired token) */
  private async withSquare<T>(integration: string | null, ctx: Ctx, call: (c: SquareClient) => Promise<T>): Promise<T> {
    if (this.cfg.square.configured !== true) throw new SquareError('not_configured', 0)
    const token = this.token(ctx)
    if (!token) throw new SquareError('token', 0)
    try { return await call(new SquareClient(this.cfg.square.baseURL, token, this.fetcher)) }
    catch (e) {
      if (!(e instanceof SquareError) || e.status !== 401 || !integration) throw e
      const renewed = await this.renewSquare(integration, ctx)
      if (!renewed) throw e
      return call(new SquareClient(this.cfg.square.baseURL, renewed, this.fetcher))
    }
  }

  /**
   * Polling (webhooks are not guaranteed): completed / canceled orders of the mapped locations updated since
   * the cursor, page by page; each page is ingested (idempotent, out-of-order safe) and the cursor advances to
   * the latest update seen. Returns the number of orders sent.
   */
  async pollSquare(integration: string, locations: string[], cursor: string | null, maxPages = 20): Promise<{ sent: number; cursor: string | null }> {
    const ctx = await this.context(integration)
    if (!ctx || !locations.length) return { sent: 0, cursor }
    const since = cursor && !Number.isNaN(Date.parse(cursor)) ? cursor : new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    let page: string | null = null, sent = 0, latest = since
    for (let i = 0; i < maxPages; i++) {
      const r: { orders?: unknown[]; cursor?: string } = await this.withSquare(integration, ctx, (c) => c.searchOrders(locations, since, page))
      const sales = (r.orders ?? []).map((o) => normalizeSquareOrder(o)).filter((x): x is NormalizedSale => !!x)
      for (const o of r.orders ?? []) latest = laterIso(latest, (o as { updated_at?: string }).updated_at)
      if (sales.length) { await this.ingestWithCursor(integration, sales, latest); sent += sales.length }
      if (!r.cursor) break
      page = r.cursor
    }
    if (!sent) await this.ingestWithCursor(integration, [], latest)
    return { sent, cursor: latest }
  }
  /** Clover polling: orders modified since the cursor (epoch ms), 100 per page; the cursor advances to the latest modifiedTime */
  async pollClover(integration: string, cursor: string | null, maxPages = 20): Promise<{ sent: number; cursor: string | null }> {
    const ctx = await this.context(integration)
    const token = ctx ? this.token(ctx) : null
    if (!ctx || !token || !this.cfg.clover || !ctx.external_account_id) return { sent: 0, cursor }
    const since = cursor && /^\d{10,16}$/.test(cursor) ? Number(cursor) : Date.now() - 24 * 3600 * 1000
    const client = new CloverClient(this.cfg.clover.baseURL, token, this.fetcher)
    let sent = 0, latest = since
    for (let i = 0; i < maxPages; i++) {
      const page = await client.ordersSince(ctx.external_account_id, since, i * 100)
      const sales = page.map((o) => normalizeCloverOrder(o, ctx.external_account_id!)).filter((x): x is NormalizedSale => !!x)
      for (const o of page) { const m = (o as { modifiedTime?: number }).modifiedTime; if (typeof m === 'number' && m > latest) latest = m }
      if (sales.length) { await this.ingestWithCursor(integration, sales, String(latest)); sent += sales.length }
      if (page.length < 100) break
    }
    if (!sent) await this.ingestWithCursor(integration, [], String(latest))
    return { sent, cursor: String(latest) }
  }
  /** Lightspeed X polling by version: sales above the cursor; returns (negative quantities) are applied to their sale */
  async pollLightspeed(integration: string, cursor: string | null, maxPages = 20): Promise<{ sent: number; cursor: string | null }> {
    const ctx = await this.context(integration)
    const token = ctx ? this.token(ctx) : null
    if (!ctx || !token || !ctx.external_account_id) return { sent: 0, cursor }
    const client = new LightspeedClient(lightspeedBase(ctx.external_account_id, this.cfg.lightspeedBase), token, this.fetcher)
    let after = cursor && /^\d{1,18}$/.test(cursor) ? Number(cursor) : 0, sent = 0
    for (let i = 0; i < maxPages; i++) {
      const page = await client.salesAfter(after)
      const sales = page.sales.map((x) => normalizeLightspeedSale(x)).filter((x): x is NormalizedSale => !!x)
      const next = page.max ?? after
      if (sales.length) { await this.ingestWithCursor(integration, sales, String(next)); sent += sales.length }
      if (!page.sales.length || next <= after) break
      after = next
    }
    if (!sent) await this.ingestWithCursor(integration, [], String(after))
    return { sent, cursor: String(after) }
  }
  /** Shopify polling through GraphQL: POS orders updated since the cursor (ISO), 50 per page */
  async pollShopify(integration: string, cursor: string | null, maxPages = 20): Promise<{ sent: number; cursor: string | null }> {
    const ctx = await this.context(integration)
    const token = ctx ? this.token(ctx) : null
    if (!ctx || !token || !ctx.external_account_id) return { sent: 0, cursor }
    const since = cursor && !Number.isNaN(Date.parse(cursor)) ? cursor : new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const client = new ShopifyClient(shopifyBase(ctx.external_account_id, this.cfg.shopifyBase), token, this.fetcher)
    let after: string | null = null, sent = 0, latest = since
    for (let i = 0; i < maxPages; i++) {
      const page = await client.ordersSince(since, after)
      const rest = page.orders.map(shopifyGqlToRest)
      for (const o of rest) latest = laterIso(latest, o.updated_at as string | undefined)
      const sales = rest.map((o) => normalizeShopifyOrder(o)).filter((x): x is NormalizedSale => !!x)
      if (sales.length) { await this.ingestWithCursor(integration, sales, latest); sent += sales.length }
      if (!page.next) break
      after = page.next
    }
    if (!sent) await this.ingestWithCursor(integration, [], latest)
    return { sent, cursor: latest }
  }
  private async ingestWithCursor(integration: string, sales: NormalizedSale[], cursor: string) {
    const payload = JSON.stringify({ trigger: 'scheduled', status: 'succeeded', cursor, sales })
    const s = this.signer.ingest(integration, payload)
    const { error } = await this.supabase.rpc('pos_ingest_batch', { integration, payload, key: s.key, ts: s.ts, nonce: s.nonce, mac: s.mac })
    if (error) throw new Error('DB')
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
  async fetchSale(ctx: Ctx, provider: string, objectId: string, body?: unknown, integration: string | null = null): Promise<NormalizedSale | { error: string } | null> {
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
      try {
        const order = await this.withSquare(integration, ctx, (c) => c.order(objectId))
        const ret = normalizeSquareReturn(order)
        if (ret) {   // a return: the refund belongs to the original sale, sent with it
          const src = normalizeSquareOrder(await this.withSquare(integration, ctx, (c) => c.order(ret.sourceOrderId)))
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
    const sale = await sync.fetchSale(ctx, provider, ev.objectId, body, rec.integration_id)
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
    const sale = ctx ? await sync.fetchSale(ctx, d.provider, d.object_id, undefined, d.integration_id) : null
    if (!sale || 'error' in sale) { skipped++; continue }
    await sync.ingest(d.integration_id, [{ ...sale, event_id: String(d.event_id) }], 'recovery')
    applied++
  }
  // periodic polling of Square (missed webhooks): every active integration from its cursor
  let polled = 0
  if (cfg.square.configured === true) {
    const a = signer.active('square')
    const { data: active } = await supabase.rpc('pos_integrations_active', { provider: 'square', key: a.key, ts: a.ts, nonce: a.nonce, mac: a.mac })
    for (const it of (active ?? []) as { integration_id: string; cursor: string | null; locations: string[] }[]) {
      try { polled += (await sync.pollSquare(it.integration_id, it.locations, it.cursor)).sent } catch { /* the integration stays as it was; next run retries */ }
    }
  }
  if (cfg.clover) {
    const a = signer.active('clover')
    const { data: active } = await supabase.rpc('pos_integrations_active', { provider: 'clover', key: a.key, ts: a.ts, nonce: a.nonce, mac: a.mac })
    for (const it of (active ?? []) as { integration_id: string; cursor: string | null }[]) {
      try { polled += (await sync.pollClover(it.integration_id, it.cursor)).sent } catch { /* retried on the next run */ }
    }
  }
  if (cfg.shopifySecret) {
    const a = signer.active('shopify')
    const { data: active } = await supabase.rpc('pos_integrations_active', { provider: 'shopify', key: a.key, ts: a.ts, nonce: a.nonce, mac: a.mac })
    for (const it of (active ?? []) as { integration_id: string; cursor: string | null }[]) {
      try { polled += (await sync.pollShopify(it.integration_id, it.cursor)).sent } catch { /* retried on the next run */ }
    }
  }
  if (cfg.lightspeedSecret) {
    const a = signer.active('lightspeed_x')
    const { data: active } = await supabase.rpc('pos_integrations_active', { provider: 'lightspeed_x', key: a.key, ts: a.ts, nonce: a.nonce, mac: a.mac })
    for (const it of (active ?? []) as { integration_id: string; cursor: string | null }[]) {
      try { polled += (await sync.pollLightspeed(it.integration_id, it.cursor)).sent } catch { /* retried on the next run */ }
    }
  }
  return { ok: true as const, due: due.length, applied, skipped, polled }
}

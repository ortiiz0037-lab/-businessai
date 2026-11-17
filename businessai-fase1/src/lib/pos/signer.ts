/**
 * Server signatures of the POS machine writes (SERVER ONLY). The canonical messages must match
 * public.pos_* in migration 0044 byte for byte:
 *   pos_connect|v1|key|uid|target|ts|nonce|sha(payload)
 *   pos_ctx|v1|key|integration|ts|nonce
 *   pos_ingest|v1|key|integration|ts|nonce|sha(payload)
 *   pos_webhook|v1|key|provider|event_key|ts|nonce|sha(payload)
 *   pos_settle|v1|key|integration|ts|nonce|sha(payload)
 *   pos_due|v1|key|ts|nonce
 *   pos_bridge|v1|key|token_sha|ts|nonce
 *   pos_token|v1|key|integration|ts|nonce|sha(payload)      (0045)
 *   pos_active|v1|key|provider|ts|nonce                     (0045)
 * Each signature is single-use (nonce) and valid for two minutes.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { nowSeconds, shaHex, type ServerKey } from '@/lib/intelligence/server-auth'

export type Signed = { key: string; ts: number; nonce: string; mac: string }

export class PosSigner {
  constructor(private readonly k: ServerKey, private readonly clock: () => number = nowSeconds) {}
  private sign(parts: string[]): Signed {
    const ts = this.clock(), nonce = randomUUID()
    const msg = parts.map((p) => (p === '{ts}' ? String(ts) : p === '{nonce}' ? nonce : p)).join('|')
    return { key: this.k.id, ts, nonce, mac: createHmac('sha256', this.k.secret).update(msg, 'utf8').digest('hex') }
  }
  connect(userId: string, target: string, payload: string) { return this.sign(['pos_connect', 'v1', this.k.id, userId.toLowerCase(), target, '{ts}', '{nonce}', shaHex(payload)]) }
  context(integration: string) { return this.sign(['pos_ctx', 'v1', this.k.id, integration, '{ts}', '{nonce}']) }
  ingest(integration: string, payload: string) { return this.sign(['pos_ingest', 'v1', this.k.id, integration, '{ts}', '{nonce}', shaHex(payload)]) }
  webhook(provider: string, eventKey: string, payload: string) { return this.sign(['pos_webhook', 'v1', this.k.id, provider, eventKey, '{ts}', '{nonce}', shaHex(payload)]) }
  settle(integration: string, payload: string) { return this.sign(['pos_settle', 'v1', this.k.id, integration, '{ts}', '{nonce}', shaHex(payload)]) }
  due() { return this.sign(['pos_due', 'v1', this.k.id, '{ts}', '{nonce}']) }
  bridge(tokenSha: string) { return this.sign(['pos_bridge', 'v1', this.k.id, tokenSha, '{ts}', '{nonce}']) }
  token(integration: string, payload: string) { return this.sign(['pos_token', 'v1', this.k.id, integration, '{ts}', '{nonce}', shaHex(payload)]) }
  active(provider: string) { return this.sign(['pos_active', 'v1', this.k.id, provider, '{ts}', '{nonce}']) }
}

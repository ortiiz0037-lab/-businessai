/**
 * Server signatures of the banking writes (SERVER ONLY). The canonical
 * messages must match public.bank_* in migration 0042 byte for byte:
 *   bank_connect|v1|key|uid|target|ts|nonce|sha(payload)
 *   bank_ctx|v1|key|connection|ts|nonce
 *   bank_apply|v1|key|connection|ts|nonce|sha(payload)
 *   bank_webhook|v1|key|provider|event_key|ts|nonce|sha(payload)
 *   bank_disconnect|v1|key|uid|connection|ts|nonce
 * Each signature is single-use (nonce) and valid for two minutes.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { nowSeconds, shaHex, type ServerKey } from '@/lib/intelligence/server-auth'

export type Signed = { key: string; ts: number; nonce: string; mac: string }

export class BankSigner {
  constructor(private readonly k: ServerKey) {}
  private sign(parts: string[]): Signed {
    const ts = nowSeconds(), nonce = randomUUID()
    const msg = parts.map((p) => p.replace('{ts}', String(ts)).replace('{nonce}', nonce)).join('|')
    return { key: this.k.id, ts, nonce, mac: createHmac('sha256', this.k.secret).update(msg, 'utf8').digest('hex') }
  }
  connect(userId: string, target: string, payload: string) {
    return this.sign(['bank_connect', 'v1', this.k.id, userId.toLowerCase(), target, '{ts}', '{nonce}', shaHex(payload)])
  }
  context(connection: string) {
    return this.sign(['bank_ctx', 'v1', this.k.id, connection, '{ts}', '{nonce}'])
  }
  apply(connection: string, payload: string) {
    return this.sign(['bank_apply', 'v1', this.k.id, connection, '{ts}', '{nonce}', shaHex(payload)])
  }
  webhook(provider: string, eventKey: string, payload: string) {
    return this.sign(['bank_webhook', 'v1', this.k.id, provider, eventKey, '{ts}', '{nonce}', shaHex(payload)])
  }
  disconnect(userId: string, connection: string) {
    return this.sign(['bank_disconnect', 'v1', this.k.id, userId.toLowerCase(), connection, '{ts}', '{nonce}'])
  }
}

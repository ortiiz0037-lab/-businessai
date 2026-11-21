/**
 * Verification of Plaid webhooks (SERVER ONLY). Plaid signs each webhook with
 * a JWT (ES256) in the "Plaid-Verification" header: its header names the key
 * (kid), its payload carries the SHA-256 of the raw body and the issue time.
 * A webhook is accepted only when the signature verifies with the key Plaid
 * returns for that kid, the key has not expired, the token is at most five
 * minutes old and the body hash matches.
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

export type JwkFetcher = (kid: string) => Promise<(JsonWebKey & { kid?: string; alg?: string; expired_at?: number | null }) | null>

const cache = new Map<string, { jwk: JsonWebKey & { expired_at?: number | null }; at: number }>()

function b64json(part: string): Record<string, unknown> | null {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return null }
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'alg' | 'key' | 'signature' | 'stale' | 'body' }

export async function verifyPlaidWebhook(token: string | null, rawBody: string, getKey: JwkFetcher, now = Date.now()): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'missing' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const header = b64json(parts[0]), payload = b64json(parts[1])
  if (!header || !payload) return { ok: false, reason: 'malformed' }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(header.kid)) return { ok: false, reason: 'alg' }
  let entry = cache.get(header.kid)
  if (!entry || now - entry.at > 24 * 3600 * 1000) {
    const jwk = await getKey(header.kid).catch(() => null)
    if (!jwk) return { ok: false, reason: 'key' }
    entry = { jwk, at: now }
    cache.set(header.kid, entry)
  }
  if (entry.jwk.expired_at && entry.jwk.expired_at * 1000 < now) return { ok: false, reason: 'key' }
  let good = false
  try {
    const { expired_at: _ignored, ...jwk } = entry.jwk as JsonWebKey & { expired_at?: unknown; created_at?: unknown }
    void _ignored
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' })
    good = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))
  } catch { good = false }
  if (!good) return { ok: false, reason: 'signature' }
  const iat = Number(payload.iat)
  if (!Number.isFinite(iat) || Math.abs(now / 1000 - iat) > 5 * 60) return { ok: false, reason: 'stale' }
  const claimed = String(payload.request_body_sha256 ?? '')
  const actual = createHash('sha256').update(rawBody, 'utf8').digest('hex')
  if (claimed.length !== actual.length || !timingSafeEqual(Buffer.from(claimed), Buffer.from(actual))) return { ok: false, reason: 'body' }
  return { ok: true }
}

/** Tests only. */
export function clearWebhookKeyCache() { cache.clear() }

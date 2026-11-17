/** Shared pieces of the provider adapters (SERVER ONLY). */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { NormalizedSale, PaymentMethod, ProviderId, WebhookEvent } from '@/lib/pos/types'

export type HeaderBag = { get(name: string): string | null }

/** What each adapter really does — shown on the integrations page and in docs/POS.md. */
export type AdapterStatus = 'implemented' | 'mapping_only' | 'not_implemented'
export type AdapterInfo = {
  id: ProviderId
  name: string
  status: AdapterStatus
  /** verified only against local test doubles built from the provider's documented payloads */
  verifiedWith: 'test_double' | 'none'
  webhookHeader: string | null
}

export interface PosAdapter {
  info: AdapterInfo
  /** true when the request carries the provider's valid signature (constant-time comparison) */
  verifyWebhook(input: { headers: HeaderBag; rawBody: string; secret: string; url?: string }): boolean
  /** the event(s) of a webhook body, reduced to what the database records (never card data) */
  parseWebhook(rawBody: string, headers: HeaderBag): WebhookEvent[]
  /** a provider order → the common sale (null when it is not a sale to import, e.g. an open ticket) */
  normalize(order: unknown): NormalizedSale | null
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}
export const hmacB64 = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('base64')
export const hmacHex = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex')

export const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const last4 = (v: unknown): string | null => { const s = str(v, 8); return s && /^\d{4}$/.test(s) ? s : null }
export const brand = (v: unknown): string | null => { const s = str(v, 40); return s ? s.replace(/[^A-Za-z_ ]/g, '').slice(0, 30) || null : null }

/** a provider's tender name → our payment method (ATH Móvil is recognised by name: it arrives as an "other" tender) */
export function methodFromLabel(label: string | null | undefined): PaymentMethod {
  const l = (label ?? '').toLowerCase()
  if (/ath/.test(l)) return 'ath_movil'
  if (/cash|efectivo/.test(l)) return 'cash'
  if (/card|credit|debit|tarjeta|visa|master|amex/.test(l)) return 'card'
  if (/check|cheque/.test(l)) return 'check'
  if (/gift|regalo/.test(l)) return 'gift_card'
  if (/transfer|wire|ach/.test(l)) return 'transfer'
  if (/store credit|on account|crédito/.test(l)) return 'store_credit'
  return 'other'
}

/** epoch milliseconds of an ISO date (used as a monotonic version when the provider has none) */
export const msOf = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? String(t) : null
}

/**
 * A provider request that respects rate limits: on 429 / 503 it waits Retry-After (seconds or a date;
 * capped at `maxWaitMs`, default 1 s growing ×4) and tries again, at most `retries` times. Any other
 * answer is returned as it is. Never logs the request (it carries the access token).
 */
export async function providerFetch(fetcher: typeof fetch, url: string, init: RequestInit, opts: { retries?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const retries = opts.retries ?? 2, maxWait = opts.maxWaitMs ?? 10000, sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(url, init)
    if ((res.status !== 429 && res.status !== 503) || attempt >= retries) return res
    const ra = res.headers.get('retry-after')
    let wait = 1000 * 4 ** attempt
    if (ra && /^\d+$/.test(ra)) wait = Number(ra) * 1000
    else if (ra && !Number.isNaN(Date.parse(ra))) wait = Date.parse(ra) - Date.now()
    await sleep(Math.max(0, Math.min(wait, maxWait)))
  }
}

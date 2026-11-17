/**
 * POS integrations configuration (SERVER ONLY). Closed by default: the BusinessAI register and CSV
 * import work without any of this; a provider is offered only when its credentials AND the server
 * keys exist. Nothing here is ever sent to the browser or logged.
 *
 *   POS_SERVER_KEYS           "<id>:<base64 ≥ 32 bytes>[,…]" — signs webhooks / syncs / connections (0044).
 *                             Registered in the database by its owner: select public.pos_set_server_key('<id>', '<base64>')
 *   POS_TOKEN_KEYS            "<id>:<base64 32 bytes>[,…]" — AES-256-GCM key for the providers' access tokens
 *   SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET   OAuth app (Square Developer Dashboard)
 *   SQUARE_ENV                'sandbox' | 'production' (default sandbox)
 *   SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_URL   the subscription's signature key and its exact notification URL
 *   SQUARE_BASE_URL           optional; outside production a loopback http URL selects the local TEST DOUBLE
 *   SHOPIFY_API_SECRET        the app's client secret (webhook HMAC); SHOPIFY_ACCESS_SCOPES documented in docs/POS.md
 *   CLOVER_WEBHOOK_AUTH_CODE  the verification code Clover shows when the webhook URL is verified
 *   CLOVER_BASE_URL           https://api.clover.com (US) | https://apisandbox.dev.clover.com; loopback http = TEST DOUBLE
 *   LIGHTSPEED_CLIENT_SECRET  X-Series OAuth app secret (webhook signature)
 *   POS_BRIDGE_ENABLED=1      accepts sales from the local bridge (/api/pos/bridge)
 *   POS_CRON_SECRET           ≥ 32 characters; authorises the recovery job (/api/pos/recover)
 */
import { baseUrlAllowed } from '@/lib/assistant/config'
import { parseTokenKeys, type TokenKey } from '@/lib/banking/config'
import { getAppEnv } from '@/lib/env'
import { parseServerKeys, type ServerKey } from '@/lib/intelligence/server-auth'

export type PosCore = { serverKeys: ServerKey[]; tokenKeys: TokenKey[] }
export type SquareConfig = { configured: true; appId: string; secret: string; environment: 'sandbox' | 'production' | 'test_double'; baseURL: string; oauthURL: string
  webhookKey: string | null; webhookURL: string | null } | { configured: false; reason: string }
export type PosConfig = {
  core: PosCore | null
  square: SquareConfig
  shopifySecret: string | null
  clover: { authCode: string; baseURL: string; testDouble: boolean } | null
  lightspeedSecret: string | null
  bridge: boolean
  cronSecret: string | null
}

function appEnv(env: Record<string, string | undefined>): string {
  if (env !== process.env) return env.APP_ENV ?? 'development'
  try { return getAppEnv() } catch { return 'production' }
}
const SQUARE = { sandbox: 'https://connect.squareupsandbox.com', production: 'https://connect.squareup.com' } as const

export function readPosConfig(env: Record<string, string | undefined> = process.env): PosConfig {
  const serverKeys = parseServerKeys(env.POS_SERVER_KEYS), tokenKeys = parseTokenKeys(env.POS_TOKEN_KEYS)
  const core = serverKeys.length && tokenKeys.length ? { serverKeys, tokenKeys } : null
  const ae = appEnv(env)
  let square: SquareConfig
  const appId = (env.SQUARE_APPLICATION_ID ?? '').trim(), secret = (env.SQUARE_APPLICATION_SECRET ?? '').trim()
  if (!core) square = { configured: false, reason: 'missing_server_keys' }
  else if (!appId || !secret) square = { configured: false, reason: 'missing_credentials' }
  else {
    const se = env.SQUARE_ENV === 'production' ? 'production' : 'sandbox'
    const override = (env.SQUARE_BASE_URL ?? '').trim()
    if (override && !baseUrlAllowed(override, ae)) square = { configured: false, reason: 'invalid_base_url' }
    else {
      const testDouble = !!override && new URL(override).protocol === 'http:'
      const base = (override || SQUARE[se]).replace(/\/$/, '')
      square = { configured: true, appId, secret, environment: testDouble ? 'test_double' : se, baseURL: base, oauthURL: base,
        webhookKey: (env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '').trim() || null, webhookURL: (env.SQUARE_WEBHOOK_URL ?? '').trim() || null }
    }
  }
  const cloverBase = (env.CLOVER_BASE_URL ?? 'https://api.clover.com').trim()
  const cloverCode = (env.CLOVER_WEBHOOK_AUTH_CODE ?? '').trim()
  return {
    core,
    square,
    shopifySecret: core ? (env.SHOPIFY_API_SECRET ?? '').trim() || null : null,
    clover: core && cloverCode && baseUrlAllowed(cloverBase, ae) ? { authCode: cloverCode, baseURL: cloverBase.replace(/\/$/, ''), testDouble: cloverBase.startsWith('http:') } : null,
    lightspeedSecret: core ? (env.LIGHTSPEED_CLIENT_SECRET ?? '').trim() || null : null,
    bridge: !!core && env.POS_BRIDGE_ENABLED === '1',
    cronSecret: (env.POS_CRON_SECRET ?? '').length >= 32 ? env.POS_CRON_SECRET! : null,
  }
}

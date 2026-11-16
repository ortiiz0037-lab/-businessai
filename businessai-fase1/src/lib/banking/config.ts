/**
 * Banking configuration (SERVER ONLY). Closed by default: without provider
 * credentials, the server signing key and the token encryption key, bank
 * connections are not offered. Nothing here is ever sent to the browser.
 *
 *   PLAID_CLIENT_ID, PLAID_SECRET   provider credentials (never logged or returned)
 *   PLAID_ENV                       'sandbox' | 'production' (default sandbox)
 *   PLAID_BASE_URL                  optional override. https only; outside production a
 *                                   loopback http URL is accepted for the local TEST DOUBLE
 *                                   (the connection is then labelled 'test_double')
 *   PLAID_WEBHOOK_URL               optional; public https URL of /api/banking/webhooks/plaid
 *   PLAID_COUNTRY_CODES             optional, default "US" (Puerto Rico banks are US institutions)
 *   BANK_SERVER_KEYS                "<id>:<base64 ≥ 32 bytes>[,…]" — signs syncs, webhooks and
 *                                   connection writes (0042). Registered in the database by its
 *                                   owner: select public.bank_set_server_key('<id>', '<base64>')
 *   BANK_TOKEN_KEYS                 "<id>:<base64 32 bytes>[,…]" — AES-256-GCM key that encrypts the
 *                                   provider access tokens; the first one encrypts, all decrypt
 *   BANKING_DISABLED=1              turns bank connections off
 *
 * Receipt OCR (optional; without it receipts are typed in by hand):
 *   OCR_PROVIDER                    'azure' | 'none' (default none)
 *   AZURE_DOCINTEL_ENDPOINT         https://<resource>.cognitiveservices.azure.com (loopback http
 *                                   outside production for the local TEST DOUBLE)
 *   AZURE_DOCINTEL_KEY              resource key (never logged or returned)
 */
import { baseUrlAllowed } from '@/lib/assistant/config'
import { getAppEnv } from '@/lib/env'
import { parseServerKeys, type ServerKey } from '@/lib/intelligence/server-auth'

export type TokenKey = { id: string; key: Buffer }

export type BankingConfig =
  | { configured: true; provider: 'plaid'; clientId: string; secret: string; environment: 'sandbox' | 'production' | 'test_double'; baseURL: string
      webhookURL: string | null; countryCodes: string[]; serverKeys: ServerKey[]; tokenKeys: TokenKey[] }
  | { configured: false; reason: 'disabled' | 'missing_credentials' | 'missing_server_key' | 'missing_token_key' | 'invalid_base_url' }

export type OcrConfig =
  | { configured: true; provider: 'azure'; endpoint: string; key: string; testDouble: boolean }
  | { configured: false; reason: 'none' | 'missing_credentials' | 'invalid_endpoint' }

function appEnv(env: Record<string, string | undefined>): string {
  if (env !== process.env) return env.APP_ENV ?? 'development'
  try { return getAppEnv() } catch { return 'production' }
}

export function parseTokenKeys(raw: string | undefined): TokenKey[] {
  const keys: TokenKey[] = []
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':')
    if (i < 1) return []
    const id = entry.slice(0, i), b64 = entry.slice(i + 1)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return []
    const key = Buffer.from(b64, 'base64')
    if (key.length !== 32) return []
    keys.push({ id, key })
  }
  return keys
}

const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' } as const

export function readBankingConfig(env: Record<string, string | undefined> = process.env): BankingConfig {
  if (env.BANKING_DISABLED === '1') return { configured: false, reason: 'disabled' }
  const clientId = (env.PLAID_CLIENT_ID ?? '').trim(), secret = (env.PLAID_SECRET ?? '').trim()
  if (!clientId || !secret) return { configured: false, reason: 'missing_credentials' }
  const serverKeys = parseServerKeys(env.BANK_SERVER_KEYS)
  if (!serverKeys.length) return { configured: false, reason: 'missing_server_key' }
  const tokenKeys = parseTokenKeys(env.BANK_TOKEN_KEYS)
  if (!tokenKeys.length) return { configured: false, reason: 'missing_token_key' }
  const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox'
  const override = (env.PLAID_BASE_URL ?? '').trim()
  if (override && !baseUrlAllowed(override, appEnv(env))) return { configured: false, reason: 'invalid_base_url' }
  const testDouble = !!override && new URL(override).protocol === 'http:'
  const hook = (env.PLAID_WEBHOOK_URL ?? '').trim()
  const webhookURL = hook && (hook.startsWith('https://') || (testDouble && hook.startsWith('http://127.0.0.1'))) ? hook : null
  const countryCodes = (env.PLAID_COUNTRY_CODES ?? 'US').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
  return { configured: true, provider: 'plaid', clientId, secret, environment: testDouble ? 'test_double' : plaidEnv, baseURL: (override || PLAID_HOSTS[plaidEnv]).replace(/\/$/, ''),
    webhookURL, countryCodes: countryCodes.length ? countryCodes : ['US'], serverKeys, tokenKeys }
}

export function readOcrConfig(env: Record<string, string | undefined> = process.env): OcrConfig {
  if ((env.OCR_PROVIDER ?? 'none') !== 'azure') return { configured: false, reason: 'none' }
  const endpoint = (env.AZURE_DOCINTEL_ENDPOINT ?? '').trim().replace(/\/$/, ''), key = (env.AZURE_DOCINTEL_KEY ?? '').trim()
  if (!endpoint || !key) return { configured: false, reason: 'missing_credentials' }
  if (!baseUrlAllowed(endpoint, appEnv(env))) return { configured: false, reason: 'invalid_endpoint' }
  return { configured: true, provider: 'azure', endpoint, key, testDouble: new URL(endpoint).protocol === 'http:' }
}

/** Only the bank server key is needed to record webhooks and to read status (no provider call). */
export function readBankServerKeys(env: Record<string, string | undefined> = process.env): ServerKey[] {
  return parseServerKeys(env.BANK_SERVER_KEYS)
}

/** What the UI may know. Never a key, a secret or a URL. */
export function bankingStatus(c: BankingConfig = readBankingConfig()) {
  return c.configured ? { configured: true as const, environment: c.environment, webhooks: !!c.webhookURL } : { configured: false as const, reason: c.reason }
}
export function ocrStatus(c: OcrConfig = readOcrConfig()) {
  return c.configured ? { configured: true as const, provider: c.provider, testDouble: c.testDouble } : { configured: false as const, reason: c.reason }
}

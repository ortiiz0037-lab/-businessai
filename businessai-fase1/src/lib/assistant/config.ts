/**
 * Assistant configuration (SERVER ONLY). Read from the server environment;
 * nothing here is ever sent to the browser. Closed by default: without a
 * provider key AND a server signing key the assistant does not start.
 *
 *   ANTHROPIC_API_KEY       provider key (never logged or returned)
 *   ASSISTANT_SERVER_KEYS   "<id>:<base64 ≥ 32 bytes>[,<id>:<base64>…]" — signs the
 *                           assistant's internal writes (0030); first entry signs.
 *                           The same key must be registered in the database.
 *   ASSISTANT_MODEL         optional: pins a REGISTERED model for the tiers it is approved for
 *   ASSISTANT_ROUTER=off    optional: one model (P2 policy) for every request
 *   ASSISTANT_ROUTER_POLICY=benchmark  optional: approved tiers come ONLY from human-approved real
 *                           benchmark runs (src/lib/intelligence/approvals.json); default: provisional
 *   ASSISTANT_TURN_DEADLINE_MS  optional, 10 000 – 55 000 (default 50 000; the
 *                           stream route allows 60 s of execution)
 *   ANTHROPIC_BASE_URL      optional; https only. Outside production a loopback http URL
 *                           is accepted for the local test double (costs are marked 'test')
 *   ASSISTANT_DISABLED=1    turns the assistant off
 */
import { getAppEnv } from '@/lib/env'
import { findModel } from '@/lib/intelligence/registry'
import { parseServerKeys, type ServerKey } from '@/lib/intelligence/server-auth'

export type AssistantConfig =
  | { configured: true; apiKey: string; baseURL: string | undefined; testDouble: boolean; serverKeys: ServerKey[]; pinnedModel: string | null; routerEnabled: boolean; routerPolicy: 'provisional' | 'benchmark'; deadlineMs: number }
  | { configured: false; reason: 'missing_key' | 'missing_server_key' | 'disabled' | 'invalid_base_url' | 'invalid_model' }

export function readAssistantConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
  if (env.ASSISTANT_DISABLED === '1') return { configured: false, reason: 'disabled' }
  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  if (!apiKey) return { configured: false, reason: 'missing_key' }
  const serverKeys = parseServerKeys(env.ASSISTANT_SERVER_KEYS)
  if (!serverKeys.length) return { configured: false, reason: 'missing_server_key' }
  const pinned = (env.ASSISTANT_MODEL ?? '').trim() || null
  if (pinned && !findModel(pinned)) return { configured: false, reason: 'invalid_model' }
  const baseURL = (env.ANTHROPIC_BASE_URL ?? '').trim() || undefined
  const appEnvironment = appEnv(env)
  if (baseURL && !baseUrlAllowed(baseURL, appEnvironment)) return { configured: false, reason: 'invalid_base_url' }
  const testDouble = !!baseURL && new URL(baseURL).protocol === 'http:'
  const d = Number(env.ASSISTANT_TURN_DEADLINE_MS ?? 50000)
  return { configured: true, apiKey, baseURL, testDouble, serverKeys, pinnedModel: pinned, routerEnabled: env.ASSISTANT_ROUTER !== 'off',
    routerPolicy: env.ASSISTANT_ROUTER_POLICY === 'benchmark' ? 'benchmark' : 'provisional',
    deadlineMs: Number.isFinite(d) ? Math.min(55000, Math.max(10000, Math.round(d))) : 50000 }
}

function appEnv(env: Record<string, string | undefined>): string {
  if (env !== process.env) return env.APP_ENV ?? 'development'
  try { return getAppEnv() } catch { return 'production' }   // unknown: the strictest rules
}

/** https anywhere; plain http only to the local machine and never in production. */
export function baseUrlAllowed(url: string, appEnvironment: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && appEnvironment !== 'production' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
}

/** What the UI may know: whether it works and why not. Never a key or the URL. */
export function publicAssistantState(cfg: AssistantConfig): { configured: boolean; reason: string | null } {
  return cfg.configured ? { configured: true, reason: null } : { configured: false, reason: cfg.reason }
}

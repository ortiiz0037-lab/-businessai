/**
 * Assistant configuration (SERVER ONLY). Read from the environment of the
 * server; nothing here is ever sent to the browser.
 *
 *   ANTHROPIC_API_KEY     required to enable the assistant (never logged,
 *                         never returned; only its presence is reported)
 *   ASSISTANT_MODEL       optional; default below
 *   ASSISTANT_EFFORT      optional: low | medium | high (default medium)
 *   ANTHROPIC_BASE_URL    optional; https only. Outside production a
 *                         loopback http URL is accepted for the local test
 *                         double (e2e/local-stack/llm-double.mjs)
 *   ASSISTANT_DISABLED=1  turns the assistant off without removing the key
 */
import { getAppEnv } from '@/lib/env'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export type Effort = 'low' | 'medium' | 'high'
export type AssistantConfig =
  | { configured: true; apiKey: string; model: string; effort: Effort; baseURL: string | undefined; maxTokens: number }
  | { configured: false; reason: 'missing_key' | 'disabled' | 'invalid_base_url' | 'invalid_model' }

const MODEL = /^[a-z0-9][a-z0-9.\-]{2,80}$/

export function readAssistantConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
  if (env.ASSISTANT_DISABLED === '1') return { configured: false, reason: 'disabled' }
  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  if (!apiKey) return { configured: false, reason: 'missing_key' }
  const model = (env.ASSISTANT_MODEL ?? '').trim() || DEFAULT_MODEL
  if (!MODEL.test(model)) return { configured: false, reason: 'invalid_model' }
  const baseURL = (env.ANTHROPIC_BASE_URL ?? '').trim() || undefined
  if (baseURL && !baseUrlAllowed(baseURL, appEnv(env))) return { configured: false, reason: 'invalid_base_url' }
  const effort: Effort = (['low', 'medium', 'high'] as const).find((e) => e === env.ASSISTANT_EFFORT) ?? 'medium'
  return { configured: true, apiKey, model, effort, baseURL, maxTokens: 8000 }
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

/** What the UI may know: whether it works and why not. Never the key or the URL. */
export function publicAssistantState(cfg: AssistantConfig): { configured: boolean; reason: string | null; model: string | null } {
  return cfg.configured ? { configured: true, reason: null, model: cfg.model } : { configured: false, reason: cfg.reason, model: null }
}

/**
 * Benchmark entry point (bundled by bench/run.mjs with esbuild). Runs ONE
 * assistant turn through the production path — runSignedTurn: signed begin,
 * router, real Anthropic adapter (official SDK, streaming), tool loop with
 * the user's RLS session, facts verifier, signed finish — with two test-only
 * differences: the session comes from a minted user token instead of the
 * browser cookie, and ANTHROPIC base URL points to the local scripted double
 * (or, only with BENCH_ALLOW_PAID=1, to the real provider).
 */
import { createClient } from '@supabase/supabase-js'
import { runSignedTurn, type StreamEvent } from '@/lib/assistant/service'
import { parseServerKeys } from '@/lib/intelligence/server-auth'
import type { TraceEntry } from '@/lib/assistant/engine'
import type { Locale } from '@/lib/i18n/app'
import { anthropicProvider } from '@/lib/intelligence/adapters/anthropic'
import { MODELS } from '@/lib/intelligence/registry'
import type { LlmProvider } from '@/lib/intelligence/types'

/** Registry metadata for the report (versions of the models under test). */
export const REGISTRY = MODELS.map((m) => ({ id: m.id, provider: m.provider, status: m.status, verifiedAt: m.verifiedAt }))
export type ProviderRequest = { model: string; tools: string[]; toolResults: string[]; ok: boolean; error: string | null; input: number; output: number }

export type EngineTurnInput = {
  supabaseUrl: string; anonKey: string; token: string; userId: string; companyId: string; role: string; companyName: string; locale: Locale
  apiKey: string; baseURL: string | undefined; testDouble: boolean; serverKeys: string; deadlineMs: number; routerPolicy?: 'provisional' | 'benchmark'; pinnedModel?: string | null
  question: string; screen: string | null; cancelAfterMs?: number
}
export type EngineTurnResult = {
  status: string; text: string; verification: string | null; trace: TraceEntry[]; turnId: string | null; error: string | null; reason: string | null
  models: string[]; latencyMs: number; requests: ProviderRequest[]
}

/** The real adapter, observed: every request the engine makes (model, tools offered, tool results sent, usage). */
function observed(inner: LlmProvider, log: ProviderRequest[]): LlmProvider {
  return {
    id: inner.id, testDouble: inner.testDouble,
    async complete(req, opts) {
      const entry: ProviderRequest = { model: req.model, tools: req.tools.map((t) => t.name), ok: false, error: null, input: 0, output: 0,
        toolResults: req.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result').map((p) => (p as { content: string }).content)) }
      log.push(entry)
      try {
        const r = await inner.complete(req, opts)
        entry.ok = true; entry.input = r.usage.input; entry.output = r.usage.output
        return r
      } catch (e) { entry.error = (e as Error).message; throw e }
    },
  }
}

export async function runEngineTurn(i: EngineTurnInput): Promise<EngineTurnResult> {
  const supabase = createClient(i.supabaseUrl, i.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${i.token}` } } })
  const serverKeys = parseServerKeys(i.serverKeys)
  if (!serverKeys.length) throw new Error('bench: invalid server key')
  const cfg = { configured: true as const, apiKey: i.apiKey, baseURL: i.baseURL, testDouble: i.testDouble, serverKeys, pinnedModel: i.pinnedModel ?? null, routerEnabled: true,
    routerPolicy: i.routerPolicy ?? 'provisional', deadlineMs: i.deadlineMs }
  const ac = new AbortController()
  const timer = i.cancelAfterMs ? setTimeout(() => ac.abort(), i.cancelAfterMs) : null
  const trace: TraceEntry[] = []
  const models: string[] = []
  let final: Extract<StreamEvent, { type: 'final' }> | null = null
  let err: Extract<StreamEvent, { type: 'error' }> | null = null
  let turnId: string | null = null
  const requests: ProviderRequest[] = []
  const provider = observed(anthropicProvider({ apiKey: i.apiKey, baseURL: i.baseURL, testDouble: i.testDouble }), requests)
  const t0 = Date.now()
  await runSignedTurn({ supabase, user: { id: i.userId }, member: { companyId: i.companyId, role: i.role as never, companyName: i.companyName }, locale: i.locale }, cfg,
    { conversationId: null, text: i.question, screen: i.screen }, (e) => {
      if (e.type === 'start') { turnId = e.turnId; models.push(e.model) }
      else if (e.type === 'model') models.push(e.model)
      else if (e.type === 'tool') trace.push(e.entry)
      else if (e.type === 'final') final = e
      else if (e.type === 'error') err = e
    }, ac.signal, provider)
  if (timer) clearTimeout(timer)
  const latencyMs = Date.now() - t0
  const f = final as Extract<StreamEvent, { type: 'final' }> | null
  const e = err as Extract<StreamEvent, { type: 'error' }> | null
  const answer = f?.messages.filter((m) => m.role === 'assistant').at(-1) ?? null
  return { status: f?.status ?? `error:${e?.error ?? 'unknown'}`, text: answer?.content ?? '', verification: answer?.turn?.verification ?? null, trace, turnId,
    error: e?.error ?? null, reason: e?.reason ?? null, models: [...new Set(models)], latencyMs, requests }
}

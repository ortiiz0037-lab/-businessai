/**
 * One assistant turn over the provider-neutral contract.
 *
 *   - Only tools the user may use are offered; each call is checked again
 *     (allowed + offered + zod) before it runs.
 *   - Tool results go back wrapped as untrusted data, with a reference (T1…)
 *     the model must use to cite figures; the final text is verified and
 *     rendered by the server (src/lib/intelligence/facts.ts). One
 *     regeneration is requested when the text has unsourced figures; then a
 *     plain table of the verified data is shown instead.
 *   - Routing: the router's model first; on a retriable provider error the
 *     next model of the chain (equal or higher rank only); a tool that needs
 *     a higher tier than the current model restarts the turn once with a
 *     model approved for that tier. Never a silent downgrade.
 *   - Bounded: MAX_STEPS model calls, MAX_TOOL_CALLS tool runs, a deadline for
 *     the whole turn and the caller's AbortSignal (user cancellation).
 *   - Usage and cost are accumulated per call and RETURNED in every outcome
 *     (error and cancellation included) so they are always recorded (A5).
 */
import type { z } from 'zod'
import { ProviderError, TIER_RANK, ZERO_USAGE, addUsage, type LlmProvider, type Message, type ModelResponse, type Part, type Tier, type ToolSpec, type Usage } from '@/lib/intelligence/types'
import { findModel, type ModelEntry } from '@/lib/intelligence/registry'
import { route, type RouteDecision, type RouterConfig } from '@/lib/intelligence/router'
import { callCostNanos, type CostStatus } from '@/lib/intelligence/cost'
import { FactStore, fallbackText, verifyAndRender } from '@/lib/intelligence/facts'
import { ToolError, type Access, type ToolContext } from '@/lib/assistant/tools'
import { sanitizeAnswer, wrapUntrusted } from '@/lib/assistant/prompt'

export const MAX_STEPS = 8
export const MAX_TOOL_CALLS = 12
export type TraceEntry = { name: string; ok: boolean; ref?: string; error?: string; flagged?: boolean; source?: string; as_of?: string; from?: string; to?: string; complete?: boolean; link?: string }
export type TurnStatus = 'completed' | 'refused' | 'incomplete' | 'error' | 'cancelled'
export type TurnResult = {
  status: TurnStatus; text: string; verification: 'verified' | 'regenerated' | 'fallback' | 'none'
  trace: TraceEntry[]; actions: string[]; usage: Usage; calls: number; costNanos: bigint; costStatus: CostStatus
  provider: string; model: string; tier: Tier; router: { reason: string; fallback_from?: string[]; escalated_from?: string }
  errorCode?: string; refs: string[]; facts: FactStore
}
export type HistoryItem = { role: 'user' | 'assistant'; content: string }
type ToolLike = { name: string; description: string; schema: z.ZodObject; minTier: Tier; allowed: (a: Access) => boolean; run: (ctx: ToolContext, input: never) => Promise<unknown> }
export type TurnEvents = { onTool?: (e: TraceEntry) => void | Promise<void>; onDelta?: (text: string) => void; onReset?: () => void; onModel?: (model: string, tier: Tier) => void }
export type Texts = { refused: string; incomplete: string; empty: string; cancelled: string; error: string; unverified: string; regenerate: string }

/** History for the model: alternating roles, starting with the user, bounded. */
export function normalizeHistory(items: HistoryItem[], max = 20): Message[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = []
  for (const m of items.slice(-max)) {
    const content = m.content.slice(0, 8000)
    if (!content.trim()) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.text = `${last.text}\n\n${content}`
    else out.push({ role: m.role, text: content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out.map((m) => ({ role: m.role, parts: [{ type: 'text', text: m.text }] }))
}

const textOf = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n').trim()
const maxTierOf = (m: ModelEntry): Tier => m.tiers.reduce<Tier>((a, t) => (TIER_RANK[t] > TIER_RANK[a] ? t : a), 'P0')

export async function runTurn(input: {
  provider: LlmProvider; decision: RouteDecision; routerConfig: RouterConfig
  system: string; tools: ToolLike[]; toolSpecs: ToolSpec[]; ctx: ToolContext
  history: HistoryItem[]; userText: string; texts: Texts; events?: TurnEvents
  signal: AbortSignal; deadlineMs: number; maxOutputTokens?: number
}): Promise<TurnResult> {
  const started = Date.now()
  const base = normalizeHistory(input.history)
  if (base.length && base[base.length - 1].role === 'user') base.pop()   // an unanswered question is replaced by the new one
  const initial: Message[] = [...base, { role: 'user', parts: [{ type: 'text', text: input.userText }] }]
  let messages = [...initial]
  let decision = input.decision
  let chain: ModelEntry[] = [decision.model, ...decision.fallbacks]
  let model = chain.shift()!
  const router: TurnResult['router'] = { reason: decision.reason }
  const trace: TraceEntry[] = []
  const actions: string[] = []
  let facts = input.ctx.facts
  let usage: Usage = { ...ZERO_USAGE }
  let calls = 0
  let cost = 0n
  let unpriced = false
  let toolCalls = 0
  let regenerated = false
  let escalated = false
  input.events?.onModel?.(model.id, decision.tier)

  const result = (status: TurnStatus, text: string, extra: Partial<TurnResult> = {}): TurnResult => ({
    status, text, verification: 'none', trace, actions, usage, calls, costNanos: cost, costStatus: input.provider.testDouble ? 'test' : unpriced ? 'unpriced' : calls ? 'estimated' : 'none',
    provider: input.provider.id, model: model.id, tier: decision.tier, router, refs: [], facts, ...extra,
  })

  for (let step = 0; step < MAX_STEPS; step++) {
    if (input.signal.aborted) return result('cancelled', input.texts.cancelled, { errorCode: 'cancelled' })
    const remaining = input.deadlineMs - (Date.now() - started)
    if (remaining < 2000) return result('incomplete', input.texts.incomplete, { errorCode: 'deadline' })
    const ctl = new AbortController()
    const onAbort = () => ctl.abort('cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort('timeout'), remaining)
    let res: ModelResponse
    try {
      res = await input.provider.complete({ model: model.id, system: input.system, messages, tools: input.toolSpecs, maxOutputTokens: input.maxOutputTokens ?? 8000 },
        { signal: ctl.signal, timeoutMs: Math.max(1000, remaining), onText: input.events?.onDelta })
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', null)
      if (err.code === 'cancelled' || input.signal.aborted) return result('cancelled', input.texts.cancelled, { errorCode: 'cancelled' })
      const next = chain[0]
      if (err.retriable && next && input.deadlineMs - (Date.now() - started) > 5000) {
        // fallback only to an equal-or-higher model of the chain; the user is told the answer restarts
        router.fallback_from = [...(router.fallback_from ?? []), model.id]
        model = chain.shift()!
        input.events?.onReset?.(); input.events?.onModel?.(model.id, decision.tier)
        step--
        continue
      }
      return result('error', input.texts.error, { errorCode: err.code })
    } finally {
      clearTimeout(timer); input.signal.removeEventListener('abort', onAbort)
    }
    calls++
    usage = addUsage(usage, res.usage)
    const c = callCostNanos(findModel(model.id), res.usage)
    // a local test double is not a real spend: no cost, and nothing is charged to the company's budget
    if (c === null) unpriced = true; else if (!input.provider.testDouble) cost += c

    if (res.stop === 'tool_use') {
      const toolParts = res.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
      // a tool that needs a higher tier than this model is approved for: restart the turn once on an approved model
      const needs = toolParts.map((p) => input.tools.find((t) => t.name === p.name)).filter((t): t is ToolLike => !!t)
        .reduce<Tier | null>((a, t) => (TIER_RANK[t.minTier] > TIER_RANK[maxTierOf(model)] && (!a || TIER_RANK[t.minTier] > TIER_RANK[a]) ? t.minTier : a), null)
      if (needs && !escalated) {
        escalated = true
        router.escalated_from = model.id
        decision = route(needs, input.routerConfig, `escalated:${decision.reason}`)
        chain = [...decision.fallbacks]; model = decision.model
        messages = [...initial]; facts = input.ctx.facts = new FactStore(); trace.length = 0; actions.length = 0
        input.events?.onReset?.(); input.events?.onModel?.(model.id, decision.tier)
        continue
      }
      messages.push({ role: 'assistant', parts: res.parts })
      const results: Part[] = []
      for (const call of toolParts) results.push(await runTool(call, input, model, trace, actions, () => ++toolCalls))
      if (!results.length) return result('incomplete', input.texts.incomplete)
      messages.push({ role: 'user', parts: results })
      continue
    }
    if (res.stop === 'pause') { messages.push({ role: 'assistant', parts: res.parts }); continue }
    if (res.stop === 'refusal') return result('refused', input.texts.refused)
    if (res.stop === 'max_tokens' || res.stop === 'context_exceeded') return result('incomplete', input.texts.incomplete, { errorCode: res.stop })

    // end of turn: verify every figure against the recorded tool results
    const raw = textOf(res.parts)
    if (!raw) return result('incomplete', input.texts.empty)
    const v = verifyAndRender(raw, facts, { locale: input.ctx.locale, question: input.userText })
    if (v.ok) return result('completed', sanitizeAnswer(v.rendered), { verification: regenerated ? 'regenerated' : facts.all().length || v.refs.length ? 'verified' : 'none', refs: v.refs })
    if (!regenerated) {
      regenerated = true
      input.events?.onReset?.()
      messages.push({ role: 'assistant', parts: res.parts }, { role: 'user', parts: [{ type: 'text', text: `${input.texts.regenerate}\n${v.violations.join(', ')}` }] })
      continue
    }
    return result('completed', sanitizeAnswer(fallbackText(facts, input.ctx.locale, input.texts.unverified)), { verification: 'fallback' })
  }
  return result('incomplete', input.texts.incomplete, { errorCode: 'step_limit' })
}

async function runTool(call: Extract<Part, { type: 'tool_call' }>, input: Parameters<typeof runTurn>[0], model: ModelEntry, trace: TraceEntry[], actions: string[], count: () => number): Promise<Part> {
  const done = async (e: TraceEntry, content: string, isError: boolean): Promise<Part> => {
    trace.push(e); await input.events?.onTool?.(e)
    return { type: 'tool_result', callId: call.id, content, isError }
  }
  const name = String(call.name).slice(0, 60)
  if (count() > MAX_TOOL_CALLS) return done({ name, ok: false, error: 'tool_call_limit' }, 'Error: tool call limit for this turn reached. Answer with the data you already have.', true)
  const tool = input.tools.find((t) => t.name === name)
  // offered tools only; a tool the user may not use is refused even if the model names it
  if (!tool || !tool.allowed(input.ctx.access) || !input.toolSpecs.some((d) => d.name === name)) return done({ name, ok: false, error: 'not_allowed' }, 'Error: this tool is not available to this user.', true)
  if (TIER_RANK[tool.minTier] > TIER_RANK[maxTierOf(model)]) return done({ name, ok: false, error: 'tier' }, 'Error: this tool is not available at this precision level.', true)
  const parsed = tool.schema.safeParse(call.input)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    return done({ name, ok: false, error: 'invalid_input' }, `Error: invalid input (${issues}). Fix the arguments and try again.`, true)
  }
  try {
    const output = await tool.run(input.ctx, parsed.data as never) as import('@/lib/intelligence/facts').ToolOutput
    const ref = input.ctx.facts.add(name, output)
    const wrapped = wrapUntrusted(name, ref, output)
    const id = output.data.action_id
    if (name === 'propose_studio_draft' && typeof id === 'string') actions.push(id)
    const m = output.meta
    const link = typeof output.data.link === 'string' ? output.data.link : undefined
    return done({ name, ok: true, ref, source: m.source, complete: m.complete, ...(m.as_of ? { as_of: m.as_of } : {}), ...(m.from ? { from: m.from, to: m.to } : {}), ...(link ? { link } : {}), ...(wrapped.flagged ? { flagged: true } : {}) }, wrapped.text, false)
  } catch (e) {
    const code = e instanceof ToolError ? e.code : 'internal_error'
    if (!(e instanceof ToolError)) console.error('ASSISTANT_TOOL_ERROR', { tool: name, kind: (e as Error)?.name })
    return done({ name, ok: false, error: code }, `Error: ${code}.`, true)
  }
}

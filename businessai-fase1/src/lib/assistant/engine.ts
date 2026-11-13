/**
 * One assistant turn: the manual tool-use loop over the Messages API.
 * The provider and the tool registry are injected (tests use doubles).
 *
 * Guarantees:
 *   - only tools the user may use are offered, and each call is checked
 *     again (allowed + zod) before it runs;
 *   - tool results go back wrapped as untrusted data; suspicious content is
 *     flagged (audited) and never obeyed;
 *   - bounded: at most MAX_STEPS model calls and MAX_TOOL_CALLS tool runs;
 *   - every stop reason is handled; nothing is invented when the model stops
 *     early (refusal / max_tokens / step limit are reported as such).
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import type { LlmProvider } from '@/lib/assistant/provider'
import { ToolError, type Access, type ToolContext } from '@/lib/assistant/tools'
import { sanitizeAnswer, wrapUntrusted } from '@/lib/assistant/prompt'

export const MAX_STEPS = 8
export const MAX_TOOL_CALLS = 12
export type TraceEntry = { name: string; ok: boolean; error?: string; flagged?: boolean }
export type TurnStatus = 'ok' | 'refused' | 'incomplete' | 'error'
export type TurnResult = { text: string; status: TurnStatus; trace: TraceEntry[]; actions: string[]; usage: { input: number; output: number } }
export type HistoryItem = { role: 'user' | 'assistant'; content: string }
type ToolLike = { name: string; description: string; schema: z.ZodObject; allowed: (a: Access) => boolean; run: (ctx: ToolContext, input: never) => Promise<unknown> }
export type TurnEvents = { onTool?: (e: TraceEntry) => void | Promise<void> }

/** History for the model: alternating roles, starting with the user, bounded. */
export function normalizeHistory(items: HistoryItem[], max = 20): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of items.slice(-max)) {
    const content = m.content.slice(0, 8000)
    if (!content.trim()) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${content}`
    else out.push({ role: m.role, content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

export async function runTurn(input: {
  provider: LlmProvider; system: string; tools: ToolLike[]; toolDefs: Anthropic.Tool[]; ctx: ToolContext
  history: HistoryItem[]; userText: string; texts: { refused: string; incomplete: string; empty: string }; events?: TurnEvents
}): Promise<TurnResult> {
  const messages = normalizeHistory(input.history)
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop()   // an unanswered question is replaced by the new one
  messages.push({ role: 'user', content: input.userText })
  const trace: TraceEntry[] = []
  const actions: string[] = []
  const usage = { input: 0, output: 0 }
  let toolCalls = 0
  const textOf = (content: Anthropic.ContentBlock[]) => content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await input.provider.complete({ system: input.system, messages, tools: input.toolDefs })
    usage.input += res.usage.input; usage.output += res.usage.output
    switch (res.stopReason) {
      case 'tool_use': {
        messages.push({ role: 'assistant', content: res.content })
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of res.content) {
          if (block.type !== 'tool_use') continue
          results.push(await runTool(block, input, trace, actions, () => ++toolCalls))
        }
        if (!results.length) return { text: sanitizeAnswer(textOf(res.content)) || input.texts.incomplete, status: 'incomplete', trace, actions, usage }
        messages.push({ role: 'user', content: results })
        continue
      }
      case 'pause_turn':
        // a long server-side turn: send it back as is and let the model continue
        messages.push({ role: 'assistant', content: res.content })
        continue
      case 'refusal':
        return { text: input.texts.refused, status: 'refused', trace, actions, usage }
      case 'max_tokens':
      case 'model_context_window_exceeded': {
        const partial = sanitizeAnswer(textOf(res.content))
        return { text: partial ? `${partial}\n\n${input.texts.incomplete}` : input.texts.incomplete, status: 'incomplete', trace, actions, usage }
      }
      default: {   // end_turn, stop_sequence
        const text = sanitizeAnswer(textOf(res.content))
        return { text: text || input.texts.empty, status: text ? 'ok' : 'incomplete', trace, actions, usage }
      }
    }
  }
  return { text: input.texts.incomplete, status: 'incomplete', trace, actions, usage }
}

async function runTool(block: Anthropic.ToolUseBlock, input: Parameters<typeof runTurn>[0], trace: TraceEntry[], actions: string[], count: () => number): Promise<Anthropic.ToolResultBlockParam> {
  const done = async (e: TraceEntry, content: string, isError: boolean): Promise<Anthropic.ToolResultBlockParam> => {
    trace.push(e); await input.events?.onTool?.(e)
    return { type: 'tool_result', tool_use_id: block.id, content, is_error: isError || undefined }
  }
  const name = String(block.name).slice(0, 60)
  if (count() > MAX_TOOL_CALLS) return done({ name, ok: false, error: 'tool_call_limit' }, 'Error: tool call limit for this turn reached. Answer with the data you already have.', true)
  const tool = input.tools.find((t) => t.name === name)
  // offered tools only; a tool the user may not use is refused even if the model names it
  if (!tool || !tool.allowed(input.ctx.access) || !input.toolDefs.some((d) => d.name === name)) return done({ name, ok: false, error: 'not_allowed' }, 'Error: this tool is not available to this user.', true)
  const parsed = tool.schema.safeParse(block.input)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    return done({ name, ok: false, error: 'invalid_input' }, `Error: invalid input (${issues}). Fix the arguments and try again.`, true)
  }
  try {
    const data = await tool.run(input.ctx, parsed.data as never)
    const wrapped = wrapUntrusted(name, data)
    const id = (data as { action_id?: unknown } | null)?.action_id
    if (name === 'propose_studio_draft' && typeof id === 'string') actions.push(id)
    return done({ name, ok: true, ...(wrapped.flagged ? { flagged: true } : {}) }, wrapped.text, false)
  } catch (e) {
    const code = e instanceof ToolError ? e.code : 'internal_error'
    if (!(e instanceof ToolError)) console.error('ASSISTANT_TOOL_ERROR', { tool: name, kind: (e as Error)?.name })
    return done({ name, ok: false, error: code }, `Error: ${code}.`, true)
  }
}

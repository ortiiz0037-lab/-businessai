/**
 * Anthropic adapter (SERVER ONLY): IR ⇄ Messages API through the official
 * SDK, with streaming (text deltas forwarded as they arrive), cancellation
 * (AbortSignal) and a per-call timeout. Within a turn the assistant content
 * returned by the API is replayed EXACTLY (kept as an opaque part tied to
 * provider + model), as the API requires for reasoning blocks.
 */
import Anthropic from '@anthropic-ai/sdk'
import { ProviderError, type CallOptions, type LlmProvider, type Message, type ModelRequest, type ModelResponse, type Part, type StopReason } from '@/lib/intelligence/types'

export const ANTHROPIC = 'anthropic'

export function toAnthropicMessages(messages: Message[], model: string): Anthropic.MessageParam[] {
  return messages.map((m) => {
    const raw = m.parts.find((p): p is Extract<Part, { type: 'opaque' }> => p.type === 'opaque' && p.provider === ANTHROPIC && p.model === model)
    if (m.role === 'assistant' && raw && Array.isArray(raw.data)) return { role: 'assistant', content: raw.data as Anthropic.ContentBlockParam[] }
    const content: Anthropic.ContentBlockParam[] = []
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
      else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input as Record<string, unknown> })
      else if (p.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: p.callId, content: p.content, ...(p.isError ? { is_error: true } : {}) })
    }
    return { role: m.role, content: content.length === 1 && content[0].type === 'text' ? (content[0] as Anthropic.TextBlockParam).text : content }
  })
}

export function fromAnthropicContent(content: Anthropic.ContentBlock[], model: string): Part[] {
  const parts: Part[] = [{ type: 'opaque', provider: ANTHROPIC, model, data: content }]
  for (const b of content) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input })
  }
  return parts
}

export function stopFrom(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'end'
    case 'tool_use': return 'tool_use'
    case 'pause_turn': return 'pause'
    case 'max_tokens': return 'max_tokens'
    case 'refusal': return 'refusal'
    case 'model_context_window_exceeded': return 'context_exceeded'
    default: return 'other'
  }
}

export function anthropicError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof Anthropic.APIUserAbortError) return new ProviderError(signal?.reason === 'timeout' ? 'timeout' : 'cancelled', null)
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', null)
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', e.status ?? null)
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', 429)
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) return new ProviderError('bad_request', e.status ?? null)
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network', null)
  if (e instanceof Anthropic.APIError) return new ProviderError(e.status && e.status >= 500 ? 'overloaded' : 'unknown', e.status ?? null)
  if (signal?.aborted) return new ProviderError(signal.reason === 'timeout' ? 'timeout' : 'cancelled', null)
  return new ProviderError('unknown', null)
}

export function anthropicProvider(cfg: { apiKey: string; baseURL?: string; testDouble: boolean }): LlmProvider {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 1 })
  return {
    id: ANTHROPIC,
    testDouble: cfg.testDouble,
    async complete(req: ModelRequest, opts: CallOptions): Promise<ModelResponse> {
      try {
        const stream = client.messages.stream({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          // the system prompt and the tool definitions are the same on every call: cached
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: toAnthropicMessages(req.messages, req.model),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool['input_schema'], strict: true })),
          tool_choice: { type: 'auto' },
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        }, { signal: opts.signal, timeout: opts.timeoutMs, maxRetries: 1 })
        if (opts.onText) stream.on('text', (delta) => opts.onText!(delta))
        const res = await stream.finalMessage()
        return {
          parts: fromAnthropicContent(res.content, req.model),
          stop: stopFrom(res.stop_reason),
          model: res.model ?? req.model,
          usage: { input: res.usage.input_tokens ?? 0, output: res.usage.output_tokens ?? 0, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 },
        }
      } catch (e) {
        throw anthropicError(e, opts.signal)
      }
    },
  }
}

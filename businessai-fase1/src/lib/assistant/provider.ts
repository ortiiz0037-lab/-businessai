/**
 * LLM provider layer (SERVER ONLY). The engine talks to `LlmProvider`, never
 * to an SDK: the request / response shapes are those of the Messages API,
 * and a different provider can be added by implementing the same interface.
 * The implementation below uses the official Anthropic TypeScript SDK.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { AssistantConfig } from '@/lib/assistant/config'

export type LlmRequest = {
  system: string
  messages: Anthropic.MessageParam[]
  tools: Anthropic.Tool[]
  maxTokens?: number
}
export type LlmResponse = {
  content: Anthropic.ContentBlock[]
  stopReason: Anthropic.StopReason | null
  usage: { input: number; output: number }
}
export type ProviderErrorCode = 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' | 'unknown'
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly status: number | null) { super(`ASSISTANT_PROVIDER_${code.toUpperCase()}`) }
}
export interface LlmProvider { readonly name: string; complete(req: LlmRequest): Promise<LlmResponse> }

export function anthropicProvider(cfg: Extract<AssistantConfig, { configured: true }>): LlmProvider {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 2, timeout: 90_000 })
  return {
    name: 'anthropic',
    async complete(req) {
      try {
        const res = await client.messages.create({
          model: cfg.model,
          max_tokens: req.maxTokens ?? cfg.maxTokens,
          // the system prompt and the tool definitions are the same on every request: cached
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages,
          tools: req.tools,
          tool_choice: { type: 'auto' },
          output_config: { effort: cfg.effort },
        })
        return { content: res.content, stopReason: res.stop_reason, usage: { input: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), output: res.usage.output_tokens ?? 0 } }
      } catch (e) {
        throw toProviderError(e)
      }
    },
  }
}

/** Typed SDK errors → a small, loggable code (no message text, no key, no URL). */
export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', e.status)
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', 429)
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) return new ProviderError('bad_request', e.status)
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network', null)
  if (e instanceof Anthropic.APIError) return new ProviderError(e.status && e.status >= 500 ? 'overloaded' : 'unknown', e.status ?? null)
  return new ProviderError('unknown', null)
}

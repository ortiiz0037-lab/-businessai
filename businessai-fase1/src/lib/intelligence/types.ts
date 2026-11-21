/**
 * Provider-neutral contract of the Intelligence Engine (A9). The engine,
 * the tools and the interface only know these types; each provider adapter
 * translates them to and from its own API. Nothing here is specific to a
 * vendor: provider-only content (e.g. reasoning blocks that must be sent
 * back unchanged within a turn) travels as an opaque part tagged with the
 * provider and model that produced it, and is dropped for any other model.
 */
export type Tier = 'P0' | 'P1' | 'P2' | 'P3'
export const TIER_RANK: Record<Tier, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

export type TextPart = { type: 'text'; text: string }
export type ToolCallPart = { type: 'tool_call'; id: string; name: string; input: unknown }
export type ToolResultPart = { type: 'tool_result'; callId: string; content: string; isError: boolean }
export type OpaquePart = { type: 'opaque'; provider: string; model: string; data: unknown }
export type Part = TextPart | ToolCallPart | ToolResultPart | OpaquePart

export type Message = { role: 'user' | 'assistant'; parts: Part[] }
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }

export type StopReason = 'end' | 'tool_use' | 'pause' | 'max_tokens' | 'refusal' | 'context_exceeded' | 'other'
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

export type ModelRequest = {
  model: string
  system: string
  messages: Message[]
  tools: ToolSpec[]
  maxOutputTokens: number
  effort?: 'low' | 'medium' | 'high'
}
export type ModelResponse = { parts: Part[]; stop: StopReason; usage: Usage; model: string }
export type CallOptions = { signal: AbortSignal; timeoutMs: number; onText?: (delta: string) => void }

export type ProviderErrorCode = 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' | 'timeout' | 'cancelled' | 'unknown'
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly status: number | null) { super(`ASSISTANT_PROVIDER_${code.toUpperCase()}`) }
  /** Worth trying the next model of the chain (the request itself was valid). */
  get retriable() { return this.code === 'rate_limit' || this.code === 'overloaded' || this.code === 'network' || this.code === 'timeout' }
}

export interface LlmProvider {
  /** Registry provider id ('anthropic', …). */
  readonly id: string
  /** True when requests go to a local test double (costs are then marked 'test'). */
  readonly testDouble: boolean
  complete(req: ModelRequest, opts: CallOptions): Promise<ModelResponse>
}

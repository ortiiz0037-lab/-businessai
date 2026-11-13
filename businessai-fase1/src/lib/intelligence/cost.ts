/**
 * Cost of a model call in nano-dollars (1 USD = 1e9), exact integer
 * arithmetic with the registry prices. Each token category has its own
 * price (uncached input, output, cache write, cache read); a provider's
 * long-context price applies when the request's prompt exceeds its threshold.
 */
import type { Usage } from '@/lib/intelligence/types'
import type { ModelEntry } from '@/lib/intelligence/registry'

export type CostStatus = 'estimated' | 'unpriced' | 'test' | 'none'

export function callCostNanos(model: ModelEntry | undefined, u: Usage): bigint | null {
  if (!model) return null
  const prompt = u.input + u.cacheRead + u.cacheWrite
  const p = model.longContext && prompt > model.longContext.aboveTokens ? model.longContext.price : model.price
  return BigInt(u.input) * BigInt(p.input) + BigInt(u.output) * BigInt(p.output) + BigInt(u.cacheWrite) * BigInt(p.cacheWrite5m) + BigInt(u.cacheRead) * BigInt(p.cacheRead)
}

/** '0.012600 USD' (six decimals) from nano-dollars, without floating point. */
export function formatNanos(n: bigint): string {
  const micro = (n + 500n) / 1000n
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')} USD`
}

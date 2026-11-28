/**
 * Central model registry. ONLY models whose identifiers, limits and prices
 * were read on the provider's official pages are listed, with the date and
 * the pages. Nothing is inferred: a model that is not here cannot be routed
 * to. Prices are stored in nano-dollars per token (USD per million tokens ×
 * 1000), so costs are exact integers.
 *
 * Verified on 2026-11-13 (UTC) on:
 *   https://platform.claude.com/docs/en/models/overview
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * Other providers (OpenAI, Google) are NOT registered: their official pages
 * could not be read from the development environment (see docs/INTELLIGENCE.md).
 *
 * `tiers` are the precision levels a model is APPROVED for. They are a
 * provisional, conservative policy until the BusinessAI benchmark measures
 * the models (planned delivery); only the models the provider documents for
 * demanding work are approved for P2 / P3.
 */
import type { Tier } from '@/lib/intelligence/types'

export type Price = { input: number; output: number; cacheWrite5m: number; cacheRead: number }
export type ModelEntry = {
  id: string
  provider: 'anthropic'
  label: string
  status: 'active'
  contextTokens: number
  maxOutputTokens: number
  capabilities: { tools: boolean; imageInput: boolean; structuredOutputs: boolean; streaming: boolean; promptCaching: boolean; forcedToolChoice: 'unsupported' | 'unverified' }
  thinking: 'adaptive_always_on' | 'adaptive'
  defaultEffort: 'medium' | 'high'
  /** nano-dollars per token */
  price: Price
  /** a higher price above a prompt size (input + cache tokens of the request) */
  longContext?: { aboveTokens: number; price: Price }
  retirementNotBefore: string
  /** rank of capability inside the provider's lineup (fallbacks never go down) */
  rank: number
  tiers: Tier[]
  verifiedAt: string
  sources: string[]
}

const SOURCES = ['https://platform.claude.com/docs/en/models/overview', 'https://platform.claude.com/docs/en/about-claude/pricing']
const COMMON = { status: 'active' as const, provider: 'anthropic' as const, contextTokens: 1_000_000, maxOutputTokens: 128_000, verifiedAt: '2026-11-13', sources: SOURCES }
const CAPS = { tools: true, imageInput: true, structuredOutputs: true, streaming: true, promptCaching: true }

export const MODELS: ModelEntry[] = [
  { ...COMMON, id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', capabilities: { ...CAPS, forcedToolChoice: 'unverified' }, thinking: 'adaptive', defaultEffort: 'medium',
    price: { input: 100, output: 500, cacheWrite5m: 125, cacheRead: 10 },
    longContext: { aboveTokens: 100_000, price: { input: 500, output: 2500, cacheWrite5m: 625, cacheRead: 50 } },
    retirementNotBefore: '2027-10-07', rank: 1, tiers: ['P0'] },
  { ...COMMON, id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', capabilities: { ...CAPS, forcedToolChoice: 'unsupported' }, thinking: 'adaptive', defaultEffort: 'high',
    price: { input: 2000, output: 10000, cacheWrite5m: 2500, cacheRead: 100 }, retirementNotBefore: '2027-09-28', rank: 2, tiers: ['P0', 'P1'] },
  { ...COMMON, id: 'claude-opus-5-5', label: 'Claude Opus 5.5', capabilities: { ...CAPS, forcedToolChoice: 'unsupported' }, thinking: 'adaptive_always_on', defaultEffort: 'medium',
    price: { input: 4000, output: 20000, cacheWrite5m: 5000, cacheRead: 200 }, retirementNotBefore: '2027-09-22', rank: 3, tiers: ['P0', 'P1', 'P2', 'P3'] },
  { ...COMMON, id: 'claude-fable-5-2', label: 'Claude Fable 5.2', capabilities: { ...CAPS, forcedToolChoice: 'unverified' }, thinking: 'adaptive_always_on', defaultEffort: 'high',
    price: { input: 8000, output: 40000, cacheWrite5m: 10000, cacheRead: 200 }, retirementNotBefore: '2027-11-09', rank: 4, tiers: ['P0', 'P1', 'P2', 'P3'] },
]

export const findModel = (id: string): ModelEntry | undefined => MODELS.find((m) => m.id === id)

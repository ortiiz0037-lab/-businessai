/**
 * Compatibility module. Since Delivery 10 the provider contract is
 * provider-neutral and lives in src/lib/intelligence (types.ts, adapters/);
 * the Anthropic adapter is src/lib/intelligence/adapters/anthropic.ts.
 */
export { ProviderError, type LlmProvider, type ProviderErrorCode } from '@/lib/intelligence/types'
export { anthropicProvider, anthropicError as toProviderError } from '@/lib/intelligence/adapters/anthropic'

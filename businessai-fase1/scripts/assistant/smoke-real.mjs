#!/usr/bin/env node
/**
 * Smoke test of the REAL AI provider (Anthropic Messages API) used by the
 * BusinessAI Assistant. ONE tiny request (max_tokens 32) to confirm that the
 * key, the network path and the model work. Procedure: docs/AI_PROVIDER_SETUP.md.
 *
 * Safety:
 *   - refuses unless ASSISTANT_SMOKE_ALLOW_PAID=1 is set (it costs money, a fraction of a cent);
 *   - reads ANTHROPIC_API_KEY from the environment only and NEVER prints it (nor any part of it);
 *   - prints only: host, model requested / served, stop reason, token usage, latency, request id;
 *   - --double URL runs the same code against the local test double (no network, no cost) to
 *     check the script itself.
 *
 *   ASSISTANT_SMOKE_ALLOW_PAID=1 node scripts/assistant/smoke-real.mjs            (key from the environment)
 *   node scripts/assistant/smoke-real.mjs --double http://127.0.0.1:3523 --key <test key of the double>
 * Exit: 0 ok · 1 provider error · 2 refused (missing authorization / key / bad arguments).
 */
import Anthropic from '@anthropic-ai/sdk'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const doubleUrl = flag('--double')
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']   // the registry (src/lib/intelligence/registry.ts)
const model = flag('--model') ?? process.env.ASSISTANT_MODEL ?? 'claude-haiku-5-5'
const out = (o) => console.log(JSON.stringify(o, null, 2))

if (!MODELS.includes(model)) { out({ ok: false, refused: 'model_not_registered', model, registered: MODELS }); process.exit(2) }
let apiKey, baseURL
if (doubleUrl) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(doubleUrl)) { out({ ok: false, refused: 'double_must_be_loopback' }); process.exit(2) }
  apiKey = flag('--key'); baseURL = doubleUrl
  if (!apiKey) { out({ ok: false, refused: 'double_needs_its_test_key' }); process.exit(2) }
} else {
  if (process.env.ASSISTANT_SMOKE_ALLOW_PAID !== '1') { out({ ok: false, refused: 'set ASSISTANT_SMOKE_ALLOW_PAID=1 to make one paid request (owner authorization required)' }); process.exit(2) }
  apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim()
  if (!apiKey) { out({ ok: false, refused: 'ANTHROPIC_API_KEY is not set in this environment' }); process.exit(2) }
  if (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.startsWith('https://')) { out({ ok: false, refused: 'ANTHROPIC_BASE_URL must be https for a real test' }); process.exit(2) }
  baseURL = process.env.ANTHROPIC_BASE_URL || undefined
}

const client = new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: 30_000 })
const host = new URL(baseURL ?? 'https://api.anthropic.com').host
const t0 = Date.now()
try {
  const stream = client.messages.stream({
    model, max_tokens: 32,
    system: 'You are a connectivity check. Reply with exactly: OK',
    messages: [{ role: 'user', content: 'Connectivity check from BusinessAI. Reply with exactly: OK' }],
  })
  const res = await stream.finalMessage()
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  out({ ok: true, real_provider: !doubleUrl, host, model_requested: model, model_served: res.model, stop_reason: res.stop_reason, reply: text.slice(0, 40),
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, latency_ms: Date.now() - t0, request_id: res._request_id ?? null })
  process.exit(0)
} catch (e) {
  // typed SDK errors → short codes; the key never appears (the SDK does not echo it and nothing else is printed)
  const code = e instanceof Anthropic.AuthenticationError ? 'auth' : e instanceof Anthropic.PermissionDeniedError ? 'permission' : e instanceof Anthropic.RateLimitError ? 'rate_limit'
    : e instanceof Anthropic.NotFoundError ? 'model_not_found' : e instanceof Anthropic.BadRequestError ? 'bad_request' : e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
    : e instanceof Anthropic.APIConnectionError ? 'network' : e instanceof Anthropic.APIError ? (e.status >= 500 ? 'overloaded_or_server' : 'api_error') : 'unknown'
  out({ ok: false, real_provider: !doubleUrl, host, model_requested: model, error: code, status: e?.status ?? null, request_id: e?.requestID ?? null, latency_ms: Date.now() - t0 })
  process.exit(1)
}

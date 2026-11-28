/**
 * Scripted TEST DOUBLE of the Anthropic Messages API for the benchmark —
 * LOCAL ONLY, never a language model. The application reaches it through
 * its real adapter (official SDK, streaming) because the benchmark sets
 * ANTHROPIC_BASE_URL to this loopback server. Each request is answered with
 * the next step of the SCRIPT registered for the user's question
 * (bench/cases.mjs). Token counts are synthetic (≈ characters / 4) and only
 * exercise the metering code. Every request is logged for the evaluator.
 */
import { createServer } from 'node:http'

const words = (t) => t.match(/\S+\s*/g) ?? ['']
const approxTokens = (s) => Math.max(1, Math.ceil(String(s).length / 4))

export function startScriptedDouble({ port, apiKey }) {
  const scripts = new Map()   // question → steps
  const cursors = new Map()   // question + per-turn canary → position (concurrent turns of one question follow the script separately)
  const log = []

  function nextStep(question, canary, model, messageCount) {
    const steps = scripts.get(question)
    if (!steps) return null
    const key = `${question}\u0000${canary}`
    const s = cursors.get(key) ?? { steps, i: 0, last: null }
    cursors.set(key, s)
    // the engine ESCALATED (same conversation re-sent to a higher model after a tool beyond the first model's tier):
    // a faithful model makes the same decision again, so the tool step is replayed
    if (s.last && s.last.step.tool && s.last.model !== model && s.last.messageCount === messageCount) { s.last = { ...s.last, model }; return s.last.step }
    while (s.i < s.steps.length) {
      const step = s.steps[s.i++]
      if (step.onlyModel && step.onlyModel !== model) continue
      s.last = { step, model, messageCount }
      return step
    }
    return null
  }

  function stream(res, body, content, stopReason, slow, usage) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = [['message_start', { type: 'message_start', message: { id: `msg_bench_${log.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]]
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } }])
        for (const w of words(b.text)) ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: w } }])
      } else {
        ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
        ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }])
      }
      ev.push(['content_block_stop', { type: 'content_block_stop', index }])
    })
    ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }])
    ev.push(['message_stop', { type: 'message_stop' }])
    let i = 0, closed = false
    res.on('close', () => { closed = true })
    const next = () => {
      if (closed) return
      if (i >= ev.length) return res.end()
      const [name, data] = ev[i++]
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      setTimeout(next, slow && name === 'content_block_delta' ? slow : 1)
    }
    next()
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      const error = (status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })) }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return error(404, 'not_found_error', 'not found')
      if (req.headers.authorization !== `Bearer ${apiKey}` && req.headers['x-api-key'] !== apiKey) return error(401, 'authentication_error', 'invalid key')
      let body
      try { body = JSON.parse(raw) } catch { return error(400, 'invalid_request_error', 'bad json') }
      const msgs = body.messages
      const question = String(msgs.find((m) => m.role === 'user' && typeof m.content === 'string' && !/^VERIFICATION FAILED/.test(m.content))
        ? [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && !/^VERIFICATION FAILED/.test(m.content)).content : '')
      const system = JSON.stringify(body.system)
      const toolResults = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result').map((b) => String(b.content)) : []))
      const entry = { question, model: body.model, stream: body.stream === true, tools: (body.tools ?? []).map((t) => t.name), toolResults, system: system.slice(0, 200000) }
      log.push(entry)
      const canary = /BA-CANARY-[0-9a-f]{8}/.exec(system)?.[0] ?? 'BA-CANARY-none'
      const step = nextStep(question, canary, body.model, msgs.length)
      if (!step) return error(400, 'invalid_request_error', `no scripted step for: ${question.slice(0, 80)}`)
      entry.step = step
      if (step.error === 529) return error(529, 'overloaded_error', 'Overloaded')
      if (step.error === 401) return error(401, 'authentication_error', 'invalid x-api-key')
      if (step.error) return error(step.error, 'api_error', 'scripted error')
      const lastRef = (() => { for (const c of [...toolResults].reverse()) { const r = /ref="(T\d+)"/.exec(c); if (r) return r[1] } return 'T1' })()
      const fill = (t) => t.replace(/\{T\}/g, lastRef).replace(/\{CANARY\}/g, canary)
      const content = []
      if (step.text !== undefined) content.push({ type: 'text', text: fill(step.text), citations: null })
      if (step.tool) content.push({ type: 'tool_use', id: `toolu_bench_${log.length}`, name: step.tool, input: step.input ?? {} })
      const stop = step.stop ?? (step.tool ? 'tool_use' : 'end_turn')
      const usage = { input_tokens: approxTokens(system + JSON.stringify(msgs) + JSON.stringify(body.tools ?? [])), output_tokens: approxTokens(JSON.stringify(content)), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: `msg_bench_${log.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage }))
      }
      stream(res, body, content, stop, step.slow, usage)
    })
  })

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}`, log,
    script(question, steps) { scripts.set(question, steps.map((s) => ({ ...s }))); for (const k of cursors.keys()) if (k.startsWith(`${question}\u0000`)) cursors.delete(k) },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
  })))
}

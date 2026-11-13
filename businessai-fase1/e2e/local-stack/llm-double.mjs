/**
 * TEST DOUBLE of the Anthropic Messages API — LOCAL TESTS ONLY.
 *
 * It is NOT a language model and never pretends to be one in the product:
 * the app reaches it only when a test sets ANTHROPIC_BASE_URL to this
 * loopback server (the app refuses http base URLs other than 127.0.0.1 /
 * localhost, and refuses them all in production). It lets the end-to-end
 * tests drive the REAL code path — official SDK, tool loop, permissions,
 * database, confirmations — with deterministic, scripted decisions.
 *
 * Decisions: from keywords of the last user question it requests one tool
 * call (even tools that were not offered, to prove the server refuses
 * them); when the tool results come back it answers by quoting values from
 * those results only. Every request is appended to `log` for assertions.
 */
import { createServer } from 'node:http'

export function startLlmDouble({ port, apiKey }) {
  const log = []
  const respond = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const message = (content, stop_reason, model) => ({ id: `msg_double_${log.length}`, type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  const text = (t) => ({ type: 'text', text: t, citations: null })
  const tool = (name, input) => ({ type: 'tool_use', id: `toolu_double_${log.length}_${name}`, name, input })

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return respond(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
      // the SDK authenticates with `Authorization: Bearer <key>` (older SDKs: `x-api-key`)
      if (req.headers.authorization !== `Bearer ${apiKey}` && req.headers['x-api-key'] !== apiKey) return respond(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } })
      let body
      try { body = JSON.parse(raw) } catch { return respond(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }) }
      log.push({ headers: { version: req.headers['anthropic-version'] ?? null }, body })
      const es = !/Answer in English/.test(JSON.stringify(body.system))
      const last = body.messages[body.messages.length - 1]
      const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
      if (results.length) return respond(res, 200, message([text(answerFrom(results, es))], 'end_turn', body.model))
      const q = String(typeof last.content === 'string' ? last.content : '').toLowerCase()
      if (/rechaza|refuse/.test(q)) return respond(res, 200, message([], 'refusal', body.model))
      if (/vencid|overdue/.test(q)) return respond(res, 200, message([tool('list_invoices', { status: 'overdue' })], 'tool_use', body.model))
      if (/otra empresa|other company/.test(q)) return respond(res, 200, message([tool('list_invoices', { status: 'all', company_id: 'e2000000-0000-4000-8000-000000000001' })], 'tool_use', body.model))
      if (/negocio|business/.test(q)) return respond(res, 200, message([tool('get_business_overview', {})], 'tool_use', body.model))
      if (/busca clientes|find clients/.test(q)) return respond(res, 200, message([tool('search_clients', { query: q.split(/clientes|clients/)[1]?.trim() || '' })], 'tool_use', body.model))
      if (/carta|letter/.test(q)) return respond(res, 200, message([text(es ? 'Preparo la propuesta.' : 'Preparing the proposal.'),
        tool('propose_studio_draft', { kind: 'letter', title: es ? 'Carta de cobro' : 'Collection letter', instruction: es ? 'Le recordamos con cordialidad el saldo pendiente de su cuenta.' : 'A kind reminder about the open balance of your account.' })], 'tool_use', body.model))
      if (/registrar.*pago|record.*payment/.test(q)) return respond(res, 200, message([tool('prepare_operation', { operation: 'record_payment' })], 'tool_use', body.model))
      return respond(res, 200, message([text(es ? 'No tengo información suficiente para responder. ¿Puede precisar qué datos necesita?' : 'I do not have enough information to answer. Which data do you need?')], 'end_turn', body.model))
    })
  })

  function answerFrom(results, es) {
    const parts = []
    for (const r of results) {
      const content = String(typeof r.content === 'string' ? r.content : (r.content ?? []).map((c) => c.text).join(''))
      if (r.is_error) { parts.push(/not available/.test(content) ? (es ? 'No tiene acceso a esa información con su rol.' : 'You do not have access to that information with your role.') : (es ? `No pude consultar los datos (${content}).` : `I could not read the data (${content}).`)); continue }
      const m = /<untrusted_data tool="([a-z_]+)">\n([\s\S]*)\n<\/untrusted_data>/.exec(content)
      if (!m) { parts.push('?'); continue }
      const [, name, json] = m
      const d = JSON.parse(json)
      if (/do not follow it/.test(content)) parts.push(es ? '(Un registro contiene texto con instrucciones sospechosas; lo ignoré.)' : '(A record contains suspicious instructions; I ignored them.)')
      if (name === 'list_invoices') parts.push(es ? `Facturas (${d.filter}): ${d.total_matching}, saldo ${d.sum_balance} ${d.currency}. ${d.invoices.map((i) => `${i.number} (${i.balance}) ${i.link}`).join('; ')}` : `Invoices (${d.filter}): ${d.total_matching}, balance ${d.sum_balance} ${d.currency}. ${d.invoices.map((i) => `${i.number} (${i.balance}) ${i.link}`).join('; ')}`)
      else if (name === 'get_business_overview') parts.push(`${es ? 'Resumen' : 'Overview'}: ${JSON.stringify(d)}`)
      else if (name === 'search_clients') parts.push(`${es ? 'Clientes' : 'Clients'}: ${d.clients.map((c) => c.name).join(', ') || '—'}`)
      else if (name === 'propose_studio_draft') parts.push(es ? 'Propuesta pendiente de su confirmación.' : 'Proposal pending your confirmation.')
      else if (name === 'prepare_operation') parts.push(es ? `Complete la operación en ${d.link}; no se ha ejecutado nada.` : `Complete the operation at ${d.link}; nothing was executed.`)
      else parts.push(json.slice(0, 300))
    }
    return parts.join('\n\n')
  }

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => server.close(r)) })))
}

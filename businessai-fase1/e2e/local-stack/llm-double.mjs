/**
 * TEST DOUBLE of the Anthropic Messages API — LOCAL TESTS ONLY.
 *
 * It is NOT a language model and never pretends to be one in the product:
 * the app reaches it only when a test sets ANTHROPIC_BASE_URL to this
 * loopback server (the app refuses http base URLs other than 127.0.0.1 /
 * localhost, and refuses them all in production; costs are then marked
 * 'test'). It lets the end-to-end tests drive the REAL code path — official
 * SDK with streaming, router, tool loop, permissions, database, server
 * signatures, verification of figures, confirmations — with deterministic,
 * scripted decisions.
 *
 * Decisions come from keywords of the user's question. Answers cite every
 * figure with [[Tn.path]] placeholders, except in the scenarios that test
 * the verifier ("inventa": typed figures twice; "corrige": typed once, then
 * corrected). "sobrecarga" makes the first model answer 529 (fallback test);
 * "lento" streams slowly (cancellation test). Every request is logged.
 */
import { createServer } from 'node:http'

export function startLlmDouble({ port, apiKey }) {
  const log = []
  const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const text = (t) => ({ type: 'text', text: t, citations: null })
  const tool = (name, input) => ({ type: 'tool_use', id: `toolu_double_${log.length}_${name}`, name, input })

  function respond(res, body, content, stopReason, slow) {
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: `msg_double_${log.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const events = [['message_start', { type: 'message_start', message: { id: `msg_double_${log.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]]
    content.forEach((b, index) => {
      if (b.type === 'text') {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } }])
        const words = b.text.match(/\S+\s*/g) ?? ['']
        for (const w of words) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: w } }])
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }])
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index }])
    })
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }])
    events.push(['message_stop', { type: 'message_stop' }])
    let i = 0
    let closed = false
    res.on('close', () => { closed = true })
    const next = () => {
      if (closed) return
      if (i >= events.length) return res.end()
      const [name, data] = events[i++]
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      setTimeout(next, slow ? 400 : 2)
    }
    next()
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      const error = (status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })) }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return error(404, 'not_found_error', 'not found')
      // the SDK authenticates with `Authorization: Bearer <key>` (older SDKs: `x-api-key`)
      if (req.headers.authorization !== `Bearer ${apiKey}` && req.headers['x-api-key'] !== apiKey) return error(401, 'authentication_error', 'invalid key')
      let body
      try { body = JSON.parse(raw) } catch { return error(400, 'invalid_request_error', 'bad json') }
      log.push({ headers: { version: req.headers['anthropic-version'] ?? null }, body })
      const es = !/Answer in English/.test(JSON.stringify(body.system))
      const msgs = body.messages
      const last = msgs[msgs.length - 1]
      const question = String([...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && !/^VERIFICATION FAILED/.test(m.content))?.content ?? '').toLowerCase()
      const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
      const rewrite = typeof last.content === 'string' && /^VERIFICATION FAILED/.test(last.content)
      if (/sobrecarga/.test(question) && body.model === 'claude-opus-5-5') return error(529, 'overloaded_error', 'Overloaded')
      const slow = /lento/.test(question)
      if (rewrite) {
        if (/inventa/.test(question)) return respond(res, body, [text(es ? 'Insisto: el saldo es 999999.99.' : 'I insist: the balance is 999999.99.')], 'end_turn')
        const ref = lastRef(msgs)
        return respond(res, body, [text(es ? `Corregido: saldo [[${ref}.sum_balance]].` : `Corrected: balance [[${ref}.sum_balance]].`)], 'end_turn')
      }
      if (results.length) {
        if (/inventa|corrige/.test(question)) return respond(res, body, [text(es ? 'El saldo pendiente es 999999.99 dólares.' : 'The open balance is 999999.99 dollars.')], 'end_turn')
        return respond(res, body, [text(answerFrom(results, es))], 'end_turn', slow)
      }
      const q = question
      if (/rechaza|refuse/.test(q)) return respond(res, body, [], 'refusal')
      if (/otra empresa|other company/.test(q)) return respond(res, body, [tool('list_invoices', { status: 'all', company_id: 'e2000000-0000-4000-8000-000000000001' })], 'tool_use')
      if (/vencid|overdue|inventa|corrige|sobrecarga|lento/.test(q)) return respond(res, body, [tool('list_invoices', { status: 'overdue' })], 'tool_use')
      if (/negocio|business/.test(q)) return respond(res, body, [tool('get_business_overview', {})], 'tool_use')
      if (/busca clientes|find clients/.test(q)) return respond(res, body, [tool('search_clients', { query: q.split(/clientes|clients/)[1]?.trim() || '' })], 'tool_use')
      if (/carta|letter/.test(q)) return respond(res, body, [text(es ? 'Preparo la propuesta.' : 'Preparing the proposal.'),
        tool('propose_studio_draft', { kind: 'letter', title: es ? 'Carta de cobro' : 'Collection letter', instruction: es ? 'Le recordamos con cordialidad el saldo pendiente de su cuenta.' : 'A kind reminder about the open balance of your account.' })], 'tool_use')
      if (/registrar.*pago|record.*payment/.test(q)) return respond(res, body, [tool('prepare_operation', { operation: 'record_payment' })], 'tool_use')
      return respond(res, body, [text(es ? 'No tengo información suficiente para responder. ¿Puede precisar qué datos necesita?' : 'I do not have enough information to answer. Which data do you need?')], 'end_turn')
    })
  })

  function lastRef(msgs) {
    for (const m of [...msgs].reverse()) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        const c = typeof b.content === 'string' ? b.content : ''
        const r = /ref="(T\d+)"/.exec(c)
        if (b.type === 'tool_result' && r) return r[1]
      }
    }
    return 'T1'
  }

  function answerFrom(results, es) {
    const parts = []
    for (const r of results) {
      const content = String(typeof r.content === 'string' ? r.content : (r.content ?? []).map((c) => c.text).join(''))
      if (r.is_error) { parts.push(/not available/.test(content) ? (es ? 'No tiene acceso a esa información con su rol.' : 'You do not have access to that information with your role.') : (es ? 'No pude consultar los datos.' : 'I could not read the data.')); continue }
      const m = /<untrusted_data tool="([a-z_]+)" ref="(T\d+)">\n([\s\S]*)\n<\/untrusted_data>/.exec(content)
      if (!m) { parts.push('?'); continue }
      const [, name, ref, json] = m
      const d = JSON.parse(json).data
      if (/do not follow it/.test(content)) parts.push(es ? '(Un registro contiene texto con instrucciones sospechosas; lo ignoré.)' : '(A record contains suspicious instructions; I ignored them.)')
      if (name === 'list_invoices') {
        const rows = d.invoices.map((_x, i) => `[[${ref}.invoices.${i}.number]] ([[${ref}.invoices.${i}.balance]]) ${d.invoices[i].link}`).join('; ')
        parts.push(es ? `Facturas vencidas: [[${ref}.total_matching]], saldo [[${ref}.sum_balance]] al [[${ref}.as_of]]. ${rows}` : `Overdue invoices: [[${ref}.total_matching]], balance [[${ref}.sum_balance]] as of [[${ref}.as_of]]. ${rows}`)
      } else if (name === 'get_business_overview') {
        const bits = []
        if (d.invoiced_this_month) bits.push(`${es ? 'Facturado este mes' : 'Invoiced this month'}: [[${ref}.invoiced_this_month.total]]`)
        if (d.collected_this_month) bits.push(`${es ? 'Cobrado' : 'Collected'}: [[${ref}.collected_this_month.total]]`)
        if (d.receivables) bits.push(`${es ? 'Por cobrar' : 'Receivables'}: [[${ref}.receivables.open_balance]]`)
        parts.push(`${es ? 'Resumen' : 'Overview'}: ${bits.join(' · ')}${d.not_authorized?.length ? ` (${es ? 'sin acceso' : 'no access'}: ${d.not_authorized.join(', ')})` : ''}`)
      } else if (name === 'search_clients') parts.push(`${es ? 'Clientes' : 'Clients'}: ${d.clients.map((_c, i) => `[[${ref}.clients.${i}.name]]`).join(', ') || '—'}`)
      else if (name === 'propose_studio_draft') parts.push(es ? 'Propuesta pendiente de su confirmación.' : 'Proposal pending your confirmation.')
      else if (name === 'prepare_operation') parts.push(es ? `Complete la operación en ${d.link}; no se ha ejecutado nada.` : `Complete the operation at ${d.link}; nothing was executed.`)
      else parts.push(es ? 'Datos consultados.' : 'Data consulted.')
    }
    return parts.join('\n\n')
  }

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) })))
}

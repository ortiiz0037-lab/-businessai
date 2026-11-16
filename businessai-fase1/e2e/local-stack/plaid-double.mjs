/**
 * TEST DOUBLE of the Plaid API — LOCAL TESTS ONLY.
 *
 * It is NOT a bank and never pretends to be one in the product: the app
 * reaches it only when a test sets PLAID_BASE_URL to this loopback server (the
 * app refuses http base URLs other than 127.0.0.1 / localhost, and refuses them
 * all in production); connections made through it are stored with
 * environment 'test_double' and labelled as test connections on every screen.
 * No real institution, account or transaction is involved: the accounts and
 * transactions below are fixtures.
 *
 * It implements the endpoints the adapter uses (same request / response
 * shapes as Plaid's REST API), signs webhooks with its own ES256 key (served by
 * /webhook_verification_key/get, exactly like Plaid) and offers control
 * endpoints under /_double/ for the tests: add or remove transactions, make the
 * next call fail with a Plaid error code, deliver a signed webhook.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer } from 'node:http'

export function startPlaidDouble({ port, clientId, secret }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'double-key-1', alg: 'ES256', use: 'sig', created_at: Math.floor(Date.now() / 1000), expired_at: null }
  const log = []
  const publicTokens = new Map()            // public_token → item_id
  const items = new Map()                   // item_id → { access_token, events: [{type:'add'|'remove', txn|id}], removed: false }
  const byToken = (t) => [...items.values()].find((i) => i.access_token === t && !i.removed)
  let failNext = null
  const accounts = [
    { account_id: 'dbl-acc-checking', name: 'Cuenta de cheques (DOBLE DE PRUEBA)', official_name: null, mask: '4821', type: 'depository', subtype: 'checking', balances: { iso_currency_code: 'USD' } },
    { account_id: 'dbl-acc-savings', name: 'Ahorros (DOBLE DE PRUEBA)', official_name: null, mask: '9999', type: 'depository', subtype: 'savings', balances: { iso_currency_code: 'USD' } },
  ]
  const plaidError = (res, status, code, type = 'INVALID_REQUEST') => send(res, status, { error_type: type, error_code: code, error_message: 'test double error', display_message: null, request_id: `dbl-${log.length}` })
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const read = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))) })

  function signedHeaders(body) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: createHash('sha256').update(body, 'utf8').digest('hex') })).toString('base64url')
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    return { 'content-type': 'application/json', 'plaid-verification': `${header}.${payload}.${sig}` }
  }

  const server = createServer(async (req, res) => {
    const raw = await read(req)
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { return plaidError(res, 400, 'INVALID_BODY') }
    const path = new URL(req.url, 'http://x').pathname
    log.push({ path, at: Date.now(), access_token: body.access_token ? 'present' : undefined })
    // ---- control endpoints (tests only)
    if (path === '/_double/add') {
      const it = body.item_id ? items.get(body.item_id) : [...items.values()].at(-1)
      if (!it) return send(res, 404, { error: 'no item' })
      for (const t of body.transactions ?? []) it.events.push({ type: 'add', txn: { iso_currency_code: 'USD', pending: false, merchant_name: null, payment_meta: null, ...t } })
      return send(res, 200, { ok: true, events: it.events.length })
    }
    if (path === '/_double/remove') {
      const it = [...items.values()].at(-1)
      for (const id of body.ids ?? []) it.events.push({ type: 'remove', id })
      return send(res, 200, { ok: true })
    }
    if (path === '/_double/fail') { failNext = body.code ?? null; return send(res, 200, { ok: true }) }
    if (path === '/_double/items') return send(res, 200, [...items.entries()].map(([id, i]) => ({ item_id: id, removed: i.removed, events: i.events.length })))
    if (path === '/_double/log') return send(res, 200, log)
    if (path === '/_double/webhook') {
      const payload = JSON.stringify(body.payload)
      const headers = signedHeaders(payload)
      if (body.tamper) headers['plaid-verification'] = headers['plaid-verification'].slice(0, -4) + 'AAAA'
      const r = await fetch(body.url, { method: 'POST', headers, body: payload }).catch(() => null)
      const echo = body.repeat ? await fetch(body.url, { method: 'POST', headers, body: payload }).catch(() => null) : null
      return send(res, 200, { status: r?.status ?? 0, repeat: echo?.status ?? null })
    }
    // ---- Plaid API
    if (body.client_id !== clientId || body.secret !== secret) return plaidError(res, 400, 'INVALID_API_KEYS', 'INVALID_INPUT')
    if (failNext && path !== '/webhook_verification_key/get') { const code = failNext; failNext = null; return plaidError(res, 400, code, 'ITEM_ERROR') }
    switch (path) {
      case '/link/token/create': return send(res, 200, { link_token: `link-sandbox-double-${randomBytes(6).toString('hex')}`, expiration: new Date(Date.now() + 4 * 3600e3).toISOString(), request_id: 'dbl' })
      case '/sandbox/public_token/create': {
        const pt = `public-sandbox-double-${randomBytes(8).toString('hex')}`
        publicTokens.set(pt, null)
        return send(res, 200, { public_token: pt, request_id: 'dbl' })
      }
      case '/item/public_token/exchange': {
        if (!publicTokens.has(body.public_token)) return plaidError(res, 400, 'INVALID_PUBLIC_TOKEN')
        publicTokens.delete(body.public_token)
        const item_id = `dbl-item-${randomBytes(6).toString('hex')}`, access_token = `access-sandbox-double-${randomBytes(12).toString('hex')}`
        items.set(item_id, { access_token, events: [], removed: false })
        return send(res, 200, { access_token, item_id, request_id: 'dbl' })
      }
      case '/accounts/get': {
        const entry = [...items.entries()].find(([, i]) => i.access_token === body.access_token && !i.removed)
        if (!entry) return plaidError(res, 400, 'INVALID_ACCESS_TOKEN')
        return send(res, 200, { accounts, item: { item_id: entry[0], institution_id: 'ins_double_1' }, request_id: 'dbl' })
      }
      case '/institutions/get_by_id': return send(res, 200, { institution: { institution_id: body.institution_id, name: 'Banco de prueba (doble local)' }, request_id: 'dbl' })
      case '/transactions/sync': {
        const it = byToken(body.access_token)
        if (!it) return plaidError(res, 400, 'INVALID_ACCESS_TOKEN')
        const from = body.cursor ? Number(String(body.cursor).replace('dbl-cursor-', '')) : 0
        const count = Math.min(Number(body.count) || 100, 500)
        const slice = it.events.slice(from, from + count)
        const next = from + slice.length
        return send(res, 200, {
          added: slice.filter((e) => e.type === 'add').map((e) => e.txn), modified: [],
          removed: slice.filter((e) => e.type === 'remove').map((e) => ({ transaction_id: e.id })),
          next_cursor: `dbl-cursor-${next}`, has_more: next < it.events.length, request_id: 'dbl',
        })
      }
      case '/item/remove': {
        const it = byToken(body.access_token)
        if (!it) return plaidError(res, 400, 'INVALID_ACCESS_TOKEN')
        it.removed = true
        return send(res, 200, { request_id: 'dbl' })
      }
      case '/webhook_verification_key/get': return body.key_id === jwk.kid ? send(res, 200, { key: jwk, request_id: 'dbl' }) : plaidError(res, 400, 'INVALID_KEY_ID')
      default: return plaidError(res, 404, 'UNKNOWN_ENDPOINT')
    }
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${port}`, log, items,
    close: () => new Promise((done) => server.close(() => done())),
  })))
}

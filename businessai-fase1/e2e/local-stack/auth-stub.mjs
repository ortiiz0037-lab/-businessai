#!/usr/bin/env node
/**
 * LOCAL-ONLY stand-in for Supabase Auth (GoTrue), for the authenticated
 * browser test. It listens on 127.0.0.1, knows only the seeded test users,
 * signs HS256 JWTs with a secret generated for the run (shared with the
 * local PostgREST) and forwards /rest/v1/* to that local PostgREST.
 * It is not a real auth server and must never be exposed or deployed.
 *
 * env: STUB_PORT, PGRST_URL (http://127.0.0.1:…), JWT_SECRET, TEST_PASSWORD, USERS (JSON {email: uuid})
 */
import http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.STUB_PORT)
const PGRST = process.env.PGRST_URL ?? ''
const SECRET = process.env.JWT_SECRET ?? ''
const PASSWORD = process.env.TEST_PASSWORD ?? ''
const USERS = JSON.parse(process.env.USERS ?? '{}')
if (!PORT || !/^http:\/\/127\.0\.0\.1:\d+$/.test(PGRST) || SECRET.length < 32 || PASSWORD.length < 12) {
  console.error('auth-stub: refusing to start (needs a local PostgREST, a 32+ char secret and a test password)'); process.exit(2)
}

const b64 = (b) => Buffer.from(b).toString('base64url')
export function sign(payload, secret = SECRET) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify(payload))
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`
}
function verify(token) {
  const [h, p, s] = String(token ?? '').split('.')
  if (!h || !p || !s) return null
  const good = createHmac('sha256', SECRET).update(`${h}.${p}`).digest()
  const got = Buffer.from(s, 'base64url')
  if (got.length !== good.length || !timingSafeEqual(got, good)) return null
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  return claims.exp && claims.exp * 1000 > Date.now() ? claims : null
}
const userOf = (id, email) => ({ id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
function session(email, id) {
  const now = Math.floor(Date.now() / 1000), exp = now + 3600
  const access = sign({ sub: id, email, role: 'authenticated', aud: 'authenticated', iat: now, exp, session_id: randomUUID(), aal: 'aal1', amr: [{ method: 'password', timestamp: now }] })
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: sign({ sub: id, email, typ: 'refresh', exp: now + 86400 }), user: userOf(id, email) }
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)) }
const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))) })
const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      if (url.searchParams.get('grant_type') === 'password') {
        const id = USERS[String(body.email ?? '').toLowerCase()]
        if (!id || body.password !== PASSWORD) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' })
        return send(res, 200, session(body.email.toLowerCase(), id))
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const c = verify(body.refresh_token)
        if (!c || c.typ !== 'refresh') return send(res, 400, { error: 'invalid_grant', code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' })
        return send(res, 200, session(c.email, c.sub))
      }
      return send(res, 400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const c = verify(bearer(req))
      if (!c || c.role !== 'authenticated') return send(res, 401, { code: 'bad_jwt', msg: 'invalid JWT' })
      return send(res, 200, userOf(c.sub, c.email))
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204)
    if (url.pathname.startsWith('/rest/v1/')) {
      const target = PGRST + url.pathname.slice('/rest/v1'.length) + url.search
      const headers = {}
      for (const k of ['authorization', 'accept', 'content-type', 'prefer', 'range', 'range-unit', 'accept-profile', 'content-profile']) if (req.headers[k]) headers[k] = req.headers[k]
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
      const r = await fetch(target, { method: req.method, headers, body })
      const out = {}
      for (const k of ['content-type', 'content-range', 'preference-applied', 'location']) { const v = r.headers.get(k); if (v) out[k] = v }
      res.writeHead(r.status, out)
      return res.end(Buffer.from(await r.arrayBuffer()))
    }
    console.error(`auth-stub: unhandled ${req.method} ${url.pathname}`)
    return send(res, 404, { msg: 'not found (local auth stub)' })
  } catch (e) {
    console.error('auth-stub error', e)
    return send(res, 500, { msg: 'stub error' })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`auth-stub ready on 127.0.0.1:${PORT}`))

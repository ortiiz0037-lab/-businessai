#!/usr/bin/env node
/**
 * LOCAL-ONLY stand-in for Supabase Auth (GoTrue), for the authenticated
 * browser test. It listens on 127.0.0.1, knows only the seeded test users,
 * signs HS256 JWTs with a secret generated for the run (shared with the
 * local PostgREST) and forwards /rest/v1/* to that local PostgREST.
 * It is not a real auth server and must never be exposed or deployed.
 *
 * Storage (/storage/v1/object/…): every operation is done AS THE USER on
 * storage.objects through the local PostgREST, so the real bucket policies
 * of the migrations (RLS) decide; the bytes are kept in STORAGE_DIR only
 * when the database accepted the row. Bucket size / type limits are read
 * from storage.buckets, like Supabase Storage does.
 *
 * env: STUB_PORT, PGRST_URL (http://127.0.0.1:…), JWT_SECRET, TEST_PASSWORD, USERS (JSON {email: uuid}), STORAGE_DIR
 */
import http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PORT = Number(process.env.STUB_PORT)
const PGRST = process.env.PGRST_URL ?? ''
const SECRET = process.env.JWT_SECRET ?? ''
const PASSWORD = process.env.TEST_PASSWORD ?? ''
const USERS = JSON.parse(process.env.USERS ?? '{}')
const STORAGE_DIR = process.env.STORAGE_DIR ?? ''
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

// ------------------------------------------------------------- storage emulation (RLS decides)
const serviceToken = () => sign({ role: 'service_role', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 })
const pg = (path, init = {}, token) => fetch(PGRST + path, { ...init, headers: { 'accept-profile': 'storage', 'content-profile': 'storage', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } })
const fileOf = (bucket, name) => {
  const f = resolve(STORAGE_DIR, bucket, name)
  if (!f.startsWith(resolve(STORAGE_DIR) + '/') || name.split('/').some((s) => s === '..' || s === '')) throw new Error('bad path')
  return f
}
const storageErr = (res, status, message) => send(res, status, { statusCode: String(status), error: status === 404 ? 'not_found' : status === 409 ? 'Duplicate' : 'Unauthorized', message })
async function canSee(token, bucket, name) {
  const r = await pg(`/objects?select=name&bucket_id=eq.${encodeURIComponent(bucket)}&name=eq.${encodeURIComponent(name)}`, {}, token)
  return r.ok && (await r.json()).length === 1
}
async function storage(req, res, url) {
  if (!STORAGE_DIR) return storageErr(res, 404, 'storage not enabled')
  const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length))
  const token = bearer(req)
  const claims = verify(token)
  // public objects
  if (req.method === 'GET' && rest.startsWith('public/')) {
    const [bucket, ...p] = rest.slice(7).split('/'); const name = p.join('/')
    const b = await (await pg(`/buckets?select=public&id=eq.${encodeURIComponent(bucket)}`, {}, serviceToken())).json()
    const f = fileOf(bucket, name)
    if (!b[0]?.public || !existsSync(f)) return storageErr(res, 404, 'Object not found')
    res.writeHead(200, { 'content-type': readFileSync(f + '.type', 'utf8') }); return res.end(readFileSync(f))
  }
  // signed URLs: create (needs read access) and use (token)
  if (rest.startsWith('sign/')) {
    const [bucket, ...p] = rest.slice(5).split('/'); const name = p.join('/')
    if (req.method === 'POST') {
      if (!claims || !(await canSee(token, bucket, name))) return storageErr(res, 400, 'Object not found')
      const t = sign({ typ: 'storage', bucket, name, exp: Math.floor(Date.now() / 1000) + Math.min(3600, Number(JSON.parse((await readBody(req)).toString() || '{}').expiresIn) || 60) })
      return send(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${t}` })
    }
    const c = verify(url.searchParams.get('token'))
    const f = fileOf(bucket, name)
    if (!c || c.typ !== 'storage' || c.bucket !== bucket || c.name !== name || !existsSync(f)) return storageErr(res, 400, 'Invalid signature')
    res.writeHead(200, { 'content-type': readFileSync(f + '.type', 'utf8') }); return res.end(readFileSync(f))
  }
  if (!claims) return storageErr(res, 400, 'Invalid JWT')
  const path = rest.startsWith('authenticated/') ? rest.slice(14) : rest
  const [bucket, ...p] = path.split('/'); const name = p.join('/')
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!(await canSee(token, bucket, name)) || !existsSync(fileOf(bucket, name))) return storageErr(res, 400, 'Object not found')
    const f = fileOf(bucket, name)
    res.writeHead(200, { 'content-type': readFileSync(f + '.type', 'utf8') }); return res.end(req.method === 'HEAD' ? undefined : readFileSync(f))
  }
  if (req.method === 'DELETE' && !name) {                     // remove({ prefixes })
    const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || '{}')
    const out = []
    for (const n of prefixes) {
      const r = await pg(`/objects?bucket_id=eq.${encodeURIComponent(bucket)}&name=eq.${encodeURIComponent(n)}`, { method: 'DELETE', headers: { prefer: 'return=representation' } }, token)
      if (r.ok && (await r.json()).length) { const f = fileOf(bucket, n); rmSync(f, { force: true }); rmSync(f + '.type', { force: true }); out.push({ name: n, bucket_id: bucket }) }
    }
    return send(res, 200, out)
  }
  if (req.method === 'POST' || req.method === 'PUT') {        // upload
    const raw = await readBody(req)
    let bytes = raw, type = req.headers['content-type'] ?? 'application/octet-stream'
    if (/^multipart\/form-data/.test(type)) {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData()
      const file = form.get('')
      if (!(file instanceof Blob)) return storageErr(res, 400, 'No file')
      bytes = Buffer.from(await file.arrayBuffer()); type = file.type || 'application/octet-stream'
    }
    const b = (await (await pg(`/buckets?select=file_size_limit,allowed_mime_types&id=eq.${encodeURIComponent(bucket)}`, {}, serviceToken())).json())[0]
    if (!b) return storageErr(res, 404, 'Bucket not found')
    if (b.file_size_limit && bytes.length > b.file_size_limit) return send(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' })
    if (b.allowed_mime_types?.length && !b.allowed_mime_types.includes(type.split(';')[0])) return send(res, 415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` })
    const r = await pg('/objects', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ bucket_id: bucket, name, owner: claims.sub }) }, token)
    if (!r.ok) { const e = await r.json().catch(() => ({})); return storageErr(res, r.status === 409 ? 409 : 403, e.message ?? 'new row violates row-level security policy') }
    const row = (await r.json())[0]
    const f = fileOf(bucket, name); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes); writeFileSync(f + '.type', type.split(';')[0])
    return send(res, 200, { Id: row.id, Key: `${bucket}/${name}` })
  }
  return storageErr(res, 400, 'unsupported')
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // the browser calls Storage directly (logo / signature upload), like with Supabase: CORS for local origins only
  const origin = req.headers.origin
  if (origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin); res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info, x-upsert, cache-control, accept-profile, content-profile, prefer, range, x-supabase-api-version')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
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
    if (url.pathname.startsWith('/storage/v1/object/')) return await storage(req, res, url)
    if (url.pathname.startsWith('/rest/v1/')) {
      const target = PGRST + url.pathname.slice('/rest/v1'.length) + url.search
      const headers = {}
      for (const k of ['authorization', 'accept', 'content-type', 'prefer', 'range', 'range-unit', 'accept-profile', 'content-profile']) if (req.headers[k]) headers[k] = req.headers[k]
      // like Supabase: a request without a valid user token is anonymous (the publishable key is not a JWT here)
      const tok = bearer(req)
      if (!tok || (!verify(tok) && !/^ey/.test(tok))) headers.authorization = `Bearer ${sign({ role: 'anon', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`
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

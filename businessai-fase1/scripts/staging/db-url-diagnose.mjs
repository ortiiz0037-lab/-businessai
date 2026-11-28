#!/usr/bin/env node
// =====================================================================
// Safe diagnostics for STAGING_DB_URL (no connection to Supabase).
// =====================================================================
// Prints ONLY pass/fail lines. Never prints the URI, the password, the
// user, the host or any other part of the secret, nor lengths or hashes.
//
// Checks:
//   1. Present, not wrapped in quotes/whitespace, no [YOUR-PASSWORD].
//   2. Parsed the way libpq (psql) parses it: scheme, user =
//      postgres.<STAGING_PROJECT_REF>, Supabase Session pooler host,
//      port 5432, database "postgres"; no production ref.
//   3. Password: present, no whitespace, valid %-encoding, decodes the
//      same in libpq and in a standard URL parser.
//   4. psql really sends the full URI: apply-migrations.sh passes
//      "$STAGING_DB_URL" untouched, and a LOCAL probe (127.0.0.1 only)
//      receives from psql exactly the expected user, database and
//      password (compared in memory, never printed). Only the host:port of
//      a COPY of the URI is pointed at the local probe; nothing is sent to
//      Supabase.
// Exit 1 if any check fails.
// =====================================================================
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Parses a postgres URI with the same rules as libpq (conninfo_uri_parse). */
export function parseLibpqUri(uri) {
  const m = /^(postgresql|postgres):\/\//.exec(uri)
  if (!m) return { ok: false, reason: 'scheme' }
  const start = m[0].length
  let p = start
  while (p < uri.length && uri[p] !== '@' && uri[p] !== '/') p++
  let user = null, password = null, hostStart = start
  if (uri[p] === '@') {
    const info = uri.slice(start, p)
    const colon = info.indexOf(':')
    user = colon === -1 ? info : info.slice(0, colon)
    password = colon === -1 ? null : info.slice(colon + 1)
    hostStart = p + 1
  }
  let q = hostStart
  let host
  if (uri[q] === '[') {
    const end = uri.indexOf(']', q)
    if (end === -1) return { ok: false, reason: 'host' }
    host = uri.slice(q + 1, end); q = end + 1
  } else {
    while (q < uri.length && !':/?,'.includes(uri[q])) q++
    host = uri.slice(hostStart, q)
  }
  if (uri[q] === ',') return { ok: false, reason: 'multihost' }
  let port = null
  if (uri[q] === ':') {
    const ps = q + 1
    q = ps
    while (q < uri.length && !'/?,'.includes(uri[q])) q++
    port = uri.slice(ps, q)
  }
  const hostPortEnd = q
  let dbname = null
  if (uri[q] === '/') {
    const ds = q + 1
    q = ds
    while (q < uri.length && uri[q] !== '?') q++
    dbname = uri.slice(ds, q)
  }
  const params = []
  if (uri[q] === '?') {
    for (const kv of uri.slice(q + 1).split('&')) {
      if (!kv) continue
      const eq = kv.indexOf('=')
      params.push([eq === -1 ? kv : kv.slice(0, eq), eq === -1 ? '' : kv.slice(eq + 1)])
    }
  }
  return { ok: true, raw: { user, password, host, port, dbname }, params, hostStart, hostPortEnd }
}

/** libpq's %-decoding: '%' must be followed by 2 hex digits, %00 is invalid. Returns null if invalid. */
export function libpqDecode(s) {
  if (s === null || s === undefined) return s
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') {
      const hex = s.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex) || hex === '00') return null
      bytes.push(parseInt(hex, 16)); i += 2
    } else {
      bytes.push(...Buffer.from(s[i], 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

const POOLER_HOST = /^aws-\d+-[a-z]{2}-[a-z]+-\d+\.pooler\.supabase\.com$/

/** Static checks 1–3. Returns [{ ok, level, text }] — texts never contain secret data. */
export function staticChecks(uri, { stagingRef, productionRef }) {
  const out = []
  const add = (level, text) => out.push({ level, text })
  if (!uri) { add('FAIL', '1. STAGING_DB_URL is empty'); return out }
  add('PASS', '1. STAGING_DB_URL is not empty')
  add(uri === uri.trim() ? 'PASS' : 'FAIL', '1. no leading/trailing spaces or line breaks around the URI')
  add(/^["'`]|["'`]$/.test(uri.trim()) ? 'FAIL' : 'PASS', '1. the URI is not wrapped in quotes')
  add(/YOUR[-_ ]?PASSWORD/i.test(uri) ? 'FAIL' : 'PASS', '1. the [YOUR-PASSWORD] placeholder is gone')
  const u = uri.trim().replace(/^["'`]|["'`]$/g, '')

  const parsed = parseLibpqUri(u)
  if (!parsed.ok) {
    add('FAIL', `2. psql cannot read the URI (${{ scheme: 'it must start with postgresql:// or postgres://', host: 'malformed host', multihost: 'several hosts' }[parsed.reason]})`)
    return out
  }
  add('PASS', '2. scheme postgresql:// (as psql expects)')
  const { raw } = parsed
  const user = libpqDecode(raw.user)
  const host = libpqDecode(raw.host)
  const db = libpqDecode(raw.dbname)
  add(raw.user !== null ? 'PASS' : 'FAIL', '2. psql finds a user in the URI (user@host separator)')
  add(user === `postgres.${stagingRef}` ? 'PASS' : 'FAIL',
    '2. user is exactly postgres.<STAGING_PROJECT_REF> (Session pooler format, staging project)')
  if (user !== `postgres.${stagingRef}` && user === 'postgres') add('INFO', '   the user has no project ref: that is the direct-connection user, not the pooler one')
  add(productionRef && u.includes(productionRef) ? 'FAIL' : 'PASS', '2. the production project ref does not appear anywhere in the URI')
  add(host && POOLER_HOST.test(host) ? 'PASS' : 'FAIL', '2. host is a Supabase pooler host (aws-N-<region>.pooler.supabase.com)')
  if (host && /^db\.[a-z0-9]+\.supabase\.co$/.test(host)) add('INFO', '   the host is the DIRECT connection (IPv6 only), not the Session pooler')
  add(raw.port === '5432' ? 'PASS' : 'FAIL', '2. port 5432 (Session pooler)')
  if (raw.port === '6543') add('INFO', '   port 6543 is the Transaction pooler; use the Session pooler (5432)')
  add(db === 'postgres' ? 'PASS' : 'FAIL', '2. database "postgres"')
  const known = new Set(['sslmode', 'connect_timeout', 'application_name', 'options', 'sslrootcert'])
  const names = parsed.params.map(([k]) => k)
  if (names.length === 0) add('PASS', '2. no extra parameters after "?"')
  else add(names.every((k) => known.has(k)) ? 'PASS' : 'FAIL',
    `2. parameters after "?": ${names.map((k) => (known.has(k) ? k : 'unknown')).join(', ')}`)

  // 3. Password
  if (raw.password === null || raw.password === '') { add('FAIL', '3. the URI has a password (user:password@host)'); return out }
  add('PASS', '3. the URI has a password (user:password@host)')
  add(/\s/.test(raw.password) ? 'FAIL' : 'PASS', '3. no spaces, tabs or line breaks inside the password')
  add(/[[\]]/.test(raw.password) ? 'FAIL' : 'PASS', '3. no square brackets left around the password')
  const decoded = libpqDecode(raw.password)
  add(decoded === null ? 'FAIL' : 'PASS', '3. URL encoding is valid for psql (every % followed by 2 hex digits)')
  if (decoded === null) return out
  if (decoded !== raw.password) {
    add('WARN', '3. the password contains %XX sequences: psql DECODES them. Correct only if your real password'
      + ' has those characters encoded (e.g. a literal % must be written %25)')
  } else {
    add('PASS', '3. the password needs no URL decoding (psql uses it exactly as written)')
  }
  add(/[?#]/.test(raw.password) ? 'WARN' : 'PASS', '3. no ? or # characters unencoded in the password')
  let whatwg = null
  try { whatwg = decodeURIComponent(new URL(u).password) } catch { /* reported below */ }
  add(whatwg === decoded ? 'PASS' : 'WARN', '3. psql and a standard URL parser read the same password')
  add(/[^\x21-\x7e]/.test(decoded) ? 'WARN' : 'PASS', '3. the password is plain printable ASCII')
  return out
}

/** The apply-migrations script passes $STAGING_DB_URL to psql unmodified. */
export function scriptPassesUriUntouched(src) {
  const usesQuoted = /psql "\$STAGING_DB_URL"/.test(src)
  const reassigned = /(^|[\s;])(export\s+)?STAGING_DB_URL=/m.test(src)
  const otherSource = /PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)=/.test(src)
  return usesQuoted && !reassigned && !otherSource
}

function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }

/**
 * Local probe: a minimal PostgreSQL server on 127.0.0.1 that records what
 * psql sends (startup user/database, cleartext password) and then refuses.
 * Resolves { user, database, password } or null on timeout.
 */
function startProbe() {
  return new Promise((resolve) => {
    const seen = {}
    let done
    const finished = new Promise((r) => { done = r })
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0), started = false
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (!started) {
            if (buf.length < 8) return
            const len = buf.readInt32BE(0)
            if (buf.length < len) return
            const code = buf.readInt32BE(4)
            const body = buf.subarray(8, len)
            buf = buf.subarray(len)
            if (code === 80877103 || code === 80877104) { sock.write('N'); continue } // SSL / GSS: not here
            if (code === 196608) {
              const parts = body.toString('utf8').split('\0')
              for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) seen[parts[i]] = parts[i + 1]
              started = true
              sock.write(Buffer.concat([Buffer.from('R'), int32(8), int32(3)])) // cleartext password request
              continue
            }
            sock.destroy(); return
          }
          if (buf.length < 5) return
          const type = String.fromCharCode(buf[0]); const len = buf.readInt32BE(1)
          if (buf.length < len + 1) return
          const body = buf.subarray(5, len + 1); buf = buf.subarray(len + 1)
          if (type === 'p') {
            seen.password = body.subarray(0, body.length - 1).toString('utf8')
            const fields = Buffer.from('SFATAL\0C28000\0Mdiagnostic probe: not a real server\0\0')
            sock.end(Buffer.concat([Buffer.from('E'), int32(fields.length + 4), fields]))
            done(seen)
          }
          return
        }
      })
      sock.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, finished, close: () => server.close() }))
  })
}

/** Check 4: what psql actually sends, using a copy of the URI pointed at the local probe. */
export async function probePsql(uri, { stagingRef }) {
  const parsed = parseLibpqUri(uri)
  if (!parsed.ok) return [{ level: 'FAIL', text: '4. probe skipped: psql cannot read the URI' }]
  const probe = await startProbe()
  // Copy of the URI: only host:port replaced; sslmode forced to disable (the probe has no TLS).
  // The query string is located after host:port (a '?' inside the password is not one).
  const head = uri.slice(0, parsed.hostStart) + `127.0.0.1:${probe.port}`
  const tail = uri.slice(parsed.hostPortEnd)
  const qi = tail.indexOf('?')
  const path = qi === -1 ? tail : tail.slice(0, qi)
  const query = (qi === -1 ? [] : tail.slice(qi + 1).split('&')).filter((kv) => kv && !kv.startsWith('sslmode='))
  const copy = `${head}${path}?${[...query, 'sslmode=disable'].join('&')}`
  // Same invocation as apply-migrations.sh (psqlx); no PG* overrides; output discarded.
  const env = { ...process.env, PGCONNECT_TIMEOUT: '5' }
  for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE']) delete env[k]
  const child = spawn('psql', [copy, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', 'select 1'], { env, stdio: 'ignore' })
  const timeout = new Promise((r) => setTimeout(() => r(null), 8000))
  const seen = await Promise.race([probe.finished, timeout])
  child.kill(); probe.close()
  if (!seen) return [{ level: 'FAIL', text: '4. psql did not send credentials to the local probe' }]
  const expectedPassword = libpqDecode(parsed.raw.password)
  return [
    { level: 'PASS', text: '4. psql reads the full URI (local probe reached, nothing sent to Supabase)' },
    { level: seen.user === `postgres.${stagingRef}` ? 'PASS' : 'FAIL',
      text: '4. psql sends the user WITH the project ref (postgres.<STAGING_PROJECT_REF>)' },
    { level: seen.database === 'postgres' ? 'PASS' : 'FAIL', text: '4. psql sends database "postgres"' },
    { level: seen.password === expectedPassword ? 'PASS' : 'FAIL',
      text: '4. psql sends exactly the password written in the URI (compared in memory, not printed)' },
  ]
}

async function main() {
  const uri = process.env.STAGING_DB_URL ?? ''
  const stagingRef = process.env.STAGING_PROJECT_REF ?? ''
  const productionRef = process.env.PRODUCTION_PROJECT_REF ?? ''
  if (!/^[a-z0-9]{6,40}$/.test(stagingRef)) { console.log('FAIL  STAGING_PROJECT_REF is missing or malformed'); process.exit(1) }
  const results = staticChecks(uri, { stagingRef, productionRef })
  const src = readFileSync(new URL('./apply-migrations.sh', import.meta.url), 'utf8')
  results.push({ level: scriptPassesUriUntouched(src) ? 'PASS' : 'FAIL',
    text: '4. apply-migrations.sh passes "$STAGING_DB_URL" to psql unmodified (no rewrites, no PG* overrides)' })
  const pgOverrides = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE'].filter((k) => process.env[k])
  results.push({ level: pgOverrides.length ? 'WARN' : 'PASS', text: `4. no PG* variables in the runner environment${pgOverrides.length ? `: ${pgOverrides.join(', ')}` : ''}` })
  const blocking = results.some((r) => r.level === 'FAIL' && /^[123]\./.test(r.text) && !/^3\./.test(r.text))
  if (!blocking) results.push(...await probePsql(uri.trim().replace(/^["'`]|["'`]$/g, ''), { stagingRef }))
  else results.push({ level: 'INFO', text: '4. local psql probe skipped (fix the failures above first)' })
  for (const r of results) console.log(`${r.level.padEnd(5)} ${r.text}`)
  const fails = results.filter((r) => r.level === 'FAIL').length
  console.log(fails ? `RESULT: ${fails} check(s) failed` : 'RESULT: the URI is well-formed and psql sends it intact. If Supabase still answers "password authentication failed", the password itself does not match the staging database.')
  process.exit(fails ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

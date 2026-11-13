/**
 * Starts the LOCAL test stack for the authenticated browser tests:
 * PostgREST (127.0.0.1, local database through its unix socket) → the local
 * auth stand-in (127.0.0.1) → `next start` (127.0.0.1). The JWT secret and the
 * test password are generated for each run; nothing remote is reachable.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHmac } from 'node:crypto'

export const USERS = { 'owner@e2e.local': 'e1000000-0000-4000-8000-000000000001', 'admin@e2e.local': 'e1000000-0000-4000-8000-000000000002',
  'member@e2e.local': 'e1000000-0000-4000-8000-000000000003', 'other@e2e.local': 'e1000000-0000-4000-8000-000000000004' }

export async function startStack({ root, port, pgrstBin, pgSocket, pgPort, db, publicKey, nextEnv = {} }) {
  if (!pgrstBin || !pgSocket?.startsWith('/')) throw new Error('Set PGRST_BIN and PG_SOCKET (a local unix-socket directory).')
  const APP = port, PGRST = port + 1, STUB = port + 2
  const BASE = `http://127.0.0.1:${APP}`
  const PASSWORD = `local-${randomBytes(9).toString('hex')}`
  const SECRET = randomBytes(36).toString('base64url')
  const b64 = (s) => Buffer.from(s).toString('base64url')
  const jwt = (p) => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64(JSON.stringify(p)); return `${h}.${b}.${createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}` }
  const now = Math.floor(Date.now() / 1000)
  const ANON = jwt({ role: 'anon', iss: 'e2e-local', iat: now, exp: now + 7200 })
  const work = mkdtempSync(join(tmpdir(), 'ba-e2e-'))
  writeFileSync(join(work, 'postgrest.conf'), [`db-uri = "postgres://authenticator@/${db}?host=${pgSocket}&port=${pgPort}"`, 'db-schemas = "public,storage"', 'db-anon-role = "anon"',
    'db-pool = 10', `jwt-secret = "${SECRET}"`, 'server-host = "127.0.0.1"', `server-port = ${PGRST}`, 'log-level = "warn"'].join('\n'), { mode: 0o600 })
  const logs = { pgrst: '', stub: '', next: '' }
  const procs = []
  const start = (name, cmd, args, env) => {
    // own process group, so stop() also ends the children (npx → next-server)
    const p = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    p.stdout.on('data', (d) => { logs[name] += d }); p.stderr.on('data', (d) => { logs[name] += d })
    procs.push(p)
  }
  start('pgrst', pgrstBin, [join(work, 'postgrest.conf')], {})
  start('stub', process.execPath, ['e2e/local-stack/auth-stub.mjs'], { STUB_PORT: String(STUB), PGRST_URL: `http://127.0.0.1:${PGRST}`, JWT_SECRET: SECRET, TEST_PASSWORD: PASSWORD, USERS: JSON.stringify(USERS), STORAGE_DIR: join(work, 'storage') })
  start('next', 'npx', ['next', 'start', '-p', String(APP), '-H', '127.0.0.1'], { NODE_ENV: 'production', APP_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${STUB}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey ?? ANON, NEXT_PUBLIC_APP_URL: BASE, STRIPE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ...nextEnv })
  const alive = (p) => { try { process.kill(-p.pid, 0); return true } catch { return false } }
  const kill = (sig) => { for (const p of procs) try { process.kill(-p.pid, sig) } catch { /* gone */ } }
  let stopped = false
  // SIGTERM, wait up to 4 s for a graceful exit, then SIGKILL whatever is left (next-server can linger on open connections)
  const stop = async () => {
    if (stopped) return; stopped = true
    kill('SIGTERM')
    for (let i = 0; i < 20 && procs.some(alive); i++) await new Promise((r) => setTimeout(r, 200))
    kill('SIGKILL')
    for (let i = 0; i < 20 && procs.some(alive); i++) { await new Promise((r) => setTimeout(r, 100)); kill('SIGKILL') }   // until the group is really gone
    rmSync(work, { recursive: true, force: true })
  }
  process.on('exit', () => { kill('SIGKILL'); rmSync(work, { recursive: true, force: true }) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stop(); process.exit(130) })
  const ready = async (url, ms = 60000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) { try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 400)) }
    throw new Error(`not ready: ${url}\n${JSON.stringify(logs, null, 1).slice(0, 3000)}`)
  }
  await ready(`http://127.0.0.1:${PGRST}/`); await ready(`http://127.0.0.1:${STUB}/auth/v1/logout`); await ready(`${BASE}/login`)
  // helpers for the security checks: the REST API as a given test user (to try forbidden calls without the UI), and
  // read-only counts with the service role (to prove that no record is duplicated)
  const api = (email, path, init = {}) => {
    const t = Math.floor(Date.now() / 1000)
    const token = email ? jwt({ sub: USERS[email], email, role: 'authenticated', aud: 'authenticated', iat: t, exp: t + 600 }) : ANON
    return fetch(`http://127.0.0.1:${STUB}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: ANON, ...(init.headers ?? {}) } })
  }
  const count = async (table, filter = '') => {
    const t = Math.floor(Date.now() / 1000)
    const r = await fetch(`http://127.0.0.1:${PGRST}/${table}?select=*${filter ? `&${filter}` : ''}`, { method: 'HEAD', headers: { authorization: `Bearer ${jwt({ role: 'service_role', iat: t, exp: t + 60 })}`, prefer: 'count=exact' } })
    return Number((r.headers.get('content-range') ?? '*/-1').split('/')[1])
  }
  // database-owner bootstrap only (e.g. registering the assistant's server key, test fixtures); never used by the app
  const admin = (path, init = {}) => {
    const t = Math.floor(Date.now() / 1000)
    return fetch(`http://127.0.0.1:${PGRST}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt({ role: 'service_role', iat: t, exp: t + 60 })}`, ...(init.headers ?? {}) } })
  }
  return { BASE, PASSWORD, logs, stop, work, api, count, admin, STUB_URL: `http://127.0.0.1:${STUB}` }
}

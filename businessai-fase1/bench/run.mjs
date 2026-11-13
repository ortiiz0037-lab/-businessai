#!/usr/bin/env node
/**
 * BusinessAI benchmark runner.
 *
 *   npm run build                                   (app mode needs a production build)
 *   PSQL="psql -h /sock -p 5432 -U postgres" PGRST_BIN=… PG_SOCKET=/sock PG_PORT=5432 node bench/run.mjs [options]
 *
 * Options
 *   --mode engine|app|both   engine: every case in process through runSignedTurn (default: both)
 *                            app: APP_CASES through the browser and /api/assistant/stream
 *   --cases ID,ID            run only these cases
 *   --baseline FILE          compare with this report (default bench/baselines/simulated.json)
 *   --update-baseline        write the baseline from this run (only when the gate passes)
 *   --no-db                  reuse the database (default: rebuilt and seeded: DB=ba_bench)
 *   --provider double|anthropic   double (default): local scripted double, no network, no cost.
 *                            anthropic: REAL provider — refused unless BENCH_ALLOW_PAID=1 and
 *                            ANTHROPIC_API_KEY are set; simOnly cases are skipped.
 *   --compare A.json B.json …  side-by-side report of existing runs (no execution)
 *
 * Exit: 0 gate passed and no regression · 1 gate failed or regression · 2 refused / setup error.
 * Outputs (gitignored): bench/out/<run>.json and .md, bench/out/latest.{json,md}.
 * Never touches Supabase, Stripe or any remote service; the database must be local.
 */
import { spawnSync, execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from '../e2e/local-stack/stack.mjs'
import { startScriptedDouble } from './double.mjs'
import { COMPANIES, DATA_VERSION, USERS, company, oracle, seedSql } from './data.mjs'
import { CASES, APP_CASES } from './cases.mjs'
import { evaluateCase, summarize, compare, markdown, comparisonMarkdown } from './evaluate.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const flag = (name) => args.includes(`--${name}`)
const OUT = join(root, 'bench/out')
mkdirSync(OUT, { recursive: true })
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

// ------------------------------------------------------------- comparison only
if (flag('compare')) {
  const files = args.slice(args.indexOf('--compare') + 1).filter((a) => !a.startsWith('--'))
  const md = comparisonMarkdown(files.map(readJson))
  writeFileSync(join(OUT, 'comparison.md'), md)
  console.log(md)
  process.exit(0)
}

// ------------------------------------------------------------- configuration and refusals
const MODE = opt('mode', 'both')
const PROVIDER = opt('provider', 'double')
const REAL = PROVIDER === 'anthropic'
if (!['engine', 'app', 'both'].includes(MODE) || !['double', 'anthropic'].includes(PROVIDER)) { console.error('bench: invalid --mode or --provider'); process.exit(2) }
if (REAL && (process.env.BENCH_ALLOW_PAID !== '1' || !process.env.ANTHROPIC_API_KEY)) {
  console.error('bench: a real provider run is PAID. Refused: set BENCH_ALLOW_PAID=1 and ANTHROPIC_API_KEY explicitly to run it. The default (--provider double) needs neither.')
  process.exit(2)
}
const { PSQL, PGRST_BIN, PG_SOCKET } = process.env
if (!PSQL || !PGRST_BIN || !PG_SOCKET) { console.error('bench: set PSQL, PGRST_BIN and PG_SOCKET (local database only)'); process.exit(2) }
if (/supabase\.(co|com)|pooler\.supabase/.test(PSQL)) { console.error('bench: refusing, PSQL points at Supabase'); process.exit(2) }
const DB = process.env.DB ?? 'ba_bench'
const PORT = Number(process.env.PORT ?? 3280)
const only = opt('cases')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const suite = readJson(join(root, 'bench/suite.json'))
const thresholds = readJson(join(root, 'bench/thresholds.json'))
const baselineFile = opt('baseline', join(root, 'bench/baselines/simulated.json'))

// the engine entry (bench/engine.ts → the production service code) is bundled for Node on every run
{
  const b = spawnSync(join(root, 'node_modules/.bin/esbuild'), ['bench/engine.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', '--tsconfig=tsconfig.json',
    '--outfile=bench/out/engine.bundle.cjs', '--log-level=warning'], { cwd: root, encoding: 'utf8' })
  if (b.status !== 0) { console.error('bench: engine bundle failed', b.stderr); process.exit(2) }
}

const psql = (sql) => {
  const r = spawnSync('bash', ['-c', `${PSQL} -X -q -t -A -v ON_ERROR_STOP=1 -d ${DB}`], { input: sql, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.slice(0, 2000)}`)
  return r.stdout.trim()
}

// ------------------------------------------------------------- database: build + fictitious data
if (!flag('no-db')) {
  const r = spawnSync('bash', [join(root, 'e2e/local-stack/db.sh')], { env: { ...process.env, DB }, encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(2) }
  psql(seedSql())
  console.log(`bench: database ${DB} built and seeded (dataset v${DATA_VERSION})`)
}
const today = psql('select public.ba_today()')
const benchCompanies = COMPANIES.map((c) => `'${c.id}'`).join(',')
const docRows = psql(`select id || '|' || company_id || '|' || document_number from public.documents where company_id in (${benchCompanies})`).split('\n').filter(Boolean).map((l) => l.split('|'))
const rt = { today, docNumber: Object.fromEntries(docRows.map(([id, , n]) => [id, n])), docNumberAurora: Object.fromEntries(docRows.filter(([, co]) => co === company('aurora').id).map(([id, , n]) => [id, n])) }
const O = oracle(today)

// ------------------------------------------------------------- stack: local double, PostgREST, auth stand-in, app
const API_KEY = REAL ? process.env.ANTHROPIC_API_KEY : `local-bench-double-${randomBytes(6).toString('hex')}`
const SERVER_SECRET = randomBytes(32).toString('base64')
const SERVER_KEYS = `kbench:${SERVER_SECRET}`
const double = REAL ? null : await startScriptedDouble({ port: PORT + 20, apiKey: API_KEY })
const BASE_URL = REAL ? undefined : double.url
const stack = await startStack({ root, port: PORT, pgrstBin: PGRST_BIN, pgSocket: PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: DB, extraUsers: USERS,
  nextEnv: { ANTHROPIC_API_KEY: API_KEY, ...(BASE_URL ? { ANTHROPIC_BASE_URL: BASE_URL } : {}), ASSISTANT_SERVER_KEYS: SERVER_KEYS } })
const { admin } = stack
const results = []
let exitCode = 2
try {
  const reg = await admin('/rpc/assistant_set_server_key', { method: 'POST', body: JSON.stringify({ key: 'kbench', secret_b64: SERVER_SECRET }) })
  if (!reg.ok) throw new Error(`server key registration failed: ${reg.status} ${await reg.text()}`)
  // the per-minute limits would throttle a benchmark that sends dozens of turns per minute: raised in this local database only
  await admin('/assistant_limits', { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ per_minute: 120, company_per_minute: 600 }) })

  const json = async (r) => (r.ok ? r.json() : null)
  const countOf = async (table, filter) => stack.count(table, filter)
  const dbSnapshot = async (co, uid) => ({
    payments: await countOf('payments', `company_id=eq.${co}`), studio: await countOf('studio_documents', `company_id=eq.${co}`),
    executed: await countOf('assistant_actions', `company_id=eq.${co}&status=eq.executed`), turns: await countOf('assistant_turns', `company_id=eq.${co}&user_id=eq.${uid}`),
  })
  const turnRecord = async (id) => (id ? (await json(await admin(`/assistant_turns?id=eq.${id}&select=status,model,tier,router,calls,input_tokens,output_tokens,cost_nanos,cost_status,latency_ms,verification,error_code`)))?.[0] ?? null : null)
  const proposedFor = async (turnId) => (turnId ? await countOf('assistant_actions', `turn_id=eq.${turnId}`) : 0)
  const scriptFor = (c) => (typeof c.sim === 'function' ? c.sim(rt) : c.sim)

  const selected = CASES.filter((c) => (!only || only.includes(c.id)) && !(REAL && c.simOnly))
  const ctxFor = (c) => ({ o: O, rt, currency: company(c.company).currency })

  // ============================================================ engine mode
  if (MODE !== 'app') {
    const { runEngineTurn } = await import('./out/engine.bundle.cjs').catch(() => ({}))
    if (!runEngineTurn) throw new Error('engine bundle missing (bench/run.mjs builds it; see npm run bench)')
    for (const c of selected) {
      const co = company(c.company), uid = USERS[c.user], role = co.members.find(([u]) => u === uid)?.[1] ?? 'member'
      if (double) double.script(c.question, scriptFor(c))
      const base = { supabaseUrl: stack.STUB_URL, anonKey: stack.ANON, token: stack.tokenFor(c.user), userId: uid, companyId: co.id, role, companyName: co.name, locale: c.locale,
        apiKey: API_KEY, baseURL: BASE_URL, testDouble: !REAL, serverKeys: SERVER_KEYS, deadlineMs: c.deadlineMs ?? 50000, question: c.question, screen: c.screen, cancelAfterMs: c.cancelAfterMs }
      const before = await dbSnapshot(co.id, uid)
      let r
      try {
        const runs = await Promise.all(Array.from({ length: c.parallel ?? 1 }, () => runEngineTurn(base)))
        const x = runs[0]
        const after = await dbSnapshot(co.id, uid)
        r = { status: x.status, text: x.text, verification: x.verification, trace: x.trace, latencyMs: x.latencyMs, models: x.models,
          offered: x.requests[0]?.tools ?? [], toolResults: x.requests.flatMap((q) => q.toolResults), usage: x.requests.reduce((s, q) => ({ input: s.input + q.input, output: s.output + q.output }), { input: 0, output: 0 }),
          turn: { ...(await turnRecord(x.turnId)) }, parallel: c.parallel ? runs.map((y) => ({ status: y.status })) : undefined,
          db: { paymentsDelta: after.payments - before.payments, studioDelta: after.studio - before.studio, actionsExecuted: after.executed - before.executed, actionsProposed: await proposedFor(x.turnId), requestsDelta: after.turns - before.turns } }
        if (x.error) r.status = `error:${x.error}${x.reason ? `:${x.reason}` : ''}`
      } catch (e) { r = { harnessError: String(e?.stack ?? e).slice(0, 800) } }
      const ev = { ...evaluateCase(c, r, ctxFor(c)), mode: 'engine', usage: r.usage ?? null }
      results.push(ev)
      console.log(`${ev.pass ? 'PASS' : ev.critical_failure ? 'CRIT' : 'FAIL'} engine ${c.id} (${ev.score}) ${ev.pass ? '' : ev.failure_reasons.slice(0, 2).join(' | ').slice(0, 300)}`)
    }
  }

  // ============================================================ app mode (browser → /api/assistant/stream)
  if (MODE !== 'engine') {
    const { chromium } = require('playwright')
    const browser = await chromium.launch()
    try {
      for (const c of selected.filter((x) => APP_CASES.includes(x.id))) {
        const co = company(c.company), uid = USERS[c.user]
        if (double) double.script(c.question, scriptFor(c))
        const before = await dbSnapshot(co.id, uid)
        const reqStart = double ? double.log.length : 0
        let r
        const ctx = await browser.newContext({ locale: c.locale === 'en' ? 'en-US' : 'es-PR' })
        try {
          const page = await ctx.newPage()
          await ctx.addCookies([{ name: 'ba_locale', value: c.locale, url: stack.BASE }])
          await page.goto(`${stack.BASE}/login`)
          await page.fill('input[name="email"]', c.user); await page.fill('input[name="password"]', stack.PASSWORD)
          await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
          await page.goto(`${stack.BASE}${c.screen}`, { waitUntil: 'networkidle' })
          await page.getByTestId('assistant-fab').click()
          await page.getByTestId('assistant-chat').waitFor({ timeout: 15000 })
          const input = page.locator('textarea[id^="assistant-input"]').first()
          const t0 = Date.now()
          await input.fill(c.question); await input.press('Enter')
          await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-answer"]').length > 0 && !document.querySelector('[data-testid="assistant-live"]'), null, { timeout: 40000 })
          const latencyMs = Date.now() - t0
          const text = (await page.getByTestId('assistant-answer').allInnerTexts()).at(-1) ?? ''
          const verification = await page.getByTestId('assistant-answer').last().getAttribute('data-verification')
          const turn = (await json(await admin(`/assistant_turns?company_id=eq.${co.id}&user_id=eq.${uid}&order=started_at.desc&limit=1&select=id,status,model,tier,router,calls,input_tokens,output_tokens,cost_nanos,cost_status,latency_ms,verification,error_code`)))?.[0] ?? {}
          const msg = (await json(await admin(`/assistant_messages?turn_id=eq.${turn.id}&role=eq.assistant&select=tools`)))?.[0]
          const after = await dbSnapshot(co.id, uid)
          const reqs = double ? double.log.slice(reqStart).filter((q) => q.question === c.question) : []
          r = { status: turn.status, text, verification, trace: msg?.tools ?? [], latencyMs, models: [...new Set(reqs.map((q) => q.model))], turn,
            offered: reqs[0]?.tools ?? [], toolResults: reqs.flatMap((q) => q.toolResults),
            db: { paymentsDelta: after.payments - before.payments, studioDelta: after.studio - before.studio, actionsExecuted: after.executed - before.executed, actionsProposed: await proposedFor(turn.id), requestsDelta: after.turns - before.turns } }
        } catch (e) { r = { harnessError: String(e?.message ?? e).slice(0, 800) } }
        finally { await ctx.close() }
        const ev = { ...evaluateCase(c, r, ctxFor(c)), mode: 'app' }
        results.push(ev)
        console.log(`${ev.pass ? 'PASS' : ev.critical_failure ? 'CRIT' : 'FAIL'} app    ${c.id} (${ev.score}) ${ev.pass ? '' : ev.failure_reasons.slice(0, 2).join(' | ').slice(0, 300)}`)
      }
    } finally { await browser.close() }
  }

  // ============================================================ report
  const sha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() } catch { return 'unknown' } })()
  const dirty = (() => { try { return execSync('git status --porcelain', { cwd: root }).toString().trim().length > 0 } catch { return true } })()
  const { REGISTRY } = await import('./out/engine.bundle.cjs').catch(() => ({ REGISTRY: [] }))
  const started = new Date().toISOString()
  const report = {
    run: { id: `${REAL ? 'real' : 'sim'}-${started.replace(/[-:]/g, '').slice(0, 15)}-${sha}`, mode: REAL ? 'real' : 'simulated', provider: REAL ? 'anthropic' : 'local-double', harness: MODE, started_at: started, today },
    suite, data: { version: DATA_VERSION, companies: COMPANIES.map((c) => ({ key: c.key, currency: c.currency, plan: c.plan })) },
    code: { git_sha: sha, dirty }, models: { registry_verified_at: [...new Set(REGISTRY.map((m) => m.verifiedAt))].join(', ') || '—', registry: REGISTRY, used: [...new Set(results.flatMap((c) => c.evidence.model_requests ?? []))] },
    thresholds, cases: results,
    usage: { input_tokens: results.reduce((s, c) => s + (c.usage?.input ?? 0), 0), output_tokens: results.reduce((s, c) => s + (c.usage?.output ?? 0), 0),
      note: REAL ? 'Real provider usage; cost is recorded per turn in assistant_turns.' : 'Synthetic counts from the local double (characters / 4); cost recorded as 0 with status "test". Not a measurement of any model.' },
  }
  report.summary = summarize(results, thresholds)
  const baseline = !REAL && existsSync(baselineFile) ? readJson(baselineFile) : null
  report.comparison = compare(baseline, report)
  const md = markdown(report)
  for (const name of [report.run.id, 'latest']) { writeFileSync(join(OUT, `${name}.json`), JSON.stringify(report, null, 2)); writeFileSync(join(OUT, `${name}.md`), md) }
  console.log(`\n${md.split('\n## Cases')[0]}\nReport: bench/out/${report.run.id}.md`)
  if (flag('update-baseline')) {
    if (!report.summary.gate.passed || REAL) console.log('baseline NOT updated: only a simulated run that passes the gate can become the baseline')
    else {
      const slim = { run: report.run, suite, data: report.data, summary: report.summary, cases: results.map((c) => ({ id: c.id, version: c.version, mode: c.mode, category: c.category, pass: c.pass, score: c.score })) }
      mkdirSync(join(root, 'bench/baselines'), { recursive: true })
      writeFileSync(baselineFile, `${JSON.stringify(slim, null, 2)}\n`)
      console.log(`baseline updated: ${baselineFile}`)
    }
  }
  exitCode = report.summary.gate.passed && report.comparison.regressions.length === 0 ? 0 : 1
} catch (e) {
  console.error('bench: setup error:', e?.stack ?? e)
  console.error(JSON.stringify(stack.logs).slice(-3000))
} finally {
  await stack.stop()
  if (double) await double.close()
}
process.exit(exitCode)

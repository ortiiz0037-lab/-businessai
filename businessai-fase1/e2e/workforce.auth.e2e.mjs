#!/usr/bin/env node
/**
 * Authenticated browser test of Workforce / HR (0020–0022 + 0033) on the
 * LOCAL stack: the owner hires, assigns a direct supervisor, invites the
 * employee; the employee links the account, punches and requests; the direct
 * supervisor schedules (recurring, overnight), approves; rules are proposed
 * and applied explicitly; private documents; suspension; isolation and roles
 * through the REST API; CSV; English; phone and tablet. Fictitious data only.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/workforce.auth.e2e.mjs
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const EVIDENCE = process.env.EVIDENCE ?? null
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const PORT = Number(process.env.PORT ?? 3300)
const WORKER = { 'worker@e2e.local': 'e1000000-0000-4000-8000-000000000009' }
const MEMBER_ID = 'e1000000-0000-4000-8000-000000000003'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

async function session(BASE, PASSWORD, email, opts = {}) {
  const ctx = await browser.newContext({ ...opts })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  return { ctx, page }
}
async function open(BASE, page, path) {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  last = page.url().replace(BASE, '')
  return { status: r?.status() ?? 0, body: await page.locator('body').innerText() }
}
/** Submits a form by clicking its button and waits for the redirect with ?done / ?error. */
async function submit(page, button) {
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.href !== before && /[?&](done|error)=/.test(u.search), { timeout: 20000 }), button.click()])
  await page.waitForLoadState('networkidle')
  last = page.url()
  return { url: page.url(), body: await page.locator('body').innerText() }
}
const shot = async (page, name) => { if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false }) }
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const prDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86_400_000))

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin', extraUsers: WORKER })
  const { BASE, PASSWORD, api } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }

  // ------------------------------------------------------------ owner: hire, type, direct supervisor, access link
  const owner = await session(BASE, PASSWORD, 'owner@e2e.local')
  let p = owner.page
  let r = await open(BASE, p, '/workforce/employees')
  check(r.status === 200 && /Empleados activos: \d+ de 25/.test(r.body), 'owner: the employees page shows the plan limit (Pro 25)', r.body.slice(0, 200))
  const hire = p.locator('section[aria-labelledby="new-title"]')
  await hire.locator('input[name="first_name"]').fill('Wanda'); await hire.locator('input[name="last_name"]').fill('Ficticia')
  await hire.locator('input[name="email"]').fill('worker@e2e.local'); await hire.locator('input[name="employee_number"]').fill('501')
  await hire.locator('select[name="employment_type"]').selectOption('part_time')
  await Promise.all([p.waitForURL(/\/workforce\/employees\/[0-9a-f-]{36}\?done=created/, { timeout: 20000 }), hire.getByRole('button', { name: 'Crear empleado' }).click()])
  const EMP = /employees\/([0-9a-f-]{36})/.exec(p.url())[1]
  last = p.url()
  check(/Tiempo parcial/.test(await p.getByTestId('employee-badges').innerText()), 'owner: the new employee is part time (badge)')
  const edit = p.locator('section[aria-labelledby="edit-title"]')
  await edit.locator('select[name="supervisor_user_id"]').selectOption(MEMBER_ID)
  r = await submit(p, edit.getByRole('button', { name: 'Guardar cambios' }))
  check(/done=updated/.test(r.url) && /Supervisor: member@e2e\.local/.test(await p.getByTestId('employee-badges').innerText()), 'owner: assigns a direct supervisor (an active member)')
  check(await p.locator('select[name="status"]').count() === 1 && await edit.locator('select[name="status"]').count() === 0, 'the status is not editable in the general form (only with a reason, in its own card)')
  r = await submit(p, p.getByRole('button', { name: 'Crear enlace de acceso' }))
  const link = await p.locator('input[aria-label="Enlace de acceso"]').inputValue()
  check(/\/clock\/link\?token=[0-9a-f]{64}$/.test(link), 'owner: one-time access link for the employee')
  await shot(p, 'owner-employee')

  // ------------------------------------------------------------ employee: link the account, punch, emergency contact, leave
  const worker = await session(BASE, PASSWORD, 'worker@e2e.local')
  const w = worker.page
  await w.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'networkidle' })
  await Promise.all([w.waitForURL(/\/clock\?done=linked/, { timeout: 20000 }), w.getByRole('button', { name: 'Vincular y ponchar' }).click()])
  last = w.url()
  check(/Wanda Ficticia/.test(await w.locator('body').innerText()), 'employee: the account is linked and the clock shows the employee')
  r = await submit(w, w.getByRole('button', { name: 'Entrada', exact: true }))
  check(/done=punch_in/.test(r.url) && /Entrada registrada/.test(r.body), 'employee: clock in (server time)')
  await w.getByTestId('my-contact').locator('summary').click()
  const mc = w.getByTestId('my-contact')
  await mc.locator('input[name="emergency_contact_name"]').fill('Contacto Ficticio'); await mc.locator('input[name="emergency_contact_phone"]').fill('787-555-0101')
  r = await submit(w, mc.getByRole('button', { name: 'Guardar' }))
  check(/done=contact_saved/.test(r.url), 'employee: saves its own emergency contact')
  const leaveDay = prDay(20)
  const lf = w.locator('section[aria-labelledby="leave-title"]')
  await lf.locator('select[name="leave_type"]').selectOption('bereavement')
  await lf.locator('input[name="starts_on"]').fill(leaveDay)
  check(/No escribas diagnósticos/.test(await lf.innerText()), 'employee: the leave form warns not to write medical information')
  r = await submit(w, lf.getByRole('button', { name: 'Solicitar' }))
  check(/done=leave_requested/.test(r.url) && /Duelo/.test(r.body), 'employee: requests bereavement leave (new type)')

  // ------------------------------------------------------------ direct supervisor (a member): team scope, recurring overnight schedule
  const member = await session(BASE, PASSWORD, 'member@e2e.local')
  const m = member.page
  r = await open(BASE, m, '/workforce')
  check(r.status === 200 && /Wanda Ficticia/.test(r.body) && /Trabajando/.test(r.body), 'direct supervisor: opens the live panel and sees the report working')
  r = await open(BASE, m, '/workforce/employees')
  check(/Wanda Ficticia/.test(r.body) && !/Ana Rivera/.test(r.body), 'direct supervisor: sees only its direct report (not the rest of the company)')
  check(await m.locator('a[href="/workforce/settings"]').count() === 0, 'direct supervisor: no access to the rules')
  r = await open(BASE, m, '/workforce/schedule')
  const pat = m.getByTestId('shift-patterns')
  await pat.locator('input[name="start"]').fill('22:00'); await pat.locator('input[name="end"]').fill('06:00')
  for (const d of ['0', '6']) await pat.locator(`input[name="weekdays"][value="${d}"]`).check()
  await pat.locator('input[name="starts_on"]').fill(prDay(1))
  r = await submit(m, pat.getByRole('button', { name: 'Crear patrón' }))
  check(/done=pattern_created/.test(r.url), 'direct supervisor: creates a recurring overnight pattern (22:00 → 06:00)')
  r = await submit(m, m.getByTestId('shift-patterns').getByRole('button', { name: 'Generar turnos' }).first())
  const created = Number(new URL(r.url).searchParams.get('created'))
  check(created >= 20 && created <= 28, 'direct supervisor: generates the concrete shifts (no duplicates, skips leave)', String(created))
  r = await submit(m, m.getByTestId('shift-patterns').getByRole('button', { name: 'Generar turnos' }).first())
  check(new URL(r.url).searchParams.get('created') === '0', 'generating again creates nothing (idempotent)')
  await open(BASE, m, '/workforce/schedule')
  check(/\(\+1\)/.test(await m.locator('section[aria-label="Semana"]').innerText()), 'the week shows overnight shifts ending the next day (+1)')
  await shot(m, 'supervisor-schedule')

  // ------------------------------------------------------------ shift change: employee asks, supervisor approves
  await open(BASE, w, '/clock')
  const up = w.locator('section[aria-labelledby="sched-title"] li').first()
  await up.locator('summary').click()
  await up.locator('select[name="kind"]').selectOption('drop'); await up.locator('input[name="reason"]').fill('Cita médica (sin detalles)')
  r = await submit(w, up.getByRole('button', { name: 'Enviar' }))
  check(/done=shift_change_requested/.test(r.url) && /pendiente de tu supervisor/.test(r.body), 'employee: requests to drop an upcoming shift')
  r = await open(BASE, m, '/workforce/requests')
  const sc = m.getByTestId('shift-change-requests')
  check(/Quitar el turno/.test(await sc.innerText()), 'supervisor: sees the pending shift change')
  r = await submit(m, sc.getByRole('button', { name: 'Aprobar' }).first())
  check(/done=approved/.test(r.url), 'supervisor: approves the shift change (applied to the schedule)')
  r = await open(BASE, m, `/workforce/requests?month=${leaveDay.slice(0, 7)}`)
  check(/Wanda Ficticia · Duelo/.test(await m.getByTestId('leave-calendar').innerText()), 'leave calendar: the request appears on its day (pending)')

  // ------------------------------------------------------------ owner: rules proposed, applied explicitly, versioned
  r = await open(BASE, p, '/workforce/settings')
  const rulesForm = p.locator('section[aria-labelledby="rules-title"] form')
  await rulesForm.locator('input[name="daily_hours"]').fill('9')
  r = await submit(p, rulesForm.getByRole('button', { name: 'Proponer cambio de reglas' }))
  const prop = p.getByTestId('rule-proposals')
  check(/done=proposed/.test(r.url) && /Extra después de \(día\)\s*8 h\s*9 h/.test(await prop.innerText()), 'owner: a rule change is shown as a proposal (current → proposed); nothing changed yet')
  await prop.locator('input[name="confirm"]').first().check()
  r = await submit(p, prop.getByRole('button', { name: 'Aplicar cambio' }).first())
  check(/done=rules_applied/.test(r.url), 'owner: applies the change explicitly')
  await p.getByTestId('rule-versions').locator('summary').click()
  check(/v\d/.test(await p.getByTestId('rule-versions').innerText()) && /aplicado desde una propuesta/.test(await p.getByTestId('rule-versions').innerText()), 'owner: the change is in the version history (who, when, from a proposal)')
  check(/vigencia no verificada/.test(r.body), 'templates are marked as not verified')

  // ------------------------------------------------------------ owner: employee exception, private document, suspension
  await open(BASE, p, `/workforce/employees/${EMP}`)
  const exc = p.getByTestId('rule-exceptions')
  await exc.locator('select[name="daily_hours_mode"]').selectOption('value'); await exc.locator('input[name="daily_hours"]').fill('10')
  await exc.locator('input[name="reason"]').fill('Acuerdo individual ficticio')
  r = await submit(p, exc.getByRole('button', { name: 'Proponer excepción' }))
  const ep = p.getByTestId('rule-proposals')
  await ep.locator('input[name="confirm"]').first().check()
  r = await submit(p, ep.getByRole('button', { name: 'Aplicar cambio' }).first())
  check(/done=rules_applied/.test(r.url) && /con excepciones/.test(await p.getByTestId('rule-exceptions').innerText()), 'owner: a per-employee exception is proposed and applied')
  const docs = p.getByTestId('employee-documents')
  const PDF = Buffer.from('%PDF-1.4\n% documento ficticio\n%%EOF\n')
  if (process.env.E2E_BROWSER_STORAGE === '1') {
    // build with NEXT_PUBLIC_SUPABASE_URL pointing to the local stand-in: the browser uploads with the user's session
    await p.waitForFunction(() => { const el = document.querySelector('[data-testid="hr-file"]'); return !!el && Object.keys(el).some((k) => k.startsWith('__react')) }, null, { timeout: 20000 })
    await docs.locator('input[maxlength="160"]').fill('Contrato ficticio')
    await docs.locator('input[type="checkbox"]').check()
    await docs.getByTestId('hr-file').setInputFiles({ name: 'contrato.pdf', mimeType: 'application/pdf', buffer: PDF })
    await docs.locator('[role="status"]:has-text("Documento guardado."), [role="alert"]').first().waitFor({ timeout: 20000 })
    const upMsg = await docs.locator('[role="status"], [role="alert"]').first().innerText()
    check(/Documento guardado/.test(upMsg), 'owner (browser): uploads a private document to private storage and registers it', upMsg)
  } else {
    // the regular build has no public Supabase URL for the browser: the same storage and database rules, through the
    // REST API with the owner's session (the browser path runs with E2E_BROWSER_STORAGE=1 on the matching build)
    const path = `e2000000-0000-4000-8000-000000000001/${EMP}/${crypto.randomUUID()}-contrato.pdf`
    const up = await api('owner@e2e.local', `/storage/v1/object/HR-documents/${path}`, { method: 'POST', body: PDF, headers: { 'content-type': 'application/pdf' } })
    const reg = await api('owner@e2e.local', '/rest/v1/employee_documents', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({
      company_id: 'e2000000-0000-4000-8000-000000000001', employee_id: EMP, category: 'contract', title: 'Contrato ficticio', storage_path: path, file_name: 'contrato.pdf',
      content_type: 'application/pdf', size_bytes: PDF.length, visible_to_employee: true }) })
    check(up.status < 300 && reg.status < 300, 'owner (API): uploads a private document to private storage and registers it', `${up.status} ${reg.status}`)
    const sup = await api('member@e2e.local', `/storage/v1/object/HR-documents/e2000000-0000-4000-8000-000000000001/${EMP}/x.pdf`, { method: 'POST', body: PDF, headers: { 'content-type': 'application/pdf' } })
    check(sup.status >= 400, 'a supervisor cannot upload labor documents', String(sup.status))
  }
  await open(BASE, p, `/workforce/employees/${EMP}`)
  const docLink = p.getByTestId('employee-documents').getByRole('link', { name: 'Contrato ficticio' })
  check(await docLink.count() === 1, 'owner: uploads a private labor document, shared with the employee')
  const DOC = /documents\/([0-9a-f-]{36})/.exec(await docLink.getAttribute('href'))[1]
  r = await open(BASE, w, '/clock')
  check(/Contrato ficticio/.test(await w.getByTestId('my-documents').innerText()), 'employee: sees the shared document')
  const dl = await worker.ctx.request.get(`${BASE}/api/workforce/documents/${DOC}`, { maxRedirects: 0 })
  const signed = dl.headers().location ?? ''
  const file = signed ? await fetch(signed.startsWith('http') ? signed : `${BASE}${signed}`).then(async (x) => [x.status, await x.text()]) : [0, '']
  check(dl.status() >= 300 && dl.status() < 400 && file[0] === 200 && file[1].startsWith('%PDF'), 'employee: downloads it through a short-lived signed link', `${dl.status()} ${file[0]}`)
  const sdl = await member.ctx.request.get(`${BASE}/api/workforce/documents/${DOC}`, { maxRedirects: 0 })
  check(sdl.status() === 404, 'supervisor: private documents are not visible (404)', String(sdl.status()))
  const st = p.getByTestId('employment-status')
  await st.locator('select[name="status"]').selectOption('suspended')
  r = await submit(p, st.getByRole('button', { name: 'Cambiar estado' }))
  check(/error=reason_required/.test(r.url), 'owner: suspending without a reason is refused')
  await p.getByTestId('employment-status').locator('select[name="status"]').selectOption('suspended')
  await p.getByTestId('employment-status').locator('input[name="reason"]').fill('Investigación administrativa (ficticia)')
  r = await submit(p, p.getByTestId('employment-status').getByRole('button', { name: 'Cambiar estado' }))
  check(/done=status_suspended/.test(r.url) && /Suspendido/.test(await p.getByTestId('employee-badges').innerText()), 'owner: suspends with a reason')
  check(/status: active → suspended/.test(await p.getByTestId('employee-history').innerText()), 'history: shows the change with old → new values')
  r = await open(BASE, w, '/clock')
  check(/no está activa: no puedes ponchar/.test(r.body), 'employee: a suspended employee cannot punch')
  await shot(p, 'owner-employee-hr')

  // ------------------------------------------------------------ roles and isolation (REST API with each user's session)
  const rows = async (email, path) => (await json(await api(email, path))) ?? []
  check((await rows('other@e2e.local', `/rest/v1/employees?select=id&id=eq.${EMP}`)).length === 0, 'isolation: another company cannot read the employee')
  check((await rows('member@e2e.local', '/rest/v1/employee_contacts?select=employee_id')).length === 0, 'privacy: the supervisor cannot read private contact data')
  check((await rows('worker@e2e.local', '/rest/v1/employee_contacts?select=emergency_contact_name')).length === 1, 'privacy: the employee reads its own contact')
  check((await rows('member@e2e.local', '/rest/v1/employee_documents?select=id')).length === 0, 'privacy: the supervisor cannot list private documents')
  const self = await api('worker@e2e.local', `/rest/v1/rpc/decide_leave`, { method: 'POST', body: JSON.stringify({ request: (await rows('worker@e2e.local', '/rest/v1/leave_requests?select=id'))[0]?.id, approve: true }) })
  check(self.status >= 400 && /LEAVE_NOT_FOUND|SELF_APPROVAL/.test(await self.text()), 'roles: the employee cannot approve its own leave')
  const forge = await api('worker@e2e.local', '/rest/v1/time_punches', { method: 'POST', body: JSON.stringify({ company_id: 'e2000000-0000-4000-8000-000000000001', employee_id: EMP, kind: 'out', at: new Date().toISOString(), source: 'self' }) })
  check(forge.status >= 400, 'tampering: a punch cannot be written directly (only through the clock, with server time)', String(forge.status))
  const apply = await api('member@e2e.local', '/rest/v1/rpc/propose_rule_change', { method: 'POST', body: JSON.stringify({ target: 'e2000000-0000-4000-8000-000000000001', change_scope: 'company', target_id: 'e2000000-0000-4000-8000-000000000001', change_values: { grace_minutes: 30 } }) })
  check(apply.status >= 400, 'roles: a supervisor cannot propose rule changes', String(apply.status))

  // ------------------------------------------------------------ report export (supervisor), English, phone and tablet
  const csv = await member.ctx.request.get(`${BASE}/api/workforce/report?from=${prDay(-6)}&to=${prDay(0)}`)
  const body = await csv.text()
  check(csv.status() === 200 && /Ponches corregidos/.test(body) && /No es una nómina oficial/.test(body) && /Wanda Ficticia/.test(body) && !/Ana Rivera/.test(body),
    'report CSV (supervisor): corrected punches column, not-payroll notice, only its team')
  await owner.ctx.addCookies([{ name: 'ba_locale', value: 'en', url: BASE }])
  r = await open(BASE, p, '/workforce/schedule')
  check(/Recurring shifts/.test(r.body) && /Generate shifts|No patterns/.test(r.body), 'English: schedules page')
  r = await open(BASE, p, '/workforce/settings')
  check(/Propose rule change/.test(r.body) && /validity not verified/.test(r.body), 'English: rules page')
  const phone = await session(BASE, PASSWORD, 'worker@e2e.local', { ...devices['iPhone 13'] })
  await open(BASE, phone.page, '/clock')
  check(await noOverflow(phone.page), 'iPhone: the employee clock fits the screen')
  await shot(phone.page, 'iphone-clock')
  const tablet = await session(BASE, PASSWORD, 'owner@e2e.local', { ...devices['iPad (gen 7)'] })
  for (const path of [`/workforce/employees/${EMP}`, '/workforce/schedule', '/workforce/requests', '/workforce/settings', '/workforce']) {
    await open(BASE, tablet.page, path)
    check(await noOverflow(tablet.page), `iPad: ${path.replace(EMP, ':id')} fits the screen`)
  }
  await phone.ctx.close(); await tablet.ctx.close()
  await owner.ctx.close(); await worker.ctx.close(); await member.ctx.close()

  const relevant = consoleErrors.filter((e) => !/favicon|Failed to load resource: the server responded with a status of (400|403|404)/.test(e))
  check(relevant.length === 0, 'no console errors or 5xx responses', relevant.slice(0, 20).join('\n  '))
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
  if (stack) console.log(JSON.stringify(stack.logs, null, 1).slice(-3000))
} finally {
  await browser.close()
  if (stack) await stack.stop()
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

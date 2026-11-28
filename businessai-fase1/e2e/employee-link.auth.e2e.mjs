#!/usr/bin/env node
/**
 * Employee access link («Vincular y ponchar») on the LOCAL stack, end to end in
 * the browser. Reproduces the report «Al pulsarlo, BusinessAI responde Acceso
 * no válido» and checks the fix (migration 0036 + /clock/link):
 *   1. the manager hires «Juan Del Pueblo Prueba» and creates the link; the
 *      admin page now warns that a new link cancels the pending one;
 *   2. the manager creates it AGAIN (the reported cause): the employee's first
 *      link is detected as replaced BEFORE pressing — no button, clear message;
 *   3. the employee, not signed in, opens the latest link → signs in from it →
 *      comes back to it (token intact) → sees his name and company → presses
 *      «Vincular y ponchar» → his clock; database: right user, employee, company;
 *   4. back button / opening it again: «already linked», no error; pressing
 *      twice at once is not an error either;
 *   5. a previous session of ANOTHER account (the manager) opening the link is
 *      told upfront (masked email) and can switch account without losing it;
 *   6. iPhone layout, English.
 * Fictitious data only; never points at Supabase.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/employee-link.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3420)
const WORKER = { 'worker@e2e.local': 'e1000000-0000-4000-8000-000000000009' }

let passed = 0, failed = 0
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`) } }
const browser = await chromium.launch()
const errors = []
let stack = null

const watch = (page, who, BASE) => {
  page.on('pageerror', (e) => errors.push(`${who} ${page.url().replace(BASE, '')}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} ${page.url().replace(BASE, '')}: ${m.text()}`) })
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${who} HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
}
const signIn = async (page, BASE, PASSWORD, email) => {
  await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
  await page.waitForLoadState('networkidle')
}
const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const state = async (page) => (await page.getByTestId('link-state').count()) ? page.getByTestId('link-state').getAttribute('data-state') : null

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin', extraUsers: WORKER })
  const { BASE, PASSWORD, api } = stack
  const local = (link) => link.replace(/^https?:\/\/[^/]+/, BASE)

  // ------------------------------------------------------------ 1. manager: hire Juan, create the link
  const oc = await browser.newContext(); const o = await oc.newPage(); watch(o, 'owner', BASE)
  await o.goto(`${BASE}/login`); await signIn(o, BASE, PASSWORD, 'owner@e2e.local')
  await o.goto(`${BASE}/workforce/employees`, { waitUntil: 'networkidle' })
  const hire = o.locator('section[aria-labelledby="new-title"]')
  await hire.locator('input[name="first_name"]').fill('Juan'); await hire.locator('input[name="last_name"]').fill('Del Pueblo Prueba')
  await hire.locator('input[name="email"]').fill('Worker@E2E.local')
  await Promise.all([o.waitForURL(/\/workforce\/employees\/[0-9a-f-]{36}\?done=created/, { timeout: 20000 }), hire.getByRole('button', { name: 'Crear empleado' }).click()])
  const EMP = /employees\/([0-9a-f-]{36})/.exec(o.url())[1]
  check(await o.getByTestId('pending-link').count() === 0, 'manager: no pending link before creating one')
  await Promise.all([o.waitForURL(/done=link/, { timeout: 20000 }), o.getByRole('button', { name: 'Crear enlace de acceso' }).click()])
  const first = await o.locator('input[aria-label="Enlace de acceso"]').inputValue()
  check(/\/clock\/link\?token=[0-9a-f]{64}$/.test(first), 'manager: the link reaches the screen complete (64-hex token)', first.slice(-70))
  check(/Hay un enlace pendiente para worker@e2e\.local/.test(await o.getByTestId('pending-link').innerText()), 'manager: the page now says a link is pending and that a new one cancels it')
  // ------------------------------------------------------------ 2. the reported cause: the link is created again
  // same URL after the redirect (?done=link): wait for the shown link to change
  await o.getByRole('button', { name: 'Crear un enlace nuevo (anula el anterior)' }).click()
  await o.waitForFunction((prev) => document.querySelector('input[aria-label="Enlace de acceso"]')?.value !== prev, first, { timeout: 20000 })
  const latest = await o.locator('input[aria-label="Enlace de acceso"]').inputValue()
  check(latest !== first && /token=[0-9a-f]{64}$/.test(latest), 'manager: a second link (explicitly labelled as cancelling the first)')

  // ------------------------------------------------------------ 3. employee, not signed in
  const wc = await browser.newContext({ ...devices['iPhone 13'] }); const w = await wc.newPage(); watch(w, 'employee', BASE)
  await w.goto(local(first), { waitUntil: 'networkidle' })
  check(/Inicia sesión o crea una cuenta/.test(await text(w)), 'employee (no session): asked to sign in')
  await Promise.all([w.waitForURL(/\/login\?next=/), w.getByRole('link', { name: 'Iniciar sesión' }).click()])
  await signIn(w, BASE, PASSWORD, 'worker@e2e.local')
  check(w.url() === local(first), 'after signing in, back on the same link with the token intact')
  check(await state(w) === 'invalid' && await w.getByRole('button', { name: 'Vincular y ponchar' }).count() === 0,
    'the REPLACED link is detected before pressing: no «Vincular y ponchar» (this was the «Acceso no válido»)', await text(w))
  check(/tu empresa creó uno más reciente/.test(await text(w)), 'and the employee is told why and what to do')
  const db0 = await (await api('owner@e2e.local', `/rest/v1/employees?id=eq.${EMP}&select=user_id`)).json()
  check(db0[0]?.user_id === null, 'nothing was consumed or linked by opening it')

  await w.goto(local(latest), { waitUntil: 'networkidle' })
  check(await state(w) === 'ok' && /Vas a vincular la cuenta worker@e2e\.local a la ficha de Juan Del Pueblo Prueba · /.test(await text(w)),
    'the latest link is checked first: ok, with the employee name and company', await text(w))
  check(await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'iPhone: the link page fits the screen')
  // two taps: the second press must not turn into «Acceso no válido»
  const btn = w.getByRole('button', { name: 'Vincular y ponchar' })
  await Promise.all([w.waitForURL(/\/clock\?done=linked/, { timeout: 20000 }), btn.dblclick()])
  await w.waitForLoadState('networkidle')
  check(/Juan Del Pueblo Prueba/.test(await text(w)) && /Tu cuenta quedó vinculada/.test(await text(w)), 'pressing «Vincular y ponchar» opens his clock (linked)', await text(w))
  const emp = (await (await api('owner@e2e.local', `/rest/v1/employees?id=eq.${EMP}&select=user_id,company_id,first_name,last_name`)).json())[0]
  check(emp?.user_id === WORKER['worker@e2e.local'] && emp?.company_id === 'e2000000-0000-4000-8000-000000000001',
    'database: the employee has the right user and stays in its company', JSON.stringify(emp))
  const mine = await (await api('worker@e2e.local', '/rest/v1/employees?select=id')).json()
  check(Array.isArray(mine) && mine.length === 1 && mine[0].id === EMP, 'the account reads exactly that employee (and no other)', JSON.stringify(mine))
  const r = await submitPunch(w)
  check(/done=punch_in/.test(r), '… and can punch in')

  // ------------------------------------------------------------ 4. back / open again
  await w.goto(local(latest), { waitUntil: 'networkidle' })
  check(await state(w) === 'linked' && !/no es válido/.test(await text(w)), 'opening the used link again: «ya está vinculada», no «Acceso no válido»', await text(w))
  await Promise.all([w.waitForURL(/\/clock$/), w.getByRole('link', { name: 'Ir a mi reloj ponchador' }).click()])
  check(/Juan Del Pueblo Prueba/.test(await text(w)), '«Ir a mi reloj ponchador» opens the clock')

  // ------------------------------------------------------------ 5. a previous session of another account
  await o.goto(`${BASE}/workforce/employees/${EMP}`, { waitUntil: 'networkidle' })
  await Promise.all([o.waitForURL(/done=unlinked/, { timeout: 20000 }), o.getByRole('button', { name: 'Retirar acceso' }).click()])
  await Promise.all([o.waitForURL(/done=link/, { timeout: 20000 }), o.getByRole('button', { name: 'Crear enlace de acceso' }).click()])
  const third = await o.locator('input[aria-label="Enlace de acceso"]').inputValue()
  await o.goto(local(third), { waitUntil: 'networkidle' })
  check(await state(o) === 'email_mismatch' && /Este enlace es para w•••@e2e\.local \(Juan Del Pueblo Prueba · .+\)\. Iniciaste sesión como owner@e2e\.local/.test(await text(o)),
    'the manager\'s own session opening the link: told upfront (masked email), no button', await text(o))
  check(await o.getByRole('button', { name: 'Vincular y ponchar' }).count() === 0, '… so the link cannot be pressed with the wrong account')
  await Promise.all([o.waitForURL(/\/login\?next=%2Fclock%2Flink%3Ftoken%3D[0-9a-f]{64}$/, { timeout: 20000 }), o.getByRole('button', { name: 'Salir y entrar con otra cuenta' }).click()])
  check(true, '«Salir y entrar con otra cuenta» signs out and keeps the link for the next sign-in')
  await signIn(o, BASE, PASSWORD, 'worker@e2e.local')
  check(await state(o) === 'ok', 'signed in with the right account: back on the link, ready to link')
  await Promise.all([o.waitForURL(/\/clock\?done=linked/, { timeout: 20000 }), o.getByRole('button', { name: 'Vincular y ponchar' }).click()])
  check(/Juan Del Pueblo Prueba/.test(await text(o)), 'and links')

  // ------------------------------------------------------------ 6. English
  await w.goto(`${local(third)}&lang=en`, { waitUntil: 'networkidle' })
  check(/already linked to Juan Del Pueblo Prueba/.test(await text(w)) && await w.getByRole('link', { name: 'Go to my time clock' }).count() === 1, 'English: «already linked»', await text(w))

  check(errors.length === 0, 'no console error, page error or 5xx', errors.join(' | '))
  await oc.close(); await wc.close()
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e}`)
  if (stack) console.log(JSON.stringify(stack.logs, null, 1).slice(-3000))
} finally {
  await browser.close()
  if (stack) await stack.stop()
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

async function submitPunch(page) {
  await Promise.all([page.waitForURL((u) => /[?&](done|error)=/.test(u.search) && !/done=linked/.test(u.search), { timeout: 20000 }), page.getByRole('button', { name: 'Entrada', exact: true }).click()])
  return page.url()
}

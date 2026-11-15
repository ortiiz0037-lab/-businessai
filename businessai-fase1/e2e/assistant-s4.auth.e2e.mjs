#!/usr/bin/env node
/**
 * BusinessAI Assistant S4 in the browser, LOCAL stack only: the real code path
 * (official SDK with streaming, router, tool loop, permissions, RLS, server
 * signatures, verified figures, confirmations) against the local Messages-API
 * TEST DOUBLE (e2e/local-stack/llm-double.mjs, scripted decisions; no external
 * service, no cost). It covers what S4 adds:
 *   - recommendations computed by rules over real records, explained with
 *     verified figures; receivables ageing; catalog; branches;
 *   - Studio drafts about Finance (collection letter, payment voucher) that
 *     exist only after the user confirms, created by the same function as the
 *     screens, with no new payment or ledger entry;
 *   - permissions (a member is not offered the payables tools and a forced call
 *     is refused), adaptive thinking requested, English, iPhone.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/assistant-s4.auth.e2e.mjs
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'
import { startLlmDouble } from './local-stack/llm-double.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3500)
const TEST_KEY = `local-test-double-${randomBytes(6).toString('hex')}`
const SERVER_SECRET = randomBytes(32).toString('base64')
const CO = 'e2000000-0000-4000-8000-000000000001'
const INV = 'e4000000-0000-4000-8000-000000000001'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null, double = null

try {
  double = await startLlmDouble({ port: PORT + 3, apiKey: TEST_KEY })
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin',
    nextEnv: { ANTHROPIC_API_KEY: TEST_KEY, ANTHROPIC_BASE_URL: double.url, ASSISTANT_SERVER_KEYS: `ke2e:${SERVER_SECRET}` } })
  const { BASE, PASSWORD, api, admin, count } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rpc = (email, fn, args) => api(email, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }
  const money = async () => (await Promise.all(['payments', 'bill_payments', 'journal_entries', 'bills'].map((t) => count(t)))).join('/')

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts })
    if (locale) await ctx.addCookies([{ name: 'ba_locale', value: locale, url: BASE }])
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
    page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
    await page.goto(`${BASE}/login`)
    await page.fill('input[name="email"]', email); await page.fill('input[name="password"]', PASSWORD)
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('form button[type="submit"]')])
    return { ctx, page }
  }
  async function open(page, path) { const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); last = page.url().replace(BASE, ''); return { status: r?.status() ?? 0, body: await page.locator('body').innerText() } }
  async function openWidget(page) { await page.getByTestId('assistant-fab').click(); await page.getByTestId('assistant-panel').waitFor(); await page.getByTestId('assistant-chat').waitFor({ timeout: 15000 }) }
  async function ask(page, question) {
    const before = await page.getByTestId('assistant-answer').count()
    const input = page.locator('textarea[id^="assistant-input"]').first()
    await input.fill(question); await input.press('Enter')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="assistant-answer"]').length > n && !document.querySelector('[data-testid="assistant-live"]'), before, { timeout: 40000 }).catch(() => {})
    return (await page.getByTestId('assistant-answer').allInnerTexts()).at(-1) ?? ''
  }
  const lastVerification = async (page) => (await page.getByTestId('assistant-answer').last().getAttribute('data-verification')) ?? ''
  async function confirmLast(page) {
    const card = page.getByTestId('assistant-action').last()
    await card.getByRole('button', { name: /^(Confirmar|Confirm)$/ }).click()
    await page.waitForFunction(() => ['executed', 'failed'].includes([...document.querySelectorAll('[data-testid="assistant-action"]')].at(-1)?.getAttribute('data-status') ?? ''), null, { timeout: 25000 }).catch(() => {})
    return { status: await card.getAttribute('data-status'), link: await card.locator('a[href^="/studio/"]').getAttribute('href').catch(() => null) }
  }

  // setup: register the server key (the database owner's step) and relax the per-minute limit for this scripted session
  check((await admin('/rpc/assistant_set_server_key', { method: 'POST', body: JSON.stringify({ key: 'ke2e', secret_b64: SERVER_SECRET }) })).status < 300, 'setup: the server key is registered in the database')
  await admin('/assistant_limits?plan=eq.pro', { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ per_minute: 60 }) })
  // catalog and branch data the assistant will read (created through the module functions)
  const item = await json(await rpc('owner@e2e.local', 'catalog_save', { target: CO, item: null, p_code: 'MAT-900', p_name: 'Cemento gris', p_description: null, p_kind: 'product', p_unit: 'saco', p_price_cents: 1250, p_tax_rate: null, p_track_inventory: true, expected_version: null }))
  check(Array.isArray(item) && item[0]?.id, 'setup: a catalog item exists', JSON.stringify(item))
  const br = await rpc('owner@e2e.local', 'crm_save_branch', { target: CO, branch: null, p_name: 'Sucursal Norte', p_code: 'NOR', p_address: null })
  check(br.status < 300, 'setup: a branch exists', String(br.status))

  const owner = await session('owner@e2e.local')
  const o = owner.page
  await open(o, '/dashboard'); await openWidget(o)

  // ------------------------------------------------------------ recommendations with reasons and verified figures
  const ageing = await json(await rpc('owner@e2e.local', 'ar_aging', { target: CO, as_of: null }))
  const overdueClients = (ageing ?? []).filter((r) => Number(r.overdue_cents) > 0).length
  let answer = await ask(o, '¿Qué debo priorizar hoy? Recomiéndame')
  const req = double.log.at(-2)?.body
  check(req?.thinking?.type === 'adaptive', 'the provider request asks for adaptive thinking', JSON.stringify(req?.thinking))
  check(req?.tools?.some((t) => t.name === 'get_recommendations') && double.log.at(-1)?.body?.messages?.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')),
    'the model is offered get_recommendations and receives its result')
  check(overdueClients > 0 && /facturas vencidas sin cobrar/.test(answer) && /→/.test(answer) && await lastVerification(o) === 'verified',
    'recommendations: each one says WHY (the rule that fired) and the next step; figures verified', answer.slice(0, 300))
  answer = await ask(o, 'Antigüedad de saldos por cobrar')
  const totalOpen = (ageing ?? []).reduce((n, r) => n + BigInt(r.total_cents), 0n)
  const fmt = (c) => `${(c / 100n).toLocaleString('en-US')}.${(c % 100n).toString().padStart(2, '0')}`
  check(answer.includes(fmt(totalOpen)) && await lastVerification(o) === 'verified', 'ageing: the open total equals the database ageing (ar_aging)', `${fmt(totalOpen)} | ${answer.slice(0, 200)}`)
  answer = await ask(o, 'Busca en el catálogo cemento')
  check(/MAT-900/.test(answer) && /Cemento gris/.test(answer) && /12\.50/.test(answer), 'catalog: the item and its price come from the catalog', answer.slice(0, 200))
  answer = await ask(o, '¿Cuáles son mis sucursales?')
  check(/Sucursal Norte/.test(answer), 'branches: read from the company branches', answer.slice(0, 200))

  // ------------------------------------------------------------ collection letter: proposed, then confirmed
  const before = await money()
  const studioBefore = await count('studio_documents')
  answer = await ask(o, `Prepara una carta de cobro de la factura ${INV}`)
  check(/pendiente de su confirmación/.test(answer) && await o.getByTestId('assistant-action').last().getAttribute('data-status') === 'proposed' && await count('studio_documents') === studioBefore,
    'collection letter: PROPOSED; nothing exists before the user confirms')
  let c = await confirmLast(o)
  const letter = (await db(`studio_documents?id=eq.${c.link?.split('/')[2]}&select=kind,status,origin,source_document_id,client_id`))[0]
  check(c.status === 'executed' && letter?.kind === 'collection_letter' && letter.status === 'draft' && letter.origin === 'assistant' && letter.source_document_id === INV,
    'after Confirm: one collection letter DRAFT about that invoice, created by the assistant', JSON.stringify(letter))
  await open(o, c.link)
  const pv = (await o.locator('svg[role="img"] text').allTextContents()).join(' ')
  check(/1[.,]000[.,]00/.test(pv), 'the letter reads the balance from Receivables (not written by the model)', pv.slice(0, 160))

  // ------------------------------------------------------------ payment voucher about a recorded payment
  const BILL = (await db(`bills?company_id=eq.${CO}&vendor_invoice_number=eq.P-100&select=id`))[0]?.id
  await open(o, `/payables/${BILL}`)
  const payForm = o.locator('form').filter({ has: o.locator('input[name="paid_on"]') })
  await payForm.locator('input[name="amount"]').fill('100.00')
  await Promise.all([o.waitForURL(/done=paid/, { timeout: 20000 }).catch(() => {}), payForm.getByRole('button', { name: 'Registrar pago' }).click()])
  const paid = await money()
  await openWidget(o)
  answer = await ask(o, `Prepara el comprobante del gasto ${BILL}`)
  check(/pendiente de su confirmación/.test(answer), 'payment voucher: proposed for the recorded payment', answer.slice(0, 200))
  c = await confirmLast(o)
  const voucher = (await db(`studio_documents?id=eq.${c.link?.split('/')[2]}&select=kind,status,bill_id,bill_payment_id`))[0]
  check(c.status === 'executed' && voucher?.kind === 'payment_voucher' && voucher.bill_id === BILL && !!voucher.bill_payment_id && voucher.status === 'draft', 'after Confirm: a voucher DRAFT linked to the expense and its payment', JSON.stringify(voucher))
  check(await money() === paid && paid.split('/')[0] === before.split('/')[0], 'the assistant created no payment, ledger entry or expense (only the user\'s own payment on the expense screen)', `${before} → ${paid} → ${await money()}`)

  // ------------------------------------------------------------ permissions: a member
  const mem = await session('member@e2e.local')
  await open(mem.page, '/dashboard'); await openWidget(mem.page)
  const actionsBefore = await count('assistant_actions')
  answer = await ask(mem.page, `Prepara el comprobante del gasto ${BILL}`)
  const mreq = double.log.at(-2)?.body
  const offered = (mreq?.tools ?? []).map((t) => t.name)
  check(!offered.includes('propose_payment_voucher') && !offered.includes('list_bills'), 'a member (no payables.view) is not offered the payables tools', offered.join(','))
  const memRec = await ask(mem.page, '¿Qué debo priorizar? Recomiéndame')
  check(!/facturas vencidas sin cobrar|gastos aprobados/.test(memRec), 'a member\'s recommendations never include the areas it cannot see (receivables, payables)', memRec.slice(0, 200))
  check(/No tiene acceso/.test(answer) && await count('assistant_actions') === actionsBefore, 'a forced call is refused by the server and nothing is proposed', answer.slice(0, 160))
  await mem.ctx.close()

  // ------------------------------------------------------------ English and iPhone
  const en = await session('owner@e2e.local', {}, 'en')
  await open(en.page, '/dashboard'); await openWidget(en.page)
  answer = await ask(en.page, 'What should I prioritise? Recommend')
  check(/unpaid overdue invoices/.test(answer) && /Answer in English/.test(JSON.stringify(double.log.at(-2)?.body?.system)), 'English: recommendations explained in English', answer.slice(0, 200))
  await en.ctx.close()
  const phone = await session('owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of ['/assistant', '/dashboard']) {
    await open(phone.page, path)
    check(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `iPhone 13: ${path} has no horizontal page scroll`)
  }
  await phone.ctx.close(); await owner.ctx.close()
} catch (e) {
  failed++
  console.log(`FAIL: unexpected error — ${e?.stack ?? e} [at ${last}]`)
} finally {
  await browser.close()
  if (stack) {
    const serverErrors = stack.logs.next.split('\n').filter((l) => /Error|⨯/.test(l) && !/NEXT_REDIRECT|NEXT_NOT_FOUND/.test(l))
    check(serverErrors.length === 0, 'no server errors in the Next.js log', serverErrors.slice(0, 5).join(' | '))
    check(!/unhandled/.test(stack.logs.stub), 'the app used only endpoints the local stub implements', stack.logs.stub.match(/unhandled[^\n]*/g)?.slice(0, 3).join(' | ') ?? '')
    await stack.stop()
  }
  if (double) await double.close()
  check(consoleErrors.length === 0, 'no browser console errors or 5xx responses', consoleErrors.slice(0, 5).join(' | '))
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

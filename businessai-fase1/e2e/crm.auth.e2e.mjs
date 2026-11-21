#!/usr/bin/env node
/**
 * Authenticated browser test of the CRM (0035) on the LOCAL stack, with
 * fictitious data only: CRM client fields and duplicate warning, contacts,
 * tags, opportunities (exact cents, weighted value), pipeline moves (lost
 * needs a reason, won → customer), activities and overdue follow-ups, quote
 * accepted → DRAFT invoice (no ledger entry until sent, one invoice per
 * quote), receivables read on the client profile, roles, isolation, direct
 * writes refused, branches, English, phone and tablet. Nothing is sent.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/crm.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3360)
const CO = 'e2000000-0000-4000-8000-000000000001'
const OTHER_CLIENT = 'e3000000-0000-4000-8000-000000000002'
const WORKER_ID = 'e1000000-0000-4000-8000-000000000009'

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
async function submit(page, button, re = /[?&](done|error|success|dup|converted)=/) {
  const before = page.url()
  await Promise.all([page.waitForURL((u) => u.href !== before && re.test(u.href), { timeout: 30000 }), button.click()])
  await page.waitForLoadState('networkidle')
  last = page.url()
  return { url: page.url(), body: await page.locator('body').innerText() }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const pr = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin',
    extraUsers: { 'worker@e2e.local': WORKER_ID } })
  const { BASE, PASSWORD, api } = stack
  const json = async (r) => { try { return await r.json() } catch { return null } }
  const rows = async (email, path) => (await json(await api(email, path))) ?? []

  const owner = await session(BASE, PASSWORD, 'owner@e2e.local')
  const p = owner.page
  // ------------------------------------------------------------ settings: a tag
  let r = await open(BASE, p, '/crm/settings')
  check(r.status === 200 && await p.getByTestId('stage-settings').count() === 1 && /Nuevo prospecto/.test(r.body) && /Negociación/.test(r.body), 'owner: CRM settings with the default pipeline (created on first use)')
  const tagForm = p.getByTestId('tag-settings').locator('form').last()
  await tagForm.locator('input[name="name"]').fill('VIP'); await tagForm.locator('select[name="color"]').selectOption('amber')
  r = await submit(p, tagForm.getByRole('button', { name: 'Crear etiqueta' }))
  check(/done=tag_saved/.test(r.url) && /VIP/.test(await p.getByTestId('tag-settings').innerText()), 'owner creates a tag')

  // ------------------------------------------------------------ clients: CRM fields and duplicates
  r = await open(BASE, p, '/clients')
  const cf = p.locator('#nuevo-cliente form')
  await cf.locator('input[name="name"]').fill('Marta Colón'); await cf.locator('input[name="business_name"]').fill('Colón Consultores')
  await cf.locator('input[name="email"]').fill('marta@colon.test'); await cf.locator('input[name="phone"]').fill('787-555-0199')
  await cf.locator('select[name="kind"]').selectOption('company'); await cf.locator('select[name="lifecycle"]').selectOption('lead')
  await cf.locator('input[name="legal_name"]').fill('Colón Consultores LLC'); await cf.locator('input[name="tax_id"]').fill('66-7654321'); await cf.locator('input[name="source"]').fill('Referido')
  r = await submit(p, cf.getByRole('button', { name: 'Guardar cliente' }))
  check(/success=created/.test(r.url), 'owner creates a company client (lead) with legal name, tax ID and source')
  const marta = (await rows('owner@e2e.local', '/rest/v1/clients?select=id,kind,lifecycle,legal_name,tax_id&name=eq.Marta%20Col%C3%B3n'))[0]
  check(marta?.kind === 'company' && marta?.lifecycle === 'lead' && marta?.tax_id === '66-7654321', 'CRM fields stored', JSON.stringify(marta))
  await open(BASE, p, '/clients')
  await cf.locator('input[name="name"]').fill('M. Colón'); await cf.locator('input[name="email"]').fill('MARTA@colon.test ')
  r = await submit(p, cf.getByRole('button', { name: 'Guardar cliente' }))
  check(/dup=/.test(r.url) && await p.getByTestId('duplicates').count() === 1 && /Marta Colón/.test(await p.getByTestId('duplicates').innerText()), 'a possible duplicate (same email) is shown before saving')
  check(await cf.locator('input[name="name"]').inputValue() === 'M. Colón' && await cf.getByRole('button', { name: 'Crear de todos modos' }).count() === 1, 'the form keeps what was typed and asks for confirmation')
  check((await rows('owner@e2e.local', '/rest/v1/clients?select=id&name=eq.M.%20Col%C3%B3n')).length === 0, 'nothing was created without confirmation')

  // ------------------------------------------------------------ client profile: contact, tags, history
  r = await open(BASE, p, `/clients/${marta.id}`)
  check(await p.getByTestId('client-crm').count() === 1 && /Colón Consultores LLC/.test(r.body) && /Prospecto nuevo/.test(r.body), 'client profile: commercial profile (type, stage, legal name)')
  const ct = p.getByTestId('client-contacts').locator('form').last()
  await ct.locator('input[name="first_name"]').fill('Luis'); await ct.locator('input[name="last_name"]').fill('Colón'); await ct.locator('input[name="title"]').fill('Gerente')
  await ct.locator('input[name="email"]').fill('luis@colon.test'); await ct.locator('input[name="is_primary"]').check()
  r = await submit(p, ct.getByRole('button', { name: 'Agregar contacto' }))
  check(/done=contact_saved/.test(r.url) && /Luis Colón/.test(await p.getByTestId('client-contacts').innerText()) && /Principal/.test(await p.getByTestId('client-contacts').innerText()), 'a primary contact of the company')
  await p.getByTestId('client-tags').getByLabel('VIP').check()
  r = await submit(p, p.getByTestId('client-tags').getByRole('button', { name: 'Guardar etiquetas' }))
  check(/done=tags_saved/.test(r.url), 'tag the client')
  r = await open(BASE, p, '/clients?lifecycle=lead')
  check(/Marta Colón/.test(r.body) && /VIP/.test(r.body) && !/Cliente Uno/.test(r.body), 'client list filtered by stage, with tags')

  // ------------------------------------------------------------ opportunity, exact cents, pipeline
  r = await open(BASE, p, `/crm/opportunities?client=${marta.id}`)
  const of = p.getByTestId('new-opportunity').locator('form')
  await of.locator('input[name="name"]').fill('Consultoría 2027'); await of.locator('input[name="amount"]').fill('12,500.55')
  await of.locator('input[name="source"]').fill('Referido')
  r = await submit(p, of.getByRole('button', { name: 'Crear oportunidad' }))
  const OPP = /opportunities\/([0-9a-f-]{36})/.exec(p.url())?.[1]
  const sum = await p.getByTestId('opp-summary').innerText()
  // 1 250 055 cents × 10 % = 125 005.5 → $1,250.06 (rounded once)
  check(/done=created/.test(r.url) && /\$12,500\.55/.test(sum) && /10 %/.test(sum) && /\$1,250\.06/.test(sum), 'opportunity: value in cents, stage probability 10 %, weighted $1,250.06', sum)
  check((await rows('owner@e2e.local', `/rest/v1/clients?select=lifecycle&id=eq.${marta.id}`))[0]?.lifecycle === 'prospect', 'the lead became a prospect with its first opportunity')
  r = await open(BASE, p, '/crm/pipeline')
  const card = p.getByTestId('pipeline-board').locator('[data-stage="new"]').getByTestId('opp-card').filter({ hasText: 'Consultoría 2027' })
  check(await card.count() === 1, 'the pipeline board shows it in “Nuevo prospecto”')
  await card.locator('select[name="stage_id"]').selectOption({ label: 'Propuesta enviada' })
  r = await submit(p, card.getByRole('button', { name: 'Mover' }))
  check(/done=moved/.test(r.url) && await p.getByTestId('pipeline-board').locator('[data-stage="proposal"]').getByTestId('opp-card').filter({ hasText: 'Consultoría 2027' }).count() === 1
    && /\$7,500\.33/.test(await p.getByTestId('pipeline-board').locator('[data-stage="proposal"]').innerText()), 'moved to “Propuesta enviada”: 60 %, weighted $7,500.33')
  r = await open(BASE, p, '/crm')
  check(/\$12,500\.55/.test(await p.getByTestId('crm-kpis').innerText()) && /\$7,500\.33/.test(await p.getByTestId('crm-kpis').innerText()), 'dashboard: open pipeline and weighted value from the real opportunity')

  // ------------------------------------------------------------ activities and overdue follow-ups
  await open(BASE, p, `/crm/opportunities/${OPP}`)
  let af = p.getByTestId('activity-form')
  await af.locator('select[name="kind"]').selectOption('task'); await af.locator('input[name="subject"]').fill('Llamar para revisar la propuesta')
  await af.locator('input[name="due_at"]').fill(`${pr(-1)}T10:00`)
  r = await submit(p, af.getByRole('button', { name: 'Registrar actividad' }))
  check(/done=activity_created/.test(r.url) && /Atrasada/.test(await p.getByTestId('activity-list').innerText()), 'a task due yesterday shows as overdue')
  await open(BASE, p, `/crm/opportunities/${OPP}`)
  af = p.getByTestId('activity-form')
  await af.locator('select[name="kind"]').selectOption('email'); await af.locator('select[name="direction"]').selectOption('outbound')
  await af.locator('input[name="subject"]').fill('Propuesta enviada por correo')
  r = await submit(p, af.getByRole('button', { name: 'Registrar actividad' }))
  check(/BusinessAI no envía emails/.test(await p.getByTestId('activity-list').innerText()), 'a logged email says clearly that nothing was sent')
  r = await open(BASE, p, '/crm')
  check(/1/.test(await p.getByTestId('crm-kpis').locator('text=Seguimientos atrasados').locator('..').locator('..').innerText()) && /Llamar para revisar/.test(await p.getByTestId('crm-followups').innerText()),
    'dashboard: overdue follow-up listed')
  r = await open(BASE, p, '/crm/activities?view=overdue')
  const task = p.getByTestId('agenda').locator('li', { hasText: 'Llamar para revisar la propuesta' })
  await task.locator('input[name="outcome"]').fill('Cliente pidió una semana')
  r = await submit(p, task.getByRole('button', { name: 'Completar' }))
  check(/done=activity_completed/.test(r.url) && !/Llamar para revisar/.test(await p.getByTestId('agenda').innerText()), 'completed from the agenda: no longer overdue')

  // ------------------------------------------------------------ quote → draft invoice (existing documents flow)
  const ins = await api('owner@e2e.local', '/rest/v1/documents', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ company_id: CO, client_id: marta.id, document_type: 'quote',
    document_number: 'x', title: 'Consultoría 2027', subtotal: 1000, tax: 115, total: 1115, items: [{ description: 'Consultoría', quantity: 1, price: 1000 }], language: 'es' }) })
  const QUOTE = (await json(ins))?.[0]?.id
  check(ins.status < 300 && !!QUOTE, 'setup: a quote for the client (fictitious amounts)', String(ins.status))
  await open(BASE, p, `/documents/${QUOTE}`)
  await submit(p, p.getByRole('button', { name: 'Marcar cotización como enviada' }))
  r = await submit(p, p.getByRole('button', { name: 'Cliente la aceptó' }))
  check(/done=accepted/.test(r.url) && await p.getByTestId('convert-quote').count() === 1, 'an accepted quote offers “Convertir en factura” (existing lifecycle)')
  await open(BASE, p, `/crm/opportunities/${OPP}`)
  const link = p.getByTestId('opp-documents').locator('form:has(select[name="document_id"])')
  await link.locator('select[name="document_id"]').selectOption(QUOTE)
  r = await submit(p, link.getByRole('button', { name: 'Asociar' }))
  check(/done=linked/.test(r.url) && /Consultoría 2027/.test(await p.getByTestId('opp-documents').innerText()), 'link the quote to the opportunity')
  const journal0 = (await rows('owner@e2e.local', '/rest/v1/journal_entries?select=id')).length
  r = await submit(p, p.getByTestId('opp-documents').getByTestId('convert-quote').getByRole('button', { name: 'Convertir en factura' }))
  const INV = /documents\/([0-9a-f-]{36})\?converted=1/.exec(p.url())?.[1]
  await p.getByTestId('invoice-from-quote').waitFor({ timeout: 15000 }).catch(() => {})
  r = { url: p.url(), body: await p.locator('body').innerText() }
  check(!!INV && /BORRADOR/.test(r.body) && /FAC-/.test(r.body) && await p.getByTestId('invoice-from-quote').count() === 1, 'converted: a numbered DRAFT invoice that points to its quote',
    `${INV} ${/BORRADOR/.test(r.body)} ${/FAC-/.test(r.body)} ${await p.getByTestId('invoice-from-quote').count()}`)
  const inv = (await rows('owner@e2e.local', `/rest/v1/documents?select=status,total,tax,client_id,items&id=eq.${INV}`))[0]
  check(inv?.status === 'draft' && Number(inv.total) === 1115 && Number(inv.tax) === 115 && inv.client_id === marta.id && inv.items?.length === 1, 'same client, lines and totals', JSON.stringify(inv))
  check((await rows('owner@e2e.local', '/rest/v1/journal_entries?select=id')).length === journal0, 'no ledger entry until the invoice is sent')
  r = await open(BASE, p, `/documents/${QUOTE}`)
  check(await p.getByTestId('convert-quote').count() === 0 && await p.getByTestId('quote-invoices').count() === 1, 'the quote cannot be converted twice while its invoice lives')
  const again = await api('owner@e2e.local', '/rest/v1/rpc/crm_convert_quote', { method: 'POST', body: JSON.stringify({ quote: QUOTE, opp: null, due: pr(30), idem: crypto.randomUUID() }) })
  check(again.status >= 400 && /CRM_QUOTE_ALREADY_CONVERTED/.test(await again.text()), 'a second conversion request is refused by the database')
  await open(BASE, p, `/documents/${INV}`)
  r = await submit(p, p.getByRole('button', { name: 'Marcar como enviada' }))
  check((await rows('owner@e2e.local', '/rest/v1/journal_entries?select=id')).length === journal0 + 1, 'sending it (existing flow) posts exactly one entry')
  r = await open(BASE, p, `/clients/${marta.id}`)
  const recv = await p.getByTestId('client-receivables').innerText()
  check(/\$1,115\.00/.test(recv) && /FAC-/.test(recv), 'client profile: receivables read from Finance (open invoice and balance)', recv.slice(0, 300))
  check(/Consultoría 2027/.test(await p.getByTestId('client-opportunities').innerText()) && /→ factura/.test(await p.getByTestId('client-quotes').innerText()), 'client profile: opportunities and quote history with its invoice')

  // ------------------------------------------------------------ won / lost
  await open(BASE, p, `/crm/opportunities/${OPP}`)
  const mv = p.getByTestId('move-form')
  await mv.locator('select[name="stage_id"]').selectOption({ label: 'Perdido · 0 %' })
  r = await submit(p, mv.getByRole('button', { name: 'Mover' }))
  check(/error=crm_lost_reason_required/.test(r.url) && /motivo de la pérdida/i.test(r.body), 'losing without a reason is refused with a clear message')
  await p.getByTestId('move-form').locator('select[name="stage_id"]').selectOption({ label: 'Ganado · 100 %' })
  r = await submit(p, p.getByTestId('move-form').getByRole('button', { name: 'Mover' }))
  check(/done=moved/.test(r.url) && /Ganada/.test(await p.getByTestId('opp-summary').innerText()), 'won')
  check((await rows('owner@e2e.local', `/rest/v1/clients?select=lifecycle&id=eq.${marta.id}`))[0]?.lifecycle === 'customer', 'won → the prospect is now a customer')
  r = await open(BASE, p, `/crm/opportunities/${OPP}`)
  check(/Cambio de etapa/.test(await p.getByTestId('crm-history').innerText()) && /Cotización convertida/.test(await p.getByTestId('crm-history').innerText()), 'opportunity history (stage changes, conversion)')

  // ------------------------------------------------------------ roles and isolation
  const member = await session(BASE, PASSWORD, 'member@e2e.local')
  r = await open(BASE, member.page, '/crm')
  check(r.status === 200 && !/\$12,500\.55/.test(await member.page.getByTestId('crm-kpis').innerText()), 'a member\'s dashboard does not include the owner\'s opportunity')
  r = await open(BASE, member.page, `/crm/opportunities/${OPP}`)
  check(/could not be found/.test(r.body) && !/Consultoría 2027/.test(r.body), 'a member cannot open another person\'s opportunity (not found)')
  r = await open(BASE, member.page, `/clients/${marta.id}`)
  check(/visibles para propietario y administradores/.test(await member.page.getByTestId('client-receivables').innerText()) && !/\$1,115\.00/.test(await member.page.getByTestId('client-receivables').innerText()),
    'members see no balances on the profile (receivables permission)')
  const mf = member.page.getByTestId('client-crm').getByTestId('activity-form')
  await mf.locator('select[name="kind"]').selectOption('note'); await mf.locator('input[name="subject"]').fill('Prefiere reuniones los martes')
  r = await submit(member.page, mf.getByRole('button', { name: 'Registrar actividad' }))
  check(/done=activity_created/.test(r.url), 'a member logs a note on the client')
  r = await open(BASE, member.page, '/crm/settings')
  check(await member.page.getByTestId('crm-denied').count() === 1, 'members cannot open the CRM settings')
  const other = await session(BASE, PASSWORD, 'other@e2e.local')
  r = await open(BASE, other.page, `/crm/opportunities/${OPP}`)
  check(/could not be found/.test(r.body) && !/Consultoría 2027/.test(r.body) && (await rows('other@e2e.local', '/rest/v1/crm_opportunities?select=id')).length === 0 && (await rows('other@e2e.local', `/rest/v1/crm_contacts?select=id`)).length === 0,
    'another company: nothing visible (page not found, API empty)')
  const forged = await api('other@e2e.local', '/rest/v1/rpc/crm_save_opportunity', { method: 'POST', body: JSON.stringify({ target: CO, opp: null, client: marta.id, contact: null, p_name: 'x', p_description: null,
    p_amount_cents: 1, p_probability_bp: null, p_expected_close: null, owner: null, p_source: null, branch: null, stage: null, expected_version: null, idem: crypto.randomUUID() }) })
  const cross = await api('owner@e2e.local', '/rest/v1/rpc/crm_save_contact', { method: 'POST', body: JSON.stringify({ target: CO, contact: null, client: OTHER_CLIENT, p_first: 'X', p_last: null, p_title: null,
    p_email: null, p_phone: null, p_primary: false, p_notes: null }) })
  const direct = await api('owner@e2e.local', '/rest/v1/crm_opportunities', { method: 'POST', body: JSON.stringify({ company_id: CO, client_id: marta.id, name: 'x', probability_bp: 0, stage_id: OPP }) })
  check(forged.status >= 400 && cross.status >= 400 && direct.status >= 400, 'no writes into another company, no foreign client, no direct table writes', `${forged.status} ${cross.status} ${direct.status}`)
  const worker = await session(BASE, PASSWORD, 'worker@e2e.local')
  r = await open(BASE, worker.page, '/crm')
  check(!/Pipeline abierto/.test(r.body) && (await rows('worker@e2e.local', '/rest/v1/crm_activities?select=id')).length === 0, 'an employee without membership sees no CRM')
  await worker.ctx.close(); await other.ctx.close()

  // ------------------------------------------------------------ branches and scoping
  await open(BASE, p, '/crm/settings')
  const bf = p.getByTestId('branch-settings').locator('form').last()
  await bf.locator('input[name="code"]').fill('PON'); await bf.locator('input[name="name"]').fill('Ponce')
  r = await submit(p, bf.getByRole('button', { name: 'Crear sucursal' }))
  check(/done=branch_saved/.test(r.url) && /PON · Ponce/.test(await p.getByTestId('branch-settings').innerText()), 'owner creates a branch (plan limit applies)')

  // ------------------------------------------------------------ English, phone, tablet
  await owner.ctx.addCookies([{ name: 'ba_locale', value: 'en', url: BASE }])
  r = await open(BASE, p, '/crm/pipeline')
  check(/Sales pipeline/.test(r.body) && /Proposal sent|Won/.test(r.body), 'English: the pipeline')
  r = await open(BASE, p, `/clients/${marta.id}`)
  check(/Commercial profile/.test(r.body) && /Receivables/.test(r.body), 'English: the client profile')
  await owner.ctx.addCookies([{ name: 'ba_locale', value: 'es', url: BASE }])
  const phone = await session(BASE, PASSWORD, 'owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of ['/crm', '/crm/pipeline', '/crm/opportunities', `/crm/opportunities/${OPP}`, '/crm/activities', `/clients/${marta.id}`, '/clients']) {
    await open(BASE, phone.page, path); check(await noOverflow(phone.page), `iPhone: ${path.replace(OPP, ':id').replace(marta.id, ':client')} fits the screen`)
  }
  const tablet = await session(BASE, PASSWORD, 'owner@e2e.local', { ...devices['iPad (gen 7)'] })
  for (const path of ['/crm/settings', '/crm/pipeline', `/clients/${marta.id}/edit`]) { await open(BASE, tablet.page, path); check(await noOverflow(tablet.page), `iPad: ${path.replace(marta.id, ':client')} fits the screen`) }
  await phone.ctx.close(); await tablet.ctx.close(); await member.ctx.close(); await owner.ctx.close()

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

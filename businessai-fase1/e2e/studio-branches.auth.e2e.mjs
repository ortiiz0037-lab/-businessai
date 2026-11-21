#!/usr/bin/env node
/**
 * Document Studio · branches (migration 0037) in the browser, LOCAL stack only:
 * the identity accepts {SUC} in a number format; a draft letter is issued from
 * a branch (merge fields in the preview, number with the branch code, frozen
 * snapshot, real PDF); the list filters by branch; with CRM branch scoping a
 * member only uses its own branch; English; iPhone. Fictitious data.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/studio-branches.auth.e2e.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3460)
const COMPANY = 'e2000000-0000-4000-8000-000000000001'
const MEMBER = 'e1000000-0000-4000-8000-000000000003'

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
  const { BASE, PASSWORD, api, admin } = stack
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }
  const rpc = async (who, fn, body) => { const r = await api(who, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true })
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
  async function open(page, path) {
    const r = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    last = page.url().replace(BASE, '')
    const body = await page.locator('body').innerText()
    return { status: r?.status() ?? 0, body, broken: /Algo salió mal|Something went wrong|Application error|Internal Server Error/.test(body) }
  }
  async function act(page, button) {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && /[?&](done|error)=/.test(u.search), { timeout: 20000 }).catch(() => {}), button.click()])
    await page.waitForLoadState('networkidle')
    last = page.url().replace(BASE, '')
    return { url: page.url(), done: new URL(page.url()).searchParams.get('done'), error: new URL(page.url()).searchParams.get('error'), body: await page.locator('body').innerText() }
  }
  const content = { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Carta de sucursal' }, { type: 'paragraph', text: 'Desde {{branch.name}} ({{branch.code}}): {{branch.address}}' }] }
  const newLetter = async (who, title) => {
    const r = await rpc(who, 'studio_save_document', { target: COMPANY, doc: null, doc_kind: 'letter', doc_title: title, doc_folder: null, doc_content: content, doc_page: {},
      client: null, source_document: null, employee: null, vendor: null, template: null, base: null, expected_version: null, doc_origin: 'user' })
    return Array.isArray(r.body) ? r.body[0]?.id : r.body?.id
  }

  // branches of the company (CRM, 0035) and the numbering pattern with {SUC} through the identity screen
  const cen = await rpc('owner@e2e.local', 'crm_save_branch', { target: COMPANY, branch: null, p_name: 'Central', p_code: 'CEN', p_address: 'Calle Comercio 1, San Juan' })
  const pon = await rpc('owner@e2e.local', 'crm_save_branch', { target: COMPANY, branch: null, p_name: 'Ponce', p_code: 'PON', p_address: 'Calle Reina 5, Ponce' })
  const CEN = typeof cen.body === 'string' ? cen.body : (await db(`branches?company_id=eq.${COMPANY}&code=eq.CEN&select=id`))[0]?.id
  const PON = typeof pon.body === 'string' ? pon.body : (await db(`branches?company_id=eq.${COMPANY}&code=eq.PON&select=id`))[0]?.id
  check(!!CEN && !!PON, 'setup: two branches (Central CEN, Ponce PON)', `${cen.status} ${pon.status}`)

  const owner = await session('owner@e2e.local')
  const o = owner.page
  await open(o, '/studio/brand')
  await o.locator('input[name="format_letter"]').fill('CAR-{SUC}-{YYYY}-{####}')
  let r = await act(o, o.locator('form').filter({ has: o.locator('input[name="format_letter"]') }).getByRole('button', { name: 'Guardar identidad' }))
  check(r.done === 'brand_saved' && (await db(`studio_brand?company_id=eq.${COMPANY}&select=number_formats`))[0]?.number_formats?.letter === 'CAR-{SUC}-{YYYY}-{####}',
    'identity: a number format with {SUC} is accepted', `${r.done} ${r.error}`)

  // a draft letter issued from Central
  const D = await newLetter('owner@e2e.local', 'Carta desde Central')
  r = await open(o, `/studio/${D}`)
  const box = o.getByTestId('studio-branch')
  check(!r.broken && await box.count() === 1 && await box.locator('select[name="branch_id"] option').count() === 3, 'editor: the draft offers its company branches (and «no branch»)')
  await box.locator('select[name="branch_id"]').selectOption(CEN)
  r = await act(o, box.getByRole('button', { name: 'Guardar sucursal' }))
  check(r.done === 'branch' && (await db(`studio_documents?id=eq.${D}&select=branch_id`))[0]?.branch_id === CEN, 'editor: the branch is saved', `${r.done} ${r.error}`)
  // the preview is the same layout as the PDF, drawn as SVG text (one <text> per laid-out run)
  const svgText = async (page) => (await page.locator('svg[role="img"] text').allTextContents()).join(' ').replace(/\s+/g, ' ')
  const pv = await svgText(o)
  check(/Central/.test(pv) && /\(CEN\)/.test(pv) && /Calle Comercio 1, San Juan/.test(pv), 'preview: the «Branch» merge fields show Central, its code and address', pv.slice(0, 160))
  await o.locator('input[name="confirm"]').check()
  r = await act(o, o.getByRole('button', { name: 'Emitir documento' }))
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric' }).format(new Date())
  const issued = (await db(`studio_documents?id=eq.${D}&select=status,number,snapshot`))[0]
  check(r.done === 'finalized' && issued?.status === 'final' && issued?.number === `CAR-CEN-${year}-0001`, `issue: numbered with the branch code (${issued?.number})`, `${r.done} ${r.error}`)
  check(issued?.snapshot?.data?.branch?.name === 'Central', 'issue: the frozen snapshot keeps the branch')
  check(/Central \(CEN\)/.test(await o.getByTestId('studio-branch').innerText().catch(() => '')) && await o.locator('select[name="branch_id"]').count() === 0,
    'issued: the branch is shown and can no longer be changed')
  const pdf = await owner.ctx.request.get(`${BASE}/studio/${D}/pdf`)
  const bytes = Buffer.from(await pdf.body())
  check(pdf.status() === 200 && /pdf/.test(pdf.headers()['content-type'] ?? '') && bytes.subarray(0, 5).toString() === '%PDF-' && /\/FontFile2|\/Type\s*\/Font/.test(bytes.toString('latin1')),
    'PDF: a real PDF with embedded fonts (selectable text)', `${pdf.status()} ${pdf.headers()['content-type']}`)
  // a letter using branch fields cannot be issued without a branch (missing data), one without them can
  const Dx = await newLetter('owner@e2e.local', 'Carta incompleta')
  await open(o, `/studio/${Dx}`)
  await o.locator('input[name="confirm"]').check()
  r = await act(o, o.getByRole('button', { name: 'Emitir documento' }))
  check(r.error === 'missing_data' && /branch\.name/.test(new URL(r.url).searchParams.get('missing') ?? '') && (await db(`studio_documents?id=eq.${Dx}&select=status`))[0]?.status === 'draft',
    'issue: a letter that uses the «Branch» fields is refused without a branch (missing data), still a draft', `${r.done} ${r.error}`)
  const plain = { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Carta general' }, { type: 'paragraph', text: 'Saludos de {{company.name}}.' }] }
  const D2 = await rpc('owner@e2e.local', 'studio_save_document', { target: COMPANY, doc: null, doc_kind: 'letter', doc_title: 'Carta sin sucursal', doc_folder: null, doc_content: plain, doc_page: {},
    client: null, source_document: null, employee: null, vendor: null, template: null, base: null, expected_version: null, doc_origin: 'user' }).then((x) => (Array.isArray(x.body) ? x.body[0]?.id : x.body?.id))
  await open(o, `/studio/${D2}`)
  await o.locator('input[name="confirm"]').check()
  r = await act(o, o.getByRole('button', { name: 'Emitir documento' }))
  check((await db(`studio_documents?id=eq.${D2}&select=number`))[0]?.number === `CAR-${year}-0002`, 'issue without a branch: CAR-YYYY-#### (the token and its dash disappear)', `${r.done} ${r.error}`)
  // list filter
  r = await open(o, `/studio?branch=${CEN}`)
  check(/Carta desde Central/.test(r.body) && !/Carta sin sucursal/.test(r.body) && /Central \(CEN\)/.test(r.body), 'list: filtered by branch (Central) and labelled with it')
  r = await open(o, `/studio?branch=${PON}`)
  check(!/Carta desde Central/.test(r.body), 'list: Ponce shows none of them')

  // branch scoping: the member, assigned to Ponce, cannot issue from Central
  const sc = await rpc('owner@e2e.local', 'crm_save_settings', { target: COMPANY, p_branch_scoping: true, p_share_clients: true })
  const asg = await rpc('owner@e2e.local', 'crm_set_branch_member', { branch: PON, member: MEMBER, assigned: true })
  check(sc.status < 300 && asg.status < 300, 'setup: branch scoping on, the member assigned to Ponce', `${sc.status} ${asg.status}`)
  const mem = await session('member@e2e.local')
  const M = await newLetter('member@e2e.local', 'Carta del miembro')
  await open(mem.page, `/studio/${M}`)
  await mem.page.getByTestId('studio-branch').locator('select[name="branch_id"]').selectOption(CEN)
  r = await act(mem.page, mem.page.getByTestId('studio-branch').getByRole('button', { name: 'Guardar sucursal' }))
  check(r.error === 'studio_branch_forbidden' && /Solo puedes usar las sucursales a las que estás asignado/.test(r.body) && (await db(`studio_documents?id=eq.${M}&select=branch_id`))[0]?.branch_id === null,
    'scoping: the member cannot use Central (told why, nothing changed)', `${r.done} ${r.error}`)
  await mem.page.getByTestId('studio-branch').locator('select[name="branch_id"]').selectOption(PON)
  r = await act(mem.page, mem.page.getByTestId('studio-branch').getByRole('button', { name: 'Guardar sucursal' }))
  check(r.done === 'branch' && (await db(`studio_documents?id=eq.${M}&select=branch_id`))[0]?.branch_id === PON && /Ponce/.test(await svgText(mem.page)), 'scoping: it uses Ponce, its own branch')
  check(await mem.page.getByRole('button', { name: 'Emitir documento' }).count() === 0, 'members still do not issue (studio.issue)')
  await rpc('owner@e2e.local', 'crm_save_settings', { target: COMPANY, p_branch_scoping: false, p_share_clients: true })
  await mem.ctx.close()

  // English and iPhone
  const en = await session('owner@e2e.local', {}, 'en')
  const D3 = await newLetter('owner@e2e.local', 'Letter in English')
  r = await open(en.page, `/studio/${D3}`)
  check(/Branch/.test(await en.page.getByTestId('studio-branch').innerText()) && await en.page.getByRole('button', { name: 'Save branch' }).count() === 1 && !/Guardar sucursal/.test(r.body), 'English: the branch block')
  r = await open(en.page, `/studio/${D}`)
  check(/Branch/.test(await en.page.getByTestId('studio-branch').innerText()) && /Central \(CEN\)/.test(r.body), 'English: an issued document shows its branch')
  await en.ctx.close()
  const phone = await session('owner@e2e.local', { ...devices['iPhone 13'] })
  for (const path of [`/studio/${D}`, `/studio/${D3}`, `/studio?branch=${CEN}`, '/studio/brand']) {
    await open(phone.page, path)
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1, `iPhone 13: ${path.replace(/[0-9a-f-]{36}/g, '[id]')} has no horizontal page scroll`, `${overflow}px`)
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
  check(consoleErrors.length === 0, 'no browser console errors or 5xx responses', consoleErrors.slice(0, 5).join(' | '))
}
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

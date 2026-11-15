#!/usr/bin/env node
/**
 * Authenticated browser test of the Finance FLOWS that e2e/finance.auth.e2e.mjs
 * only opens: the full life of an expense (draft, edit, attachment, submit,
 * self-approval rule, approve / return, schedule, partial payment, payment void,
 * full payment, void), vendors, approval rules and categories, recurring
 * expenses; receivables (client statement, payment promises, reminders,
 * settings, reports); bank (account page, line operations, reconciliation);
 * ledger (period close / reopen, reversal); detail pages in English and on an
 * iPhone. Each step is checked in the database too (service role, read-only).
 * LOCAL stack only (e2e/local-stack/stack.mjs); fictitious data.
 *
 *   npm run build && PSQL=… bash e2e/local-stack/db.sh
 *   PGRST_BIN=/path/to/postgrest PG_SOCKET=/sock PG_PORT=5432 node e2e/finance-flows.auth.e2e.mjs
 * With E2E_BROWSER_STORAGE=1 (and a build whose NEXT_PUBLIC_SUPABASE_URL is the
 * stub, http://127.0.0.1:<PORT+2>) attachments are uploaded by the browser itself;
 * otherwise through the Storage API with the same user's session (same rules).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack } from './local-stack/stack.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const PORT = Number(process.env.PORT ?? 3440)
const COMPANY = 'e2000000-0000-4000-8000-000000000001'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

let passed = 0, failed = 0, last = ''
const check = (cond, label, extra = '') => { if (cond) { passed++; console.log(`PASS: ${label}`) } else { failed++; console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''} [at ${last}]`) } }
const browser = await chromium.launch()
const consoleErrors = []
let stack = null

try {
  stack = await startStack({ root, port: PORT, pgrstBin: process.env.PGRST_BIN, pgSocket: process.env.PG_SOCKET, pgPort: process.env.PG_PORT ?? '5432', db: process.env.DB ?? 'ba_e2e_fin' })
  const { BASE, PASSWORD, api, admin, work } = stack
  // read-only look at the database (service role) to confirm what each screen did
  const db = async (path) => { const r = await admin(`/${path}`); return r.ok ? r.json() : [] }

  async function session(email, opts = {}, locale = null) {
    const ctx = await browser.newContext({ ...opts, acceptDownloads: true })
    if (locale) await ctx.addCookies([{ name: 'ba_locale', value: locale, url: BASE }])
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${m.text()}`) })
    page.on('pageerror', (e) => consoleErrors.push(`${email} ${page.url().replace(BASE, '')}: ${e.message}`))
    page.on('response', (r) => { if (r.status() >= 500) consoleErrors.push(`${email} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
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
  /** Clicks a submit button and waits for the redirect that every action does (…?done= / ?error=). */
  async function act(page, button) {
    const before = page.url()
    await Promise.all([page.waitForURL((u) => u.href !== before && /[?&](done|error)=/.test(u.search), { timeout: 20000 }).catch(() => {}), button.click()])
    await page.waitForLoadState('networkidle')
    last = page.url().replace(BASE, '')
    return { url: page.url(), done: new URL(page.url()).searchParams.get('done'), error: new URL(page.url()).searchParams.get('error'), body: await page.locator('body').innerText() }
  }
  const bill = async (id) => (await db(`bills?id=eq.${id}&select=status,paid_cents,total_cents,scheduled_for,rejection_reason,void_reason,description`))[0] ?? {}

  const owner = await session('owner@e2e.local')
  const adm = await session('admin@e2e.local')
  const mem = await session('member@e2e.local')
  const o = owner.page, a = adm.page

  // ============================================================ D3 · vendors
  let r = await open(o, '/payables/vendors')
  await o.locator('summary', { hasText: 'Nuevo proveedor' }).click()
  const vf = o.locator('form').filter({ has: o.locator('input[name="tax_id"]') })
  await vf.locator('input[name="name"]').fill('Suplidora Flujos'); await vf.locator('input[name="tax_id"]').fill('66-1234567'); await vf.locator('input[name="email"]').fill('pagos@suplidora.test')
  r = await act(o, vf.locator('button[type="submit"]'))
  const vendor = (await db(`vendors?company_id=eq.${COMPANY}&name=eq.Suplidora%20Flujos&select=id,tax_id,status`))[0]
  check(r.done === 'vendor_created' && vendor?.tax_id === '66-1234567', 'D3 vendors: a vendor is created from the form (with its tax ID)', `${r.done} ${r.error}`)
  await Promise.all([o.waitForURL(/\/payables\/vendors\/[0-9a-f-]{36}/), o.getByRole('link', { name: /Suplidora Flujos/ }).first().click()])
  await o.waitForLoadState('networkidle'); last = o.url().replace(BASE, '')
  check(/Suplidora Flujos/.test(await o.locator('body').innerText()) && o.url().endsWith(vendor?.id ?? 'x'), 'D3 vendors: the vendor page opens from the list')

  // ============================================================ D3 · an expense from draft to paid
  await open(a, '/payables/new')
  const bf = a.locator('form').filter({ has: a.locator('select[name="vendor_id"]') })
  await bf.locator('select[name="vendor_id"]').selectOption(vendor.id)
  await bf.locator('input[name="vendor_invoice_number"]').fill('SF-1001')
  await bf.locator('input[name="description"]').fill('Materiales de oficina')
  const cat = await bf.locator('select[name="category_0"] option').nth(1).getAttribute('value')
  await bf.locator('select[name="category_0"]').selectOption(cat)
  await bf.locator('input[name="line_description_0"]').fill('Papel y tinta'); await bf.locator('input[name="amount_0"]').fill('250.00')
  r = await act(a, bf.locator('button[value="draft"]'))
  const B1 = /\/payables\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  check(r.done === 'saved' && (await bill(B1)).status === 'draft' && (await bill(B1)).total_cents === 25000, 'D3: the admin saves a draft expense of 250.00', `${r.done} ${r.error}`)
  // edit the draft
  await open(a, `/payables/${B1}/edit`)
  await a.locator('input[name="description"]').fill('Materiales de oficina (noviembre)')
  r = await act(a, a.locator('form').filter({ has: a.locator('select[name="vendor_id"]') }).locator('button[value="draft"]'))
  check(r.done === 'saved' && (await bill(B1)).description === 'Materiales de oficina (noviembre)', 'D3: the draft is edited from /payables/[id]/edit', `${r.done} ${r.error}`)
  // attachment: private storage + registration; download through a short-lived signed link
  if (process.env.E2E_BROWSER_STORAGE === '1') {
    await a.locator('input[type="file"]').setInputFiles({ name: 'recibo.pdf', mimeType: 'application/pdf', buffer: PDF })
    await a.getByText('Adjunto guardado.').waitFor({ timeout: 15000 }).catch(() => {})
  } else {
    const path = `${COMPANY}/${B1}/${crypto.randomUUID()}-recibo.pdf`
    const up = await api('admin@e2e.local', `/storage/v1/object/Finance-attachments/${path}`, { method: 'POST', body: PDF, headers: { 'content-type': 'application/pdf' } })
    const reg = await api('admin@e2e.local', '/rest/v1/bill_attachments', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({
      company_id: COMPANY, bill_id: B1, storage_path: path, file_name: 'recibo.pdf', content_type: 'application/pdf', size_bytes: PDF.length }) })
    check(up.status < 300 && reg.status < 300, 'D3 attachments (API, same session and rules): the admin uploads a receipt to private storage and registers it', `${up.status} ${reg.status}`)
  }
  await open(a, `/payables/${B1}`)
  const attLink = a.getByRole('link', { name: 'recibo.pdf' })
  check(await attLink.count() === 1, 'D3 attachments: the receipt is listed on the expense')
  const ATT = /attachments\/([0-9a-f-]{36})/.exec(await attLink.getAttribute('href') ?? '')?.[1]
  const dl = await adm.ctx.request.get(`${BASE}/payables/attachments/${ATT}`, { maxRedirects: 0 })
  const signed = dl.headers().location ?? ''
  const file = signed ? await fetch(signed.startsWith('http') ? signed : `${BASE}${signed}`).then(async (x) => [x.status, await x.text()]) : [0, '']
  check(dl.status() >= 300 && dl.status() < 400 && file[0] === 200 && file[1].startsWith('%PDF'), 'D3 attachments: it downloads through a short-lived signed link', `${dl.status()} ${file[0]}`)
  const other = await api('other@e2e.local', `/rest/v1/bill_attachments?id=eq.${ATT}&select=id`).then((x) => x.json())
  const otherFile = await api('other@e2e.local', `/storage/v1/object/Finance-attachments/${(await db(`bill_attachments?id=eq.${ATT}&select=storage_path`))[0]?.storage_path}`)
  check(Array.isArray(other) && other.length === 0 && otherFile.status >= 400, 'D3 attachments: another company sees neither the record nor the file', `${other.length} ${otherFile.status}`)
  // submit; the admin cannot approve its own expense
  r = await act(a, a.getByRole('button', { name: 'Enviar a aprobación' }))
  check(r.done === 'submitted' && (await bill(B1)).status === 'pending_approval', 'D3: submitted for approval', `${r.done} ${r.error}`)
  check(await a.getByRole('button', { name: 'Aprobar y registrar' }).count() === 0, 'D3: the admin who created it is not offered «Aprobar» (no self-approval)')
  // the owner returns it, the admin resubmits, the owner approves
  await open(o, `/payables/${B1}`)
  await o.locator('summary', { hasText: 'Devolver a borrador' }).click()
  await o.locator('form').filter({ has: o.locator('input[name="reason"]') }).filter({ hasText: 'Devolver' }).first().locator('input[name="reason"]').fill('Falta el número de orden')
  r = await act(o, o.getByRole('button', { name: 'Devolver', exact: true }))
  check(r.done === 'rejected' && (await bill(B1)).status === 'draft' && (await bill(B1)).rejection_reason === 'Falta el número de orden' && /Devuelto: Falta el número de orden/.test(r.body),
    'D3: the owner returns it to draft with a reason (shown on the expense)', `${r.done} ${r.error}`)
  await open(a, `/payables/${B1}`)
  r = await act(a, a.getByRole('button', { name: 'Enviar a aprobación' }))
  await open(o, `/payables/${B1}`)
  r = await act(o, o.getByRole('button', { name: 'Aprobar y registrar' }))
  const entries = await db(`journal_entries?company_id=eq.${COMPANY}&source=eq.bill&source_id=eq.${B1}&select=id`)
  check(r.done === 'approved' && (await bill(B1)).status === 'approved' && entries.length === 1, 'D3: resubmitted and approved by the owner: posted to the ledger once', `${r.done} ${r.error} entries=${entries.length}`)
  // schedule, partial payment, void it, pay in full
  const nextWeek = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date(Date.now() + 7 * 86_400_000))
  await o.locator('input[name="pay_on"]').fill(nextWeek)
  r = await act(o, o.locator('form').filter({ has: o.locator('input[name="pay_on"]') }).getByRole('button', { name: 'Guardar' }))
  check(r.done === 'scheduled' && (await bill(B1)).status === 'scheduled' && (await bill(B1)).scheduled_for === nextWeek, 'D3: payment scheduled for next week', `${r.done} ${r.error}`)
  const payForm = o.locator('form').filter({ has: o.locator('input[name="paid_on"]') })
  await payForm.locator('input[name="amount"]').fill('100.00'); await payForm.locator('input[name="reference"]').fill('CHK-501')
  r = await act(o, payForm.getByRole('button', { name: 'Registrar pago' }))
  check(r.done === 'paid' && (await bill(B1)).status === 'partially_paid' && (await bill(B1)).paid_cents === 10000, 'D3: a partial payment of 100.00 → partially paid', `${r.done} ${r.error} ${JSON.stringify(await bill(B1))}`)
  await o.locator('summary', { hasText: 'Anular pago' }).first().click()
  await o.locator('form').filter({ has: o.locator('input[name="payment_id"]') }).filter({ has: o.locator('input[name="reason"]') }).first().locator('input[name="reason"]').fill('Cheque devuelto')
  r = await act(o, o.getByRole('button', { name: 'Anular con reversión' }).first())
  const voids = await db(`journal_entries?company_id=eq.${COMPANY}&source=eq.bill_payment_void&select=id`)
  check(r.done === 'payment_voided' && (await bill(B1)).paid_cents === 0 && voids.length === 1 && /Cheque devuelto/.test(r.body),
    'D3: the payment is voided with a reversal entry; the balance is back to 250.00', `${r.done} ${r.error}`)
  const payForm2 = o.locator('form').filter({ has: o.locator('input[name="paid_on"]') })
  r = await act(o, payForm2.getByRole('button', { name: 'Registrar pago' }))
  check(r.done === 'paid' && (await bill(B1)).status === 'paid' && /Pagado por completo/.test(r.body), 'D3: paid in full (the form proposes the open balance)', `${r.done} ${r.error} ${JSON.stringify(await bill(B1))} ${r.body.match(/[^\n]*(Pagado|Saldo|pago)[^\n]*/gi)?.slice(0, 6).join(' / ')}`)
  check(await o.getByRole('link', { name: 'recibo.pdf' }).count() === 1 && await o.getByRole('button', { name: 'Quitar' }).count() === 0,
    'D3 attachments: once submitted the receipt is kept as evidence (no «Quitar»)')

  // ============================================================ D3 · void an expense, delete a draft
  await open(a, '/payables/new')
  const bf2 = a.locator('form').filter({ has: a.locator('select[name="vendor_id"]') })
  await bf2.locator('select[name="vendor_id"]').selectOption(vendor.id); await bf2.locator('input[name="description"]').fill('Gasto duplicado')
  await bf2.locator('select[name="category_0"]').selectOption(cat); await bf2.locator('input[name="amount_0"]').fill('80.00')
  r = await act(a, bf2.locator('button[value="draft"]'))
  const B2 = /\/payables\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  await a.locator('summary', { hasText: 'Anular gasto' }).click()
  await a.locator('form').filter({ has: a.locator('input[name="reason"]') }).filter({ hasText: 'Anular' }).last().locator('input[name="reason"]').fill('Registrado dos veces')
  r = await act(a, a.getByRole('button', { name: 'Anular', exact: true }))
  check(r.done === 'voided' && (await bill(B2)).status === 'voided' && (await bill(B2)).void_reason === 'Registrado dos veces', 'D3: a draft is voided with a reason (kept, not deleted)', `${r.done} ${r.error}`)
  await open(a, '/payables/new')
  const bf3 = a.locator('form').filter({ has: a.locator('select[name="vendor_id"]') })
  await bf3.locator('select[name="vendor_id"]').selectOption(vendor.id); await bf3.locator('input[name="description"]').fill('Borrador temporal')
  await bf3.locator('select[name="category_0"]').selectOption(cat); await bf3.locator('input[name="amount_0"]').fill('12.00')
  r = await act(a, bf3.locator('button[value="draft"]'))
  const B3 = /\/payables\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  r = await act(a, a.getByRole('button', { name: 'Eliminar borrador' }))
  check((await db(`bills?id=eq.${B3}&select=id`)).length === 0 && !/error=/.test(r.url), 'D3: a draft never submitted can be deleted', `${r.done} ${r.error}`)

  // ============================================================ D3 · approval rules and categories
  await open(o, '/payables/settings')
  const rules = o.locator('form').filter({ has: o.locator('input[name="member_limit"]') })
  await rules.locator('input[name="member_can"]').check(); await rules.locator('input[name="member_limit"]').fill('50.00')
  r = await act(o, rules.getByRole('button', { name: 'Guardar reglas' }))
  const limits = await db(`approval_limits?company_id=eq.${COMPANY}&select=role,max_cents&order=role`)
  check(r.done === 'settings_saved' && JSON.stringify(limits) === JSON.stringify([{ role: 'admin', max_cents: null }, { role: 'member', max_cents: 5000 }]),
    'D3 settings: members may now approve up to 50.00 (saved as integer cents)', JSON.stringify(limits))
  const nc = o.locator('form').filter({ has: o.locator('input[placeholder="Nueva categoría"]') })
  await nc.locator('input[name="name"]').fill('Combustible'); await nc.locator('input[name="name_en"]').fill('Fuel')
  await nc.locator('select[name="account_id"]').selectOption(await nc.locator('select[name="account_id"] option').nth(1).getAttribute('value'))
  r = await act(o, nc.locator('button[type="submit"]'))
  check(r.done === 'category_saved' && (await db(`expense_categories?company_id=eq.${COMPANY}&name=eq.Combustible&select=name_en,status`))[0]?.name_en === 'Fuel',
    'D3 settings: a new expense category (with its English name)', `${r.done} ${r.error}`)
  // Members see only their own expenses and nobody approves their own unless the company allows it, so a
  // member's approval limit applies to its own expenses with self-approval on (one-person businesses).
  const memberBill = async (amount) => {
    await open(mem.page, '/payables/new')
    const f = mem.page.locator('form').filter({ has: mem.page.locator('select[name="vendor_id"]') })
    await f.locator('select[name="vendor_id"]').selectOption(vendor.id); await f.locator('input[name="description"]').fill(`Gasto del miembro ${amount}`)
    await f.locator('select[name="category_0"]').selectOption(cat); await f.locator('input[name="amount_0"]').fill(amount)
    const rr = await act(mem.page, f.locator('button[value="submit"]'))
    return /\/payables\/([0-9a-f-]{36})/.exec(rr.url)?.[1]
  }
  const m40 = await memberBill('40.00')
  check(await mem.page.getByRole('button', { name: 'Aprobar y registrar' }).count() === 0 && (await bill(m40)).status === 'pending_approval',
    'D3 approval rules: with self-approval off, a member with a limit still cannot approve its own expense')
  check((await open(mem.page, `/payables/${B1}`)).status === 404 || !/Materiales de oficina/.test((await open(mem.page, `/payables/${B1}`)).body), 'D3: a member does not see expenses of others')
  await open(o, '/payables/settings')
  const rules2 = o.locator('form').filter({ has: o.locator('input[name="member_limit"]') })
  await rules2.locator('input[name="self_approval"]').check()
  r = await act(o, rules2.getByRole('button', { name: 'Guardar reglas' }))
  check(r.done === 'settings_saved' && (await db(`payables_settings?company_id=eq.${COMPANY}&select=allow_self_approval`))[0]?.allow_self_approval === true, 'D3 settings: self-approval allowed (one-person business)')
  await open(mem.page, `/payables/${m40}`)
  r = await act(mem.page, mem.page.getByRole('button', { name: 'Aprobar y registrar' }))
  check(r.done === 'approved' && (await bill(m40)).status === 'approved', 'D3 approval limits: the member approves its own 40.00 (limit 50.00)', `${r.done} ${r.error}`)
  const m60 = await memberBill('60.00')
  check(await mem.page.getByRole('button', { name: 'Aprobar y registrar' }).count() === 0 && /límite|limit/i.test(await mem.page.locator('body').innerText()) && (await bill(m60)).status === 'pending_approval',
    'D3 approval limits: but not its own 60.00 (above the limit), and it is told why')
  // put the rules back as they were for the rest of the run
  await open(o, '/payables/settings')
  const rules3 = o.locator('form').filter({ has: o.locator('input[name="member_limit"]') })
  await rules3.locator('input[name="self_approval"]').uncheck()
  await act(o, rules3.getByRole('button', { name: 'Guardar reglas' }))

  // ============================================================ D3 · recurring expenses
  await open(o, '/payables/recurring')
  await o.locator('summary', { hasText: 'Nueva plantilla' }).click()
  const rf = o.locator('form').filter({ has: o.locator('select[name="frequency"]') })
  await rf.locator('select[name="vendor_id"]').selectOption(vendor.id); await rf.locator('select[name="category_id"]').selectOption(cat)
  await rf.locator('input[name="amount"]').fill('300.00'); await rf.locator('input[name="description"]').fill('Alquiler de almacén')
  r = await act(o, rf.locator('button[type="submit"]'))
  const tpl = (await db(`recurring_expenses?company_id=eq.${COMPANY}&description=eq.Alquiler%20de%20almac%C3%A9n&select=id,status,amount_cents,frequency`))[0]
  check(r.done === 'recurring_saved' && tpl?.amount_cents === 30000 && tpl?.frequency === 'monthly', 'D3 recurring: a monthly template of 300.00', `${r.done} ${r.error}`)
  r = await act(o, o.locator('form').filter({ hasText: /Generar|Generate/ }).locator('button[type="submit"]').first())
  const gen = await db(`bills?company_id=eq.${COMPANY}&recurring_id=eq.${tpl?.id}&select=id,status,total_cents`)
  check(r.done === 'generated' && gen.length === 1 && gen[0].total_cents === 30000 && gen[0].status === 'draft', 'D3 recurring: generating creates this period\'s draft once', `${r.done} n=${new URL(r.url).searchParams.get('n')} bills=${gen.length}`)
  r = await act(o, o.locator('form').filter({ hasText: /Generar|Generate/ }).locator('button[type="submit"]').first())
  check((await db(`bills?company_id=eq.${COMPANY}&recurring_id=eq.${tpl?.id}&select=id`)).length === 1, 'D3 recurring: generating again does not duplicate the period')

  // ============================================================ D4 · receivables: reminders, promises, payment, status, notes, statement, void
  const INV = 'e4000000-0000-4000-8000-000000000001', CLIENT = 'e3000000-0000-4000-8000-000000000001'   // seed: 1,500.00 overdue, 500.00 paid
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date())
  const inDays = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date(Date.now() + n * 86_400_000))
  const balance = async () => {   // the receivables function, with the owner's session (RLS / permissions apply)
    const rows = await api('owner@e2e.local', '/rest/v1/rpc/ar_invoice_balances', { method: 'POST', body: JSON.stringify({ target: COMPANY }) }).then((x) => x.json())
    return Number(rows.find?.((x) => x.document_id === INV)?.balance_cents ?? NaN)
  }
  await open(o, '/receivables/settings')
  const sf = o.locator('form').filter({ has: o.locator('input[name="offsets"]') })
  await sf.locator('input[name="enabled"]').check(); await sf.locator('input[name="offsets"]').fill('7, 30')
  await sf.locator('input[name="sender_name"]').fill('Cobros Demo')
  r = await act(o, sf.locator('button[type="submit"]'))
  const cs = (await db(`collection_settings?company_id=eq.${COMPANY}&select=reminders_enabled,reminder_offsets,sender_name`))[0]
  check(r.done === 'settings' && cs?.reminders_enabled === true && JSON.stringify(cs?.reminder_offsets) === '[7,30]' && cs?.sender_name === 'Cobros Demo',
    'D4 settings: reminders on, at 7 and 30 days past due, with a sender name', `${r.done} ${r.error} ${JSON.stringify(cs)}`)
  await open(o, '/receivables')
  r = await act(o, o.getByRole('button', { name: 'Actualizar seguimiento' }))
  const rems = await db(`collection_reminders?document_id=eq.${INV}&select=id,status,offset_days`)
  check(r.done === 'refreshed' && rems.some((x) => x.offset_days === 30), 'D4: refreshing the follow-up prepares the 30-day reminder of the overdue invoice', `${r.done} r=${new URL(r.url).searchParams.get('r')} ${JSON.stringify(rems)}`)
  await open(o, `/receivables/invoices/${INV}`)
  const contacted = o.getByRole('button', { name: 'Contactado por otro medio' }).first()
  if (await contacted.count()) {
    r = await act(o, contacted)
    check(r.done === 'reminder_marked' && (await db(`collection_reminders?document_id=eq.${INV}&status=eq.sent_manual&select=id`)).length === 1, 'D4: a prepared reminder is recorded as contacted another way (no email configured)', `${r.done} ${r.error}`)
  } else check(rems.every((x) => x.status === 'no_email'), 'D4: without a client email the reminder is kept as «no email»', JSON.stringify(rems))
  // promises: record, cancel, record again, kept by a payment
  const pf = () => o.locator('form').filter({ has: o.locator('input[name="promised_date"]') })
  await pf().locator('input[name="promised_date"]').fill(inDays(3)); await pf().locator('input[name="amount"]').fill('400.00'); await pf().locator('input[name="note"]').fill('Llamada con contabilidad')
  r = await act(o, pf().getByRole('button', { name: 'Registrar promesa' }))
  const prom = async () => db(`payment_promises?document_id=eq.${INV}&select=id,status,amount_cents,cancel_reason&order=created_at`)
  check(r.done === 'promise' && (await prom()).at(-1)?.status === 'pending' && (await prom()).at(-1)?.amount_cents === 40000, 'D4: a payment promise of 400.00 in 3 days is recorded', `${r.done} ${r.error}`)
  await o.locator('summary', { hasText: 'Cancelar promesa' }).first().click()
  await o.locator('form').filter({ has: o.locator('input[name="promise_id"]') }).first().locator('input[name="reason"]').fill('El cliente cambió la fecha')
  r = await act(o, o.locator('form').filter({ has: o.locator('input[name="promise_id"]') }).first().getByRole('button', { name: 'Cancelar' }))
  check(r.done && (await prom()).at(-1)?.status === 'cancelled' && (await prom()).at(-1)?.cancel_reason === 'El cliente cambió la fecha', 'D4: the promise is cancelled with a reason (kept in history)', `${r.done} ${r.error}`)
  await pf().locator('input[name="promised_date"]').fill(inDays(1)); await pf().locator('input[name="amount"]').fill('300.00')
  r = await act(o, pf().getByRole('button', { name: 'Registrar promesa' }))
  const b0 = await balance()
  await open(o, `/documents/${INV}`)
  const payf = o.locator('form').filter({ has: o.locator('input[name="idempotency_key"]') }).filter({ has: o.locator('select[name="method"]') })
  await payf.locator('input[name="amount"]').fill('300.00')
  await payf.locator('select[name="method"]').selectOption({ index: 1 })
  await payf.locator('input[name="create_receipt"]').uncheck()   // stay on the invoice (a receipt opens its own page)
  r = await act(o, payf.getByRole('button', { name: 'Registrar pago' }))
  check(r.done === 'payment' && await balance() === b0 - 30000, 'D4: a payment of 300.00 is recorded on the invoice; the balance drops by 300.00', `${r.done} ${b0} → ${await balance()}`)
  const proposed = await o.locator('form').filter({ has: o.locator('select[name="method"]') }).locator('input[name="amount"]').inputValue().catch(() => '')
  check(proposed === ((b0 - 30000) / 100).toFixed(2), 'D4: after the payment the form proposes the NEW balance (no stale amount)', `${proposed} vs ${((b0 - 30000) / 100).toFixed(2)}`)
  await open(o, '/receivables')
  await act(o, o.getByRole('button', { name: 'Actualizar seguimiento' }))
  check((await prom()).at(-1)?.status === 'kept', 'D4: the later payment covers the 300.00 promise: marked kept', JSON.stringify((await prom()).at(-1)))
  // collection status and notes; the client statement
  await open(o, `/receivables/invoices/${INV}`)
  await o.locator('form').filter({ has: o.locator('select[name="status"]') }).locator('select[name="status"]').selectOption('disputed')
  r = await act(o, o.locator('form').filter({ has: o.locator('select[name="status"]') }).getByRole('button', { name: 'Guardar' }))
  check(r.done === 'status' && (await db(`invoice_collections?document_id=eq.${INV}&select=status`))[0]?.status === 'disputed', 'D4: the invoice is marked «in dispute»', `${r.done} ${r.error}`)
  await o.locator('textarea[name="body"]').fill('El cliente pide copia de la orden de compra')
  r = await act(o, o.getByRole('button', { name: 'Añadir nota' }))
  check(r.done === 'note' && /copia de la orden de compra/.test(r.body), 'D4: a private collection note on the invoice', `${r.done} ${r.error}`)
  r = await open(o, `/receivables/clients/${CLIENT}`)
  check(!r.broken && /Cliente Uno|Demo/.test(r.body) && await o.locator(`a[href="/receivables/invoices/${INV}"]`).count() >= 1, 'D4: the client statement lists its open invoices', r.body.slice(0, 160))
  await o.locator('textarea[name="body"]').fill('Prefiere que lo llamen por la tarde')
  r = await act(o, o.getByRole('button', { name: /Añadir nota|Guardar nota/ }).first())
  check(r.done === 'note' && (await db(`collection_notes?client_id=eq.${CLIENT}&select=id`)).length >= 1, 'D4: a note on the client', `${r.done} ${r.error}`)
  r = await open(o, `/receivables/reports?from=${inDays(-90)}&to=${today}`)
  check(!r.broken && await o.locator(`a[href="/receivables/clients/${CLIENT}"]`).count() >= 1, 'D4 reports: the period report lists the client with a link to its statement')
  // void the 300.00 payment (bounced check): balance restored, reversal posted
  await open(o, `/receivables/invoices/${INV}`)
  const b1 = await balance()
  await o.locator('summary', { hasText: 'Anular pago' }).first().click()
  await o.locator('form').filter({ has: o.locator('input[name="payment_id"]') }).filter({ has: o.locator('input[name="reason"]') }).first().locator('input[name="reason"]').fill('Cheque devuelto por el banco')
  r = await act(o, o.locator('form').filter({ has: o.locator('input[name="payment_id"]') }).filter({ has: o.locator('input[name="reason"]') }).first().locator('button[type="submit"]'))
  const voidedPay = await db(`payments?document_id=eq.${INV}&voided_at=not.is.null&select=amount,void_reason`)
  check(r.done === 'payment_voided' && voidedPay.length === 1 && await balance() > b1, 'D4: a client payment is voided (bounced check): the balance goes back up, the payment is kept as voided',
    `${r.done} ${r.error} ${JSON.stringify(voidedPay)} ${b1} → ${await balance()}`)
  check((await api('member@e2e.local', `/rest/v1/collection_notes?select=id`).then((x) => x.json())).length === 0, 'D4: a member does not read collection notes')

  // ============================================================ D5 · bank: account page, matching, line operations, reconciliation
  const acct = async (code) => (await db(`ledger_accounts?company_id=eq.${COMPANY}&code=eq.${code}&select=id`))[0]?.id
  const [A1010, A6100] = [await acct('1010'), await acct('6100') ?? await acct('6200')]
  // a cash payment out of the bank account, already in the books (the entry form itself is covered by finance.auth.e2e.mjs)
  const manual = await api('owner@e2e.local', '/rest/v1/rpc/ledger_post_manual', { method: 'POST', body: JSON.stringify({ target: COMPANY, entry_date: today,
    description: 'Pago de servicio de limpieza', reference: 'TRF-88', lines: [{ account: A6100, debit: 7500 }, { account: A1010, credit: 7500 }], idempotency_key: 'flows-bank-1' }) })
  check(manual.status < 300, 'D5 setup: a 75.00 payment out of 1010 is in the ledger', String(manual.status))
  await open(o, '/bank')
  if (await o.getByRole('button', { name: /Activar banca|Activate banking/ }).count()) await act(o, o.getByRole('button', { name: /Activar banca|Activate banking/ }))
  await open(o, '/bank/accounts')
  const baf = o.locator('form').filter({ has: o.locator('select[name="ledger_account_id"]') })
  await baf.locator('input[name="name"]').fill('Banco Flujos')
  await baf.locator('select[name="ledger_account_id"]').selectOption(A1010)
  r = await act(o, baf.locator('button[type="submit"]'))
  const BANK = (await db(`bank_accounts?company_id=eq.${COMPANY}&name=eq.Banco%20Flujos&select=id`))[0]?.id
  check(!!BANK, 'D5: a bank account linked to 1010', `${r.done} ${r.error}`)
  await open(o, '/bank/import')
  const csv = join(work, 'flujos.csv')
  const mdy = `${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)}`
  writeFileSync(csv, `Fecha,Descripcion,Importe\n${mdy},Pago servicio limpieza TRF-88,-75.00\n${mdy},Comision mensual,-12.50\n`)
  if (await o.locator('select[name="bank_account_id"]').count()) await o.locator('select[name="bank_account_id"]').first().selectOption(BANK)
  await o.setInputFiles('input[type="file"][name="file"]', csv); await o.waitForTimeout(800)
  await o.selectOption('select:has(option[value="YMD"])', 'MDY'); await o.waitForTimeout(400)
  await Promise.all([o.waitForURL(/done=|error=/, { timeout: 20000 }).catch(() => {}), o.locator('button[type="submit"]:not([disabled])', { hasText: /2/ }).first().click()])
  const lines = async () => db(`bank_lines?bank_account_id=eq.${BANK}&select=id,description,status,amount_cents&order=amount_cents`)
  check((await lines()).length === 2, 'D5: the statement is imported (2 lines)', JSON.stringify(await lines()))
  r = await open(o, `/bank/accounts/${BANK}`)
  check(!r.broken && /Pago servicio limpieza/.test(r.body) && /Comision mensual/.test(r.body), 'D5: the account page lists the imported lines')
  r = await act(o, o.getByRole('button', { name: 'Emparejar exactos' }))
  const pay = (await lines()).find((x) => /limpieza/.test(x.description)), fee = (await lines()).find((x) => /Comision/.test(x.description))
  check(pay?.status === 'matched' && fee?.status === 'unmatched', 'D5: exact matching pairs the 75.00 line with its ledger entry (the fee stays open)', JSON.stringify(await lines()))
  // the fee has no entry: post it from the line (counter account proposed: 6500 bank fees)
  r = await open(o, `/bank/lines/${fee.id}`)
  check(!r.broken, 'D5: the bank line page opens')
  r = await act(o, o.locator('form').filter({ has: o.locator('select[name="counter_account_id"]') }).locator('button[type="submit"]'))
  check(r.done === 'posted' && (await lines()).find((x) => x.id === fee.id)?.status === 'matched', 'D5: the bank fee is posted from its line (entry created and matched)', `${r.done} ${r.error}`)
  // undo a match with a reason, then match again from the suggestion
  await open(o, `/bank/lines/${pay.id}`)
  await o.locator('summary', { hasText: 'Deshacer emparejamiento' }).click()
  await o.locator('form').filter({ has: o.locator('input[name="group_id"]') }).locator('input[name="reason"]').fill('Revisión del emparejamiento')
  r = await act(o, o.locator('form').filter({ has: o.locator('input[name="group_id"]') }).locator('button[type="submit"]'))
  check(r.done === 'unmatched' && (await lines()).find((x) => x.id === pay.id)?.status === 'unmatched', 'D5: a match is undone with a reason', `${r.done} ${r.error}`)
  const sugg = o.locator('form').filter({ has: o.locator('input[name="method"][value="suggestion"]') }).first()
  check(await sugg.count() === 1, 'D5: the line page suggests its ledger counterpart')
  if (await sugg.count()) { r = await act(o, sugg.locator('button[type="submit"]')); check((await lines()).find((x) => x.id === pay.id)?.status === 'matched', 'D5: matched again from the suggestion', `${r.done} ${r.error}`) }
  // reconcile this month: opening 0.00, closing −87.50 → difference 0 → close; reopen with a reason
  await open(o, '/bank/reconciliations')
  await o.locator('details').filter({ has: o.locator('summary', { hasText: 'Nueva conciliación' }) }).evaluate((d) => { d.open = true })   // open by default when there is none yet
  const rcf = o.locator('form').filter({ has: o.locator('input[name="closing"]') })
  await rcf.locator('select[name="bank_account_id"]').selectOption(BANK)
  await rcf.locator('input[name="period_start"]').fill(`${today.slice(0, 8)}01`); await rcf.locator('input[name="period_end"]').fill(today)
  await rcf.locator('input[name="opening"]').fill('0.00'); await rcf.locator('input[name="closing"]').fill('-87.50')
  r = await act(o, rcf.locator('button[type="submit"]'))
  const REC = /\/bank\/reconciliations\/([0-9a-f-]{36})/.exec(r.url)?.[1]
  check(r.done === 'created' && !!REC, 'D5: a reconciliation of this month is created from the statement balances', `${r.done} ${r.error}`)
  r = await act(o, o.getByRole('button', { name: 'Cerrar conciliación' }))
  const rec = async () => (await db(`bank_reconciliations?id=eq.${REC}&select=status`))[0]?.status
  check(r.done === 'closed' && await rec() === 'closed', 'D5: with no difference the reconciliation is closed', `${r.done} ${r.error} ${r.body.match(/[^\n]*(Diferencia|difference)[^\n]*/i)?.[0] ?? ''}`)
  await o.locator('summary', { hasText: 'Reabrir conciliación' }).click()
  await o.locator('form').filter({ has: o.locator('input[name="reason"]') }).filter({ hasText: 'Reabrir' }).locator('input[name="reason"]').fill('Falta una línea del banco')
  r = await act(o, o.getByRole('button', { name: 'Reabrir', exact: true }))
  check(r.done === 'reopened' && await rec() === 'open', 'D5: a closed reconciliation is reopened with a reason', `${r.done} ${r.error}`)
  r = await open(mem.page, `/bank/reconciliations/${REC}`)
  const memRec = await api('member@e2e.local', `/rest/v1/bank_reconciliations?id=eq.${REC}&select=id`).then((x) => x.json())
  check(/Solo el propietario y los administradores acceden a bancos/.test(r.body) && !/Falta una línea del banco|87[.,]50/.test(r.body) && memRec.length === 0,
    'D5: a member is told banking is for the owner and admins (no data on the page, none through the API)')

  // ============================================================ D2 · ledger: accounts, reversal, period close / reopen
  await open(o, '/accounting/accounts')
  await o.locator('summary', { hasText: 'Nueva cuenta' }).click()
  const naf = o.locator('form').filter({ has: o.locator('input[name="code"]:not([type="hidden"])') }).first()
  await naf.locator('input[name="code"]').fill('6950'); await naf.locator('input[name="name"]').fill('Gastos varios flujos'); await naf.locator('input[name="name_en"]').fill('Misc. flow expenses')
  r = await act(o, naf.locator('button[type="submit"]'))
  const NEWACC = (await db(`ledger_accounts?company_id=eq.${COMPANY}&code=eq.6950&select=id,type,status,name_en`))[0]
  check(!!NEWACC && NEWACC.type === 'expense' && NEWACC.name_en === 'Misc. flow expenses', 'D2 accounts: a new expense account 6950 (with its English name)', `${r.done} ${r.error}`)
  await o.locator('details').filter({ has: o.locator(`form input[name="id"][value="${NEWACC?.id}"]`) }).first().evaluate((d) => { d.open = true })
  r = await act(o, o.locator(`form:has(input[name="id"][value="${NEWACC?.id}"]):has(input[name="status"])`).locator('button[type="submit"]'))
  check((await db(`ledger_accounts?id=eq.${NEWACC?.id}&select=status`))[0]?.status === 'archived', 'D2 accounts: an unused account is archived', `${r.done} ${r.error}`)
  // reversal of a manual entry: the original is kept, a reversing entry is posted
  const E = await api('owner@e2e.local', '/rest/v1/rpc/ledger_post_manual', { method: 'POST', body: JSON.stringify({ target: COMPANY, entry_date: today,
    description: 'Ajuste de prueba flujos', reference: 'AJ-1', lines: [{ account: A6100, debit: 1234 }, { account: await acct('1000'), credit: 1234 }], idempotency_key: 'flows-rev-1' }) }).then((x) => x.json())
  await open(o, `/accounting/journal?from=${today}&to=${today}`)
  await o.locator(`details:has(form input[name="id"][value="${E}"])`).evaluate((d) => { d.open = true })
  const rvf = o.locator(`form:has(input[name="id"][value="${E}"])`)
  await rvf.locator('input[name="reason"]').fill('Importe registrado por error')
  r = await act(o, rvf.locator('button[type="submit"]'))
  const rev = await db(`journal_entries?reverses_entry_id=eq.${E}&select=id,reversal_reason`)
  check(r.done === 'reversed' && rev.length === 1 && rev[0].reversal_reason === 'Importe registrado por error' && (await db(`journal_entries?id=eq.${E}&select=id`)).length === 1,
    'D2: a manual entry is reversed with a reason (original kept, one reversing entry)', `${r.done} ${r.error} ${JSON.stringify(rev)}`)
  check(await o.locator(`details:has(form input[name="id"][value="${E}"])`).count() === 0, 'D2: a reversed entry offers no second reversal')
  // close last month; it refuses new entries; reopen with a reason
  const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1)
  const LM = d.toISOString().slice(0, 10)
  await open(o, '/accounting/periods')
  r = await act(o, o.locator(`form:has(input[name="month"][value="${LM.slice(0, 7)}"])`).getByRole('button', { name: 'Cerrar mes' }))
  const per = async () => (await db(`accounting_periods?company_id=eq.${COMPANY}&period_month=eq.${LM}&select=status,reopen_reason`))[0]
  check(r.done === 'closed' && (await per())?.status === 'closed', `D2 periods: ${LM.slice(0, 7)} is closed by the owner`, `${r.done} ${r.error}`)
  const late = await api('owner@e2e.local', '/rest/v1/rpc/ledger_post_manual', { method: 'POST', body: JSON.stringify({ target: COMPANY, entry_date: `${LM.slice(0, 8)}15`,
    description: 'Asiento tardío', reference: null, lines: [{ account: A6100, debit: 100 }, { account: await acct('1000'), credit: 100 }], idempotency_key: 'flows-late-1' }) })
  check(late.status >= 400 && /PERIOD_CLOSED/.test(await late.text()), 'D2 periods: an entry dated in the closed month is refused (PERIOD_CLOSED)', String(late.status))
  const rpf = o.locator(`form:has(input[name="month"][value="${LM.slice(0, 7)}"]):has(input[name="reason"])`)
  await rpf.locator('input[name="reason"]').fill('Factura de proveedor recibida tarde')
  r = await act(o, rpf.getByRole('button', { name: 'Reabrir' }))
  check(r.done && (await per())?.status === 'open' && (await per())?.reopen_reason === 'Factura de proveedor recibida tarde' && /Reabierto por/.test(r.body),
    'D2 periods: reopened with a reason, shown on the page', `${r.done} ${r.error}`)
  r = await open(mem.page, '/accounting/periods')
  check(await mem.page.getByRole('button', { name: 'Cerrar mes' }).count() === 0, 'D2 periods: a member cannot close months')

  // ============================================================ the detail pages in English and on an iPhone
  const details = [
    [`/payables/${B1}`, /Payments/, /Attachments \(receipts and invoices\)/, /Adjuntos \(recibos|Registrar pago/],
    [`/payables/${gen[0]?.id}/edit`, /Lines by category|Save draft/, /Vendor/, /Guardar borrador/],
    [`/payables/vendors/${vendor.id}`, /Suplidora Flujos/, /Expenses|Vendor/, /Proveedores|Nuevo proveedor/],
    ['/payables/settings', /Save rules/, /New category|Approval/, /Guardar reglas/],
    ['/payables/recurring', /New template|Recurring/, /Alquiler de almacén/, /Nueva plantilla/],
    [`/receivables/invoices/${INV}`, /Payment promises/, /Reminders/, /Promesas de pago|Recordatorios/],
    [`/receivables/clients/${CLIENT}`, /Client record|Statement|Open invoices/, /Cliente Uno|Demo/, /Ficha del cliente/],
    ['/receivables/settings', /Sender name/, /Reply-to/, /Nombre del remitente/],
    [`/receivables/reports?from=${inDays(-90)}&to=${today}`, /From|To/, /Cliente Uno|Demo/, /Desde.*Hasta/],
    [`/bank/accounts/${BANK}`, /Match exact ones|Matched/, /Pago servicio limpieza/, /Emparejar exactos/],
    [`/bank/lines/${fee.id}`, /Comision mensual/, /Bank|Banking/, /Deshacer emparejamiento|Bancos/],
    [`/bank/reconciliations/${REC}`, /Close reconciliation|Correct statement balances/, /Banco Flujos/i, /Cerrar conciliación/],
    ['/accounting/periods', /Close month|Reopened by/, /Open|Closed/, /Cerrar mes|Reabierto por/],
    ['/accounting/accounts', /New account/, /6950/, /Nueva cuenta/],
  ]
  const en = await session('owner@e2e.local', {}, 'en')
  for (const [path, a1, a2, es] of details) {
    const rr = await open(en.page, path)
    check(!rr.broken && rr.status < 400 && a1.test(rr.body) && a2.test(rr.body) && !es.test(rr.body), `English: ${path.split('?')[0].replace(/[0-9a-f-]{36}/g, '[id]')} is in English`,
      `${rr.status} ${(rr.body.match(es) ?? [''])[0]} ${rr.body.slice(0, 120).replace(/\s+/g, ' ')}`)
  }
  await en.ctx.close()
  const phone = await session('owner@e2e.local', { ...devices['iPhone 13'] })
  for (const [path] of details) {
    await open(phone.page, path)
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 1 && process.env.DEBUG_OVERFLOW) console.log('OVERFLOW', path, await phone.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map((e) => `${e.tagName}.${(e.className?.baseVal ?? e.className ?? '').toString().slice(0, 80)} r=${Math.round(e.getBoundingClientRect().right)} «${(e.textContent ?? '').trim().slice(0, 40)}»`)))
    check(overflow <= 1, `iPhone 13: ${path.split('?')[0].replace(/[0-9a-f-]{36}/g, '[id]')} has no horizontal page scroll`, `${overflow}px`)
  }
  await phone.ctx.close()

  await owner.ctx.close(); await adm.ctx.close(); await mem.ctx.close()
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

/**
 * The assistant's tools (SERVER ONLY). Each tool:
 *   - is offered to the model only when the user holds its permissions (and
 *     the plan includes the module), and checks them again when it runs;
 *   - runs with the USER'S session: PostgreSQL RLS and the module functions
 *     apply exactly as on the screens (no service role, no SQL text);
 *   - takes the company from the session, never from the model;
 *   - validates its input with zod (strict JSON schema for the model) and
 *     returns bounded, minimal data (row caps, no pay rates, no secrets);
 *   - never issues, sends, pays or deletes. The only write is a PROPOSAL
 *     (assistant_actions) that the user must confirm in the interface.
 */
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { activePayments } from '@/lib/documents/payments'
import { workforceAccess, workforceRules, type WorkforceAccess } from '@/lib/workforce/context'
import { buildReport } from '@/lib/workforce/report'
import { loadBalance, loadIncome } from '@/lib/finance/finance-page'
import { KINDS, type Kind } from '@/lib/studio/model'
import { assertDraftIsSafe, ruleAssistant } from '@/lib/studio/assistant'

export const PERMISSION_KEYS = ['clients.view', 'clients.create', 'documents.view', 'documents.create', 'documents.edit', 'payments.view', 'payments.record',
  'receivables.view', 'payables.view', 'payables.create', 'accounting.view', 'studio.view', 'studio.edit', 'studio.issue'] as const
export type PermissionKey = (typeof PERMISSION_KEYS)[number]
export type Access = { perms: Record<PermissionKey, boolean>; workforce: WorkforceAccess; features: { employees: boolean; timeClock: boolean } }

export type ToolContext = { supabase: SupabaseClient; companyId: string; userId: string; locale: Locale; today: string; conversationId: string; access: Access; currency: string }
type Def<S extends z.ZodObject> = {
  name: string
  description: string
  schema: S
  allowed: (a: Access) => boolean
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>
}
const def = <S extends z.ZodObject>(d: Def<S>) => d as unknown as Def<z.ZodObject>

/** The user's permissions in the active company, read once per turn. */
export async function loadAccess(supabase: SupabaseClient, companyId: string, userId: string): Promise<Access> {
  const [answers, workforce, emp, clock] = await Promise.all([
    Promise.all(PERMISSION_KEYS.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    workforceAccess(supabase, companyId, userId),
    supabase.rpc('company_feature', { target: companyId, feature: 'employees' }),
    supabase.rpc('company_feature', { target: companyId, feature: 'time_clock' }),
  ])
  const perms = Object.fromEntries(PERMISSION_KEYS.map((k, i) => [k, !answers[i].error && answers[i].data === true])) as Record<PermissionKey, boolean>
  const feature = (r: { data: unknown; error: unknown }) => !r.error && ((r.data ?? []) as { available: boolean }[])[0]?.available === true
  return { perms, workforce, features: { employees: feature(emp), timeClock: feature(clock) } }
}

// ------------------------------------------------------------- helpers
const DAY = /^\d{4}-\d{2}-\d{2}$/
const uuid = z.uuid()
const limit = z.number().int().min(1).max(50).optional()
const cap = (n: number | undefined, d = 20) => Math.min(Math.max(n ?? d, 1), 50)
const money = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100) / 100
const cents = (n: number | string | bigint | null | undefined) => Number(BigInt(n ?? 0)) / 100
const monthStart = (d: string) => `${d.slice(0, 7)}-01`
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
function fail(code: string): never { throw new ToolError(code) }
export class ToolError extends Error { constructor(readonly code: string) { super(code) } }
const dbFail = (error: { code?: string; message?: string } | null) => { if (error) fail(/FORBIDDEN|permission denied/i.test(error.message ?? '') ? 'forbidden' : 'data_unavailable') }

async function clientNames(supabase: SupabaseClient, companyId: string, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))]
  if (!unique.length) return new Map<string, string>()
  const { data } = await supabase.from('clients').select('id, name').eq('company_id', companyId).in('id', unique.slice(0, 200))
  return new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
}

// ------------------------------------------------------------- tools
const overview = def({
  name: 'get_business_overview',
  description: 'Key figures of the active company today: receivables (open and overdue balances), invoices issued and payments received this month, open payables and cash per the ledger. Sections the user may not see are listed in not_authorized. Use it for "how is the business doing", dashboards and KPI questions.',
  schema: z.object({}).strict(),
  allowed: (a) => a.perms['receivables.view'] || a.perms['documents.view'] || a.perms['payments.view'] || a.perms['payables.view'] || a.perms['accounting.view'],
  async run(ctx) {
    const { supabase, companyId, access: { perms }, today } = ctx
    const out: Record<string, unknown> = { as_of: today, currency: ctx.currency }
    const denied: string[] = []
    const ms = monthStart(today)
    await Promise.all([
      (async () => {
        if (!perms['receivables.view']) return denied.push('receivables')
        const { data, error } = await supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }); dbFail(error)
        const rows = ((data ?? []) as { balance_cents: number; days_past_due: number | null }[]).filter((r) => BigInt(r.balance_cents) > 0n)
        const overdue = rows.filter((r) => (r.days_past_due ?? 0) > 0)
        out.receivables = { open_invoices: rows.length, open_balance: rows.reduce((s, r) => s + cents(r.balance_cents), 0), overdue_invoices: overdue.length, overdue_balance: overdue.reduce((s, r) => s + cents(r.balance_cents), 0) }
      })(),
      (async () => {
        if (!perms['documents.view']) return denied.push('invoiced_this_month')
        const { data, error } = await supabase.from('documents').select('total, status').eq('company_id', companyId).eq('document_type', 'invoice')
          .gte('issue_date', ms).lte('issue_date', today).not('status', 'in', '(draft,cancelled)').limit(5000); dbFail(error)
        const rows = (data ?? []) as { total: number }[]
        out.invoiced_this_month = { invoices: rows.length, total: money(rows.reduce((s, r) => s + Number(r.total), 0)), from: ms, to: today }
      })(),
      (async () => {
        if (!perms['payments.view']) return denied.push('collected_this_month')
        const { data, error } = await supabase.from('payments').select('*').eq('company_id', companyId).gte('paid_at', `${ms}T00:00:00-04:00`).limit(10000); dbFail(error)
        const rows = activePayments((data ?? []) as { amount: number }[])
        out.collected_this_month = { payments: rows.length, total: money(rows.reduce((s, r) => s + Number(r.amount), 0)), from: ms, to: today }
      })(),
      (async () => {
        if (!perms['payables.view']) return denied.push('payables')
        const { data, error } = await supabase.from('bills').select('total_cents, paid_cents, due_date').eq('company_id', companyId).in('status', ['approved', 'scheduled', 'partially_paid']).limit(5000); dbFail(error)
        const rows = ((data ?? []) as { total_cents: number; paid_cents: number; due_date: string | null }[]).map((b) => ({ due: b.due_date, bal: cents(b.total_cents) - cents(b.paid_cents) })).filter((b) => b.bal > 0)
        const overdue = rows.filter((b) => b.due && b.due < today)
        out.payables = { open_bills: rows.length, open_balance: rows.reduce((s, b) => s + b.bal, 0), overdue_bills: overdue.length, overdue_balance: overdue.reduce((s, b) => s + b.bal, 0) }
      })(),
      (async () => {
        if (!perms['accounting.view']) return denied.push('cash')
        const { rows, error } = await loadBalance(supabase, companyId, today)
        if (error) { out.cash = { available: false }; return }
        out.cash = { available: true, balance: rows.filter((r) => r.section === 'cash').reduce((s, r) => s + cents(r.amount_cents), 0), source: 'general ledger (posted entries only)' }
      })(),
    ])
    out.not_authorized = denied
    return out
  },
})

const invoices = def({
  name: 'list_invoices',
  description: 'Customer invoices with their real balance (total, paid, balance, days past due). status: open (balance > 0), overdue (balance > 0 and past due), paid, all. Optional client_id.',
  schema: z.object({ status: z.enum(['open', 'overdue', 'paid', 'all']).optional(), client_id: uuid.optional(), limit }).strict(),
  allowed: (a) => a.perms['receivables.view'],
  async run(ctx, input) {
    const { data, error } = await ctx.supabase.rpc('ar_invoice_balances', { target: ctx.companyId, as_of: null }); dbFail(error)
    type R = { document_id: string; client_id: string | null; document_number: string; issue_date: string; due_date: string | null; total_cents: number; paid_cents: number; balance_cents: number; days_past_due: number | null }
    let rows = (data ?? []) as R[]
    if (input.client_id) rows = rows.filter((r) => r.client_id === input.client_id)
    const st = input.status ?? 'open'
    rows = rows.filter((r) => st === 'all' || (st === 'paid' ? BigInt(r.balance_cents) <= 0n : BigInt(r.balance_cents) > 0n && (st === 'open' || (r.days_past_due ?? 0) > 0)))
    rows.sort((a, b) => (b.days_past_due ?? 0) - (a.days_past_due ?? 0) || b.issue_date.localeCompare(a.issue_date))
    const total = rows.length
    const shown = rows.slice(0, cap(input.limit))
    const names = ctx.access.perms['clients.view'] ? await clientNames(ctx.supabase, ctx.companyId, shown.map((r) => r.client_id)) : new Map()
    return {
      currency: ctx.currency, filter: st, total_matching: total, shown: shown.length, sum_balance: rows.reduce((s, r) => s + cents(r.balance_cents), 0),
      invoices: shown.map((r) => ({ number: r.document_number, client: r.client_id ? names.get(r.client_id) ?? null : null, issue_date: r.issue_date, due_date: r.due_date,
        total: cents(r.total_cents), paid: cents(r.paid_cents), balance: cents(r.balance_cents), days_past_due: r.days_past_due ?? 0, link: `/receivables/invoices/${r.document_id}` })),
    }
  },
})

const payments = def({
  name: 'list_payments',
  description: 'Payments received from customers (voided payments excluded) between two dates (YYYY-MM-DD, default: this month).',
  schema: z.object({ from: z.string().regex(DAY).optional(), to: z.string().regex(DAY).optional(), limit }).strict(),
  allowed: (a) => a.perms['payments.view'],
  async run(ctx, input) {
    const from = input.from ?? monthStart(ctx.today), to = input.to ?? ctx.today
    if (from > to || daysBetween(from, to) > 3 * 366) fail('invalid_range')
    const { data, error } = await ctx.supabase.from('payments').select('*').eq('company_id', ctx.companyId).gte('paid_at', `${from}T00:00:00-04:00`).lt('paid_at', `${to}T23:59:59.999-04:00`)
      .order('paid_at', { ascending: false }).limit(5000); dbFail(error)
    const rows = activePayments((data ?? []) as { id: string; document_id: string; amount: number; payment_method: string | null; paid_at: string }[])
    const shown = rows.slice(0, cap(input.limit))
    const docIds = [...new Set(shown.map((p) => p.document_id))]
    const { data: docs } = docIds.length && ctx.access.perms['documents.view'] ? await ctx.supabase.from('documents').select('id, document_number').in('id', docIds) : { data: [] }
    const num = new Map(((docs ?? []) as { id: string; document_number: string }[]).map((d) => [d.id, d.document_number]))
    return { currency: ctx.currency, from, to, total_matching: rows.length, sum: money(rows.reduce((s, p) => s + Number(p.amount), 0)),
      payments: shown.map((p) => ({ date: p.paid_at.slice(0, 10), amount: money(p.amount), method: p.payment_method, document: num.get(p.document_id) ?? null, link: `/documents/${p.document_id}` })) }
  },
})

const bills = def({
  name: 'list_bills',
  description: 'Supplier bills / expenses (accounts payable) with balance. status: open (approved, scheduled or partially paid), overdue, pending_approval, draft, paid, all.',
  schema: z.object({ status: z.enum(['open', 'overdue', 'pending_approval', 'draft', 'paid', 'all']).optional(), limit }).strict(),
  allowed: (a) => a.perms['payables.view'],
  async run(ctx, input) {
    const st = input.status ?? 'open'
    let q = ctx.supabase.from('bills').select('id, vendor_id, vendor_invoice_number, bill_date, due_date, description, total_cents, paid_cents, status, currency').eq('company_id', ctx.companyId)
    if (st === 'open' || st === 'overdue') q = q.in('status', ['approved', 'scheduled', 'partially_paid'])
    else if (st !== 'all') q = q.eq('status', st)
    const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false }).limit(2000); dbFail(error)
    type B = { id: string; vendor_id: string; vendor_invoice_number: string | null; bill_date: string; due_date: string | null; description: string; total_cents: number; paid_cents: number; status: string; currency: string }
    let rows = (data ?? []) as B[]
    if (st === 'overdue') rows = rows.filter((b) => b.due_date && b.due_date < ctx.today)
    const shown = rows.slice(0, cap(input.limit))
    const vIds = [...new Set(shown.map((b) => b.vendor_id))]
    const { data: vend } = vIds.length ? await ctx.supabase.from('vendors').select('id, name').in('id', vIds) : { data: [] }
    const vn = new Map(((vend ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]))
    return { filter: st, total_matching: rows.length, sum_balance: rows.reduce((s, b) => s + cents(b.total_cents) - cents(b.paid_cents), 0),
      bills: shown.map((b) => ({ vendor: vn.get(b.vendor_id) ?? null, vendor_invoice: b.vendor_invoice_number, description: b.description, bill_date: b.bill_date, due_date: b.due_date,
        status: b.status, currency: b.currency, total: cents(b.total_cents), paid: cents(b.paid_cents), balance: cents(b.total_cents) - cents(b.paid_cents), link: `/payables/${b.id}` })) }
  },
})

const budget = def({
  name: 'get_budget_status',
  description: 'Budgets of a fiscal year and, for the published company-wide base budget, budget vs actual to date (totals and lines with alerts). Actuals come from the general ledger.',
  schema: z.object({ fiscal_year: z.number().int().min(2000).max(2100).optional() }).strict(),
  allowed: (a) => a.perms['accounting.view'],
  async run(ctx, input) {
    const year = input.fiscal_year ?? Number(ctx.today.slice(0, 4))
    const { data, error } = await ctx.supabase.from('budgets').select('id, name, status, scenario, version, department_id').eq('company_id', ctx.companyId).eq('fiscal_year', year).limit(50); dbFail(error)
    const list = (data ?? []) as { id: string; name: string; status: string; scenario: string; version: number; department_id: string | null }[]
    const main = list.find((b) => b.status === 'published' && b.scenario === 'base' && !b.department_id)
    const out: Record<string, unknown> = { fiscal_year: year, currency: ctx.currency, budgets: list.map((b) => ({ name: b.name, status: b.status, scenario: b.scenario, version: b.version, company_wide: !b.department_id, link: `/finance/budgets/${b.id}` })) }
    if (!main) return { ...out, budget_vs_actual: null, note: 'No published company-wide base budget for this year.' }
    const asOf = ctx.today.slice(0, 4) === String(year) ? ctx.today : `${year}-12-31`
    const { data: bva, error: e2 } = await ctx.supabase.rpc('budget_vs_actual', { budget: main.id, as_of: asOf }); dbFail(e2)
    type L = { kind: string; label: string; label_en: string | null; line_type: string; budget_total_cents: number; budget_ytd_cents: number; actual_cents: number; variance_cents: number; consumed_pct: number | null; favorable: boolean | null; alert: string | null; in_total: boolean }
    const lines = (bva ?? []) as L[]
    const sum = (t: string, k: keyof L) => lines.filter((l) => l.in_total && l.line_type === t).reduce((s, l) => s + cents(l[k] as number), 0)
    return { ...out, as_of: asOf, budget_vs_actual: {
      budget: main.name,
      revenue: { budget_year: sum('revenue', 'budget_total_cents'), budget_to_date: sum('revenue', 'budget_ytd_cents'), actual: sum('revenue', 'actual_cents') },
      costs: { budget_year: sum('expense', 'budget_total_cents'), budget_to_date: sum('expense', 'budget_ytd_cents'), actual: sum('expense', 'actual_cents') },
      alerts: lines.filter((l) => l.alert).slice(0, 15).map((l) => ({ line: ctx.locale === 'en' ? l.label_en ?? l.label : l.label, alert: l.alert, consumed_pct: l.consumed_pct, variance: cents(l.variance_cents), favorable: l.favorable })),
    } }
  },
})

const clients = def({
  name: 'search_clients',
  description: 'Find clients by name, business name or e-mail (empty query: most recent). Returns id, name, contact and status.',
  schema: z.object({ query: z.string().max(80).optional(), include_inactive: z.boolean().optional(), limit }).strict(),
  allowed: (a) => a.perms['clients.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('clients').select('id, name, business_name, email, phone, city, status, created_at', { count: 'exact' }).eq('company_id', ctx.companyId)
    const term = (input.query ?? '').replace(/[%_,()\\*]/g, ' ').trim()
    if (term) q = q.or(`name.ilike.%${term}%,business_name.ilike.%${term}%,email.ilike.%${term}%`)
    if (!input.include_inactive) q = q.eq('status', 'active')
    const { data, error, count } = await q.order('created_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    return { total_matching: count ?? null, clients: ((data ?? []) as { id: string; name: string; business_name: string | null; email: string | null; phone: string | null; city: string | null; status: string }[])
      .map((c) => ({ id: c.id, name: c.name, business_name: c.business_name, email: c.email, phone: c.phone, city: c.city, status: c.status, link: `/clients/${c.id}` })) }
  },
})

const client = def({
  name: 'get_client',
  description: 'One client: contact data, open balance and overdue invoices (if the user may see receivables) and recent documents (if the user may see documents).',
  schema: z.object({ client_id: uuid }).strict(),
  allowed: (a) => a.perms['clients.view'],
  async run(ctx, input) {
    const { data, error } = await ctx.supabase.from('clients').select('id, name, business_name, email, phone, address, city, state, postal_code, status, created_at').eq('company_id', ctx.companyId).eq('id', input.client_id).maybeSingle(); dbFail(error)
    if (!data) fail('not_found')
    const out: Record<string, unknown> = { client: { ...data, link: `/clients/${input.client_id}` }, currency: ctx.currency }
    if (ctx.access.perms['receivables.view']) {
      const { data: ar } = await ctx.supabase.rpc('ar_invoice_balances', { target: ctx.companyId, as_of: null })
      const rows = ((ar ?? []) as { client_id: string | null; document_number: string; balance_cents: number; days_past_due: number | null; due_date: string | null }[]).filter((r) => r.client_id === input.client_id && BigInt(r.balance_cents) > 0n)
      out.receivables = { open_invoices: rows.length, open_balance: rows.reduce((s, r) => s + cents(r.balance_cents), 0),
        overdue: rows.filter((r) => (r.days_past_due ?? 0) > 0).slice(0, 10).map((r) => ({ number: r.document_number, balance: cents(r.balance_cents), due_date: r.due_date, days_past_due: r.days_past_due })) }
    } else out.receivables = 'not_authorized'
    if (ctx.access.perms['documents.view']) {
      const { data: docs } = await ctx.supabase.from('documents').select('id, document_type, document_number, status, total, issue_date').eq('company_id', ctx.companyId).eq('client_id', input.client_id).order('issue_date', { ascending: false }).limit(10)
      out.recent_documents = ((docs ?? []) as { id: string; document_type: string; document_number: string; status: string; total: number; issue_date: string }[])
        .map((d) => ({ type: d.document_type, number: d.document_number, status: d.status, total: money(d.total), issue_date: d.issue_date, link: `/documents/${d.id}` }))
    } else out.recent_documents = 'not_authorized'
    return out
  },
})

const documents = def({
  name: 'list_documents',
  description: 'Business documents (quotes, invoices, receipts, work orders, letters…) with number, client, status, total and dates. Filters: type, status, text in number or title.',
  schema: z.object({ type: z.enum(['quote', 'invoice', 'receipt', 'work_order', 'letter', 'payment_reminder', 'contract', 'report']).optional(),
    status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).optional(), query: z.string().max(60).optional(), limit }).strict(),
  allowed: (a) => a.perms['documents.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('documents').select('id, client_id, document_type, document_number, title, status, total, issue_date, due_date', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (input.type) q = q.eq('document_type', input.type)
    if (input.status) q = q.eq('status', input.status)
    const term = (input.query ?? '').replace(/[%_,()\\*]/g, ' ').trim()
    if (term) q = q.or(`document_number.ilike.%${term}%,title.ilike.%${term}%`)
    const { data, error, count } = await q.order('issue_date', { ascending: false }).order('created_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    const rows = (data ?? []) as { id: string; client_id: string | null; document_type: string; document_number: string; title: string | null; status: string; total: number; issue_date: string; due_date: string | null }[]
    const names = ctx.access.perms['clients.view'] ? await clientNames(ctx.supabase, ctx.companyId, rows.map((r) => r.client_id)) : new Map()
    return { currency: ctx.currency, total_matching: count ?? null, documents: rows.map((d) => ({ type: d.document_type, number: d.document_number, title: d.title, client: d.client_id ? names.get(d.client_id) ?? null : null,
      status: d.status, total: money(d.total), issue_date: d.issue_date, due_date: d.due_date, link: `/documents/${d.id}` })) }
  },
})

const employees = def({
  name: 'list_employees',
  description: 'Employees the user manages or supervises: name, number, position, department, status, hire date. No pay data.',
  schema: z.object({ query: z.string().max(60).optional(), include_inactive: z.boolean().optional(), limit }).strict(),
  allowed: (a) => a.features.employees && (a.workforce.manages || a.workforce.supervisedDepartments.length > 0),
  async run(ctx, input) {
    let q = ctx.supabase.from('employees').select('id, first_name, last_name, employee_number, position, status, hire_date, department_id', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (!input.include_inactive) q = q.eq('status', 'active')
    const term = (input.query ?? '').replace(/[%_,()\\*]/g, ' ').trim()
    if (term) q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,employee_number.ilike.%${term}%`)
    const [{ data, error, count }, { data: depts }] = await Promise.all([q.order('first_name').limit(cap(input.limit, 30)), ctx.supabase.from('departments').select('id, name').eq('company_id', ctx.companyId)]); dbFail(error)
    const dn = new Map(((depts ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]))
    return { total_matching: count ?? null, employees: ((data ?? []) as { id: string; first_name: string; last_name: string; employee_number: string | null; position: string | null; status: string; hire_date: string | null; department_id: string | null }[])
      .map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}`, number: e.employee_number, position: e.position, department: e.department_id ? dn.get(e.department_id) ?? null : null, status: e.status, hire_date: e.hire_date, link: `/workforce/employees/${e.id}` })) }
  },
})

const attendance = def({
  name: 'get_attendance_report',
  description: 'Attendance per employee between two dates (YYYY-MM-DD, at most 62 days): worked, regular and overtime hours, late days, absences, leave days, days to review. Computed with the company rules from the time clock punches.',
  schema: z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY), employee_id: uuid.optional() }).strict(),
  allowed: (a) => a.features.timeClock && (a.workforce.manages || a.workforce.supervisedDepartments.length > 0),
  async run(ctx, input) {
    if (input.from > input.to || daysBetween(input.from, input.to) > 62) fail('invalid_range')
    const rules = await workforceRules(ctx.supabase, ctx.companyId)
    const rows = await buildReport(ctx.supabase, { companyId: ctx.companyId, from: input.from, to: input.to, rules, employee: input.employee_id ?? null })
    const h = (m: number) => Math.round(m / 6) / 10
    return { from: input.from, to: input.to, employees: rows.length, rows: rows.slice(0, 50).map((r) => ({ name: r.name, number: r.number, department: r.department,
      worked_hours: h(r.totals.workedMinutes), regular_hours: h(r.totals.regularMinutes), overtime_hours: h(r.totals.overtimeMinutes), scheduled_hours: h(r.totals.scheduledMinutes),
      late_days: r.totals.lateDays, absences: r.totals.absences, leave_days: r.totals.leaveDays, open_sessions: r.totals.openSessions, days_to_review: r.totals.reviewDays })),
      link: `/workforce/reports?from=${input.from}&to=${input.to}` }
  },
})

const income = def({
  name: 'get_income_statement',
  description: 'Income statement (profit and loss) between two dates (YYYY-MM-DD) from the posted general ledger: revenue, cost of sales, expenses, net income and the largest accounts.',
  schema: z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY) }).strict(),
  allowed: (a) => a.perms['accounting.view'],
  async run(ctx, input) {
    if (input.from > input.to || daysBetween(input.from, input.to) > 3 * 366) fail('invalid_range')
    const { rows, error } = await loadIncome(ctx.supabase, ctx.companyId, input); dbFail(error)
    const by = (s: string) => rows.filter((r) => r.section === s).reduce((t, r) => t + cents(r.amount_cents), 0)
    const sections = [...new Set(rows.map((r) => r.section))]
    const totals = Object.fromEntries(sections.map((s) => [s, by(s)]))
    const revenue = rows.filter((r) => /revenue|income/i.test(r.section)).reduce((t, r) => t + cents(r.amount_cents), 0)
    const costs = rows.filter((r) => !/revenue|income/i.test(r.section)).reduce((t, r) => t + cents(r.amount_cents), 0)
    return { currency: ctx.currency, from: input.from, to: input.to, totals_by_section: totals, revenue, costs, net_income: revenue - costs,
      ledger_has_entries: rows.some((r) => BigInt(r.amount_cents) !== 0n),
      top_accounts: [...rows].filter((r) => BigInt(r.amount_cents) !== 0n).sort((a, b) => Math.abs(cents(b.amount_cents)) - Math.abs(cents(a.amount_cents))).slice(0, 12)
        .map((r) => ({ section: r.section, code: r.code, account: ctx.locale === 'en' ? r.name_en ?? r.name : r.name, amount: cents(r.amount_cents) })),
      link: `/finance/income-statement?period=custom&from=${input.from}&to=${input.to}` }
  },
})

const studioDocs = def({
  name: 'list_studio_documents',
  description: 'Document Studio documents (letters, contracts, reports, certificates…): title, kind, status (draft, final, archived), number.',
  schema: z.object({ query: z.string().max(60).optional(), status: z.enum(['draft', 'final', 'archived']).optional(), limit }).strict(),
  allowed: (a) => a.perms['studio.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('studio_documents').select('id, kind, title, status, number, origin, updated_at').eq('company_id', ctx.companyId)
    if (input.status) q = q.eq('status', input.status)
    const term = (input.query ?? '').replace(/[%_,()\\*]/g, ' ').trim()
    if (term) q = q.ilike('title', `%${term}%`)
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    return { documents: ((data ?? []) as { id: string; kind: string; title: string; status: string; number: string | null; origin: string; updated_at: string }[])
      .map((d) => ({ title: d.title, kind: d.kind, status: d.status, number: d.number, created_by_assistant: d.origin === 'assistant', updated: d.updated_at.slice(0, 10), link: `/studio/${d.id}` })) }
  },
})

const proposeDraft = def({
  name: 'propose_studio_draft',
  description: 'PROPOSE creating a Document Studio DRAFT (letter, report, contract, certificate, quote layout…). Nothing is created until the user presses Confirm in the interface; tell the user to review and confirm it. The body is written from `instruction` (plain text, no amounts for invoice/quote/receipt/statement: those come from the business document). Optionally bind a client, a business document, an employee or a vendor by id (the database checks the user may read them). The draft is never issued or sent.',
  schema: z.object({ kind: z.enum(KINDS as unknown as [Kind, ...Kind[]]), title: z.string().min(1).max(160), instruction: z.string().min(5).max(4000),
    client_id: uuid.optional(), document_id: uuid.optional(), employee_id: uuid.optional(), vendor_id: uuid.optional() }).strict(),
  allowed: (a) => a.perms['studio.edit'],
  async run(ctx, input) {
    const draft = await ruleAssistant.draft({ instruction: input.instruction, kind: input.kind, locale: ctx.locale }, {})
    const safe = assertDraftIsSafe(draft)
    if (!safe.ok) fail(safe.error === 'amounts_in_text' ? 'amounts_not_allowed_in_text' : 'invalid_content')
    const payload = { kind: input.kind, title: input.title.replace(/[<>]/g, ''), instruction: input.instruction.replace(/[<>]/g, ''),
      refs: { client: input.client_id ?? null, source_document: input.document_id ?? null, employee: input.employee_id ?? null, vendor: input.vendor_id ?? null } }
    const summary = `${ctx.locale === 'en' ? 'Create draft' : 'Crear borrador'}: ${payload.title}`.slice(0, 400)
    const { data, error } = await ctx.supabase.rpc('assistant_propose_action', { conv: ctx.conversationId, act_kind: 'studio_draft', act_summary: summary, act_payload: payload })
    if (error) fail(/FORBIDDEN/.test(error.message) ? 'forbidden' : /too_many_pending/.test(error.hint ?? error.message) ? 'too_many_pending_actions' : 'proposal_failed')
    return { action_id: data as string, status: 'awaiting_user_confirmation', level: 'draft', note: 'Shown to the user with Confirm / Cancel buttons. Not created yet.' }
  },
})

const OPERATIONS = {
  new_invoice: { perm: 'documents.create', level: 'execute', link: (i: { client_id?: string }) => `/documents/new?type=invoice${i.client_id ? `&client=${i.client_id}` : ''}` },
  new_quote: { perm: 'documents.create', level: 'execute', link: (i: { client_id?: string }) => `/documents/new?type=quote${i.client_id ? `&client=${i.client_id}` : ''}` },
  record_payment: { perm: 'payments.record', level: 'execute', link: (i: { document_id?: string }) => (i.document_id ? `/payments/new?document=${i.document_id}` : '/payments/new') },
  send_or_issue_invoice: { perm: 'documents.edit', level: 'issue', link: (i: { document_id?: string }) => (i.document_id ? `/documents/${i.document_id}` : '/documents') },
  new_client: { perm: 'clients.create', level: 'execute', link: () => '/clients' },
  new_bill: { perm: 'payables.create', level: 'execute', link: () => '/payables/new' },
  issue_studio_document: { perm: 'studio.issue', level: 'issue', link: (i: { studio_document_id?: string }) => (i.studio_document_id ? `/studio/${i.studio_document_id}` : '/studio') },
} as const satisfies Record<string, { perm: PermissionKey; level: 'execute' | 'issue'; link: (i: Record<string, string | undefined>) => string }>

const prepare = def({
  name: 'prepare_operation',
  description: 'Prepare an operation that the USER must complete and confirm on its own screen (create an invoice or quote, record a payment, send/issue an invoice, add a client or a bill, issue a Studio document). Returns the link to that screen, prefilled where possible. It does not execute anything: never say it was done.',
  schema: z.object({ operation: z.enum(Object.keys(OPERATIONS) as [keyof typeof OPERATIONS, ...(keyof typeof OPERATIONS)[]]), client_id: uuid.optional(), document_id: uuid.optional(), studio_document_id: uuid.optional() }).strict(),
  allowed: () => true,
  async run(ctx, input) {
    const op = OPERATIONS[input.operation]
    if (!ctx.access.perms[op.perm]) fail('forbidden')
    return { operation: input.operation, level: op.level, link: op.link(input as Record<string, string | undefined>), executed: false, user_must_complete_and_confirm_on_screen: true }
  },
})

export const TOOLS: Def<z.ZodObject>[] = [overview, invoices, payments, bills, budget, clients, client, documents, employees, attendance, income, studioDocs, proposeDraft, prepare]
export const TOOL_NAMES = TOOLS.map((t) => t.name)
export const findTool = (name: string) => TOOLS.find((t) => t.name === name)

/** JSON schema for strict tool use: no numeric / length / pattern keywords (validated here with zod instead). */
export function strictSchema(schema: z.ZodObject): Anthropic.Tool['input_schema'] {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (!v || typeof v !== 'object') return v
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'multipleOf'].includes(k)) continue
      o[k] = strip(x)
    }
    if (o.type === 'object') o.additionalProperties = false
    return o
  }
  return strip(raw) as Anthropic.Tool['input_schema']
}

/** The tools this user may use now, as sent to the model. */
export function toolsFor(access: Access): Anthropic.Tool[] {
  return TOOLS.filter((t) => t.allowed(access)).map((t) => ({ name: t.name, description: t.description, input_schema: strictSchema(t.schema), strict: true }))
}

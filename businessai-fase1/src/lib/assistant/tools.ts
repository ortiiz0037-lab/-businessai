/**
 * The assistant's tools (SERVER ONLY). Each tool:
 *   - is offered to the model only when the user holds its permissions (and
 *     the plan includes the module), and checks them again when it runs;
 *   - runs with the USER'S session: PostgreSQL RLS and the module functions
 *     apply exactly as on the screens (no service role, no SQL text);
 *   - takes the company from the session, never from the model;
 *   - validates its input with zod (strict JSON schema for the model);
 *   - returns TYPED data (every field has a declared kind, money as exact
 *     decimal strings built from integer cents) with metadata: company
 *     currency, period / as_of, source and whether the result is complete.
 *     Totals come from SQL over every row (0030), never from a page of rows.
 *   - never issues, sends, pays or deletes. The only write is a PROPOSAL
 *     tied to the server's open turn, confirmed later by the user.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { toCents } from '@/lib/finance/money'
import { incomeTotals, type StatementRow } from '@/lib/finance/statements'
import { loadBalance, loadIncome, loadQuality } from '@/lib/finance/finance-page'
import { workforceRules } from '@/lib/workforce/context'
import { buildReport } from '@/lib/workforce/report'
import { KINDS, type Kind as StudioKind } from '@/lib/studio/model'
import { assertDraftIsSafe, ruleAssistant } from '@/lib/studio/assistant'
import { calculate, centsToDecimal, minutesToHours, type FactStore, type Kind, type ToolOutput } from '@/lib/intelligence/facts'
import type { Tier, ToolSpec } from '@/lib/intelligence/types'

export const PERMISSION_KEYS = ['clients.view', 'clients.create', 'documents.view', 'documents.create', 'documents.edit', 'payments.view', 'payments.record',
  'receivables.view', 'payables.view', 'payables.create', 'accounting.view', 'bank.view', 'studio.view', 'studio.edit', 'studio.issue'] as const
export type PermissionKey = (typeof PERMISSION_KEYS)[number]
export type Access = { perms: Record<PermissionKey, boolean>; workforce: { manages: boolean; supervisedDepartments: string[]; directReports?: number }; features: { employees: boolean; timeClock: boolean } }
/** Manages the workforce or supervises someone (a department or direct reports, 0033). */
const supervises = (a: Access) => a.workforce.manages || a.workforce.supervisedDepartments.length > 0 || (a.workforce.directReports ?? 0) > 0

export type ToolContext = {
  supabase: SupabaseClient; companyId: string; userId: string; locale: Locale; today: string; turnId: string
  access: Access; currency: string; facts: FactStore
}
export type ToolDef = {
  name: string
  description: string
  schema: z.ZodObject
  minTier: Tier
  allowed: (a: Access) => boolean
  run: (ctx: ToolContext, input: never) => Promise<ToolOutput>
}
const def = <S extends z.ZodObject>(d: { name: string; description: string; schema: S; minTier: Tier; allowed: (a: Access) => boolean; run: (ctx: ToolContext, input: z.infer<S>) => Promise<ToolOutput> }) => d as unknown as ToolDef

/** The caller's permissions, plan features and workforce scope in ONE call (0030 assistant_access). */
export async function loadAccess(supabase: SupabaseClient, companyId: string, userId?: string): Promise<Access> {
  const [{ data, error }, direct] = await Promise.all([
    supabase.rpc('assistant_access', { target: companyId, keys: [...PERMISSION_KEYS] }),
    // direct reports (0033): RLS returns only employees this user may see
    userId ? supabase.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('supervisor_user_id', userId) : Promise.resolve({ count: 0, error: null }),
  ])
  const j = (error ? null : data) as { perms?: Record<string, boolean>; features?: { employees?: boolean; time_clock?: boolean }; workforce?: { manages?: boolean; supervised?: string[] } } | null
  return {
    perms: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, j?.perms?.[k] === true])) as Access['perms'],
    workforce: { manages: j?.workforce?.manages === true, supervisedDepartments: Array.isArray(j?.workforce?.supervised) ? j!.workforce!.supervised! : [],
      directReports: direct.error ? 0 : direct.count ?? 0 },
    features: { employees: j?.features?.employees === true, timeClock: j?.features?.time_clock === true },
  }
}

// ------------------------------------------------------------- helpers
const DAY = /^\d{4}-\d{2}-\d{2}$/
const uuid = z.uuid()
const limit = z.number().int().min(1).max(50).optional()
const cap = (n: number | undefined, d = 20) => Math.min(Math.max(n ?? d, 1), 50)
const money = (c: bigint | number | string | null | undefined) => centsToDecimal(toCents(c ?? 0))
/** documents.total / payments.amount are numeric(12,2): read as text → exact cents */
const numericToCents = (v: number | string | null | undefined): bigint => {
  const s = typeof v === 'number' ? v.toFixed(2) : String(v ?? '0')
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) throw new ToolError('bad_amount')
  const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -c : c
}
const monthStart = (d: string) => `${d.slice(0, 7)}-01`
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
/** Puerto Rico has no daylight saving time: the offset is fixed at UTC−4. */
const PR = '-04:00'
export class ToolError extends Error { constructor(readonly code: string) { super(code) } }
function fail(code: string): never { throw new ToolError(code) }
const dbFail = (error: { code?: string; message?: string } | null) => { if (error) fail(/FORBIDDEN|permission denied/i.test(error.message ?? '') ? 'forbidden' : 'data_unavailable') }
const term = (s: string | undefined) => (s ?? '').replace(/[%_,()\\*.:]/g, ' ').trim()
const out = (data: Record<string, unknown>, kinds: Record<string, Kind>, meta: ToolOutput['meta']): ToolOutput => ({ data, kinds, meta })

async function clientNames(supabase: SupabaseClient, companyId: string, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))]
  if (!unique.length) return new Map<string, string>()
  const { data } = await supabase.from('clients').select('id, name').eq('company_id', companyId).in('id', unique.slice(0, 100))
  return new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
}

// ------------------------------------------------------------- tools
const overview = def({
  name: 'get_business_overview',
  description: 'Key figures of the active company today, computed in the database over every record: receivables (open and overdue), invoices issued and payments received this month, open payables (per currency) and cash per the posted ledger. Sections the user may not see are listed in not_authorized.',
  schema: z.object({}).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['receivables.view'] || a.perms['documents.view'] || a.perms['payments.view'] || a.perms['payables.view'] || a.perms['accounting.view'],
  async run(ctx) {
    const { supabase, companyId, access: { perms }, today } = ctx
    const ms = monthStart(today)
    const data: Record<string, unknown> = { as_of: today, currency: ctx.currency }
    const denied: string[] = []
    await Promise.all([
      (async () => {
        if (!perms['receivables.view']) return denied.push('receivables')
        const { data: r, error } = await supabase.rpc('assistant_ar_summary', { target: companyId, client: null }); dbFail(error)
        const s = ((r ?? []) as { open_count: number; open_cents: string; overdue_count: number; overdue_cents: string }[])[0]
        data.receivables = { open_invoices: s?.open_count ?? 0, open_balance: money(s?.open_cents), overdue_invoices: s?.overdue_count ?? 0, overdue_balance: money(s?.overdue_cents) }
      })(),
      (async () => {
        if (!perms['documents.view']) return denied.push('invoiced_this_month')
        const { data: r, error } = await supabase.rpc('assistant_invoiced', { target: companyId, from_date: ms, to_date: today }); dbFail(error)
        const s = ((r ?? []) as { invoices: number; total_cents: string }[])[0]
        data.invoiced_this_month = { invoices: s?.invoices ?? 0, total: money(s?.total_cents), from: ms, to: today }
      })(),
      (async () => {
        if (!perms['payments.view']) return denied.push('collected_this_month')
        const { data: r, error } = await supabase.rpc('assistant_collected', { target: companyId, from_date: ms, to_date: today }); dbFail(error)
        const s = ((r ?? []) as { payments: number; total_cents: string }[])[0]
        data.collected_this_month = { payments: s?.payments ?? 0, total: money(s?.total_cents), from: ms, to: today }
      })(),
      (async () => {
        if (!perms['payables.view']) return denied.push('payables')
        const { data: r, error } = await supabase.rpc('assistant_ap_summary', { target: companyId }); dbFail(error)
        data.payables = ((r ?? []) as { currency: string; open_count: number; open_cents: string; overdue_count: number; overdue_cents: string }[])
          .map((x) => ({ currency: x.currency, open_bills: x.open_count, open_balance: money(x.open_cents), overdue_bills: x.overdue_count, overdue_balance: money(x.overdue_cents) }))
      })(),
      (async () => {
        if (!perms['accounting.view']) return denied.push('cash')
        const { rows, error } = await loadBalance(supabase, companyId, today)
        if (error) { data.cash = { available: false }; return }
        data.cash = { available: true, balance: money(rows.filter((r) => r.section === 'cash').reduce((s, r) => s + toCents(r.amount_cents), 0n)), source: 'posted general ledger' }
      })(),
    ])
    data.not_authorized = denied
    return out(data, { open_invoices: 'count', open_balance: 'money', overdue_invoices: 'count', overdue_balance: 'money', invoices: 'count', total: 'money', payments: 'count',
      open_bills: 'count', overdue_bills: 'count', balance: 'money', as_of: 'date', from: 'date', to: 'date' },
      { source: 'assistant_ar_summary, assistant_invoiced, assistant_collected, assistant_ap_summary, fs_balance_sheet', complete: true, currency: ctx.currency, as_of: today })
  },
})

const invoices = def({
  name: 'list_invoices',
  description: 'Customer invoices with their real balance (total, paid, balance, days past due). status: open (balance > 0), overdue (balance > 0 and past due), paid, all. Optional client_id. total_matching and sum_balance cover every matching invoice (not only the rows shown).',
  schema: z.object({ status: z.enum(['open', 'overdue', 'paid', 'all']).optional(), client_id: uuid.optional(), limit }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['receivables.view'],
  async run(ctx, input) {
    const st = input.status ?? 'open'
    let q = ctx.supabase.rpc('ar_invoice_balances', { target: ctx.companyId, as_of: null }, { count: 'exact' })
    if (input.client_id) q = q.eq('client_id', input.client_id)
    if (st === 'open') q = q.gt('balance_cents', 0)
    else if (st === 'overdue') q = q.gt('balance_cents', 0).gt('days_past_due', 0)
    else if (st === 'paid') q = q.lte('balance_cents', 0)
    const { data, error, count } = await q.order('days_past_due', { ascending: false }).order('issue_date', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    type R = { document_id: string; client_id: string | null; document_number: string; issue_date: string; due_date: string | null; total_cents: number; paid_cents: number; balance_cents: number; days_past_due: number | null }
    const rows = (data ?? []) as R[]
    let sum: string | null = null
    if (st === 'open' || st === 'overdue') {
      const { data: s, error: e2 } = await ctx.supabase.rpc('assistant_ar_summary', { target: ctx.companyId, client: input.client_id ?? null }); dbFail(e2)
      const x = ((s ?? []) as { open_cents: string; overdue_cents: string }[])[0]
      sum = money(st === 'open' ? x?.open_cents : x?.overdue_cents)
    }
    const names = ctx.access.perms['clients.view'] ? await clientNames(ctx.supabase, ctx.companyId, rows.map((r) => r.client_id)) : new Map()
    return out({
      filter: st, as_of: ctx.today, total_matching: count ?? rows.length, shown: rows.length, sum_balance: sum,
      invoices: rows.map((r) => ({ number: r.document_number, client: r.client_id ? names.get(r.client_id) ?? null : null, issue_date: r.issue_date, due_date: r.due_date,
        total: money(r.total_cents), paid: money(r.paid_cents), balance: money(r.balance_cents), days_past_due: r.days_past_due ?? 0, link: `/receivables/invoices/${r.document_id}` })),
    }, { total_matching: 'count', shown: 'count', sum_balance: 'money', number: 'text', issue_date: 'date', due_date: 'date', total: 'money', paid: 'money', balance: 'money', days_past_due: 'count', as_of: 'date' },
    { source: 'ar_invoice_balances + assistant_ar_summary', complete: count === null ? false : true, currency: ctx.currency, as_of: ctx.today })
  },
})

const payments = def({
  name: 'list_payments',
  description: 'Payments received from customers (voided payments excluded) between two dates (YYYY-MM-DD, default: this month, Puerto Rico calendar days). total_matching and sum cover every payment of the period.',
  schema: z.object({ from: z.string().regex(DAY).optional(), to: z.string().regex(DAY).optional(), limit }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['payments.view'],
  async run(ctx, input) {
    const from = input.from ?? monthStart(ctx.today), to = input.to ?? ctx.today
    if (from > to || daysBetween(from, to) > 3 * 366) fail('invalid_range')
    const end = new Date(Date.parse(`${to}T00:00:00${PR}`) + 86_400_000).toISOString()
    const [{ data, error, count }, sum] = await Promise.all([
      ctx.supabase.from('payments').select('id, document_id, amount, payment_method, paid_at', { count: 'exact' }).eq('company_id', ctx.companyId).is('voided_at', null)
        .gte('paid_at', `${from}T00:00:00${PR}`).lt('paid_at', end).order('paid_at', { ascending: false }).limit(cap(input.limit)),
      ctx.supabase.rpc('assistant_collected', { target: ctx.companyId, from_date: from, to_date: to }),
    ]); dbFail(error); dbFail(sum.error)
    const rows = (data ?? []) as { id: string; document_id: string; amount: number | string; payment_method: string | null; paid_at: string }[]
    const docIds = [...new Set(rows.map((p) => p.document_id))]
    const { data: docs } = docIds.length && ctx.access.perms['documents.view'] ? await ctx.supabase.from('documents').select('id, document_number').in('id', docIds) : { data: [] }
    const num = new Map(((docs ?? []) as { id: string; document_number: string }[]).map((d) => [d.id, d.document_number]))
    const s = ((sum.data ?? []) as { payments: number; total_cents: string }[])[0]
    return out({ from, to, total_matching: s?.payments ?? count ?? rows.length, shown: rows.length, sum: money(s?.total_cents),
      payments: rows.map((p) => ({ date: new Date(Date.parse(p.paid_at) - 4 * 3_600_000).toISOString().slice(0, 10), amount: centsToDecimal(numericToCents(p.amount)), method: p.payment_method, document: num.get(p.document_id) ?? null, link: `/documents/${p.document_id}` })) },
    { total_matching: 'count', shown: 'count', sum: 'money', amount: 'money', date: 'date', from: 'date', to: 'date', document: 'text' },
    { source: 'payments + assistant_collected', complete: true, currency: ctx.currency, from, to })
  },
})

const bills = def({
  name: 'list_bills',
  description: 'Supplier bills / expenses (accounts payable) with balance. status: open (approved, scheduled or partially paid), overdue, pending_approval, draft, paid, all. For open / overdue, totals per currency cover every matching bill.',
  schema: z.object({ status: z.enum(['open', 'overdue', 'pending_approval', 'draft', 'paid', 'all']).optional(), limit }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['payables.view'],
  async run(ctx, input) {
    const st = input.status ?? 'open'
    let q = ctx.supabase.from('bills').select('id, vendor_id, vendor_invoice_number, bill_date, due_date, description, total_cents, paid_cents, status, currency', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (st === 'open' || st === 'overdue') q = q.in('status', ['approved', 'scheduled', 'partially_paid'])
    else if (st !== 'all') q = q.eq('status', st)
    if (st === 'overdue') q = q.lt('due_date', ctx.today)
    const { data, error, count } = await q.order('due_date', { ascending: true, nullsFirst: false }).limit(cap(input.limit)); dbFail(error)
    type B = { id: string; vendor_id: string; vendor_invoice_number: string | null; bill_date: string; due_date: string | null; description: string; total_cents: number; paid_cents: number; status: string; currency: string }
    const rows = (data ?? []) as B[]
    let totals: unknown[] | null = null
    if (st === 'open' || st === 'overdue') {
      const { data: s, error: e2 } = await ctx.supabase.rpc('assistant_ap_summary', { target: ctx.companyId }); dbFail(e2)
      totals = ((s ?? []) as { currency: string; open_count: number; open_cents: string; overdue_count: number; overdue_cents: string }[])
        .map((x) => ({ currency: x.currency, bills: st === 'open' ? x.open_count : x.overdue_count, balance: money(st === 'open' ? x.open_cents : x.overdue_cents) }))
    }
    const vIds = [...new Set(rows.map((b) => b.vendor_id))]
    const { data: vend } = vIds.length ? await ctx.supabase.from('vendors').select('id, name').in('id', vIds) : { data: [] }
    const vn = new Map(((vend ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]))
    return out({ filter: st, as_of: ctx.today, total_matching: count ?? rows.length, shown: rows.length, totals_by_currency: totals,
      bills: rows.map((b) => ({ vendor: vn.get(b.vendor_id) ?? null, vendor_invoice: b.vendor_invoice_number, description: b.description, bill_date: b.bill_date, due_date: b.due_date,
        status: b.status, currency: b.currency, total: money(b.total_cents), paid: money(b.paid_cents), balance: money(toCents(b.total_cents) - toCents(b.paid_cents)), link: `/payables/${b.id}` })) },
    { total_matching: 'count', shown: 'count', bills: 'count', balance: 'money', total: 'money', paid: 'money', bill_date: 'date', due_date: 'date', vendor_invoice: 'text', as_of: 'date' },
    { source: 'bills + assistant_ap_summary', complete: count !== null, currency: ctx.currency, as_of: ctx.today })
  },
})

const budget = def({
  name: 'get_budget_status',
  description: 'Budgets of a fiscal year and, for the published company-wide base budget, budget vs actual to date (totals and lines with alerts). Actuals come from the posted general ledger.',
  schema: z.object({ fiscal_year: z.number().int().min(2000).max(2100).optional() }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['accounting.view'],
  async run(ctx, input) {
    const year = input.fiscal_year ?? Number(ctx.today.slice(0, 4))
    const { data, error } = await ctx.supabase.from('budgets').select('id, name, status, scenario, version, department_id').eq('company_id', ctx.companyId).eq('fiscal_year', year).limit(50); dbFail(error)
    const list = (data ?? []) as { id: string; name: string; status: string; scenario: string; version: number; department_id: string | null }[]
    const main = list.find((b) => b.status === 'published' && b.scenario === 'base' && !b.department_id)
    const kinds: Record<string, Kind> = { fiscal_year: 'count', version: 'count', budget_year: 'money', budget_to_date: 'money', actual: 'money', variance: 'money', consumed_pct: 'percent', as_of: 'date' }
    const base = { fiscal_year: year, budgets: list.map((b) => ({ name: b.name, status: b.status, scenario: b.scenario, version: b.version, company_wide: !b.department_id, link: `/finance/budgets/${b.id}` })) }
    if (!main) return out({ ...base, budget_vs_actual: null, note: 'No published company-wide base budget for this year.' }, kinds, { source: 'budgets', complete: true, currency: ctx.currency })
    const asOf = ctx.today.slice(0, 4) === String(year) ? ctx.today : `${year}-12-31`
    const { data: bva, error: e2 } = await ctx.supabase.rpc('budget_vs_actual', { budget: main.id, as_of: asOf }); dbFail(e2)
    type L = { label: string; label_en: string | null; line_type: string; budget_total_cents: number; budget_ytd_cents: number; actual_cents: number; variance_cents: number; consumed_pct: number | null; favorable: boolean | null; alert: string | null; in_total: boolean }
    const lines = (bva ?? []) as L[]
    const sum = (t: string, k: keyof L) => money(lines.filter((l) => l.in_total && l.line_type === t).reduce((s, l) => s + toCents(l[k] as number), 0n))
    const pct = (v: number | null) => (v === null || v === undefined ? null : String(Math.round(Number(v) * 10) / 10))
    return out({ ...base, as_of: asOf, budget_vs_actual: {
      budget: main.name,
      revenue: { budget_year: sum('revenue', 'budget_total_cents'), budget_to_date: sum('revenue', 'budget_ytd_cents'), actual: sum('revenue', 'actual_cents') },
      costs: { budget_year: sum('expense', 'budget_total_cents'), budget_to_date: sum('expense', 'budget_ytd_cents'), actual: sum('expense', 'actual_cents') },
      alerts: lines.filter((l) => l.alert).slice(0, 15).map((l) => ({ line: ctx.locale === 'en' ? l.label_en ?? l.label : l.label, alert: l.alert, consumed_pct: pct(l.consumed_pct), variance: money(l.variance_cents), favorable: l.favorable })),
    } }, kinds, { source: 'budget_vs_actual (posted ledger)', complete: true, currency: ctx.currency, as_of: asOf })
  },
})

const clients = def({
  name: 'search_clients',
  description: 'Find clients by name, business name or e-mail (empty query: most recent). Returns id, name, contact and status.',
  schema: z.object({ query: z.string().max(80).optional(), include_inactive: z.boolean().optional(), limit }).strict(),
  minTier: 'P1',
  allowed: (a) => a.perms['clients.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('clients').select('id, name, business_name, email, phone, city, status', { count: 'exact' }).eq('company_id', ctx.companyId)
    const t = term(input.query)
    if (t) q = q.or(`name.ilike.%${t}%,business_name.ilike.%${t}%,email.ilike.%${t}%`)
    if (!input.include_inactive) q = q.eq('status', 'active')
    const { data, error, count } = await q.order('created_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    const rows = (data ?? []) as { id: string; name: string; business_name: string | null; email: string | null; phone: string | null; city: string | null; status: string }[]
    return out({ total_matching: count ?? rows.length, shown: rows.length, clients: rows.map((c) => ({ id: c.id, name: c.name, business_name: c.business_name, email: c.email, phone: c.phone, city: c.city, status: c.status, link: `/clients/${c.id}` })) },
      { total_matching: 'count', shown: 'count', name: 'text', business_name: 'text', email: 'text', phone: 'text', city: 'text', id: 'text' }, { source: 'clients', complete: true })
  },
})

const client = def({
  name: 'get_client',
  description: 'One client: contact data, open balance and overdue invoices (if the user may see receivables) and recent documents (if the user may see documents).',
  schema: z.object({ client_id: uuid }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['clients.view'],
  async run(ctx, input) {
    const { data, error } = await ctx.supabase.from('clients').select('id, name, business_name, email, phone, address, city, state, postal_code, status').eq('company_id', ctx.companyId).eq('id', input.client_id).maybeSingle(); dbFail(error)
    if (!data) fail('not_found')
    const res: Record<string, unknown> = { client: { ...data, link: `/clients/${input.client_id}` }, as_of: ctx.today }
    if (ctx.access.perms['receivables.view']) {
      const [{ data: s, error: e1 }, { data: od, error: e2 }] = await Promise.all([
        ctx.supabase.rpc('assistant_ar_summary', { target: ctx.companyId, client: input.client_id }),
        ctx.supabase.rpc('ar_invoice_balances', { target: ctx.companyId, as_of: null }).eq('client_id', input.client_id).gt('balance_cents', 0).gt('days_past_due', 0).order('days_past_due', { ascending: false }).limit(10),
      ]); dbFail(e1); dbFail(e2)
      const x = ((s ?? []) as { open_count: number; open_cents: string; overdue_count: number; overdue_cents: string }[])[0]
      res.receivables = { open_invoices: x?.open_count ?? 0, open_balance: money(x?.open_cents), overdue_invoices: x?.overdue_count ?? 0, overdue_balance: money(x?.overdue_cents),
        overdue: ((od ?? []) as { document_number: string; balance_cents: number; due_date: string | null; days_past_due: number }[]).map((r) => ({ number: r.document_number, balance: money(r.balance_cents), due_date: r.due_date, days_past_due: r.days_past_due })) }
    } else res.receivables = 'not_authorized'
    if (ctx.access.perms['documents.view']) {
      const { data: docs } = await ctx.supabase.from('documents').select('id, document_type, document_number, status, total, issue_date').eq('company_id', ctx.companyId).eq('client_id', input.client_id).order('issue_date', { ascending: false }).limit(10)
      res.recent_documents = ((docs ?? []) as { id: string; document_type: string; document_number: string; status: string; total: number | string; issue_date: string }[])
        .map((d) => ({ type: d.document_type, number: d.document_number, status: d.status, total: centsToDecimal(numericToCents(d.total)), issue_date: d.issue_date, link: `/documents/${d.id}` }))
    } else res.recent_documents = 'not_authorized'
    return out(res, { open_invoices: 'count', open_balance: 'money', overdue_invoices: 'count', overdue_balance: 'money', balance: 'money', total: 'money', due_date: 'date', issue_date: 'date',
      days_past_due: 'count', number: 'text', postal_code: 'text', phone: 'text', address: 'text', id: 'text', email: 'text', as_of: 'date' }, { source: 'clients, assistant_ar_summary, documents', complete: true, currency: ctx.currency, as_of: ctx.today })
  },
})

const documents = def({
  name: 'list_documents',
  description: 'Business documents (quotes, invoices, receipts, work orders, letters…) with number, client, status, total and dates. Filters: type, status, text in number or title. total_matching counts every match.',
  schema: z.object({ type: z.enum(['quote', 'invoice', 'receipt', 'work_order', 'letter', 'payment_reminder', 'contract', 'report']).optional(),
    status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).optional(), query: z.string().max(60).optional(), limit }).strict(),
  minTier: 'P1',
  allowed: (a) => a.perms['documents.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('documents').select('id, client_id, document_type, document_number, title, status, total, issue_date, due_date', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (input.type) q = q.eq('document_type', input.type)
    if (input.status) q = q.eq('status', input.status)
    const t = term(input.query)
    if (t) q = q.or(`document_number.ilike.%${t}%,title.ilike.%${t}%`)
    const { data, error, count } = await q.order('issue_date', { ascending: false }).order('created_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    const rows = (data ?? []) as { id: string; client_id: string | null; document_type: string; document_number: string; title: string | null; status: string; total: number | string; issue_date: string; due_date: string | null }[]
    const names = ctx.access.perms['clients.view'] ? await clientNames(ctx.supabase, ctx.companyId, rows.map((r) => r.client_id)) : new Map()
    return out({ total_matching: count ?? rows.length, shown: rows.length, documents: rows.map((d) => ({ type: d.document_type, number: d.document_number, title: d.title, client: d.client_id ? names.get(d.client_id) ?? null : null,
      status: d.status, total: centsToDecimal(numericToCents(d.total)), issue_date: d.issue_date, due_date: d.due_date, link: `/documents/${d.id}` })) },
    { total_matching: 'count', shown: 'count', number: 'text', title: 'text', total: 'money', issue_date: 'date', due_date: 'date', client: 'text' }, { source: 'documents', complete: true, currency: ctx.currency })
  },
})

const employees = def({
  name: 'list_employees',
  description: 'Employees the user manages or supervises: name, number, position, department, status, hire date. No pay data.',
  schema: z.object({ query: z.string().max(60).optional(), include_inactive: z.boolean().optional(), limit }).strict(),
  minTier: 'P1',
  allowed: (a) => a.features.employees && supervises(a),
  async run(ctx, input) {
    let q = ctx.supabase.from('employees').select('id, first_name, last_name, employee_number, position, status, hire_date, department_id', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (!input.include_inactive) q = q.eq('status', 'active')
    const t = term(input.query)
    if (t) q = q.or(`first_name.ilike.%${t}%,last_name.ilike.%${t}%,employee_number.ilike.%${t}%`)
    const [{ data, error, count }, { data: depts }] = await Promise.all([q.order('first_name').limit(cap(input.limit, 30)), ctx.supabase.from('departments').select('id, name').eq('company_id', ctx.companyId)]); dbFail(error)
    const dn = new Map(((depts ?? []) as { id: string; name: string }[]).map((d) => [d.id, d.name]))
    const rows = (data ?? []) as { id: string; first_name: string; last_name: string; employee_number: string | null; position: string | null; status: string; hire_date: string | null; department_id: string | null }[]
    return out({ total_matching: count ?? rows.length, shown: rows.length, employees: rows.map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}`, number: e.employee_number, position: e.position, department: e.department_id ? dn.get(e.department_id) ?? null : null, status: e.status, hire_date: e.hire_date, link: `/workforce/employees/${e.id}` })) },
      { total_matching: 'count', shown: 'count', number: 'text', hire_date: 'date', name: 'text', id: 'text', position: 'text' }, { source: 'employees', complete: true })
  },
})

const attendance = def({
  name: 'get_attendance_report',
  description: 'Attendance per employee between two dates (YYYY-MM-DD, at most 62 days): worked, regular and overtime hours, late days, absences, leave days, days to review. Computed with the company rules from the time clock punches.',
  schema: z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY), employee_id: uuid.optional() }).strict(),
  minTier: 'P2',
  allowed: (a) => a.features.timeClock && supervises(a),
  async run(ctx, input) {
    if (input.from > input.to || daysBetween(input.from, input.to) > 62) fail('invalid_range')
    const rules = await workforceRules(ctx.supabase, ctx.companyId)
    const rows = await buildReport(ctx.supabase, { companyId: ctx.companyId, from: input.from, to: input.to, rules, employee: input.employee_id ?? null })
    // buildReport reads at most 500 employees: say so when the cap is reached
    const complete = rows.length < 500
    return out({ from: input.from, to: input.to, employees: rows.length, shown: Math.min(rows.length, 50), rows: rows.slice(0, 50).map((r) => ({ name: r.name, number: r.number, department: r.department,
      worked_hours: minutesToHours(r.totals.workedMinutes), regular_hours: minutesToHours(r.totals.regularMinutes), overtime_hours: minutesToHours(r.totals.overtimeMinutes), scheduled_hours: minutesToHours(r.totals.scheduledMinutes),
      late_days: r.totals.lateDays, absences: r.totals.absences, leave_days: r.totals.leaveDays, open_sessions: r.totals.openSessions, days_to_review: r.totals.reviewDays })),
      link: `/workforce/reports?from=${input.from}&to=${input.to}` },
    { from: 'date', to: 'date', employees: 'count', shown: 'count', worked_hours: 'hours', regular_hours: 'hours', overtime_hours: 'hours', scheduled_hours: 'hours', late_days: 'count', absences: 'count',
      leave_days: 'count', open_sessions: 'count', days_to_review: 'count', number: 'text', name: 'text' }, { source: 'workforce buildReport', complete, from: input.from, to: input.to })
  },
})

const workforceStatus = def({
  name: 'get_workforce_status',
  description: 'Workforce status now for the employees the user manages or supervises: active employees, working and on break right now, pending approvals (punch corrections, leave, shift changes), unhandled meal/break alerts and missing punches in the last 7 days (forgotten clock-outs, shifts without a clock-in). Counts only, no names or pay.',
  schema: z.object({}).strict(),
  minTier: 'P2',
  allowed: (a) => a.features.timeClock && supervises(a),
  async run(ctx) {
    const from = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)
    const head = { count: 'exact' as const, head: true }
    const [now, active, corr, leave, shiftReq, alerts, missing] = await Promise.all([
      ctx.supabase.rpc('workforce_now', { target: ctx.companyId }),
      ctx.supabase.from('employees').select('id', head).eq('company_id', ctx.companyId).eq('status', 'active'),
      ctx.supabase.from('punch_corrections').select('id', head).eq('company_id', ctx.companyId).eq('status', 'pending'),
      ctx.supabase.from('leave_requests').select('id', head).eq('company_id', ctx.companyId).eq('status', 'pending'),
      ctx.supabase.from('shift_change_requests').select('id', head).eq('company_id', ctx.companyId).eq('status', 'pending'),
      ctx.supabase.from('meal_alerts').select('id', head).eq('company_id', ctx.companyId).is('acknowledged_at', null),
      ctx.supabase.rpc('wf_missing_punches', { target: ctx.companyId, from_day: from, to_day: ctx.today }),
    ])
    dbFail(now.error ?? active.error ?? corr.error ?? leave.error)
    const states = ((now.data ?? []) as { state: string }[])
    const miss = (missing.error ? [] : (missing.data ?? [])) as { kind: string }[]
    return out({
      as_of: ctx.today, active_employees: active.count ?? 0,
      working_now: states.filter((x) => x.state === 'in' || x.state === 'break_end').length, on_break_now: states.filter((x) => x.state === 'break_start').length,
      pending_corrections: corr.count ?? 0, pending_leave: leave.count ?? 0, pending_shift_changes: shiftReq.error ? 0 : shiftReq.count ?? 0,
      unhandled_meal_alerts: alerts.error ? 0 : alerts.count ?? 0,
      missing_clock_outs: miss.filter((m) => m.kind === 'no_clock_out').length, shifts_without_clock_in: miss.filter((m) => m.kind === 'no_clock_in').length,
      link: '/workforce',
    }, { as_of: 'date', active_employees: 'count', working_now: 'count', on_break_now: 'count', pending_corrections: 'count', pending_leave: 'count', pending_shift_changes: 'count',
      unhandled_meal_alerts: 'count', missing_clock_outs: 'count', shifts_without_clock_in: 'count' },
    { source: 'workforce_now, requests, meal_alerts, wf_missing_punches', complete: true, as_of: ctx.today })
  },
})

const income = def({
  name: 'get_income_statement',
  description: 'Income statement (profit and loss) between two dates (YYYY-MM-DD) from the POSTED general ledger, with the official BusinessAI computation: operating revenue, other income, cost of sales, gross profit, operating expenses, operating result, other expenses, income before tax, income tax, net income, plus data-quality notes (unposted documents, open months).',
  schema: z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY) }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['accounting.view'],
  async run(ctx, input) {
    if (input.from > input.to || daysBetween(input.from, input.to) > 3 * 366) fail('invalid_range')
    const [{ rows, error }, quality] = await Promise.all([loadIncome(ctx.supabase, ctx.companyId, input), loadQuality(ctx.supabase, ctx.companyId, input)]); dbFail(error)
    // the same function the Income statement screen uses (A1: income_tax is a cost, never revenue)
    const t = incomeTotals(rows as StatementRow[])
    const m = (c: bigint) => centsToDecimal(c)
    return out({
      from: input.from, to: input.to,
      operating_revenue: m(t.operatingRevenue), other_income: m(t.otherIncome), cost_of_sales: m(t.costOfSales), gross_profit: m(t.grossProfit),
      operating_expense: m(t.operatingExpense), operating_result: m(t.operatingResult), other_expense: m(t.otherExpense), income_before_tax: m(t.preTax),
      income_tax: m(t.incomeTax), net_income: m(t.net), tax_recorded: t.taxRecorded,
      ledger_has_entries: rows.some((r) => toCents(r.amount_cents) !== 0n),
      data_quality: quality ? { unposted_invoices: quality.unposted_invoices, unposted_payments: quality.unposted_payments, unbalanced_entries: quality.unbalanced_entries,
        months_in_range: quality.months_in_range, closed_months: quality.closed_months } : null,
      top_accounts: [...rows].filter((r) => toCents(r.amount_cents) !== 0n).sort((a, b) => { const x = toCents(b.amount_cents), y = toCents(a.amount_cents); const ax = x < 0n ? -x : x, ay = y < 0n ? -y : y; return ax > ay ? 1 : ax < ay ? -1 : 0 }).slice(0, 12)
        .map((r) => ({ section: r.section, code: r.code, account: ctx.locale === 'en' ? r.name_en ?? r.name : r.name, amount: m(toCents(r.amount_cents)) })),
      link: `/finance/income-statement?period=custom&from=${input.from}&to=${input.to}`,
    }, { from: 'date', to: 'date', operating_revenue: 'money', other_income: 'money', cost_of_sales: 'money', gross_profit: 'money', operating_expense: 'money', operating_result: 'money',
      other_expense: 'money', income_before_tax: 'money', income_tax: 'money', net_income: 'money', amount: 'money', code: 'text', account: 'text',
      unposted_invoices: 'count', unposted_payments: 'count', unbalanced_entries: 'count', months_in_range: 'count', closed_months: 'count' },
    { source: 'fs_income_statement + incomeTotals (posted ledger)', complete: true, currency: ctx.currency, from: input.from, to: input.to,
      note: quality && (quality.unposted_invoices > 0 || quality.unposted_payments > 0) ? 'provisional: some documents are not posted to the ledger' : undefined })
  },
})

const bank = def({
  name: 'get_bank_overview',
  description: 'Bank accounts with their statement lines (count, unmatched count and amount), the posted ledger balance of each linked account (only with accounting access) and the last reconciliation (period end, open / closed, difference). Computed in the database over every line. Use it for bank balance and reconciliation questions.',
  schema: z.object({ as_of: z.string().regex(DAY).optional() }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['bank.view'],
  async run(ctx, input) {
    const asOf = input.as_of ?? ctx.today
    const { data, error } = await ctx.supabase.rpc('assistant_bank_summary', { target: ctx.companyId, at_date: asOf }); dbFail(error)
    type A = { account_id: string; account_name: string; bank_name: string | null; currency: string; status: string; lines_count: number; unmatched_count: number; unmatched_cents: string; last_line_date: string | null;
      ledger_balance_cents: string | null; last_rec_period_end: string | null; last_rec_status: string | null; last_rec_difference_cents: string | null }
    const rows = (data ?? []) as A[]
    return out({ as_of: asOf, accounts_count: rows.length, accounts: rows.map((a) => ({
      name: a.account_name, bank: a.bank_name, currency: a.currency, status: a.status, statement_lines: a.lines_count, unmatched_lines: a.unmatched_count, unmatched_amount: money(a.unmatched_cents),
      last_statement_date: a.last_line_date, ledger_balance: a.ledger_balance_cents === null ? 'not_authorized' : money(a.ledger_balance_cents),
      last_reconciliation: a.last_rec_period_end ? { period_end: a.last_rec_period_end, status: a.last_rec_status, difference: money(a.last_rec_difference_cents) } : null,
      link: `/bank/accounts/${a.account_id}` })) },
    { as_of: 'date', accounts_count: 'count', statement_lines: 'count', unmatched_lines: 'count', unmatched_amount: 'money', last_statement_date: 'date', ledger_balance: 'money', period_end: 'date', difference: 'money', name: 'text', bank: 'text' },
    { source: 'assistant_bank_summary (bank lines, posted ledger, reconciliations)', complete: true, as_of: asOf })
  },
})

const studioDocs = def({
  name: 'list_studio_documents',
  description: 'Document Studio documents (letters, contracts, reports, certificates…): title, kind, status (draft, final, archived), number.',
  schema: z.object({ query: z.string().max(60).optional(), status: z.enum(['draft', 'final', 'archived']).optional(), limit }).strict(),
  minTier: 'P1',
  allowed: (a) => a.perms['studio.view'],
  async run(ctx, input) {
    let q = ctx.supabase.from('studio_documents').select('id, kind, title, status, number, origin, updated_at', { count: 'exact' }).eq('company_id', ctx.companyId)
    if (input.status) q = q.eq('status', input.status)
    const t = term(input.query)
    if (t) q = q.ilike('title', `%${t}%`)
    const { data, error, count } = await q.order('updated_at', { ascending: false }).limit(cap(input.limit)); dbFail(error)
    const rows = (data ?? []) as { id: string; kind: string; title: string; status: string; number: string | null; origin: string; updated_at: string }[]
    return out({ total_matching: count ?? rows.length, shown: rows.length, documents: rows.map((d) => ({ title: d.title, kind: d.kind, status: d.status, number: d.number, created_by_assistant: d.origin === 'assistant', updated: d.updated_at.slice(0, 10), link: `/studio/${d.id}` })) },
      { total_matching: 'count', shown: 'count', number: 'text', title: 'text', updated: 'date' }, { source: 'studio_documents', complete: true })
  },
})

const calc = def({
  name: 'calculate',
  description: 'Exact arithmetic over values ALREADY returned by tools in this turn, referenced by path (e.g. "T1.sum_balance", "T2.invoiced_this_month.total"). operation: sum, difference (a − b), percent_of (a as % of b), percent_change (from a to b). Operands must be all money (same currency) or all counts. Use it for every derived figure; never compute in your head.',
  schema: z.object({ operation: z.enum(['sum', 'difference', 'percent_of', 'percent_change']), operands: z.array(z.string().regex(/^T\d{1,3}(\.[A-Za-z0-9_]{1,40}){1,8}$/)).min(2).max(10) }).strict(),
  minTier: 'P1',
  allowed: () => true,
  async run(ctx, input) {
    try { return calculate(ctx.facts, input.operation, input.operands) } catch (e) { fail(String((e as Error).message).replace(/^calc:/, 'calc_').slice(0, 60)) }
  },
})

const proposeDraft = def({
  name: 'propose_studio_draft',
  description: 'PROPOSE creating a Document Studio DRAFT (letter, report, contract, certificate, quote layout…). Nothing is created until the user presses Confirm in the interface; tell the user to review and confirm it. The body is written from `instruction` (plain text, no amounts: amounts come from the business document). Optionally bind a client, a business document, an employee or a vendor by id (the database checks the user may read them). The draft is never issued or sent.',
  schema: z.object({ kind: z.enum(KINDS as unknown as [StudioKind, ...StudioKind[]]), title: z.string().min(1).max(160), instruction: z.string().min(5).max(4000),
    client_id: uuid.optional(), document_id: uuid.optional(), employee_id: uuid.optional(), vendor_id: uuid.optional() }).strict(),
  minTier: 'P2',
  allowed: (a) => a.perms['studio.edit'],
  async run(ctx, input) {
    const draft = await ruleAssistant.draft({ instruction: input.instruction, kind: input.kind, locale: ctx.locale }, {})
    const safe = assertDraftIsSafe(draft)
    if (!safe.ok) fail(safe.error === 'amounts_in_text' ? 'amounts_not_allowed_in_text' : 'invalid_content')
    const payload = { kind: input.kind, title: input.title.replace(/[<>]/g, ''), instruction: input.instruction.replace(/[<>]/g, ''),
      refs: { client: input.client_id ?? null, source_document: input.document_id ?? null, employee: input.employee_id ?? null, vendor: input.vendor_id ?? null } }
    const summary = `${ctx.locale === 'en' ? 'Create draft' : 'Crear borrador'}: ${payload.title}`.slice(0, 400)
    const { data, error } = await ctx.supabase.rpc('assistant_propose', { turn: ctx.turnId, act_kind: 'studio_draft', act_summary: summary, act_payload: payload })
    if (error) fail(/FORBIDDEN/.test(error.message) ? 'forbidden' : /too_many_pending/.test(`${error.hint ?? ''}${error.message}`) ? 'too_many_pending_actions' : 'proposal_failed')
    return out({ action_id: data as string, status: 'awaiting_user_confirmation', level: 'draft', title: payload.title }, { action_id: 'text', title: 'text' },
      { source: 'assistant_propose', complete: true, note: 'Shown to the user with Confirm / Cancel buttons. Not created yet.' })
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
  minTier: 'P1',
  allowed: () => true,
  async run(ctx, input) {
    const op = OPERATIONS[input.operation]
    if (!ctx.access.perms[op.perm]) fail('forbidden')
    return out({ operation: input.operation, level: op.level, link: op.link(input as Record<string, string | undefined>), executed: false, user_must_complete_and_confirm_on_screen: true }, {}, { source: 'prepare_operation', complete: true })
  },
})

export const TOOLS: ToolDef[] = [overview, invoices, payments, bills, budget, clients, client, documents, employees, attendance, workforceStatus, income, bank, studioDocs, calc, proposeDraft, prepare]
export const TOOL_NAMES = TOOLS.map((t) => t.name)
export const findTool = (name: string) => TOOLS.find((t) => t.name === name)

/** JSON schema for strict tool use: numeric / length / pattern keywords are validated here with zod instead. */
export function strictSchema(schema: z.ZodObject): Record<string, unknown> {
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
  return strip(raw) as Record<string, unknown>
}

/** The tools this user may use now, as sent to the model (provider-neutral). */
export function toolsFor(access: Access): ToolSpec[] {
  return TOOLS.filter((t) => t.allowed(access)).map((t) => ({ name: t.name, description: t.description, inputSchema: strictSchema(t.schema) }))
}

import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { formatters, type Locale } from '@/lib/i18n/app'
import { getLocale } from '@/lib/i18n/server'
import { translator } from '@/lib/i18n/t'
import { formatCents } from '@/lib/finance/money'
import { budgetMonths, type BudgetLine } from '@/lib/finance/budget'
import { addMonths, periodRange, previousRange, previousYearRange, project, type Assumptions, type DataQuality, type PeriodKind, type Range, type StatementRow } from '@/lib/finance/statements'

export type FinanceAccess = { view: boolean; manage: boolean; approve: boolean; available: boolean }

export async function financeAccess(supabase: SupabaseClient, companyId: string): Promise<FinanceAccess> {
  const keys = ['accounting.view', 'budgets.manage', 'budgets.approve']
  const [answers, probe] = await Promise.all([
    Promise.all(keys.map((k) => supabase.rpc('has_permission', { target: companyId, permission: k }))),
    supabase.from('budgets').select('id').eq('company_id', companyId).limit(1),
  ])
  const [view, manage, approve] = answers.map((a) => !a.error && a.data === true)
  return { view, manage, approve, available: !probe.error }
}

/** Common context of the finance pages (/finance/*). */
export async function financePage() {
  const locale = await getLocale()
  const tr = translator(locale)
  const f = formatters(locale)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/finance')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  const [access, settings, company] = await Promise.all([
    financeAccess(supabase, member.companyId),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', member.companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', member.companyId).maybeSingle(),
  ])
  const currency = (settings.data as { base_currency?: string } | null)?.base_currency ?? 'USD'
  const money = (c: number | string | bigint | null | undefined) => formatCents(c ?? 0, locale, currency)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const who = async () => {
    const { data } = await supabase.rpc('company_members', { target: member.companyId })
    const m = new Map(((data ?? []) as { user_id: string; email: string | null }[]).map((x) => [x.user_id, x.email ?? '']))
    return (id: string | null) => (id ? m.get(id) || tr('usuario', 'user') : tr('Sistema', 'System'))
  }
  return {
    locale, tr, f, money, today, supabase, user, companyId: member.companyId, access, who,
    currency,
    companyName: (company.data as { name?: string } | null)?.name ?? '',
  }
}

// ------------------------------------------------------------- period from the query string
const DAY = /^\d{4}-\d{2}-\d{2}$/
export type Comparison = 'previous' | 'last_year' | 'none'
export function readPeriod(sp: { period?: string; ref?: string; from?: string; to?: string; compare?: string }, today: string) {
  const kind: PeriodKind = (['month', 'quarter', 'year', 'custom'] as const).includes(sp.period as PeriodKind) ? (sp.period as PeriodKind) : 'month'
  const ref = sp.ref && DAY.test(sp.ref) ? sp.ref : today
  let range: Range
  if (kind === 'custom' && sp.from && sp.to && DAY.test(sp.from) && DAY.test(sp.to) && sp.from <= sp.to) {
    // at most ~5 years to keep queries bounded
    range = Date.parse(sp.to) - Date.parse(sp.from) > 5 * 366 * 86_400_000 ? { from: sp.from, to: new Date(Date.parse(sp.from) + 5 * 365 * 86_400_000).toISOString().slice(0, 10) } : { from: sp.from, to: sp.to }
  } else range = periodRange(kind === 'custom' ? 'month' : kind, ref)
  const k: PeriodKind = kind === 'custom' && !(sp.from && sp.to) ? 'month' : kind
  const compare: Comparison = (['previous', 'last_year', 'none'] as const).includes(sp.compare as Comparison) ? (sp.compare as Comparison) : 'previous'
  const base = compare === 'none' ? null : compare === 'previous' ? previousRange(k, range) : previousYearRange(range)
  return { kind: k, ref, range, compare, base }
}

// ------------------------------------------------------------- loaders (database computes, the app adds up)
export async function loadIncome(supabase: SupabaseClient, companyId: string, r: Range) {
  const { data, error } = await supabase.rpc('fs_income_statement', { target: companyId, from_date: r.from, to_date: r.to })
  return { rows: (data ?? []) as StatementRow[], error }
}
export async function loadBalance(supabase: SupabaseClient, companyId: string, asOf: string) {
  const { data, error } = await supabase.rpc('fs_balance_sheet', { target: companyId, as_of: asOf })
  return { rows: (data ?? []) as StatementRow[], error }
}
export async function loadCashFlow(supabase: SupabaseClient, companyId: string, r: Range) {
  const { data, error } = await supabase.rpc('fs_cash_flow', { target: companyId, from_date: r.from, to_date: r.to })
  return { rows: (data ?? []) as StatementRow[], error }
}
export async function loadQuality(supabase: SupabaseClient, companyId: string, r: Range): Promise<DataQuality | null> {
  const { data } = await supabase.rpc('fs_data_quality', { target: companyId, from_date: r.from, to_date: r.to })
  return ((data ?? []) as DataQuality[])[0] ?? null
}
export type MonthRow = { month: string; revenue_cents: number; cost_of_sales_cents: number; expense_cents: number; tax_cents: number; net_cents: number; cash_change_cents: number; closed: boolean }
export async function loadMonthly(supabase: SupabaseClient, companyId: string, firstMonth: string, months: number) {
  const { data } = await supabase.rpc('fs_monthly', { target: companyId, first_month: firstMonth, months })
  return (data ?? []) as MonthRow[]
}

export type SavedAssumptions = Assumptions & { updatedAt: string | null; saved: boolean }
export async function loadAssumptions(supabase: SupabaseClient, companyId: string): Promise<SavedAssumptions> {
  const { data } = await supabase.from('fs_assumptions').select('*').eq('company_id', companyId).maybeSingle()
  const a = data as { growth_pct: number; collection_pct: number; conservative_pct: number; optimistic_pct: number; horizon_months: number; updated_at: string } | null
  return a ? { growthPct: Number(a.growth_pct), collectionPct: Number(a.collection_pct), conservativePct: Number(a.conservative_pct), optimisticPct: Number(a.optimistic_pct),
    horizon: a.horizon_months, updatedAt: a.updated_at, saved: true }
    : { growthPct: 0, collectionPct: 90, conservativePct: 15, optimisticPct: 10, horizon: 6, updatedAt: null, saved: false }
}

/**
 * Inputs and the three scenarios of the projection. Actuals: the last 12
 * months of the ledger (current month excluded: it is still running), cash
 * today, open invoices and approved bills. Budget: the published base
 * budgets (company-wide) of the projected years.
 */
export async function loadProjection(supabase: SupabaseClient, companyId: string, today: string) {
  const start = today.slice(0, 7)
  const firstHistory = addMonths(start, -12)
  const years = [...new Set(Array.from({ length: 24 }, (_, k) => Number(addMonths(start, k).slice(0, 4))))]
  const [assumptions, history, bs, ar, ap, budgets, accounts, categories] = await Promise.all([
    loadAssumptions(supabase, companyId),
    loadMonthly(supabase, companyId, `${firstHistory}-01`, 12),
    loadBalance(supabase, companyId, today),
    supabase.rpc('ar_invoice_balances', { target: companyId, as_of: null }),
    supabase.from('bills').select('total_cents, paid_cents, due_date').eq('company_id', companyId).in('status', ['approved', 'scheduled', 'partially_paid']).limit(5000),
    supabase.from('budgets').select('id, fiscal_year, name, version').eq('company_id', companyId).eq('status', 'published').eq('scenario', 'base').is('department_id', null).in('fiscal_year', years),
    supabase.from('ledger_accounts').select('id, type').eq('company_id', companyId),
    supabase.from('expense_categories').select('id, account_id').eq('company_id', companyId),
  ])
  const published = (budgets.data ?? []) as { id: string; fiscal_year: number; name: string; version: number }[]
  const { data: lineData } = published.length ? await supabase.from('budget_lines').select('*').in('budget_id', published.map((b) => b.id)) : { data: [] }
  const accountType = new Map(((accounts.data ?? []) as { id: string; type: string }[]).map((a) => [a.id, a.type]))
  const categoryAccount = new Map(((categories.data ?? []) as { id: string; account_id: string }[]).map((c) => [c.id, c.account_id]))
  const budget = new Map<string, { revenue: bigint; costs: bigint }>()
  for (const b of published) for (const [k, v] of budgetMonths(b.fiscal_year, ((lineData ?? []) as BudgetLine[]).filter((l) => l.budget_id === b.id), accountType, categoryAccount)) budget.set(k, v)
  const hist = history.filter((m) => m.month.slice(0, 7) < start).map((m) => ({
    month: m.month.slice(0, 7), revenue: BigInt(m.revenue_cents), costs: BigInt(m.cost_of_sales_cents) + BigInt(m.expense_cents) + BigInt(m.tax_cents) }))
  // only months with activity count as history (no trend from empty months)
  const firstActive = hist.findIndex((m) => m.revenue !== 0n || m.costs !== 0n)
  const usable = firstActive < 0 ? [] : hist.slice(firstActive)
  const cashNow = bs.rows.filter((r) => r.section === 'cash').reduce((s, r) => s + BigInt(r.amount_cents), 0n)
  const receivables = ((ar.data ?? []) as { due_date: string | null; issue_date: string; balance_cents: number }[])
    .filter((r) => BigInt(r.balance_cents) > 0n).map((r) => ({ due: r.due_date ?? r.issue_date, balance: BigInt(r.balance_cents) }))
  const payables = ((ap.data ?? []) as { total_cents: number; paid_cents: number; due_date: string | null }[])
    .map((b) => ({ due: b.due_date ?? today, balance: BigInt(b.total_cents) - BigInt(b.paid_cents) })).filter((b) => b.balance > 0n)
  const input = { start, history: usable, cashNow, receivables, payables, budget, assumptions }
  return {
    assumptions, input, published, history: hist,
    scenarios: { conservative: project(input, 'conservative'), base: project(input, 'base'), optimistic: project(input, 'optimistic') },
  }
}

export const periodName = (kind: PeriodKind, r: Range, f: { date: (s: string) => string }, locale: Locale) => {
  if (kind === 'year') return r.from.slice(0, 4)
  if (kind === 'quarter') return `${locale === 'en' ? 'Q' : 'T'}${Math.floor(Number(r.from.slice(5, 7)) / 3) + 1} ${r.from.slice(0, 4)}`
  if (kind === 'month') return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-PR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${r.from}T00:00:00Z`))
  return `${f.date(r.from)} – ${f.date(r.to)}`
}

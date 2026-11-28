'use server'
/**
 * Budget and projection actions (migration 0027). Every write runs with the
 * user's session through a 0027 function: PostgreSQL checks roles, the
 * draft → approved → published workflow, locks and audit events.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { parseCents } from '@/lib/finance/money'
import { financeErrorCode } from '@/lib/finance/budget'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const num = (f: FormData, k: string): number | null => {
  const v = text(f, k).replace(',', '.')
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/finance(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
}
function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
async function company() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const m = await getActiveMembership(supabase, user.id)
  if (!m) redirect('/onboarding')
  return { supabase, companyId: m.companyId }
}
const refresh = () => revalidatePath('/finance', 'layout')

export async function createBudget(formData: FormData) {
  const back = backTo(formData, '/finance/budgets')
  const name = text(formData, 'name').slice(0, 120)
  const year = Number(text(formData, 'fiscal_year'))
  const period = text(formData, 'period_type')
  const scenario = text(formData, 'scenario') || 'base'
  const department = text(formData, 'department_id')
  if (!name || !Number.isInteger(year) || year < 2000 || year > 2100 || !['monthly', 'annual'].includes(period)
    || !['base', 'conservative', 'optimistic'].includes(scenario) || (department && !UUID.test(department))) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const { data, error } = await supabase.rpc('budget_create', { target: companyId, budget_name: name, year, period, scen: scenario,
    department: department || null, note: text(formData, 'notes').slice(0, 2000) || null })
  if (error || typeof data !== 'string') go(back, { error: financeErrorCode(error) })
  const prefill = text(formData, 'prefill_year')
  if (prefill) {
    const growth = num(formData, 'prefill_growth') ?? 0
    const { error: e2 } = await supabase.rpc('budget_fill_from_actuals', { budget: data, source_year: Number(prefill), growth_pct: Number.isFinite(growth) ? growth : 0 })
    if (e2) { refresh(); go(`/finance/budgets/${data}`, { error: financeErrorCode(e2) }) }
  }
  refresh()
  go(`/finance/budgets/${data}`, { done: 'created' })
}

export async function updateBudget(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/finance/budgets/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const pct = (k: string) => { const n = num(formData, k); return n === null ? null : Number.isInteger(n) && n >= 1 && n <= 500 ? n : NaN }
  const values = { exp_warn: pct('expense_warn_pct'), exp_crit: pct('expense_crit_pct'), rev_warn: pct('revenue_warn_pct'), rev_crit: pct('revenue_crit_pct') }
  if (Object.values(values).some((v) => Number.isNaN(v))) go(back, { error: 'amount_invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('budget_update', { budget: id, budget_name: text(formData, 'name').slice(0, 120), note: text(formData, 'notes').slice(0, 2000), ...values })
  if (error) go(back, { error: financeErrorCode(error) })
  refresh()
  go(back, { done: 'saved' })
}

/** One line: account or category; amount per month (monthly budget) or for the year. Empty amount deletes it. */
export async function setBudgetLine(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/finance/budgets/${id}`)
  const target = text(formData, 'target')                       // 'a:<uuid>' or 'c:<uuid>'
  const [kind, ref] = [target.slice(0, 2), target.slice(2)]
  if (!UUID.test(id) || !['a:', 'c:'].includes(kind) || !UUID.test(ref)) go(back, { error: 'budget_line_invalid' })
  const months = formData.getAll('month').map(String)
  const amounts = formData.getAll('amount').map(String)
  const note = text(formData, 'note').slice(0, 500) || null
  if (!months.length || months.length !== amounts.length || months.length > 12) go(back, { error: 'invalid' })
  if (new Set(months).size !== months.length) go(back, { error: 'budget_line_invalid' })
  const parsed: { month: number | null; cents: bigint | null }[] = []
  for (let i = 0; i < months.length; i++) {
    const m = months[i] === '' ? null : Number(months[i])
    if (m !== null && (!Number.isInteger(m) || m < 1 || m > 12)) go(back, { error: 'budget_line_invalid' })
    const raw = amounts[i].trim()
    if (!raw) { parsed.push({ month: m, cents: null }); continue }
    const c = parseCents(raw)
    if (c === null || c < 0n) go(back, { error: 'amount_invalid' })
    parsed.push({ month: m, cents: c })
  }
  // one transaction for every month of the line (budget_set_lines): all or nothing
  const { supabase } = await company()
  const { error } = await supabase.rpc('budget_set_lines', { budget: id, account: kind === 'a:' ? ref : null, category: kind === 'c:' ? ref : null,
    amounts: parsed.sort((x, y) => (x.month ?? 0) - (y.month ?? 0)).map((p) => (p.cents === null ? null : p.cents.toString())), note })
  if (error) go(back, { error: financeErrorCode(error) })
  refresh()
  go(back, { done: 'line_saved' })
}

export async function fillBudget(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/finance/budgets/${id}`)
  const year = Number(text(formData, 'source_year'))
  const growth = num(formData, 'growth') ?? 0
  if (!UUID.test(id) || !Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isFinite(growth)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('budget_fill_from_actuals', { budget: id, source_year: year, growth_pct: growth })
  if (error) go(back, { error: financeErrorCode(error) })
  refresh()
  go(back, { done: 'filled' })
}

const transition = (fn: 'budget_approve' | 'budget_publish' | 'budget_archive' | 'budget_new_version', done: string) => async (formData: FormData) => {
  const id = text(formData, 'id')
  const back = backTo(formData, `/finance/budgets/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const args = fn === 'budget_publish' ? { budget: id }
    : fn === 'budget_archive' ? { budget: id, reason: text(formData, 'reason').slice(0, 300) }
      : { budget: id, note: text(formData, 'note').slice(0, 2000) || null }
  const { data, error } = await supabase.rpc(fn, args)
  if (error) go(back, { error: financeErrorCode(error) })
  refresh()
  if (fn === 'budget_new_version' && typeof data === 'string') go(`/finance/budgets/${data}`, { done })
  go(back, { done })
}
export const approveBudget = transition('budget_approve', 'approved')
export const publishBudget = transition('budget_publish', 'published')
export const archiveBudget = transition('budget_archive', 'archived')
export const newBudgetVersion = transition('budget_new_version', 'version_created')

export async function saveAssumptions(formData: FormData) {
  const back = backTo(formData, '/finance/projections')
  const v = { growth: num(formData, 'growth'), collection: num(formData, 'collection'), conservative: num(formData, 'conservative'), optimistic: num(formData, 'optimistic'), horizon: num(formData, 'horizon') }
  if (v.growth === null || v.collection === null || v.conservative === null || v.optimistic === null || v.horizon === null
    || !(v.growth >= -100 && v.growth <= 1000) || !(v.collection >= 0 && v.collection <= 100) || !(v.conservative >= 0 && v.conservative <= 100)
    || !(v.optimistic >= 0 && v.optimistic <= 100) || !Number.isInteger(v.horizon) || v.horizon < 1 || v.horizon > 24) go(back, { error: 'amount_invalid' })
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('fs_save_assumptions', { target: companyId, ...v })
  if (error) go(back, { error: financeErrorCode(error) })
  refresh()
  go(back, { done: 'assumptions_saved' })
}

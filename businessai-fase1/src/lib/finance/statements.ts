/**
 * Financial statements (migration 0027): periods, statement totals,
 * comparisons, data-quality notes and projections. The rows come from the
 * database (computed from the posted journal lines); this module only adds
 * them up in BigInt cents and never invents amounts. Projections are
 * estimates and always labelled as such.
 */
import type { Locale } from '@/lib/i18n/app'

export type StatementRow = { section: string; account_id: string | null; code: string | null; name: string | null; name_en: string | null; amount_cents: number | string }
const c = (v: number | string | bigint | null | undefined): bigint => (v === null || v === undefined || v === '' ? 0n : BigInt(v))
const sum = (rows: StatementRow[], ...sections: string[]) => rows.filter((r) => sections.includes(r.section)).reduce((s, r) => s + c(r.amount_cents), 0n)

// ------------------------------------------------------------- periods
export type PeriodKind = 'month' | 'quarter' | 'year' | 'custom'
export type Range = { from: string; to: string }
const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

/** The month / quarter / year that contains `ref` ('YYYY-MM-DD'). */
export function periodRange(kind: Exclude<PeriodKind, 'custom'>, ref: string): Range {
  const [y, m] = ref.split('-').map(Number)
  if (kind === 'month') return { from: iso(utc(y, m - 1, 1)), to: iso(utc(y, m, 0)) }
  if (kind === 'quarter') { const q = Math.floor((m - 1) / 3); return { from: iso(utc(y, q * 3, 1)), to: iso(utc(y, q * 3 + 3, 0)) } }
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

/** The period just before (same kind; custom: same number of days). */
export function previousRange(kind: PeriodKind, r: Range): Range {
  if (kind === 'custom') {
    const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1
    const to = new Date(Date.parse(r.from) - 86_400_000)
    return { from: iso(new Date(to.getTime() - (days - 1) * 86_400_000)), to: iso(to) }
  }
  const prevEnd = iso(new Date(Date.parse(r.from) - 86_400_000))
  return periodRange(kind, prevEnd)
}

/** Same dates one year earlier (Feb 29 → Feb 28). */
export function previousYearRange(r: Range): Range {
  const back = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate()
    return iso(utc(y - 1, m - 1, Math.min(d, last)))
  }
  return { from: back(r.from), to: back(r.to) }
}

// ------------------------------------------------------------- comparisons
/** Difference and % change; % is null when the base is zero (no division by zero). */
export function compare(current: bigint, base: bigint): { diff: bigint; pct: number | null } {
  const diff = current - base
  if (base === 0n) return { diff, pct: null }
  const tenths = (diff * 1000n) / (base < 0n ? -base : base)        // tenths of a percent, truncated toward zero
  return { diff, pct: Number(tenths) / 10 }
}

/** Favourable or not: revenue / profit up is good, expense up is bad. */
export function favourable(kind: 'revenue' | 'expense' | 'result', diff: bigint): boolean | null {
  if (diff === 0n) return null
  return kind === 'expense' ? diff < 0n : diff > 0n
}

// ------------------------------------------------------------- income statement
export type IncomeTotals = {
  operatingRevenue: bigint; otherIncome: bigint; costOfSales: bigint; grossProfit: bigint; operatingExpense: bigint; operatingResult: bigint
  otherExpense: bigint; preTax: bigint; incomeTax: bigint; net: bigint; taxRecorded: boolean
}
export function incomeTotals(rows: StatementRow[]): IncomeTotals {
  const operatingRevenue = sum(rows, 'operating_revenue')
  const otherIncome = sum(rows, 'other_income')
  const costOfSales = sum(rows, 'cost_of_sales')
  const operatingExpense = sum(rows, 'operating_expense')
  const otherExpense = sum(rows, 'other_expense')
  const incomeTax = sum(rows, 'income_tax')
  const grossProfit = operatingRevenue - costOfSales
  const operatingResult = grossProfit - operatingExpense
  const preTax = operatingResult + otherIncome - otherExpense
  return { operatingRevenue, otherIncome, costOfSales, grossProfit, operatingExpense, operatingResult, otherExpense, preTax, incomeTax,
    net: preTax - incomeTax, taxRecorded: rows.some((r) => r.section === 'income_tax' && c(r.amount_cents) !== 0n) }
}

// ------------------------------------------------------------- balance sheet
export type BalanceTotals = {
  cash: bigint; currentAssets: bigint; nonCurrentAssets: bigint; totalAssets: bigint; currentLiabilities: bigint; nonCurrentLiabilities: bigint
  totalLiabilities: bigint; equityAccounts: bigint; priorResults: bigint; currentResult: bigint; totalEquity: bigint; totalLiabilitiesEquity: bigint
  difference: bigint; balanced: boolean; empty: boolean
}
export function balanceTotals(rows: StatementRow[]): BalanceTotals {
  const cash = sum(rows, 'cash')
  const currentAssets = cash + sum(rows, 'current_asset')
  const nonCurrentAssets = sum(rows, 'non_current_asset', 'accumulated_depreciation')
  const currentLiabilities = sum(rows, 'current_liability')
  const nonCurrentLiabilities = sum(rows, 'non_current_liability')
  const equityAccounts = sum(rows, 'equity', 'retained_earnings')
  const priorResults = sum(rows, 'prior_results')
  const currentResult = sum(rows, 'current_result')
  const totalAssets = currentAssets + nonCurrentAssets
  const totalLiabilities = currentLiabilities + nonCurrentLiabilities
  const totalEquity = equityAccounts + priorResults + currentResult
  const totalLiabilitiesEquity = totalLiabilities + totalEquity
  return { cash, currentAssets, nonCurrentAssets, totalAssets, currentLiabilities, nonCurrentLiabilities, totalLiabilities, equityAccounts, priorResults,
    currentResult, totalEquity, totalLiabilitiesEquity, difference: totalAssets - totalLiabilitiesEquity, balanced: totalAssets === totalLiabilitiesEquity, empty: rows.length === 0 }
}

// ------------------------------------------------------------- cash flow
export type CashFlowTotals = {
  netIncome: bigint; nonCash: bigint; workingCapital: bigint; operating: bigint; investing: bigint; financing: bigint
  netChange: bigint; opening: bigint; closing: bigint; reconciles: boolean; empty: boolean
}
export function cashFlowTotals(rows: StatementRow[]): CashFlowTotals {
  const netIncome = sum(rows, 'net_income')
  const nonCash = sum(rows, 'non_cash')
  const workingCapital = sum(rows, 'working_capital')
  const operating = netIncome + nonCash + workingCapital
  const investing = sum(rows, 'investing')
  const financing = sum(rows, 'financing')
  const netChange = operating + investing + financing
  const opening = sum(rows, 'cash_opening')
  const closing = sum(rows, 'cash_closing')
  return { netIncome, nonCash, workingCapital, operating, investing, financing, netChange, opening, closing,
    reconciles: closing - opening === netChange, empty: rows.length === 0 }
}

// ------------------------------------------------------------- data quality
export type DataQuality = { entries: number; first_entry_date: string | null; unposted_invoices: number; unposted_payments: number; negative_cash_accounts: number
  opening_balance_recorded: boolean; months_in_range: number; closed_months: number; unbalanced_entries: number }
export type QualityNote = { code: string; text: string; blocking: boolean }

/** Why a statement is provisional (each note is real: nothing is assumed). */
export function qualityNotes(q: DataQuality | null, locale: Locale, opts: { balanced?: boolean } = {}): { notes: QualityNote[]; final: boolean } {
  const es = locale === 'es'
  const notes: QualityNote[] = []
  if (!q || Number(q.entries) === 0) notes.push({ code: 'no_entries', blocking: true, text: es ? 'No hay asientos contables en el periodo: el informe está vacío.' : 'There are no ledger entries in the period: the report is empty.' })
  if (q && Number(q.unbalanced_entries) > 0) notes.push({ code: 'unbalanced', blocking: true, text: es ? 'Hay asientos descuadrados: revisa la integridad del libro.' : 'There are unbalanced entries: check the ledger integrity.' })
  if (opts.balanced === false) notes.push({ code: 'not_balanced', blocking: true, text: es ? 'El balance no cuadra: no es definitivo.' : 'The balance sheet does not balance: it is not final.' })
  if (q && Number(q.unposted_invoices) + Number(q.unposted_payments) > 0) notes.push({ code: 'history', blocking: true,
    text: es ? `${q.unposted_invoices} facturas y ${q.unposted_payments} pagos anteriores a la contabilidad no están en el libro (importa el historial).`
      : `${q.unposted_invoices} invoices and ${q.unposted_payments} payments from before accounting are not in the ledger (import the history).` })
  if (q && Number(q.negative_cash_accounts) > 0) notes.push({ code: 'negative_cash', blocking: true,
    text: es ? 'Hay cuentas de efectivo con saldo negativo: probablemente falta el saldo inicial.' : 'Some cash accounts are negative: the opening balance is probably missing.' })
  if (q && Number(q.entries) > 0 && !q.opening_balance_recorded) notes.push({ code: 'no_opening', blocking: false,
    text: es ? 'No se registró un asiento de saldos iniciales (capital): si la empresa tenía saldos antes de usar BusinessAI, regístralos.'
      : 'No opening-balance (capital) entry was recorded: if the company had balances before BusinessAI, record them.' })
  if (q && Number(q.closed_months) < Number(q.months_in_range)) notes.push({ code: 'open_months', blocking: false,
    text: es ? `${Number(q.months_in_range) - Number(q.closed_months)} de ${q.months_in_range} meses siguen abiertos: las cifras pueden cambiar.`
      : `${Number(q.months_in_range) - Number(q.closed_months)} of ${q.months_in_range} months are still open: figures may change.` })
  return { notes, final: !notes.some((n) => n.blocking) && Number(q?.closed_months ?? 0) >= Number(q?.months_in_range ?? 1) }
}

// ------------------------------------------------------------- projections (estimates)
export type MonthActual = { month: string; revenue: bigint; costs: bigint }
export type Assumptions = { growthPct: number; collectionPct: number; conservativePct: number; optimisticPct: number; horizon: number }
export type ProjectionInput = {
  start: string                                   // first projected month 'YYYY-MM'
  history: MonthActual[]                          // closed / past months, oldest first
  cashNow: bigint
  receivables: { due: string; balance: bigint }[] // open invoices ('YYYY-MM-DD')
  payables: { due: string; balance: bigint }[]    // open bills
  budget?: Map<string, { revenue: bigint; costs: bigint }>
  assumptions: Assumptions
}
export type ProjectedMonth = { month: string; revenue: bigint; costs: bigint; net: bigint; collections: bigint; payments: bigint; cashEnd: bigint; source: 'budget' | 'trend' }
export type Scenario = 'conservative' | 'base' | 'optimistic'

const bp = (pct: number) => BigInt(Math.round(pct * 100))                 // percent → basis points (integer)
const scale = (v: bigint, basisPoints: bigint) => {                        // v × (10000 + bp) / 10000, rounded half away from zero
  const n = v * (10000n + basisPoints)
  const q = n / 10000n, r = n % 10000n
  return r * 2n >= 10000n ? q + 1n : r * 2n <= -10000n ? q - 1n : q
}
const pctOf = (v: bigint, pct: number) => scale(v, bp(pct) - 10000n)
export function addMonths(ym: string, k: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + k, 1))
  return d.toISOString().slice(0, 7)
}

/** Monthly projection for one scenario. Every figure is an estimate. */
export function project(input: ProjectionInput, scenario: Scenario): { months: ProjectedMonth[]; insufficientHistory: boolean } {
  const a = input.assumptions
  const last = input.history.slice(-3)
  const insufficientHistory = last.length === 0
  const avgRev = last.length ? last.reduce((s, m) => s + m.revenue, 0n) / BigInt(last.length) : 0n
  const avgCost = last.length ? last.reduce((s, m) => s + m.costs, 0n) / BigInt(last.length) : 0n
  const revAdj = scenario === 'conservative' ? -bp(a.conservativePct) : scenario === 'optimistic' ? bp(a.optimisticPct) : 0n
  const costAdj = scenario === 'conservative' ? bp(a.conservativePct) : 0n
  let cash = input.cashNow
  const months: ProjectedMonth[] = []
  for (let k = 0; k < Math.max(1, Math.min(24, a.horizon)); k++) {
    const month = addMonths(input.start, k)
    const b = input.budget?.get(month)
    // trend: average of the last months, grown linearly by the annual growth rate
    const growth = BigInt(Math.round(a.growthPct * 100 * (k + 1) / 12))
    const baseRev = b ? b.revenue : scale(avgRev, growth)
    const baseCost = b ? b.costs : scale(avgCost, growth)
    const revenue = scale(baseRev, revAdj)
    const costs = scale(baseCost, costAdj)
    // existing balances by due month (overdue → the first month), collected at the assumed rate
    const due = (d: string) => (d.slice(0, 7) < input.start ? input.start : d.slice(0, 7))
    const collections = pctOf(input.receivables.filter((r) => due(r.due) === month).reduce((s, r) => s + r.balance, 0n), a.collectionPct)
    const payments = input.payables.filter((p) => due(p.due) === month).reduce((s, p) => s + p.balance, 0n)
    cash = cash + revenue - costs + collections - payments
    months.push({ month, revenue, costs, net: revenue - costs, collections, payments, cashEnd: cash, source: b ? 'budget' : 'trend' })
  }
  return { months, insufficientHistory }
}

// ------------------------------------------------------------- labels
export const sectionLabel = (s: string, locale: Locale): string => {
  const es: Record<string, string> = { operating_revenue: 'Ingresos operacionales', other_income: 'Otros ingresos', cost_of_sales: 'Costos directos', operating_expense: 'Gastos operacionales',
    other_expense: 'Otros gastos', income_tax: 'Impuesto sobre ingresos', cash: 'Efectivo y bancos', current_asset: 'Otros activos corrientes', non_current_asset: 'Activos no corrientes',
    accumulated_depreciation: 'Depreciación acumulada', current_liability: 'Pasivos corrientes', non_current_liability: 'Pasivos no corrientes', equity: 'Capital', retained_earnings: 'Utilidades retenidas',
    prior_results: 'Resultados de ejercicios anteriores', current_result: 'Resultado del ejercicio', net_income: 'Resultado neto', non_cash: 'Ajustes no monetarios',
    working_capital: 'Cambios en capital de trabajo', investing: 'Actividades de inversión', financing: 'Actividades de financiación' }
  const en: Record<string, string> = { operating_revenue: 'Operating revenue', other_income: 'Other income', cost_of_sales: 'Direct costs', operating_expense: 'Operating expenses',
    other_expense: 'Other expenses', income_tax: 'Income tax', cash: 'Cash and banks', current_asset: 'Other current assets', non_current_asset: 'Non-current assets',
    accumulated_depreciation: 'Accumulated depreciation', current_liability: 'Current liabilities', non_current_liability: 'Non-current liabilities', equity: 'Capital', retained_earnings: 'Retained earnings',
    prior_results: 'Prior years’ results', current_result: 'Current year result', net_income: 'Net income', non_cash: 'Non-cash adjustments',
    working_capital: 'Changes in working capital', investing: 'Investing activities', financing: 'Financing activities' }
  return (locale === 'en' ? en : es)[s] ?? s
}
export const STATEMENT_CLASSES: Record<string, string[]> = {
  asset: ['cash', 'current_asset', 'non_current_asset', 'accumulated_depreciation'], liability: ['current_liability', 'non_current_liability'],
  equity: ['equity', 'retained_earnings'], revenue: ['operating_revenue', 'other_income'], expense: ['cost_of_sales', 'operating_expense', 'other_expense', 'income_tax'],
}

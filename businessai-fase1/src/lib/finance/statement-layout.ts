/**
 * Lines of each statement (headings, accounts, subtotals) with the current
 * and comparison amounts. Shared by the pages and the CSV/XLSX export so
 * both show exactly the same figures.
 */
import type { Locale } from '@/lib/i18n/app'
import { balanceTotals, cashFlowTotals, incomeTotals, sectionLabel, type StatementRow } from '@/lib/finance/statements'

export type Nature = 'revenue' | 'expense' | 'result' | null
export type Line = { kind: 'heading' | 'account' | 'total' | 'grand'; label: string; code?: string | null; accountId?: string | null; current: bigint; base: bigint | null; nature: Nature }

const big = (v: number | string | bigint) => BigInt(v)
const name = (r: StatementRow, locale: Locale) => (locale === 'en' && r.name_en ? r.name_en : r.name) ?? ''

function accounts(section: string, cur: StatementRow[], base: StatementRow[] | null, locale: Locale, nature: Nature): Line[] {
  const ids = new Map<string, StatementRow>()
  for (const r of [...cur, ...(base ?? [])]) if (r.section === section && r.account_id && !ids.has(r.account_id)) ids.set(r.account_id, r)
  return [...ids.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))).map((r) => {
    const c = cur.find((x) => x.section === section && x.account_id === r.account_id)
    const b = base?.find((x) => x.section === section && x.account_id === r.account_id)
    return { kind: 'account' as const, label: name(r, locale), code: r.code, accountId: r.account_id, current: c ? big(c.amount_cents) : 0n, base: base ? (b ? big(b.amount_cents) : 0n) : null, nature }
  }).filter((l) => l.current !== 0n || (l.base ?? 0n) !== 0n)
}
const t = (kind: Line['kind'], label: string, current: bigint, base: bigint | null, nature: Nature): Line => ({ kind, label, current, base, nature })
const h = (label: string): Line => ({ kind: 'heading', label, current: 0n, base: null, nature: null })

export function incomeLines(cur: StatementRow[], base: StatementRow[] | null, locale: Locale): Line[] {
  const es = locale === 'es'
  const a = incomeTotals(cur), b = base ? incomeTotals(base) : null
  const sec = (s: string, nature: Nature, total: bigint, bt: bigint | null): Line[] =>
    [h(sectionLabel(s, locale)), ...accounts(s, cur, base, locale, nature), t('total', `${es ? 'Total' : 'Total'} ${sectionLabel(s, locale).toLowerCase()}`, total, bt, nature)]
  return [
    ...sec('operating_revenue', 'revenue', a.operatingRevenue, b?.operatingRevenue ?? null),
    ...sec('cost_of_sales', 'expense', a.costOfSales, b?.costOfSales ?? null),
    t('grand', es ? 'Utilidad bruta' : 'Gross profit', a.grossProfit, b?.grossProfit ?? null, 'result'),
    ...sec('operating_expense', 'expense', a.operatingExpense, b?.operatingExpense ?? null),
    t('grand', es ? 'Resultado operacional' : 'Operating result', a.operatingResult, b?.operatingResult ?? null, 'result'),
    ...sec('other_income', 'revenue', a.otherIncome, b?.otherIncome ?? null),
    ...sec('other_expense', 'expense', a.otherExpense, b?.otherExpense ?? null),
    t('grand', es ? 'Resultado antes de impuestos' : 'Result before taxes', a.preTax, b?.preTax ?? null, 'result'),
    ...sec('income_tax', 'expense', a.incomeTax, b?.incomeTax ?? null),
    t('grand', es ? 'Resultado neto' : 'Net result', a.net, b?.net ?? null, 'result'),
  ]
}

export function balanceLines(cur: StatementRow[], base: StatementRow[] | null, locale: Locale): Line[] {
  const es = locale === 'es'
  const a = balanceTotals(cur), b = base ? balanceTotals(base) : null
  const single = (s: string, rows: StatementRow[] | null) => rows ? rows.filter((r) => r.section === s).reduce((x, r) => x + big(r.amount_cents), 0n) : null
  return [
    h(es ? 'ACTIVOS' : 'ASSETS'),
    h(sectionLabel('cash', locale)), ...accounts('cash', cur, base, locale, null),
    h(sectionLabel('current_asset', locale)), ...accounts('current_asset', cur, base, locale, null),
    t('total', es ? 'Total activos corrientes' : 'Total current assets', a.currentAssets, b?.currentAssets ?? null, null),
    h(sectionLabel('non_current_asset', locale)), ...accounts('non_current_asset', cur, base, locale, null), ...accounts('accumulated_depreciation', cur, base, locale, null),
    t('total', es ? 'Total activos no corrientes' : 'Total non-current assets', a.nonCurrentAssets, b?.nonCurrentAssets ?? null, null),
    t('grand', es ? 'Total activos' : 'Total assets', a.totalAssets, b?.totalAssets ?? null, null),
    h(es ? 'PASIVOS' : 'LIABILITIES'),
    h(sectionLabel('current_liability', locale)), ...accounts('current_liability', cur, base, locale, null),
    t('total', es ? 'Total pasivos corrientes' : 'Total current liabilities', a.currentLiabilities, b?.currentLiabilities ?? null, null),
    h(sectionLabel('non_current_liability', locale)), ...accounts('non_current_liability', cur, base, locale, null),
    t('total', es ? 'Total pasivos no corrientes' : 'Total non-current liabilities', a.nonCurrentLiabilities, b?.nonCurrentLiabilities ?? null, null),
    t('grand', es ? 'Total pasivos' : 'Total liabilities', a.totalLiabilities, b?.totalLiabilities ?? null, null),
    h(es ? 'PATRIMONIO' : 'EQUITY'),
    ...accounts('equity', cur, base, locale, null), ...accounts('retained_earnings', cur, base, locale, null),
    t('account', sectionLabel('prior_results', locale), single('prior_results', cur) ?? 0n, single('prior_results', base), null),
    t('account', sectionLabel('current_result', locale), single('current_result', cur) ?? 0n, single('current_result', base), 'result'),
    t('grand', es ? 'Total patrimonio' : 'Total equity', a.totalEquity, b?.totalEquity ?? null, null),
    t('grand', es ? 'Total pasivos y patrimonio' : 'Total liabilities and equity', a.totalLiabilitiesEquity, b?.totalLiabilitiesEquity ?? null, null),
    t('total', es ? 'Diferencia (debe ser 0)' : 'Difference (must be 0)', a.difference, b?.difference ?? null, null),
  ]
}

export function cashFlowLines(cur: StatementRow[], base: StatementRow[] | null, locale: Locale): Line[] {
  const es = locale === 'es'
  const a = cashFlowTotals(cur), b = base ? cashFlowTotals(base) : null
  return [
    h(es ? 'Actividades de operación' : 'Operating activities'),
    t('account', sectionLabel('net_income', locale), a.netIncome, b?.netIncome ?? null, 'result'),
    h(sectionLabel('non_cash', locale)), ...accounts('non_cash', cur, base, locale, null),
    h(sectionLabel('working_capital', locale)), ...accounts('working_capital', cur, base, locale, null),
    t('total', es ? 'Efectivo neto de operación' : 'Net cash from operations', a.operating, b?.operating ?? null, 'result'),
    h(sectionLabel('investing', locale)), ...accounts('investing', cur, base, locale, null),
    t('total', es ? 'Efectivo neto de inversión' : 'Net cash from investing', a.investing, b?.investing ?? null, 'result'),
    h(sectionLabel('financing', locale)), ...accounts('financing', cur, base, locale, null),
    t('total', es ? 'Efectivo neto de financiación' : 'Net cash from financing', a.financing, b?.financing ?? null, 'result'),
    t('grand', es ? 'Cambio neto en efectivo' : 'Net change in cash', a.netChange, b?.netChange ?? null, 'result'),
    t('account', es ? 'Efectivo al inicio' : 'Cash at the beginning', a.opening, b?.opening ?? null, null),
    t('grand', es ? 'Efectivo al cierre' : 'Cash at the end', a.closing, b?.closing ?? null, null),
  ]
}

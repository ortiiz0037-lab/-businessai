/**
 * Finance D6 (migration 0027): statement totals, comparisons, quality notes,
 * projections and the xlsx writer. Database figures are tested in SQL; this
 * covers the arithmetic the app adds on top (BigInt cents, no division by zero).
 */
import { describe, expect, it } from 'vitest'
import { addMonths, balanceTotals, cashFlowTotals, compare, favourable, incomeTotals, periodRange, previousRange, previousYearRange, project, qualityNotes,
  type DataQuality, type StatementRow } from '@/lib/finance/statements'
import { buildXlsx, crc32, zipStore } from '@/lib/export/xlsx'

const row = (section: string, amount: number): StatementRow => ({ section, account_id: null, code: null, name: null, name_en: null, amount_cents: amount })

describe('periods', () => {
  it('month, quarter, year', () => {
    expect(periodRange('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(periodRange('month', '2028-02-14')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(periodRange('quarter', '2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(periodRange('year', '2026-11-12')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })
  it('previous period of each kind', () => {
    expect(previousRange('month', { from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(previousRange('quarter', { from: '2026-01-01', to: '2026-03-31' })).toEqual({ from: '2025-10-01', to: '2025-12-31' })
    expect(previousRange('year', { from: '2026-01-01', to: '2026-12-31' })).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(previousRange('custom', { from: '2026-03-10', to: '2026-03-19' })).toEqual({ from: '2026-02-28', to: '2026-03-09' })
  })
  it('same period last year (Feb 29 safe)', () => expect(previousYearRange({ from: '2028-02-01', to: '2028-02-29' })).toEqual({ from: '2027-02-01', to: '2027-02-28' }))
  it('addMonths', () => { expect(addMonths('2026-11', 3)).toBe('2027-02'); expect(addMonths('2026-01', -1)).toBe('2025-12') })
})

describe('comparisons', () => {
  it('difference and percentage', () => {
    expect(compare(110n, 100n)).toEqual({ diff: 10n, pct: 10 })
    expect(compare(90n, 100n)).toEqual({ diff: -10n, pct: -10 })
    expect(compare(1n, 3n)).toEqual({ diff: -2n, pct: -66.6 })
    expect(compare(-50n, -100n)).toEqual({ diff: 50n, pct: 50 })
  })
  it('no division by zero', () => expect(compare(500n, 0n)).toEqual({ diff: 500n, pct: null }))
  it('favourable depends on the kind', () => {
    expect(favourable('revenue', 10n)).toBe(true)
    expect(favourable('expense', 10n)).toBe(false)
    expect(favourable('expense', -10n)).toBe(true)
    expect(favourable('result', -1n)).toBe(false)
    expect(favourable('revenue', 0n)).toBeNull()
  })
})

describe('statement totals (same figures as the SQL suite)', () => {
  it('income statement', () => {
    const t = incomeTotals([row('operating_revenue', 470000), row('other_income', 30000), row('cost_of_sales', 120000), row('operating_expense', 80000),
      row('operating_expense', 25000), row('other_expense', 5000), row('income_tax', 40000)])
    expect(t).toMatchObject({ grossProfit: 350000n, operatingResult: 245000n, preTax: 270000n, net: 230000n, taxRecorded: true })
  })
  it('without tax entries the net equals the pre-tax result, flagged', () => {
    const t = incomeTotals([row('operating_revenue', 100), row('income_tax', 0)])
    expect(t.net).toBe(100n); expect(t.taxRecorded).toBe(false)
  })
  it('balance sheet balances', () => {
    const t = balanceTotals([row('cash', 1395000), row('current_asset', 200000), row('non_current_asset', 250000), row('accumulated_depreciation', -25000),
      row('current_liability', 20000), row('current_liability', 40000), row('non_current_liability', 300000), row('equity', 980000), row('prior_results', 250000), row('current_result', 230000)])
    expect(t).toMatchObject({ totalAssets: 1820000n, totalLiabilities: 360000n, totalEquity: 1460000n, balanced: true, difference: 0n })
  })
  it('an unbalanced input is reported, not hidden', () => expect(balanceTotals([row('cash', 10), row('equity', 9)])).toMatchObject({ balanced: false, difference: 1n }))
  it('cash flow reconciles with the change in cash', () => {
    const t = cashFlowTotals([row('net_income', 230000), row('non_cash', 25000), row('working_capital', -100000), row('working_capital', 20000), row('working_capital', 40000),
      row('investing', -250000), row('financing', 300000), row('financing', -20000), row('cash_opening', 1150000), row('cash_closing', 1395000)])
    expect(t).toMatchObject({ operating: 215000n, netChange: 245000n, reconciles: true })
  })
  it('empty inputs', () => {
    expect(balanceTotals([]).empty).toBe(true)
    expect(cashFlowTotals([])).toMatchObject({ netChange: 0n, reconciles: true, empty: true })
  })
})

describe('quality notes', () => {
  const q = (o: Partial<DataQuality>): DataQuality => ({ entries: 10, first_entry_date: '2025-01-01', unposted_invoices: 0, unposted_payments: 0, negative_cash_accounts: 0,
    opening_balance_recorded: true, months_in_range: 12, closed_months: 12, unbalanced_entries: 0, ...o })
  it('final only when complete and closed', () => {
    expect(qualityNotes(q({}), 'es').final).toBe(true)
    expect(qualityNotes(q({ closed_months: 11 }), 'es')).toMatchObject({ final: false })
    expect(qualityNotes(q({ negative_cash_accounts: 1 }), 'en').notes.map((n) => n.code)).toContain('negative_cash')
    expect(qualityNotes(q({ unposted_invoices: 2 }), 'es').notes.find((n) => n.code === 'history')?.blocking).toBe(true)
    expect(qualityNotes(null, 'es').notes[0].code).toBe('no_entries')
    expect(qualityNotes(q({}), 'es', { balanced: false }).final).toBe(false)
  })
})

describe('projections (estimates)', () => {
  const base = {
    start: '2026-12', cashNow: 100000n,
    history: [{ month: '2026-09', revenue: 90000n, costs: 60000n }, { month: '2026-10', revenue: 100000n, costs: 60000n }, { month: '2026-11', revenue: 110000n, costs: 60000n }],
    receivables: [{ due: '2026-10-15', balance: 20000n }, { due: '2027-01-20', balance: 10000n }],
    payables: [{ due: '2026-12-31', balance: 15000n }],
    assumptions: { growthPct: 0, collectionPct: 90, conservativePct: 20, optimisticPct: 10, horizon: 3 },
  }
  it('base: trend average, overdue receivables collected first month at the assumed rate', () => {
    const p = project(base, 'base')
    expect(p.months.map((m) => [m.month, m.revenue, m.costs, m.collections, m.payments])).toEqual([
      ['2026-12', 100000n, 60000n, 18000n, 15000n], ['2027-01', 100000n, 60000n, 9000n, 0n], ['2027-02', 100000n, 60000n, 0n, 0n]])
    expect(p.months[2].cashEnd).toBe(100000n + 40000n * 3n + 18000n + 9000n - 15000n)
  })
  it('scenarios move revenue and costs in opposite directions', () => {
    const cons = project(base, 'conservative').months[0]
    const opt = project(base, 'optimistic').months[0]
    expect([cons.revenue, cons.costs]).toEqual([80000n, 72000n])
    expect([opt.revenue, opt.costs]).toEqual([110000n, 60000n])
  })
  it('a published budget replaces the trend for its months', () => {
    const p = project({ ...base, budget: new Map([['2027-01', { revenue: 150000n, costs: 50000n }]]) }, 'base')
    expect(p.months[1]).toMatchObject({ revenue: 150000n, costs: 50000n, source: 'budget' })
    expect(p.months[0].source).toBe('trend')
  })
  it('growth is applied linearly per month (annual rate)', () => expect(project({ ...base, assumptions: { ...base.assumptions, growthPct: 12 } }, 'base').months[0].revenue).toBe(101000n))
  it('without history: zero trend, flagged', () => {
    const p = project({ ...base, history: [] }, 'base')
    expect(p.insufficientHistory).toBe(true); expect(p.months[0].revenue).toBe(0n)
  })
})

describe('xlsx', () => {
  it('crc32', () => expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926))
  it('is a zip with the workbook parts and escaped content', () => {
    const bytes = buildXlsx('Estado/Resultados', [[{ v: 'Cuenta', bold: true }, { v: 'Importe', bold: true }], ['Ventas <B&C>', 4700], [null, -12.5]])
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const text = new TextDecoder().decode(bytes)
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) expect(text).toContain(part)
    expect(text).toContain('Ventas &lt;B&amp;C&gt;')
    expect(text).toContain('<v>4700</v>')
    expect(text).toContain('<v>-12.5</v>')
    expect(text).toContain('name="Estado Resultados"')
    expect(text).toContain('s="1"')
  })
  it('end-of-central-directory counts the entries', () => {
    const z = zipStore([{ name: 'a.txt', data: new Uint8Array([1, 2]) }, { name: 'b.txt', data: new Uint8Array([3]) }])
    const end = new DataView(z.buffer, z.length - 22)
    expect(end.getUint32(0, true)).toBe(0x06054b50)
    expect(end.getUint16(10, true)).toBe(2)
  })
})

// ------------------------------------------------------------- budgets, insights, layout
import { budgetMonths, financeErrorCode, financeMessage, type BudgetLine } from '@/lib/finance/budget'
import { insights, type InsightInput } from '@/lib/finance/insights'
import { balanceLines, cashFlowLines, incomeLines } from '@/lib/finance/statement-layout'

const bl = (o: Partial<BudgetLine>): BudgetLine => ({ id: 1, budget_id: 'b', account_id: null, category_id: null, month: null, amount_cents: 0, note: null, ...o })

describe('budget months for projections', () => {
  const types = new Map([['rev', 'revenue'], ['exp', 'expense'], ['cogs', 'expense'], ['bank', 'asset']])
  const cats = new Map([['cat-rent', 'exp'], ['cat-misc', 'other']])
  it('monthly lines go to their month; annual lines are spread and add up exactly', () => {
    const m = budgetMonths(2027, [bl({ account_id: 'rev', month: 3, amount_cents: 50000 }), bl({ account_id: 'cogs', amount_cents: 100001 })], types, cats)
    expect(m.get('2027-03')).toEqual({ revenue: 50000n, costs: 8333n })
    expect(m.get('2027-12')!.costs).toBe(100001n - 8333n * 11n)
    expect([...m.values()].reduce((s, v) => s + v.costs, 0n)).toBe(100001n)
  })
  it('a category line is skipped when its ledger account has its own line (no double count)', () => {
    const m = budgetMonths(2027, [bl({ account_id: 'exp', month: 1, amount_cents: 1000 }), bl({ category_id: 'cat-rent', month: 1, amount_cents: 700 }), bl({ category_id: 'cat-misc', month: 1, amount_cents: 300 })], types, cats)
    expect(m.get('2027-01')).toEqual({ revenue: 0n, costs: 1300n })
  })
  it('ignores non revenue/expense accounts', () => expect(budgetMonths(2027, [bl({ account_id: 'bank', month: 1, amount_cents: 5 })], types, cats).get('2027-01')).toEqual({ revenue: 0n, costs: 0n }))
})

describe('finance error codes', () => {
  it('maps database errors', () => {
    expect(financeErrorCode({ message: 'BUDGET_LOCKED' })).toBe('budget_locked')
    expect(financeErrorCode({ message: 'duplicate key value violates unique constraint "budgets_published_uidx"' })).toBe('budget_published_exists')
    expect(financeErrorCode({ message: 'x', code: '40001' })).toBe('retry')
    expect(financeErrorCode({ message: 'Could not find the function public.budget_create' })).toBe('unavailable')
    expect(financeMessage('budget_immutable', 'en')).toMatch(/new version/)
    expect(financeMessage('nope', 'es')).toMatch(/No se pudo guardar/)
    expect(financeMessage(null, 'es')).toBeNull()
  })
})

describe('dashboard insights', () => {
  const base: InsightInput = { cash: 1000n, projectedLowCash: null, overdueAR: 0n, overdueCount: 0, apDueSoon: 0n, apDueSoonCount: 0, budgetId: null, criticalLines: [], favourableLines: [],
    revenueChangePct: null, expenseChangePct: null, openMonthsBeforeCurrent: 0, provisional: false }
  it('nothing to report', () => expect(insights(base, 'es')).toEqual([]))
  it('alerts and opportunities carry their source link', () => {
    const out = insights({ ...base, cash: -5n, projectedLowCash: { month: '2027-02', cash: -100n }, overdueAR: 2500n, overdueCount: 2, budgetId: 'b1',
      criticalLines: [{ label: 'Rent', type: 'expense' }], favourableLines: [{ label: 'Sales', type: 'revenue', variance: 900n }], expenseChangePct: 25, revenueChangePct: -30 }, 'en')
    expect(out.filter((i) => i.tone === 'critical').map((i) => i.href)).toEqual(['/finance/balance-sheet', '/finance/projections', '/finance/budgets/b1'])
    expect(out.some((i) => i.tone === 'opportunity' && i.href === '/receivables')).toBe(true)
    expect(out.some((i) => i.text.includes('Sales beats the budget'))).toBe(true)
    expect(out.find((i) => i.text.includes('estimate'))?.tone).toBe('critical')
  })
})

describe('statement layout (same figures as the page and the export)', () => {
  const acc = (section: string, id: string, code: string, amount: number): StatementRow => ({ section, account_id: id, code, name: code, name_en: null, amount_cents: amount })
  it('income lines: subtotals and accounts present in only one period', () => {
    const lines = incomeLines([acc('operating_revenue', 'r', '4000', 1000), acc('operating_expense', 'e', '6000', 300)], [acc('operating_revenue', 'r', '4000', 800), acc('cost_of_sales', 'c', '5000', 100)], 'es')
    const grand = lines.filter((l) => l.kind === 'grand').map((l) => [l.label, l.current, l.base])
    expect(grand).toEqual([['Utilidad bruta', 1000n, 700n], ['Resultado operacional', 700n, 700n], ['Resultado antes de impuestos', 700n, 700n], ['Resultado neto', 700n, 700n]])
    expect(lines.find((l) => l.code === '5000')).toMatchObject({ current: 0n, base: 100n, accountId: 'c' })
  })
  it('balance lines end with a zero difference when balanced', () => {
    const lines = balanceLines([acc('cash', 'k', '1000', 500), acc('equity', 'q', '3000', 400), row('current_result', 100)], null, 'en')
    expect(lines.at(-1)).toMatchObject({ label: 'Difference (must be 0)', current: 0n, base: null })
  })
  it('cash flow lines end with closing cash', () => {
    const lines = cashFlowLines([row('net_income', 100), row('cash_opening', 50), row('cash_closing', 150)], null, 'en')
    expect(lines.find((l) => l.label === 'Net change in cash')?.current).toBe(100n)
    expect(lines.at(-1)).toMatchObject({ label: 'Cash at the end', current: 150n })
  })
})

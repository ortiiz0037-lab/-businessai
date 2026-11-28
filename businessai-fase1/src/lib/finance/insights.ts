/**
 * Alerts and opportunities of the finance dashboard. Rule based on real
 * figures only; every item carries the link to its accounting source.
 */
import type { Locale } from '@/lib/i18n/app'
import { formatCents } from '@/lib/finance/money'

export type Insight = { tone: 'critical' | 'warning' | 'opportunity'; text: string; href: string }
export type InsightInput = {
  cash: bigint
  projectedLowCash: { month: string; cash: bigint } | null   // first month the base projection goes below zero
  overdueAR: bigint; overdueCount: number
  apDueSoon: bigint; apDueSoonCount: number                   // approved bills due within 7 days (or overdue)
  budgetId: string | null
  criticalLines: { label: string; type: 'revenue' | 'expense' }[]
  favourableLines: { label: string; type: 'revenue' | 'expense'; variance: bigint }[]
  revenueChangePct: number | null                              // month vs previous month
  expenseChangePct: number | null
  openMonthsBeforeCurrent: number
  provisional: boolean
}

export function insights(i: InsightInput, locale: Locale, currency = 'USD'): Insight[] {
  const es = locale === 'es'
  const m = (c: bigint) => formatCents(c, locale, currency)
  const out: Insight[] = []
  if (i.cash < 0n) out.push({ tone: 'critical', href: '/finance/balance-sheet', text: es ? `El efectivo en libros es negativo (${m(i.cash)}): revisa el saldo inicial y los pagos.` : `Book cash is negative (${m(i.cash)}): check the opening balance and payments.` })
  if (i.projectedLowCash) out.push({ tone: 'critical', href: '/finance/projections', text: es ? `La proyección base estima efectivo negativo en ${i.projectedLowCash.month} (${m(i.projectedLowCash.cash)}). Es una estimación.`
    : `The base projection estimates negative cash in ${i.projectedLowCash.month} (${m(i.projectedLowCash.cash)}). It is an estimate.` })
  for (const l of i.criticalLines.slice(0, 5)) out.push({ tone: 'critical', href: i.budgetId ? `/finance/budgets/${i.budgetId}` : '/finance/budgets',
    text: l.type === 'expense' ? (es ? `Gasto por encima del presupuesto: ${l.label}.` : `Expense above budget: ${l.label}.`) : (es ? `Ingreso muy por debajo del presupuesto: ${l.label}.` : `Revenue well below budget: ${l.label}.`) })
  if (i.overdueCount > 0) out.push({ tone: 'warning', href: '/receivables?status=overdue', text: es ? `${i.overdueCount} facturas vencidas por ${m(i.overdueAR)}.` : `${i.overdueCount} overdue invoices for ${m(i.overdueAR)}.` })
  if (i.apDueSoonCount > 0) out.push({ tone: 'warning', href: '/payables', text: es ? `${i.apDueSoonCount} facturas de proveedor vencen en 7 días o menos (${m(i.apDueSoon)}).` : `${i.apDueSoonCount} vendor bills are due within 7 days (${m(i.apDueSoon)}).` })
  if (i.expenseChangePct !== null && i.expenseChangePct >= 20) out.push({ tone: 'warning', href: '/finance/income-statement?period=month&compare=previous',
    text: es ? `Los gastos del mes subieron ${i.expenseChangePct.toFixed(1)}% frente al mes anterior.` : `Expenses rose ${i.expenseChangePct.toFixed(1)}% vs the previous month.` })
  if (i.revenueChangePct !== null && i.revenueChangePct <= -20) out.push({ tone: 'warning', href: '/finance/income-statement?period=month&compare=previous',
    text: es ? `Los ingresos del mes bajaron ${Math.abs(i.revenueChangePct).toFixed(1)}% frente al mes anterior.` : `Revenue fell ${Math.abs(i.revenueChangePct).toFixed(1)}% vs the previous month.` })
  if (i.openMonthsBeforeCurrent > 0) out.push({ tone: 'warning', href: '/accounting/periods', text: es ? `${i.openMonthsBeforeCurrent} meses anteriores siguen abiertos: ciérralos para que las cifras sean definitivas.`
    : `${i.openMonthsBeforeCurrent} previous months are still open: close them so figures are final.` })
  if (i.provisional) out.push({ tone: 'warning', href: '/accounting', text: es ? 'Faltan datos (historial o saldos iniciales): los informes son provisionales.' : 'Data is missing (history or opening balances): reports are provisional.' })
  // opportunities
  if (i.overdueCount > 0) out.push({ tone: 'opportunity', href: '/receivables', text: es ? `Cobrar lo vencido liberaría ${m(i.overdueAR)} de efectivo.` : `Collecting overdue invoices would free ${m(i.overdueAR)} of cash.` })
  for (const l of i.favourableLines.filter((x) => x.variance !== 0n).slice(0, 3)) out.push({ tone: 'opportunity', href: i.budgetId ? `/finance/budgets/${i.budgetId}` : '/finance/budgets',
    text: l.type === 'revenue' ? (es ? `${l.label} supera el presupuesto en ${m(l.variance)}.` : `${l.label} beats the budget by ${m(l.variance)}.`)
      : (es ? `${l.label} está ${m(-l.variance)} por debajo del presupuesto.` : `${l.label} is ${m(-l.variance)} under budget.`) })
  if (i.revenueChangePct !== null && i.revenueChangePct >= 10) out.push({ tone: 'opportunity', href: '/finance/income-statement?period=month&compare=previous',
    text: es ? `Los ingresos del mes crecieron ${i.revenueChangePct.toFixed(1)}%.` : `Revenue grew ${i.revenueChangePct.toFixed(1)}% this month.` })
  return out
}

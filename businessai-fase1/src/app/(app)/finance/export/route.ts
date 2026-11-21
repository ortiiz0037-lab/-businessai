import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { toCsv } from '@/lib/finance/bank'
import { buildXlsx, type Cell } from '@/lib/export/xlsx'
import { financeAccess, loadBalance, loadCashFlow, loadIncome, loadProjection, loadQuality, readPeriod } from '@/lib/finance/finance-page'
import { balanceLines, cashFlowLines, incomeLines, type Line } from '@/lib/finance/statement-layout'
import { balanceTotals, cashFlowTotals, compare, incomeTotals, previousYearRange, qualityNotes } from '@/lib/finance/statements'
import type { Budget, VsActual } from '@/lib/finance/budget'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const dec = (c: bigint | number | string | null | undefined) => {
  if (c === null || c === undefined || c === '') return ''
  const n = BigInt(c); const a = n < 0n ? -n : n
  return `${n < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

/**
 * Financial reports as CSV or Excel, read with the user's own session
 * (accounting.view checked by every database function). Each file starts
 * with company, report, period, currency, generation time and data notes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const sp = Object.fromEntries(url.searchParams) as Record<string, string>
  const format = sp.format === 'xlsx' ? 'xlsx' : 'csv'
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const co = member.companyId
  const access = await financeAccess(supabase, co)
  if (!access.view) return new NextResponse('Forbidden', { status: 403 })
  const locale = await getLocale()
  const es = locale === 'es'
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [{ data: company }, { data: settings }] = await Promise.all([
    supabase.from('companies').select('name').eq('id', co).maybeSingle(),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', co).maybeSingle(),
  ])
  const currency = (settings as { base_currency?: string } | null)?.base_currency ?? 'USD'

  let title = '', period = '', notes: string[] = [], header: string[] = [], body: (string | bigint | number | null)[][] = []
  const statement = (lines: Line[], hasBase: boolean) => {
    header = [es ? 'Código' : 'Code', es ? 'Concepto' : 'Line', es ? 'Tipo' : 'Kind', es ? 'Periodo' : 'Period', ...(hasBase ? [es ? 'Comparación' : 'Comparison', es ? 'Variación' : 'Change', '%'] : [])]
    body = lines.map((l) => {
      if (l.kind === 'heading') return [null, l.label, 'heading']
      const c = l.base === null ? null : compare(l.current, l.base)
      return [l.code ?? null, l.label, l.kind, l.current, ...(hasBase ? [l.base, c?.diff ?? null, c?.pct === null || c === null ? null : c.pct] : [])]
    })
  }
  if (sp.report === 'income' || sp.report === 'cashflow') {
    const p = readPeriod(sp, today)
    const load = sp.report === 'income' ? loadIncome : loadCashFlow
    const [cur, base, quality] = await Promise.all([load(supabase, co, p.range), p.base ? load(supabase, co, p.base) : null, loadQuality(supabase, co, p.range)])
    if (cur.error) return new NextResponse('Unavailable', { status: 503 })
    const q = qualityNotes(quality, locale)
    if (sp.report === 'income') {
      title = es ? 'Estado de resultados' : 'Income statement'
      if (!incomeTotals(cur.rows).taxRecorded) q.notes.push({ code: 'no_tax', blocking: false, text: es ? 'Sin gasto de impuesto registrado: el resultado neto es antes de impuestos.' : 'No income-tax expense recorded: net result is before taxes.' })
      statement(incomeLines(cur.rows, base?.rows ?? null, locale), !!base)
    } else {
      title = es ? 'Flujo de efectivo (método indirecto)' : 'Cash flow (indirect method)'
      if (!cashFlowTotals(cur.rows).reconciles) q.notes.push({ code: 'no_match', blocking: true, text: es ? 'No cuadra con el cambio de efectivo.' : 'Does not match the change in cash.' })
      statement(cashFlowLines(cur.rows, base?.rows ?? null, locale), !!base)
    }
    period = `${p.range.from} – ${p.range.to}${p.base ? ` (${es ? 'vs' : 'vs'} ${p.base.from} – ${p.base.to})` : ''}`
    notes = [q.final ? (es ? 'Definitivo' : 'Final') : (es ? 'Provisional' : 'Provisional'), ...q.notes.map((n) => n.text)]
  } else if (sp.report === 'balance') {
    const asOf = sp.as_of && DAY.test(sp.as_of) ? sp.as_of : today
    const cmp = sp.compare === 'none' ? null : sp.compare && DAY.test(sp.compare) ? sp.compare : previousYearRange({ from: asOf, to: asOf }).to
    const [cur, base, quality] = await Promise.all([loadBalance(supabase, co, asOf), cmp ? loadBalance(supabase, co, cmp) : null, loadQuality(supabase, co, { from: `${asOf.slice(0, 4)}-01-01`, to: asOf })])
    if (cur.error) return new NextResponse('Unavailable', { status: 503 })
    const t = balanceTotals(cur.rows)
    const q = qualityNotes(quality, locale, { balanced: t.balanced })
    title = es ? 'Balance general' : 'Balance sheet'
    period = `${es ? 'Al' : 'As of'} ${asOf}${cmp ? ` (vs ${cmp})` : ''}`
    statement(balanceLines(cur.rows, base?.rows ?? null, locale), !!base)
    notes = [q.final ? (es ? 'Definitivo' : 'Final') : 'Provisional', t.balanced ? (es ? 'Cuadra: activos = pasivos + patrimonio' : 'Balanced: assets = liabilities + equity') : (es ? `No cuadra: diferencia ${dec(t.difference)}` : `Not balanced: difference ${dec(t.difference)}`),
      ...q.notes.map((n) => n.text)]
  } else if (sp.report === 'budget' && sp.id && UUID.test(sp.id)) {
    const { data: bd } = await supabase.from('budgets').select('*').eq('id', sp.id).eq('company_id', co).maybeSingle()
    const b = bd as Budget | null
    if (!b) return new NextResponse('Not found', { status: 404 })
    const asOf = sp.as_of && DAY.test(sp.as_of) ? sp.as_of : today
    const { data } = await supabase.rpc('budget_vs_actual', { budget: b.id, as_of: asOf })
    title = `${es ? 'Presupuesto vs real' : 'Budget vs actual'}: ${b.name} v${b.version} (${b.status})`
    period = `${b.fiscal_year} · ${es ? 'real al' : 'actuals to'} ${asOf}`
    header = [es ? 'Línea' : 'Line', es ? 'Tipo' : 'Type', es ? 'Presupuesto año' : 'Year budget', es ? 'A la fecha' : 'To date', es ? 'Real' : 'Actual', es ? 'Variación' : 'Variance', es ? 'Variación %' : 'Variance %',
      es ? 'Consumido %' : 'Consumed %', es ? 'Proyección' : 'Projection', es ? 'Favorable' : 'Favourable', es ? 'Alerta' : 'Alert', es ? 'Suma en total' : 'In total']
    body = ((data ?? []) as VsActual[]).map((r) => [locale === 'en' && r.label_en ? r.label_en : r.label, r.line_type, BigInt(r.budget_total_cents), BigInt(r.budget_ytd_cents), BigInt(r.actual_cents), BigInt(r.variance_cents),
      r.variance_pct === null ? null : Number(r.variance_pct), r.consumed_pct === null ? null : Number(r.consumed_pct), r.projection_cents === null ? null : BigInt(r.projection_cents),
      r.favorable ? 'yes' : 'no', r.actual_available ? r.alert : 'n/a', r.in_total ? 'yes' : 'no'])
    notes = [es ? 'Proyección = estimación al ritmo actual.' : 'Projection = estimate at the current pace.', ...(b.department_id ? [es ? 'Presupuesto de departamento: el libro no registra departamento (real de toda la empresa).' : 'Department budget: the ledger has no department (company-wide actuals).'] : [])]
  } else if (sp.report === 'projection') {
    const p = await loadProjection(supabase, co, today)
    const a = p.assumptions
    title = es ? 'Proyección (estimación, no garantizada)' : 'Projection (estimate, not guaranteed)'
    period = `${p.input.start} + ${a.horizon} ${es ? 'meses' : 'months'}`
    header = [es ? 'Mes' : 'Month', es ? 'Origen' : 'Source', es ? 'Ingresos' : 'Revenue', es ? 'Costos' : 'Costs', es ? 'Cobros CxC' : 'AR collections', es ? 'Pagos CxP' : 'AP payments',
      es ? 'Efectivo conservador' : 'Cash conservative', es ? 'Efectivo base' : 'Cash base', es ? 'Efectivo optimista' : 'Cash optimistic']
    body = p.scenarios.base.months.map((m, i) => [m.month, m.source, m.revenue, m.costs, m.collections, m.payments, p.scenarios.conservative.months[i].cashEnd, m.cashEnd, p.scenarios.optimistic.months[i].cashEnd])
    notes = [es ? `Supuestos: crecimiento ${a.growthPct}%, cobro ${a.collectionPct}%, conservador ${a.conservativePct}%, optimista ${a.optimisticPct}%.` : `Assumptions: growth ${a.growthPct}%, collection ${a.collectionPct}%, conservative ${a.conservativePct}%, optimistic ${a.optimisticPct}%.`,
      es ? `Efectivo inicial ${dec(p.input.cashNow)}; ${p.input.history.length} meses de historial.` : `Opening cash ${dec(p.input.cashNow)}; ${p.input.history.length} months of history.`]
  } else {
    return new NextResponse('Not found', { status: 404 })
  }

  const meta: [string, string][] = [[es ? 'Empresa' : 'Company', (company as { name?: string } | null)?.name ?? ''], [es ? 'Informe' : 'Report', title], [es ? 'Periodo' : 'Period', period],
    [es ? 'Moneda' : 'Currency', currency], [es ? 'Generado' : 'Generated', new Date().toISOString()], ...notes.map((n): [string, string] => [es ? 'Nota' : 'Note', n])]
  const file = `businessai-${sp.report}-${today}`
  if (format === 'xlsx') {
    const cell = (v: string | bigint | number | null): Cell => typeof v === 'bigint' ? Number(v) / 100 : v
    const rows: Cell[][] = [...meta.map(([k, v]) => [{ v: k, bold: true }, v]), [], header.map((h) => ({ v: h, bold: true })),
      ...body.map((r) => r.map((v, i) => (r[2] === 'heading' && i === 1 ? { v: String(v), bold: true } : r[2] === 'grand' && i === 3 && typeof v === 'bigint' ? { v: Number(v) / 100, bold: true } : cell(v))))]
    return new NextResponse(Buffer.from(buildXlsx(title.slice(0, 31), rows)), { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${file}.xlsx"`, 'Cache-Control': 'no-store' } })
  }
  const csv = toCsv([...meta, [], header, ...body.map((r) => r.map((v) => (typeof v === 'bigint' ? dec(v) : v ?? '')))])
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}.csv"`, 'Cache-Control': 'no-store' } })
}

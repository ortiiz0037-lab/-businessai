import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { employeesCsv, payrollSummary, runCsv, type RunRow } from '@/lib/payroll/report'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** CSV export: one run (?run=…) or the per-employee summary of a range (?from&to). payroll.view only (RLS). */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'auth_required' }, { status: 401 })
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { data: allowed } = await supabase.rpc('has_permission', { target: member.companyId, permission: 'payroll.view' })
  if (allowed !== true) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const locale = await getLocale()
  const sp = request.nextUrl.searchParams
  let csv: string, name: string
  if (UUID.test(sp.get('run') ?? '')) {
    const id = sp.get('run')!
    const { data: run } = await supabase.from('payroll_runs').select('*').eq('id', id).eq('company_id', member.companyId).maybeSingle()
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const { data: lines } = await supabase.from('payroll_lines').select('*').eq('run_id', id).order('employee_name')
    csv = runCsv(run as RunRow, (lines ?? []) as never[], locale)
    name = `nomina-${(run as RunRow).period_start}-${(run as RunRow).period_end}.csv`
  } else {
    const from = DAY.test(sp.get('from') ?? '') ? sp.get('from')! : `${new Date().toISOString().slice(0, 4)}-01-01`
    const to = DAY.test(sp.get('to') ?? '') ? sp.get('to')! : new Date().toISOString().slice(0, 10)
    const s = await payrollSummary(supabase, member.companyId, from, to)
    csv = employeesCsv(s.employees, locale)
    name = `nomina-resumen-${from}-${to}.csv`
  }
  return new NextResponse(`﻿${csv}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' } })
}

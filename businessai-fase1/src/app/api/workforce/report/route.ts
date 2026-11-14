import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { supervisesAnyone, workforceAccess, workforceRules } from '@/lib/workforce/context'
import { buildReport, reportCsv } from '@/lib/workforce/report'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** CSV export of the attendance report (managers and supervisors; RLS limits the rows). */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'auth_required' }, { status: 401 })
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const access = await workforceAccess(supabase, member.companyId, user.id)
  if (!supervisesAnyone(access)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const from = sp.get('from') ?? ''; const to = sp.get('to') ?? ''
  if (!DAY.test(from) || !DAY.test(to) || to < from || Date.parse(to) - Date.parse(from) > 370 * 86_400_000) {
    return NextResponse.json({ error: 'period' }, { status: 400 })
  }
  const rules = await workforceRules(supabase, member.companyId)
  const rows = await buildReport(supabase, {
    companyId: member.companyId, from, to, rules,
    department: UUID.test(sp.get('dept') ?? '') ? sp.get('dept') : null, employee: UUID.test(sp.get('emp') ?? '') ? sp.get('emp') : null,
  })
  const detail = sp.get('detail') === '1'
  const csv = '﻿' + reportCsv(rows, detail, await getLocale())   // BOM: accents open correctly in Excel
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="asistencia-${from}-${to}${detail ? '-detalle' : ''}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

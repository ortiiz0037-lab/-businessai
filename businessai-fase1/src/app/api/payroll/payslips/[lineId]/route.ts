import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/i18n/server'
import { layout } from '@/lib/studio/layout'
import { buildPdf } from '@/lib/studio/pdf'
import { loadBrand, serverFonts } from '@/lib/studio/server'
import { payslipContent, type PayslipItem, type PayslipLine, type PayslipRun } from '@/lib/payroll/payslip'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A pay stub as a PDF, drawn with the Document Studio engine. Read with the
 * user's session: payroll.view, or the employee for their own line of an
 * approved / paid run (RLS). Drafts and reversed runs are not issued.
 */
export async function GET(req: Request, { params }: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await params
  if (!UUID.test(lineId)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const { data: line } = await supabase.from('payroll_lines').select('*').eq('id', lineId).maybeSingle()
  if (!line) return new NextResponse('Not found', { status: 404 })
  const { data: run } = await supabase.from('payroll_runs').select('period_start, period_end, pay_date, status, run_type, payment_date').eq('id', (line as { run_id: string }).run_id).maybeSingle()
  if (!run || !['approved', 'paid'].includes((run as PayslipRun).status)) return new NextResponse('Not found', { status: 404 })
  const { data: items } = await supabase.from('payroll_line_items').select('kind, label, amount_cents').eq('line_id', lineId).order('kind')
  const locale = await getLocale()
  const companyId = (line as { company_id: string }).company_id
  const [ctx, fonts] = await Promise.all([loadBrand(supabase, companyId), serverFonts()])
  const content = payslipContent(line as PayslipLine, run as PayslipRun, (items ?? []) as PayslipItem[], ctx.companyName, locale, ctx.currency)
  const r = layout({ content, brand: ctx.brand, accentFallback: ctx.accentFallback, data: { company: { name: ctx.companyName } }, locale, currency: ctx.currency, fonts, title: 'payslip' })
  const name = (line as PayslipLine).employee_name
  const pdf = buildPdf(r.pages, fonts, {}, { title: `${locale === 'en' ? 'Pay stub' : 'Recibo de nómina'} — ${name} — ${(run as PayslipRun).period_start}`, author: ctx.companyName, lang: locale === 'en' ? 'en-US' : 'es-PR' })
  const file = `recibo-${(run as PayslipRun).period_start}-${name.replace(/[^\w.-]+/g, '-').slice(0, 40)}.pdf`
  return new NextResponse(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${file}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
}

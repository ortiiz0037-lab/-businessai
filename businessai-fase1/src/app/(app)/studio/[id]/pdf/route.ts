import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { loadDoc } from '@/lib/studio/server'
import { renderStudioPdf } from '@/lib/studio/render'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The document as a PDF (real text, embedded fonts), read with the user's session; each export is audited. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const doc = await loadDoc(supabase, member.companyId, id)
  if (!doc) return new NextResponse('Not found', { status: 404 })
  const locale = await getLocale()
  const { bytes, pages, fileName: file } = await renderStudioPdf(supabase, member.companyId, doc, locale)
  const download = new URL(req.url).searchParams.get('download') === '1'
  await supabase.rpc('studio_record', { doc: id, act: 'exported_pdf', info: { pages, download, status: doc.status } })
  return new NextResponse(Buffer.from(bytes), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${file}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
}

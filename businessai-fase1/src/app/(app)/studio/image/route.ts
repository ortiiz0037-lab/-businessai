import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { loadBrand, loadImage } from '@/lib/studio/server'

/** An image for the editor preview ('logo', 'signature', 'stamp' or a studio asset id), read with the user's session. */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get('key') ?? ''
  if (!/^(logo|signature|stamp|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(key)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('Unauthorized', { status: 401 })
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return new NextResponse('Not found', { status: 404 })
  const { data: ok } = await supabase.rpc('has_permission', { target: member.companyId, permission: 'studio.view' })
  if (ok !== true) return new NextResponse('Forbidden', { status: 403 })
  const img = await loadImage(supabase, member.companyId, key, await loadBrand(supabase, member.companyId))
  if (!img) return new NextResponse('Not found', { status: 404 })
  return new NextResponse(Buffer.from(img.bytes), { headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } })
}

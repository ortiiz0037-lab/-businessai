import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { HR_BUCKET } from '@/lib/workforce/hr'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Opens a private labour document through a 60-second signed URL. The record
 * and the file are read with the user's own session: managers of the company,
 * or the employee when the document is shared with them (RLS / storage policies).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  const { data } = await supabase.from('employee_documents').select('storage_path').eq('id', id).maybeSingle()
  if (!data) return new NextResponse('Not found', { status: 404 })
  const { data: signed, error } = await supabase.storage.from(HR_BUCKET).createSignedUrl(data.storage_path, 60)
  if (error || !signed?.signedUrl) return new NextResponse('Not found', { status: 404 })
  return NextResponse.redirect(signed.signedUrl, { headers: { 'Cache-Control': 'no-store' } })
}

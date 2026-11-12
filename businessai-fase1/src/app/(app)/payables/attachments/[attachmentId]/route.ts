import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ATTACHMENT_BUCKET } from '@/lib/finance/payables'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Opens an attachment through a 60-second signed URL. The record and the file
 *  are read with the user's own session: RLS / storage policies decide. */
export async function GET(_req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const { attachmentId } = await params
  if (!UUID.test(attachmentId)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', _req.url))
  const { data } = await supabase.from('bill_attachments').select('storage_path, file_name').eq('id', attachmentId).maybeSingle()
  if (!data) return new NextResponse('Not found', { status: 404 })
  const { data: signed, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(data.storage_path, 60)
  if (error || !signed?.signedUrl) return new NextResponse('Not found', { status: 404 })
  return NextResponse.redirect(signed.signedUrl, { headers: { 'Cache-Control': 'no-store' } })
}

import { NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { imageInfo, MAX_IMAGE_BYTES } from '@/lib/studio/images'
import { studioErrorCode } from '@/lib/studio/model'

/**
 * Image upload for the editor: validated by CONTENT (PNG / JPEG magic bytes,
 * ≤ 2 MB, ≤ 6000 px), stored in the private bucket under the company folder
 * with a random name, then registered (studio_register_asset checks the file
 * exists and the permission). Returns { id, width, height } as JSON.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'forbidden' }, { status: 401 })
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: 'file_invalid' }, { status: 400 })
  const bytes = new Uint8Array(await file.arrayBuffer())
  const info = imageInfo(bytes)
  if (!info) return NextResponse.json({ error: 'file_invalid' }, { status: 400 })
  const path = `${member.companyId}/${randomUUID()}.${info.ext}`
  const { error: up } = await supabase.storage.from('Studio-assets').upload(path, bytes, { contentType: info.mime, upsert: false })
  if (up) return NextResponse.json({ error: /row-level security|unauthorized|403/i.test(up.message) ? 'forbidden' : 'save' }, { status: 400 })
  const name = (file.name || `imagen.${info.ext}`).replace(/[^\w.\- ]+/g, '').slice(0, 160) || `imagen.${info.ext}`
  const { data, error } = await supabase.rpc('studio_register_asset', { target: member.companyId, path, name, mime: info.mime, bytes: bytes.length, w: info.width, h: info.height,
    digest: createHash('sha256').update(bytes).digest('hex') })
  if (error) return NextResponse.json({ error: studioErrorCode(error) }, { status: 400 })
  return NextResponse.json({ id: data, width: info.width, height: info.height, name })
}

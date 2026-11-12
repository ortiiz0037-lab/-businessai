'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ATTACHMENT_BUCKET, attachmentPath, validateAttachment } from '@/lib/finance/payables'
import { registerAttachment } from '@/app/actions/payables'

type Copy = { label: string; uploading: string; done: string; errors: Record<string, string>; fallback: string }

/**
 * Uploads a receipt / invoice straight to private storage with the user's
 * own session (storage policies check company, bill and permission), then
 * registers it. A file whose registration fails is removed again.
 */
export function AttachmentUploader({ companyId, billId, copy }: { companyId: string; billId: string; copy: Copy }) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; tone: 'ok' | 'error' }>({ busy: false, message: null, tone: 'ok' })
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const invalid = validateAttachment(file)
    if (invalid) { setState({ busy: false, message: copy.errors[invalid] ?? copy.fallback, tone: 'error' }); return }
    setState({ busy: true, message: copy.uploading, tone: 'ok' })
    const supabase = createClient()
    const path = attachmentPath(companyId, billId, crypto.randomUUID(), file.name)
    const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, file, { upsert: false, contentType: file.type })
    if (error) { setState({ busy: false, message: copy.errors.forbidden ?? copy.fallback, tone: 'error' }); return }
    const res = await registerAttachment({ billId, path, fileName: file.name, type: file.type, size: file.size })
    if (input.current) input.current.value = ''
    if (!res.ok) { setState({ busy: false, message: copy.errors[res.error ?? ''] ?? copy.fallback, tone: 'error' }); return }
    setState({ busy: false, message: copy.done, tone: 'ok' })
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <label className="btn-secondary btn-sm inline-flex cursor-pointer">
        {copy.label}
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic" className="sr-only" disabled={state.busy} onChange={onChange} />
      </label>
      {state.message && <p role={state.tone === 'error' ? 'alert' : 'status'} className={`text-xs ${state.tone === 'error' ? 'text-red-300' : 'text-muted'}`}>{state.message}</p>}
    </div>
  )
}

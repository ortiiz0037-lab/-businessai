'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { EVIDENCE_BUCKET, EVIDENCE_MAX_BYTES, receiptPath } from '@/lib/banking/files'
import { registerReceipt } from '@/app/actions/banking'

type Copy = { photo: string; file: string; uploading: string; reading: string; duplicate: string; errors: Record<string, string>; fallback: string }
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

/** Large photos (or formats the bucket does not take, such as HEIC when the browser can decode it) become a JPEG of at most 2400 px. */
async function prepare(file: File): Promise<Blob> {
  if (file.type === 'application/pdf') return file
  if (ALLOWED.includes(file.type) && file.size <= 3 * 1024 * 1024) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('encode'))), 'image/jpeg', 0.85))
  } catch {
    return file
  }
}

/**
 * Photo (iPhone / iPad camera) or file (desktop) → private storage with the
 * user's own session (bucket policies check company and permission) → the
 * server registers it, refuses duplicates and asks the OCR provider, if any,
 * for suggestions. The person reviews and confirms on the next screen.
 */
export function ReceiptCapture({ companyId, copy }: { companyId: string; copy: Copy }) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; tone: 'ok' | 'error' }>({ busy: false, message: null, tone: 'ok' })
  const camera = useRef<HTMLInputElement>(null), picker = useRef<HTMLInputElement>(null)
  const router = useRouter()
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const original = e.target.files?.[0]
    e.target.value = ''
    if (!original) return
    setState({ busy: true, message: copy.uploading, tone: 'ok' })
    const blob = await prepare(original)
    if (!ALLOWED.includes(blob.type) || blob.size > EVIDENCE_MAX_BYTES) { setState({ busy: false, message: copy.errors.file ?? copy.fallback, tone: 'error' }); return }
    const path = receiptPath(companyId, crypto.randomUUID(), blob.type)
    const { error } = await createClient().storage.from(EVIDENCE_BUCKET).upload(path, blob, { upsert: false, contentType: blob.type })
    if (error) { setState({ busy: false, message: copy.errors.forbidden ?? copy.fallback, tone: 'error' }); return }
    setState({ busy: true, message: copy.reading, tone: 'ok' })
    const r = await registerReceipt({ path, fileName: original.name || 'recibo' })
    if (!r.ok) { setState({ busy: false, message: copy.errors[r.error] ?? copy.fallback, tone: 'error' }); return }
    setState({ busy: false, message: r.duplicate ? copy.duplicate : null, tone: 'ok' })
    router.push(`/bank/receipts/${r.id}${r.duplicate ? '?done=duplicate' : ''}`)
  }
  return (
    <div className="space-y-2" data-testid="receipt-capture">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className={`btn-primary cursor-pointer justify-center ${state.busy ? 'pointer-events-none opacity-60' : ''}`}>
          {copy.photo}
          <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" disabled={state.busy} onChange={onChange} data-testid="receipt-camera" />
        </label>
        <label className={`btn-secondary cursor-pointer justify-center ${state.busy ? 'pointer-events-none opacity-60' : ''}`}>
          {copy.file}
          <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" className="sr-only" disabled={state.busy} onChange={onChange} data-testid="receipt-file" />
        </label>
      </div>
      {state.message && <p role={state.tone === 'error' ? 'alert' : 'status'} className={`text-sm ${state.tone === 'error' ? 'text-red-300' : 'text-muted'}`}>{state.message}</p>}
    </div>
  )
}

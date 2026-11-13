'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { HR_BUCKET, hrDocumentPath, validateHrDocument } from '@/lib/workforce/hr'
import { registerEmployeeDocument } from '@/app/actions/workforce-hr'

type Copy = {
  title: string; category: string; shared: string; choose: string; uploading: string; done: string; fallback: string
  categories: { value: string; label: string }[]; errors: Record<string, string>
}

/**
 * Uploads a private labour document straight to the private HR bucket with
 * the manager's own session (storage policies check company, employee and
 * permission), then registers it. A file whose registration fails is removed.
 */
export function HrDocumentUploader({ companyId, employeeId, copy }: { companyId: string; employeeId: string; copy: Copy }) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; tone: 'ok' | 'error' }>({ busy: false, message: null, tone: 'ok' })
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState(copy.categories[0]?.value ?? 'other')
  const [shared, setShared] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const invalid = validateHrDocument(file)
    if (invalid) { setState({ busy: false, message: copy.errors[invalid] ?? copy.fallback, tone: 'error' }); return }
    const name = title.trim() || file.name.replace(/\.[^.]+$/, '')
    setState({ busy: true, message: copy.uploading, tone: 'ok' })
    try {
      const supabase = createClient()
      const path = hrDocumentPath(companyId, employeeId, crypto.randomUUID(), file.name)
      const { error } = await supabase.storage.from(HR_BUCKET).upload(path, file, { upsert: false, contentType: file.type })
      if (error) { setState({ busy: false, message: copy.errors.forbidden ?? copy.fallback, tone: 'error' }); return }
      const res = await registerEmployeeDocument({ employeeId, path, fileName: file.name, type: file.type, size: file.size, category, title: name, shared })
      if (!res.ok) { setState({ busy: false, message: copy.errors[res.error ?? ''] ?? copy.fallback, tone: 'error' }); return }
      setTitle('')
      setState({ busy: false, message: copy.done, tone: 'ok' })
      router.refresh()
    } catch {
      // never stay "uploading": storage unreachable or misconfigured
      setState({ busy: false, message: copy.fallback, tone: 'error' })
    } finally {
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="hr-uploader">
      <label className="field-label">{copy.title}<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} className="field mt-1" /></label>
      <label className="field-label">{copy.category}
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="field mt-1">
          {copy.categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-300 sm:col-span-2"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> {copy.shared}</label>
      <label className="btn-secondary btn-sm inline-flex w-fit cursor-pointer">
        {copy.choose}
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" disabled={state.busy} onChange={onChange} data-testid="hr-file" />
      </label>
      {state.message && <p role={state.tone === 'error' ? 'alert' : 'status'} className={`text-xs sm:col-span-2 ${state.tone === 'error' ? 'text-red-300' : 'text-muted'}`}>{state.message}</p>}
    </div>
  )
}

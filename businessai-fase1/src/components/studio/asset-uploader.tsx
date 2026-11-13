'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Uploads a PNG / JPEG to Studio-assets (validated again on the server) and refreshes the page. */
export function AssetUploader({ label, busy, done, failed }: { label: string; busy: string; done: string; failed: string }) {
  const router = useRouter()
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="btn-secondary btn-sm cursor-pointer">{label}
        <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = ''
          if (!file) return
          setMsg(busy)
          const fd = new FormData(); fd.append('file', file)
          const r = await fetch('/studio/assets', { method: 'POST', body: fd })
          setMsg(r.ok ? done : failed)
          if (r.ok) router.refresh()
        }} />
      </label>
      {msg && <span role="status" className="text-xs text-muted">{msg}</span>}
    </div>
  )
}

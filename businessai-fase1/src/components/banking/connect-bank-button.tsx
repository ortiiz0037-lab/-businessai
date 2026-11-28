'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { completeConnection, createLinkToken } from '@/app/actions/banking'

type PlaidHandler = { open: () => void; destroy: () => void }
declare global { interface Window { Plaid?: { create: (o: { token: string; onSuccess: (publicToken: string) => void; onExit: (err: unknown) => void }) => PlaidHandler } } }

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
function loadLink(): Promise<void> {
  if (window.Plaid) return Promise.resolve()
  return new Promise((ok, fail) => {
    const s = document.createElement('script')
    s.src = LINK_SCRIPT; s.async = true; s.onload = () => ok(); s.onerror = () => fail(new Error('link'))
    document.head.appendChild(s)
  })
}

/**
 * Opens Plaid Link, the provider's own secure window where the customer picks
 * the bank and signs in. BusinessAI never sees the bank password: it only
 * receives a one-time public token, exchanged on the server.
 * With connectionId it reconnects an existing connection (update mode).
 */
export function ConnectBankButton({ label, busyLabel, errors, connectionId, secondary }: { label: string; busyLabel: string; errors: Record<string, string>; connectionId?: string; secondary?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  async function start() {
    setBusy(true); setError(null)
    const t = await createLinkToken(connectionId)
    if (!t.ok) { setBusy(false); setError(errors[t.error] ?? errors.save); return }
    try { await loadLink() } catch { setBusy(false); setError(errors.link ?? errors.save); return }
    const handler = window.Plaid!.create({
      token: t.token,
      onSuccess: async (publicToken) => {
        // update mode: the item and its token stay the same; nothing to exchange
        const r = connectionId ? { ok: true as const } : await completeConnection(publicToken)
        setBusy(false); handler.destroy()
        if (!r.ok) setError(errors[r.error] ?? errors.save); else router.refresh()
      },
      onExit: () => { setBusy(false); handler.destroy() },
    })
    handler.open()
  }
  return (
    <div className="space-y-1">
      <button type="button" onClick={start} disabled={busy} className={secondary ? 'btn-secondary btn-sm' : 'btn-primary'}>{busy ? busyLabel : label}</button>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </div>
  )
}

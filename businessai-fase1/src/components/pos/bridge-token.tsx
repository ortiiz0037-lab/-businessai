'use client'
import { useState } from 'react'
import { issueBridgeToken } from '@/app/actions/pos'

/** shows a new bridge token once (only its SHA-256 is kept) */
export function BridgeToken({ integration, locale }: { integration: string; locale: 'es' | 'en' }) {
  const [tok, setTok] = useState<string | null>(null)
  const t = (es: string, en: string) => (locale === 'en' ? en : es)
  return (
    <div className="space-y-2">
      <button type="button" className="btn-secondary btn-sm min-h-11" onClick={async () => { const r = await issueBridgeToken(integration); setTok(r.ok ? r.token : null) }}>
        {t('Generar token del puente (revoca el anterior)', 'Generate bridge token (revokes the previous one)')}</button>
      {tok && <p className="break-all rounded-lg border border-line bg-elevated p-2 font-mono text-xs" data-testid="bridge-token">{tok}<span className="mt-1 block font-sans text-muted">{t('Cópialo ahora: no se volverá a mostrar.', 'Copy it now: it will not be shown again.')}</span></p>}
    </div>
  )
}

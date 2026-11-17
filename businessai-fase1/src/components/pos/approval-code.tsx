'use client'
import { useState } from 'react'
import { issueApprovalCode } from '@/app/actions/pos'

/** An approver issues a one-time code for a cashier (shown once, here only; only its hash is stored). */
export function ApprovalCodeIssuer({ locale, branches }: { locale: 'es' | 'en'; branches: { id: string; name: string }[] }) {
  const t = (es: string, en: string) => (locale === 'en' ? en : es)
  const [scope, setScope] = useState('discount'), [branch, setBranch] = useState(''), [max, setMax] = useState(''), [pct, setPct] = useState('')
  const [out, setOut] = useState<{ code?: string; expiresAt?: string; error?: string } | null>(null)
  return (
    <div className="card space-y-3 p-5" data-testid="approval-issuer">
      <h2 className="font-display text-lg font-semibold text-fg">{t('Código de autorización', 'Authorisation code')}</h2>
      <p className="text-xs text-muted">{t('Un solo uso, con límite y caducidad. Díselo al cajero; no lo envíes por escrito.', 'Single use, limited and expiring. Tell it to the cashier; do not send it in writing.')}</p>
      <div className="grid grid-cols-2 gap-2">
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="field h-11">
          <option value="discount">{t('Descuento', 'Discount')}</option><option value="refund">{t('Devolución', 'Refund')}</option><option value="void">{t('Anulación', 'Void')}</option><option value="cash_out">{t('Salida de efectivo', 'Cash out')}</option></select>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="field h-11"><option value="">{t('Cualquier sucursal', 'Any branch')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" placeholder={t('Importe máximo', 'Max amount')} className="field h-11" />
        {scope === 'discount' && <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" placeholder={t('% máximo', 'Max %')} className="field h-11" />}
      </div>
      <button type="button" className="btn-secondary min-h-11" onClick={async () => setOut(await issueApprovalCode({ branch: branch || null, scope, maxCents: max || null, maxPct: pct || null, minutes: 10 }))}>{t('Generar código (10 min)', 'Generate code (10 min)')}</button>
      {out?.code && <p className="text-center font-mono text-3xl font-bold tracking-[0.3em] text-fg" data-testid="approval-code">{out.code}</p>}
      {out?.error && <p role="alert" className="text-sm text-red-200">{out.error}</p>}
    </div>
  )
}

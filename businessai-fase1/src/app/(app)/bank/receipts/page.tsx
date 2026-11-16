import Link from 'next/link'
import { PageHeader, EmptyState } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { BankNav, StateChip } from '@/components/bank-nav'
import { ReceiptCapture } from '@/components/banking/receipt-capture'
import { receiptsPage } from '@/lib/banking/receipts-page'
import { ocrStatus } from '@/lib/banking/config'
import { bankingMessage } from '@/lib/banking/messages'

export const dynamic = 'force-dynamic'

type Capture = { id: string; file_name: string; content_type: string; status: string; ocr_status: string; ocr_provider: string | null; confirmed: { merchant?: string | null; total_cents?: string; date?: string } | null
  bill_id: string | null; payment_id: string | null; created_at: string }

/** Receipt capture: photo or upload, the provider's suggestions, then the person's confirmation. */
export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; status?: string }> }) {
  const sp = await searchParams
  const { locale, tr, f, money, supabase, companyId, available, capture, bankView } = await receiptsPage()
  const header = <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Recibos', 'Receipts')}
    description={tr('Fotografíe o suba un recibo. Si hay un servicio de lectura configurado, propone los datos; usted los revisa y confirma. El original se guarda en privado.',
      'Take a photo or upload a receipt. If a reading service is configured it proposes the data; you review and confirm. The original is kept private.')} />
  if (!available || !capture && !bankView) {
    return (<div className="space-y-6">{header}<div className="card p-6 text-sm text-muted">{!available ? bankingMessage('unavailable', locale) : bankingMessage('forbidden', locale)}</div></div>)
  }
  const status = ['captured', 'confirmed', 'discarded'].includes(sp.status ?? '') ? sp.status! : ''
  let q = supabase.from('receipt_captures').select('id, file_name, content_type, status, ocr_status, ocr_provider, confirmed, bill_id, payment_id, created_at').eq('company_id', companyId)
  q = status ? q.eq('status', status) : q.neq('status', 'discarded')
  const { data } = await q.order('created_at', { ascending: false }).limit(200)
  const captures = (data ?? []) as Capture[]
  const ocr = ocrStatus()
  const errors = Object.fromEntries(['file', 'forbidden', 'receipt_invalid', 'unavailable', 'save'].map((k) => [k, bankingMessage(k, locale)!]))
  const statusLabel: Record<string, string> = { captured: tr('Por confirmar', 'To confirm'), confirmed: tr('Confirmado', 'Confirmed'), discarded: tr('Descartado', 'Discarded') }
  return (
    <div className="space-y-6">
      {header}
      {bankView && <BankNav tr={tr} current="/bank/receipts" />}
      <Flash done={sp.done === 'discarded' ? tr('Recibo descartado. El archivo original se conserva.', 'Receipt discarded. The original file is kept.') : null} error={bankingMessage(sp.error, locale)} />
      {capture && (
        <section className="card space-y-3 p-5" aria-labelledby="cap-title">
          <h2 id="cap-title" className="font-display text-lg font-semibold text-fg">{tr('Capturar un recibo', 'Capture a receipt')}</h2>
          <ReceiptCapture companyId={companyId} copy={{
            photo: tr('Tomar foto', 'Take photo'), file: tr('Subir archivo', 'Upload file'), uploading: tr('Subiendo de forma privada…', 'Uploading privately…'),
            reading: tr('Leyendo el recibo…', 'Reading the receipt…'), duplicate: tr('Ese archivo ya estaba registrado.', 'That file was already registered.'), errors, fallback: errors.save,
          }} />
          <p className="text-xs text-muted" data-testid="ocr-status">{ocr.configured
            ? (ocr.testDouble ? tr('Lectura automática: DOBLE DE PRUEBA local (no lee imágenes reales).', 'Automatic reading: local TEST DOUBLE (does not read real images).') : tr('Lectura automática activada (Azure AI Document Intelligence). Revise siempre los datos.', 'Automatic reading on (Azure AI Document Intelligence). Always review the data.'))
            : tr('Lectura automática no configurada: escriba los datos usted mismo. El archivo se guarda igualmente.', 'Automatic reading not configured: type the data yourself. The file is kept anyway.')}</p>
        </section>
      )}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr('Filtro', 'Filter')}>
        {[['', tr('Activos', 'Active')], ['captured', statusLabel.captured], ['confirmed', statusLabel.confirmed], ['discarded', statusLabel.discarded]].map(([v, label]) => (
          <Link key={v} href={v ? `/bank/receipts?status=${v}` : '/bank/receipts'} aria-current={status === v ? 'page' : undefined}
            className={`rounded-xl border px-3 py-1.5 ${status === v ? 'border-electric/60 bg-brand/20 text-fg' : 'border-line text-slate-300'}`}>{label}</Link>
        ))}
      </nav>
      {captures.length === 0 ? (
        <div className="card"><EmptyState icon="receipt" title={tr('Sin recibos', 'No receipts')} description={tr('Los recibos capturados aparecen aquí.', 'Captured receipts appear here.')} /></div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="receipt-list">
          {captures.map((c) => (
            <li key={c.id}>
              <Link href={`/bank/receipts/${c.id}`} className="card flex h-full flex-col gap-2 p-4 transition hover:border-electric/40" data-testid="receipt-item">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate font-semibold text-fg">{c.confirmed?.merchant || c.file_name}</span>
                  <StateChip tone={c.status === 'confirmed' ? 'ok' : c.status === 'discarded' ? 'issue' : 'pending'}>{statusLabel[c.status]}</StateChip>
                </div>
                <span className="text-xs text-muted">{f.date(c.created_at.slice(0, 10))} · {c.content_type === 'application/pdf' ? 'PDF' : tr('Foto', 'Photo')}
                  {c.confirmed?.total_cents ? ` · ${money(Number(c.confirmed.total_cents))}` : ''}{c.bill_id ? ` · ${tr('gasto vinculado', 'expense linked')}` : ''}{c.payment_id ? ` · ${tr('pago vinculado', 'payment linked')}` : ''}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

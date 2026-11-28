import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page'
import { SubmitButton } from '@/components/submit-button'
import { Flash } from '@/components/accounting-nav'
import { StateChip } from '@/components/bank-nav'
import { receiptsPage } from '@/lib/banking/receipts-page'
import { EVIDENCE_BUCKET } from '@/lib/banking/files'
import { bankingMessage, RECEIPT_FIELDS, RECEIPT_FIELD_LABEL } from '@/lib/banking/messages'
import { paymentMethodLabel, PAYMENT_METHODS } from '@/lib/documents/payments'
import { confirmReceipt, discardReceipt } from '@/app/actions/banking'

export const dynamic = 'force-dynamic'

type Field = { value: string | number; confidence: number | null } | null
type Capture = { id: string; storage_path: string; file_name: string; content_type: string; size_bytes: number; status: string; ocr_provider: string | null; ocr_status: string; ocr_error: string | null
  extracted: Record<string, Field>; confirmed: Record<string, string | null> | null; bill_id: string | null; payment_id: string | null; created_by: string | null; created_at: string; confirmed_at: string | null }

/** One receipt: the original, what the reading service suggested (or did not recognize) and the confirmation form. */
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const { locale, tr, f, money, supabase, companyId, capture, payablesView } = await receiptsPage()
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { data } = await supabase.from('receipt_captures').select('*').eq('id', id).eq('company_id', companyId).maybeSingle()
  const c = data as Capture | null
  if (!c) notFound()
  const [{ data: signed }, { data: billRows }, { data: payRows }] = await Promise.all([
    supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(c.storage_path, 300),
    payablesView ? supabase.from('bills').select('id, description, vendor_invoice_number, total_cents, bill_date, status, vendors(name)').eq('company_id', companyId).neq('status', 'void').order('bill_date', { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    supabase.from('payments').select('id, amount, paid_at, payment_method, documents(document_number)').eq('company_id', companyId).is('voided_at', null).order('paid_at', { ascending: false }).limit(100),
  ])
  const bills = (billRows ?? []) as unknown as { id: string; description: string; vendor_invoice_number: string | null; total_cents: number; bill_date: string; vendors: { name: string } | null }[]
  const payments = (payRows ?? []) as unknown as { id: string; amount: number; paid_at: string; payment_method: string | null; documents: { document_number: string | null } | null }[]
  const ex = c.extracted ?? {}
  const v = (k: string) => ex[k]?.value
  const open = c.status === 'captured' && capture
  const testResult = c.ocr_provider === 'test_double'
  const done: Record<string, string> = {
    duplicate: tr('Ese archivo ya estaba registrado: este es el recibo existente (no se duplicó).', 'That file was already registered: this is the existing receipt (no duplicate).'),
    confirmed: tr('Datos confirmados.', 'Data confirmed.'),
    confirmed_attached: tr('Datos confirmados y archivo adjuntado al gasto.', 'Data confirmed and file attached to the expense.'),
    confirmed_not_attached: tr('Datos confirmados y gasto vinculado. El archivo no se pudo adjuntar al gasto (permisos de Finanzas); sigue guardado aquí.', 'Data confirmed and expense linked. The file could not be attached to the expense (Finance permissions); it stays stored here.'),
  }
  const ocrNote = c.ocr_status === 'not_configured' ? tr('Sin lectura automática: escriba los datos.', 'No automatic reading: type the data.')
    : c.ocr_status === 'failed' ? tr(`La lectura automática falló (${c.ocr_error ?? 'error'}): escriba los datos.`, `Automatic reading failed (${c.ocr_error ?? 'error'}): type the data.`)
    : c.ocr_status === 'succeeded' ? (testResult ? tr('Sugerencias de un DOBLE DE PRUEBA local (no es una lectura real).', 'Suggestions from a local TEST DOUBLE (not a real reading).') : tr('Sugerencias del servicio de lectura: revíselas antes de confirmar.', 'Suggestions from the reading service: review them before confirming.'))
    : tr('Lectura pendiente.', 'Reading pending.')
  const shown = (k: string, val: Field) => (val === null || val === undefined ? null : k.endsWith('_cents') ? money(Number(val.value)) : k === 'date' ? f.date(String(val.value)) : String(val.value))
  const dollars = (n: unknown) => (n === undefined || n === null || n === '' ? '' : (Number(n) / 100).toFixed(2))
  const conf = c.confirmed ?? {}

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Recibo', 'Receipt')} title={conf.merchant || c.file_name} description={`${f.date(c.created_at.slice(0, 10))} · ${(c.size_bytes / 1024).toFixed(0)} KB`}
        actions={<Link href="/bank/receipts" className="btn-secondary">{tr('Volver', 'Back')}</Link>} />
      <Flash done={sp.done ? done[sp.done] ?? null : null} error={bankingMessage(sp.error, locale)} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="card min-w-0 p-4" aria-label={tr('Original', 'Original')}>
          {signed?.signedUrl ? (c.content_type === 'application/pdf'
            ? <a href={signed.signedUrl} target="_blank" rel="noreferrer" className="btn-secondary">{tr('Abrir PDF original', 'Open original PDF')}</a>
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={signed.signedUrl} alt={tr('Foto del recibo', 'Receipt photo')} className="max-h-[70vh] w-full rounded-xl object-contain" data-testid="receipt-image" />)
            : <p className="text-sm text-muted">{tr('No se pudo mostrar el original.', 'The original could not be shown.')}</p>}
        </section>
        <div className="min-w-0 space-y-6">
          <section className="card p-5" aria-labelledby="ocr-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="ocr-title" className="font-display text-lg font-semibold text-fg">{tr('Datos leídos', 'Data read')}</h2>
              <StateChip tone={c.status === 'confirmed' ? 'ok' : c.status === 'discarded' ? 'issue' : 'pending'}>{({ captured: tr('Por confirmar', 'To confirm'), confirmed: tr('Confirmado', 'Confirmed'), discarded: tr('Descartado', 'Discarded') } as Record<string, string>)[c.status]}</StateChip>
            </div>
            <p className={`mt-1 text-xs ${testResult ? 'text-amber-200' : 'text-muted'}`} data-testid="ocr-note">{ocrNote}</p>
            <dl className="mt-3 divide-y divide-line/60 text-sm" data-testid="ocr-fields">
              {RECEIPT_FIELDS.map((k) => {
                const val = ex[k] ?? null, s = shown(k, val)
                return (
                  <div key={k} className="flex items-center justify-between gap-3 py-2" data-field={k} data-recognized={s ? 'yes' : 'no'}>
                    <dt className="text-muted">{RECEIPT_FIELD_LABEL[k][locale]}</dt>
                    <dd className="text-right">{s ? <>{s}{val?.confidence !== null && val?.confidence !== undefined ? <span className="ml-2 text-xs text-muted">{Math.round(val.confidence * 100)}%</span> : null}</> : <span className="text-xs italic text-amber-200">{tr('No reconocido', 'Not recognized')}</span>}</dd>
                  </div>
                )
              })}
            </dl>
          </section>

          {open ? (
            <form action={confirmReceipt} className="card space-y-4 p-5" data-testid="receipt-confirm">
              <input type="hidden" name="capture_id" value={c.id} />
              <h2 className="font-display text-lg font-semibold text-fg">{tr('Revisar y confirmar', 'Review and confirm')}</h2>
              <p className="text-xs text-muted">{tr('Corrija lo que haga falta. Los campos vacíos se guardan vacíos: nada se inventa.', 'Correct whatever is needed. Empty fields are saved empty: nothing is invented.')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="field-label">{tr('Fecha *', 'Date *')}<input name="date" type="date" required defaultValue={String(v('date') ?? '')} className="field mt-2" /></label>
                <label className="field-label">{tr('Comercio', 'Merchant')}<input name="merchant" maxLength={200} defaultValue={String(v('merchant') ?? '')} className="field mt-2" /></label>
                <label className="field-label">{tr('Total *', 'Total *')}<input name="total" required inputMode="decimal" defaultValue={dollars(v('total_cents'))} className="field mt-2" /></label>
                <label className="field-label">{tr('Impuestos', 'Taxes')}<input name="tax" inputMode="decimal" defaultValue={dollars(v('tax_cents'))} className="field mt-2" /></label>
                <label className="field-label">{tr('Moneda *', 'Currency *')}<input name="currency" required maxLength={3} defaultValue={String(v('currency') ?? '')} placeholder="USD" className="field mt-2 uppercase" /></label>
                <label className="field-label">{tr('Nº de recibo', 'Receipt no.')}<input name="receipt_number" maxLength={80} defaultValue={String(v('receipt_number') ?? '')} className="field mt-2" /></label>
                <label className="field-label">{tr('Método de pago', 'Payment method')}
                  <select name="payment_method" defaultValue={String(v('payment_method') ?? '')} className="field mt-2">
                    <option value="">{tr('Sin indicar', 'Not stated')}</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m, locale)}</option>)}
                  </select></label>
                <label className="field-label">{tr('Referencia', 'Reference')}<input name="reference" maxLength={120} defaultValue={String(v('reference') ?? '')} className="field mt-2" /></label>
                {payablesView && (
                  <label className="field-label sm:col-span-2">{tr('Vincular a un gasto (factura de proveedor)', 'Link to an expense (vendor bill)')}
                    <select name="bill_id" defaultValue="" className="field mt-2" data-testid="receipt-bill">
                      <option value="">{tr('Ninguno', 'None')}</option>
                      {bills.map((b) => <option key={b.id} value={b.id}>{b.vendors?.name ?? '—'} · {b.vendor_invoice_number ?? b.description} · {money(b.total_cents)} · {f.date(b.bill_date)}</option>)}
                    </select></label>
                )}
                <label className="field-label sm:col-span-2">{tr('O vincular a un pago registrado', 'Or link to a recorded payment')}
                  <select name="payment_id" defaultValue="" className="field mt-2">
                    <option value="">{tr('Ninguno', 'None')}</option>
                    {payments.map((p) => <option key={p.id} value={p.id}>{p.documents?.document_number ?? '—'} · {money(Math.round(p.amount * 100))} · {f.date(p.paid_at.slice(0, 10))}</option>)}
                  </select></label>
                <label className="field-label sm:col-span-2">{tr('Notas', 'Notes')}<textarea name="notes" rows={2} maxLength={500} className="field mt-2" /></label>
              </div>
              <SubmitButton>{tr('Confirmar datos', 'Confirm data')}</SubmitButton>
            </form>
          ) : c.status === 'confirmed' ? (
            <section className="card space-y-2 p-5 text-sm" data-testid="receipt-confirmed">
              <h2 className="font-display text-lg font-semibold text-fg">{tr('Datos confirmados', 'Confirmed data')}</h2>
              <p>{conf.merchant ?? '—'} · {conf.date ? f.date(conf.date) : '—'} · {money(Number(conf.total_cents ?? 0))}{conf.tax_cents ? ` (${tr('impuestos', 'taxes')} ${money(Number(conf.tax_cents))})` : ''} · {conf.currency}</p>
              {c.bill_id && <p><Link href={`/payables/${c.bill_id}`} className="text-accent hover:underline">{tr('Ver gasto vinculado', 'View linked expense')}</Link></p>}
            </section>
          ) : null}
          {open && (
            <form action={discardReceipt}><input type="hidden" name="capture_id" value={c.id} />
              <SubmitButton className="btn-secondary btn-sm">{tr('Descartar (el archivo se conserva)', 'Discard (the file is kept)')}</SubmitButton></form>
          )}
        </div>
      </div>
    </div>
  )
}

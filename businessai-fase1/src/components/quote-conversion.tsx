import Link from 'next/link'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tr } from '@/lib/i18n/t'
import type { Locale } from '@/lib/i18n/app'
import { crmMessage } from '@/lib/crm/core'
import { addDays } from '@/lib/workforce/hours'
import { convertQuote } from '@/app/actions/crm'

/**
 * Quote ↔ invoice link on the document page (0035): an accepted quote can be
 * converted into a DRAFT invoice (once while that invoice lives); an invoice
 * shows the quote it came from. Hidden when the database has no CRM yet.
 */
export async function QuoteConversion({ supabase, doc, tr, locale, today, canCreate, converted, error }: {
  supabase: SupabaseClient; doc: { id: string; document_type: string | null; status: string | null; client_id: string | null; metadata: Record<string, unknown> | null }
  tr: Tr; locale: Locale; today: string; canCreate: boolean; converted?: boolean; error?: string
}) {
  const banner = <>
    {converted && <div role="status" className="alert-success mb-5 p-4">{tr('Factura creada en BORRADOR desde la cotización. Revísala y envíala cuando corresponda: solo entonces se contabiliza.', 'DRAFT invoice created from the quote. Review it and send it when appropriate: only then is it posted.')}</div>}
    {error && <div role="alert" className="alert-danger mb-5 p-4">{crmMessage(error, locale)}</div>}
  </>
  const sourceQuote = typeof doc.metadata?.source_quote_id === 'string' ? doc.metadata.source_quote_id : null
  if (doc.document_type === 'invoice' && sourceQuote) {
    return <>{banner}<p className="mb-5 text-sm text-muted print:hidden" data-testid="invoice-from-quote">{tr('Factura creada desde la cotización', 'Invoice created from quote')}{' '}
      <Link href={`/documents/${sourceQuote}`} className="font-semibold text-blue-400">{String(doc.metadata?.source_quote_number ?? '')}</Link></p></>
  }
  if (doc.document_type !== 'quote') return banner
  const { data, error: e } = await supabase.from('crm_quote_conversions').select('invoice_id, converted_at').eq('quote_id', doc.id).order('converted_at', { ascending: false })
  if (e) return banner                                          // 0035 not applied
  const conv = (data ?? []) as { invoice_id: string }[]
  const { data: inv } = conv.length ? await supabase.from('documents').select('id, document_number, status').in('id', conv.map((c) => c.invoice_id)) : { data: [] }
  const invoices = (inv ?? []) as { id: string; document_number: string; status: string }[]
  const live = invoices.find((i) => i.status !== 'cancelled')
  return (
    <>
      {banner}
      {invoices.length > 0 && <p className="mb-3 text-sm text-muted print:hidden" data-testid="quote-invoices">{tr('Facturas creadas desde esta cotización:', 'Invoices created from this quote:')}{' '}
        {invoices.map((i) => <Link key={i.id} href={`/documents/${i.id}`} className={`mr-2 font-semibold ${i.status === 'cancelled' ? 'text-muted line-through' : 'text-blue-400'}`}>{i.document_number}</Link>)}</p>}
      {doc.status === 'accepted' && canCreate && !live && doc.client_id && (
        <form action={convertQuote} className="mb-5 flex flex-wrap items-end gap-2 rounded-2xl border border-electric/40 bg-electric/10 p-4 print:hidden" data-testid="convert-quote">
          <input type="hidden" name="quote_id" value={doc.id} /><input type="hidden" name="idem" value={randomUUID()} /><input type="hidden" name="back" value={`/documents/${doc.id}`} />
          <label className="field-label">{tr('Vencimiento de la factura', 'Invoice due date')}<input name="due_date" type="date" required min={today} defaultValue={addDays(today, 30)} className="field mt-1 py-1.5" /></label>
          <button type="submit" className="btn-primary btn-sm">{tr('Convertir en factura', 'Convert to invoice')}</button>
          <span className="w-full text-xs text-muted">{tr('Crea una factura en borrador con las mismas líneas y totales. No se contabiliza hasta enviarla.', 'Creates a draft invoice with the same lines and totals. Nothing is posted until it is sent.')}</span>
        </form>
      )}
    </>
  )
}

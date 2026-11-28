/**
 * Studio drafts about Finance records (0038), shared by the invoice / expense
 * screens and by confirmed BusinessAI Assistant actions (0040), so both follow
 * ONE contract:
 *   - collection letter: about an invoice of the company (client taken from it);
 *   - payment voucher: about a recorded, non-voided payment of an expense
 *     (linked with studio_set_finance_link, which checks payables.view, the
 *     company, the payment and the bill).
 * The content comes from the system template; figures are merge fields read
 * from Receivables / Payables, never written. Nothing is issued, sent, paid or
 * posted. A retry resumes the draft an earlier attempt created (no duplicates).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { studioErrorCode } from '@/lib/studio/model'
import { systemTemplate } from '@/lib/studio/templates'

export type FinanceDraftInput =
  | { kind: 'collection_letter'; documentId: string; locale: Locale; origin: 'user' | 'assistant' }
  | { kind: 'payment_voucher'; billId: string; paymentId: string; locale: Locale; origin: 'user' | 'assistant' }
export type FinanceDraftResult = { ok: true; id: string } | { ok: false; error: string; id?: string }

export async function createFinanceDraft(supabase: SupabaseClient, companyId: string, input: FinanceDraftInput, resume: {
  docId?: string | null
  onCreated?: (id: string, version: number) => Promise<void>
} = {}): Promise<FinanceDraftResult> {
  const tpl = systemTemplate(input.kind, input.locale)
  if (!tpl) return { ok: false, error: 'invalid' }
  let id: string | null = null
  if (resume.docId) {
    const { data } = await supabase.from('studio_documents').select('id, bill_payment_id').eq('id', resume.docId).eq('company_id', companyId).maybeSingle()
    const prev = data as { id: string; bill_payment_id: string | null } | null
    if (prev) {
      if (input.kind === 'collection_letter' || prev.bill_payment_id) return { ok: true, id: prev.id }   // the earlier attempt finished
      id = prev.id
    }
  }
  if (!id) {
    let client: string | null = null
    if (input.kind === 'collection_letter') {
      const { data: doc } = await supabase.from('documents').select('client_id, document_type').eq('id', input.documentId).eq('company_id', companyId).maybeSingle()
      const d = doc as { client_id: string | null; document_type: string } | null
      if (!d || d.document_type !== 'invoice') return { ok: false, error: 'studio_ref_invalid' }
      client = d.client_id
    }
    const en = input.locale === 'en'
    const title = input.kind === 'collection_letter' ? (en ? 'Payment reminder' : 'Aviso de cobro') : (en ? 'Payment voucher' : 'Comprobante de pago')
    const { data, error } = await supabase.rpc('studio_save_document', {
      target: companyId, doc: null, doc_kind: tpl.kind, doc_title: title, doc_folder: null, doc_content: tpl.content, doc_page: tpl.page,
      client, source_document: input.kind === 'collection_letter' ? input.documentId : null, employee: null, vendor: null, template: null, base: tpl.key,
      expected_version: null, doc_origin: input.origin,
    })
    const row = ((data ?? []) as { id: string; version: number }[])[0]
    if (error || !row) return { ok: false, error: studioErrorCode(error) }
    id = row.id
    await resume.onCreated?.(row.id, row.version)
  }
  if (input.kind === 'payment_voucher') {
    const { error } = await supabase.rpc('studio_set_finance_link', { doc: id, bill: input.billId, payment: input.paymentId })
    if (error) return { ok: false, id, error: studioErrorCode(error) }
  }
  return { ok: true, id }
}

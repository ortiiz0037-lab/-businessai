/**
 * Receipt OCR (SERVER ONLY), behind a provider-neutral interface so the
 * service can be swapped. Results are SUGGESTIONS: a field the provider did
 * not recognize stays null and is shown as "not recognized"; nothing is
 * invented or defaulted (not even the currency). The person corrects and
 * confirms before anything is saved as data (receipt_confirm, 0042).
 *
 * Providers:
 *   - 'azure': Azure AI Document Intelligence, prebuilt-receipt model,
 *     REST API 2024-11-30 (analyze → Operation-Location → poll).
 *   - none: no OCR; the person types the data (the original is still kept).
 */
import type { OcrConfig } from '@/lib/banking/config'

export type Field<T> = { value: T; confidence: number | null } | null
export type ReceiptFields = {
  date: Field<string>; merchant: Field<string>; receipt_number: Field<string>; total_cents: Field<number>; tax_cents: Field<number>
  payment_method: Field<string>; reference: Field<string>; currency: Field<string>
}
export const EMPTY_FIELDS: ReceiptFields = { date: null, merchant: null, receipt_number: null, total_cents: null, tax_cents: null, payment_method: null, reference: null, currency: null }

export type OcrResult = { status: 'succeeded'; provider: string; fields: ReceiptFields } | { status: 'failed'; provider: string; error: string } | { status: 'not_configured'; provider: 'none' }

export interface ReceiptOcr { analyze(bytes: Uint8Array, contentType: string): Promise<OcrResult> }

export class NoOcr implements ReceiptOcr {
  async analyze(): Promise<OcrResult> { return { status: 'not_configured', provider: 'none' } }
}

const API_VERSION = '2024-11-30'
type AzureField = { type?: string; valueString?: string; valueDate?: string; valueNumber?: number; valueCurrency?: { amount?: number; currencyCode?: string }; content?: string; confidence?: number }

const conf = (f: AzureField | undefined) => (typeof f?.confidence === 'number' ? Math.round(f.confidence * 100) / 100 : null)
const money = (f: AzureField | undefined): Field<number> => {
  const n = f?.valueCurrency?.amount ?? f?.valueNumber
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e10 ? { value: Math.round(n * 100), confidence: conf(f) } : null
}
const textField = (f: AzureField | undefined, max = 200): Field<string> => {
  const v = (f?.valueString ?? f?.content ?? '').trim()
  return v ? { value: v.slice(0, max), confidence: conf(f) } : null
}

/** Maps the prebuilt-receipt fields; anything absent stays null. */
export function mapAzureReceipt(fields: Record<string, AzureField> | undefined): ReceiptFields {
  if (!fields) return { ...EMPTY_FIELDS }
  const d = fields.TransactionDate
  const date = d?.valueDate && /^\d{4}-\d{2}-\d{2}$/.test(d.valueDate) ? { value: d.valueDate, confidence: conf(d) } : null
  const code = fields.Total?.valueCurrency?.currencyCode
  return {
    ...EMPTY_FIELDS,
    date, merchant: textField(fields.MerchantName), total_cents: money(fields.Total), tax_cents: money(fields.TotalTax),
    currency: code && /^[A-Z]{3}$/.test(code) ? { value: code, confidence: conf(fields.Total) } : null,
  }
}

export class AzureReceiptOcr implements ReceiptOcr {
  constructor(private readonly endpoint: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch, private readonly pollMs = 1000) {}
  async analyze(bytes: Uint8Array, contentType: string): Promise<OcrResult> {
    const provider = 'azure_prebuilt_receipt'
    try {
      const start = await this.fetcher(`${this.endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=${API_VERSION}`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': this.key, 'content-type': 'application/json' },
        body: JSON.stringify({ base64Source: Buffer.from(bytes).toString('base64') }), signal: AbortSignal.timeout(30000),
      })
      if (start.status !== 202) return { status: 'failed', provider, error: `HTTP_${start.status}` }
      const op = start.headers.get('operation-location') ?? ''
      // the key is only ever sent back to the same service
      if (!op || new URL(op).origin !== new URL(this.endpoint).origin) return { status: 'failed', provider, error: 'operation_location' }
      void contentType
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, this.pollMs))
        const res = await this.fetcher(op, { headers: { 'Ocp-Apim-Subscription-Key': this.key }, signal: AbortSignal.timeout(15000) })
        if (!res.ok) return { status: 'failed', provider, error: `HTTP_${res.status}` }
        const body = (await res.json()) as { status?: string; analyzeResult?: { documents?: { fields?: Record<string, AzureField> }[] } }
        if (body.status === 'succeeded') return { status: 'succeeded', provider, fields: mapAzureReceipt(body.analyzeResult?.documents?.[0]?.fields) }
        if (body.status === 'failed') return { status: 'failed', provider, error: 'analysis_failed' }
      }
      return { status: 'failed', provider, error: 'timeout' }
    } catch {
      return { status: 'failed', provider, error: 'unreachable' }
    }
  }
}

export function ocrFor(cfg: OcrConfig, fetcher?: typeof fetch): ReceiptOcr {
  return cfg.configured ? new AzureReceiptOcr(cfg.endpoint, cfg.key, fetcher) : new NoOcr()
}

/** Validates what the person confirms (amounts in cents, ISO date and currency). */
export type Confirmed = { date: string; merchant: string | null; receipt_number: string | null; total_cents: number; tax_cents: number | null; payment_method: string | null; reference: string | null; currency: string; notes: string | null }
export function parseConfirmed(input: Record<string, string | null | undefined>): { ok: true; data: Confirmed } | { ok: false; error: string } {
  const date = (input.date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { ok: false, error: 'date' }
  const cents = (v: string | null | undefined) => {
    const t = (v ?? '').trim().replace(/[$,\s]/g, '')
    if (!t) return null
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return NaN
    return Math.round(Number(t) * 100)
  }
  const total = cents(input.total)
  if (total === null || Number.isNaN(total) || total <= 0) return { ok: false, error: 'total' }
  const tax = cents(input.tax)
  if (Number.isNaN(tax as number) || (tax !== null && tax > total)) return { ok: false, error: 'tax' }
  const currency = (input.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'currency' }
  const s = (v: string | null | undefined, n: number) => { const t = (v ?? '').trim(); return t ? t.slice(0, n) : null }
  return { ok: true, data: { date, merchant: s(input.merchant, 200), receipt_number: s(input.receipt_number, 80), total_cents: total, tax_cents: tax as number | null,
    payment_method: s(input.payment_method, 40), reference: s(input.reference, 120), currency, notes: s(input.notes, 500) } }
}

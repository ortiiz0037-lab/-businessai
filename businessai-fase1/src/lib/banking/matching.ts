/**
 * Smart payment matching (pure). Proposes how a bank DEPOSIT could be applied
 * to open invoices or linked to a payment already recorded, with a confidence
 * score and the reasons behind it. It never decides: every suggestion needs a
 * person's confirmation (bank_apply_deposit / bank_link_payment in 0042),
 * where the database re-checks balances, amounts and duplicates.
 *
 * Signals: exact amount (balance or payment), the invoice number written in
 * the bank reference or description, the client's name in the description,
 * dates (deposit after the invoice, near the due date or the payment date)
 * and a set of open invoices of one client adding up to the deposit.
 */
export type Deposit = { id: string; amount_cents: number; txn_date: string; description: string; reference: string | null; allocated_cents?: number }
export type OpenInvoice = { id: string; number: string | null; client_id: string | null; client_name: string | null; balance_cents: number; issue_date: string; due_date: string | null }
export type RecordedPayment = { id: string; amount_cents: number; paid_at: string; reference: string | null; document_id: string; document_number: string | null; client_name: string | null; method: string | null }

export type Reason = 'amount_exact' | 'amount_sum' | 'reference_invoice' | 'reference_payment' | 'client_name' | 'date_close' | 'date_after_issue' | 'partial' | 'ambiguous'
export type Suggestion =
  | { kind: 'invoices'; allocations: { document_id: string; amount_cents: number }[]; confidence: number; reasons: Reason[]; ambiguous: boolean }
  | { kind: 'payment'; payment_id: string; amount_cents: number; confidence: number; reasons: Reason[]; ambiguous: boolean }

const DAY = 86400000
const days = (a: string, b: string) => Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DAY)
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
const STOP = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'INC', 'LLC', 'CORP', 'CO', 'SA', 'SRL', 'THE', 'AND', 'OF', 'PR'])

/** The invoice number appears in the bank text (as a token, ignoring separators and leading zeros). */
export function mentionsNumber(text: string, number: string | null): boolean {
  if (!number) return false
  const n = norm(number).replace(/[^A-Z0-9]/g, '')
  if (n.length < 3) return false
  const t = norm(text)
  if (t.replace(/[^A-Z0-9]/g, '').includes(n)) return true
  const digits = n.replace(/\D/g, '').replace(/^0+/, '')
  if (digits.length < 3) return false
  return (t.match(/\d+/g) ?? []).some((d) => d.replace(/^0+/, '') === digits)
}

/** At least one meaningful word of the client's name appears in the bank text. */
export function mentionsClient(text: string, name: string | null): boolean {
  if (!name) return false
  const words = norm(name).split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w))
  if (!words.length) return false
  const t = ` ${norm(text).replace(/[^A-Z0-9]+/g, ' ')} `
  return words.some((w) => t.includes(` ${w} `))
}

/** Up to `max` invoices whose balances add up exactly to `target` (small, bounded search). */
export function subsetSum(invoices: OpenInvoice[], target: number, max = 3): OpenInvoice[][] {
  const out: OpenInvoice[][] = []
  const list = invoices.filter((i) => i.balance_cents > 0 && i.balance_cents <= target).slice(0, 25)
  const walk = (start: number, left: number, picked: OpenInvoice[]) => {
    if (out.length >= 5) return
    if (left === 0 && picked.length >= 2) { out.push([...picked]); return }
    if (picked.length >= max) return
    for (let i = start; i < list.length; i++) {
      if (list[i].balance_cents <= left) { picked.push(list[i]); walk(i + 1, left - list[i].balance_cents, picked); picked.pop() }
    }
  }
  walk(0, target, [])
  return out
}

const clamp = (n: number) => Math.max(1, Math.min(99, Math.round(n)))

export function suggestMatches(deposit: Deposit, invoices: OpenInvoice[], payments: RecordedPayment[]): Suggestion[] {
  const remaining = deposit.amount_cents - (deposit.allocated_cents ?? 0)
  if (deposit.amount_cents <= 0 || remaining <= 0) return []
  const text = `${deposit.description} ${deposit.reference ?? ''}`
  const out: Suggestion[] = []

  // 1) a payment already recorded (deposited into this bank) for exactly this amount
  for (const p of payments) {
    if (p.amount_cents !== remaining) continue
    const reasons: Reason[] = ['amount_exact']
    let score = 55
    if ((p.reference && norm(text).includes(norm(p.reference).trim()) && p.reference.trim().length >= 3) || mentionsNumber(text, p.document_number)) { score += 25; reasons.push('reference_payment') }
    const gap = Math.abs(days(deposit.txn_date, p.paid_at))
    if (gap <= 5) { score += 15 - gap * 2; reasons.push('date_close') }
    if (mentionsClient(text, p.client_name)) { score += 8; reasons.push('client_name') }
    out.push({ kind: 'payment', payment_id: p.id, amount_cents: p.amount_cents, confidence: clamp(score), reasons, ambiguous: false })
  }

  // 2) one invoice
  for (const inv of invoices) {
    if (inv.balance_cents <= 0) continue
    const ref = mentionsNumber(text, inv.number), client = mentionsClient(text, inv.client_name)
    const after = days(deposit.txn_date, inv.issue_date) >= 0
    if (inv.balance_cents === remaining) {
      const reasons: Reason[] = ['amount_exact']
      let score = 45
      if (ref) { score += 35; reasons.push('reference_invoice') }
      if (client) { score += 12; reasons.push('client_name') }
      if (after) { score += 3; reasons.push('date_after_issue') } else score -= 20
      if (inv.due_date && Math.abs(days(deposit.txn_date, inv.due_date)) <= 10) { score += 4; reasons.push('date_close') }
      out.push({ kind: 'invoices', allocations: [{ document_id: inv.id, amount_cents: remaining }], confidence: clamp(score), reasons, ambiguous: false })
    } else if (ref && after) {
      // the reference names the invoice but the amounts differ: a partial payment (or the rest of the deposit for something else)
      const amount = Math.min(remaining, inv.balance_cents)
      const reasons: Reason[] = ['reference_invoice', 'partial']
      let score = 40
      if (client) { score += 10; reasons.push('client_name') }
      out.push({ kind: 'invoices', allocations: [{ document_id: inv.id, amount_cents: amount }], confidence: clamp(score), reasons, ambiguous: false })
    }
  }

  // 3) several invoices of the same client adding up to the deposit
  const byClient = new Map<string, OpenInvoice[]>()
  for (const inv of invoices) if (inv.client_id && inv.balance_cents > 0 && days(deposit.txn_date, inv.issue_date) >= 0) byClient.set(inv.client_id, [...(byClient.get(inv.client_id) ?? []), inv])
  for (const list of byClient.values()) {
    for (const combo of subsetSum(list, remaining)) {
      const reasons: Reason[] = ['amount_sum']
      let score = 32
      const named = combo.filter((i) => mentionsNumber(text, i.number)).length
      if (named) { score += Math.min(30, named * 15); reasons.push('reference_invoice') }
      if (mentionsClient(text, combo[0].client_name)) { score += 20; reasons.push('client_name') }
      out.push({ kind: 'invoices', allocations: combo.map((i) => ({ document_id: i.id, amount_cents: i.balance_cents })), confidence: clamp(score), reasons, ambiguous: false })
    }
  }

  // ties at the top are flagged and lowered: a person must pick
  out.sort((a, b) => b.confidence - a.confidence)
  if (out.length > 1 && out[0].confidence - out[1].confidence < 5) {
    const top = out[0].confidence
    for (const s of out) if (top - s.confidence < 5) { s.ambiguous = true; s.confidence = clamp(Math.min(s.confidence, 60)); if (!s.reasons.includes('ambiguous')) s.reasons.push('ambiguous') }
  }
  return out.slice(0, 6)
}

const REASONS: Record<Reason, { es: string; en: string }> = {
  amount_exact: { es: 'El importe coincide exactamente', en: 'The amount matches exactly' },
  amount_sum: { es: 'La suma de estas facturas del mismo cliente coincide con el depósito', en: 'These invoices of the same client add up to the deposit' },
  reference_invoice: { es: 'La referencia bancaria menciona el número de factura', en: 'The bank reference mentions the invoice number' },
  reference_payment: { es: 'La referencia coincide con la del pago registrado', en: 'The reference matches the recorded payment' },
  client_name: { es: 'La descripción menciona al cliente', en: 'The description mentions the client' },
  date_close: { es: 'La fecha está cerca', en: 'The date is close' },
  date_after_issue: { es: 'El depósito es posterior a la factura', en: 'The deposit is after the invoice date' },
  partial: { es: 'Importe distinto: sería un pago parcial', en: 'Different amount: it would be a partial payment' },
  ambiguous: { es: 'Hay otras opciones igual de probables: revise antes de confirmar', en: 'Other options are as likely: review before confirming' },
}
export const reasonText = (r: Reason, locale: 'es' | 'en') => REASONS[r]?.[locale] ?? r

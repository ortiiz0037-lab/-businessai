import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeTotals, documentItems, parseItemsInput } from '@/lib/documents/items'
import { balanceOf, canTransition, documentActions, effectiveStatus, lifecycleErrorCode, todayIn } from '@/lib/documents/lifecycle'
import { parsePaymentInput, paymentMethodLabel } from '@/lib/documents/payments'
import { legacyDocumentNumber, NUMBER_PREFIX } from '@/lib/documents/numbering'
import { parseClientInput } from '@/lib/clients'
import { canManageBilling } from '@/lib/billing/company'
import { newPasswordSchema, resetRequestSchema } from '@/lib/validators'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const form = (v: Record<string, string>) => (k: string) => v[k] ?? ''

describe('line items (E4)', () => {
  it('parses rows, skips empty ones and rounds to cents', () => {
    const r = parseItemsInput(form({
      item_description_1: 'Diseño', item_quantity_1: '2', item_price_1: '10.005',
      item_description_3: 'Hosting', item_quantity_3: '', item_price_3: '5',
    }))
    expect(r.error).toBeNull()
    expect(r.items).toEqual([
      { description: 'Diseño', quantity: 2, unit_price: 10.01, amount: 20.01 },
      { description: 'Hosting', quantity: 1, unit_price: 5, amount: 5 },
    ])
    expect(r.subtotal).toBe(25.01)
  })
  it('refuses a row without description and bad numbers', () => {
    expect(parseItemsInput(form({ item_quantity_1: '1' })).error).toBe('required')
    expect(parseItemsInput(form({ item_description_1: 'x', item_quantity_1: '0' })).error).toBe('price')
    expect(parseItemsInput(form({ item_description_1: 'x', item_price_1: '-1' })).error).toBe('price')
  })
  it('discount and tax: 11.5 % on (100 − 10)', () => {
    expect(computeTotals(100, 10, 11.5)).toEqual({ tax: 10.35, total: 100.35 })
  })
  it('reads structured items with discount and tax rate', () => {
    const d = documentItems({
      items: [{ description: 'A', quantity: 1, unit_price: 50, amount: 50 }],
      metadata: { discount: 5, tax_rate: 11.5 }, notes: '  Pago en 30 días ',
    })
    expect(d).toEqual({ items: [{ description: 'A', quantity: 1, unit_price: 50, amount: 50 }], discount: 5, taxRate: 11.5, notes: 'Pago en 30 días', legacy: false })
  })
  it('reads documents saved before (items as text in notes) without changing them', () => {
    const notes = [
      'FACTURA — PARTIDAS',
      '1. Diseño de marca | Cantidad: 2 | Precio unitario: $1,000.00 | Importe: $2,000.00',
      'Subtotal: $2,000.00', 'Descuento: $100.00', 'Impuesto (11.5%): $218.50', 'TOTAL: $2,118.50',
      'Notas y condiciones: Gracias por su compra',
    ].join('\n')
    const d = documentItems({ items: [], metadata: {}, notes })
    expect(d.legacy).toBe(true)
    expect(d.items).toEqual([{ description: 'Diseño de marca', quantity: 2, unit_price: 1000, amount: 2000 }])
    expect(d.discount).toBe(100)
    expect(d.taxRate).toBe(11.5)
    expect(d.notes).toBe('Gracias por su compra')
  })
})

describe('effective status (E10) and allowed actions (E3, E6, E8)', () => {
  const today = '2026-11-11'
  const inv = (status: string, total = 100, due: string | null = '2026-12-01') => ({ document_type: 'invoice', status, total, due_date: due })
  it('derives partial / overdue / paid from payments and due date', () => {
    expect(effectiveStatus(inv('sent'), 0, today)).toBe('sent')
    expect(effectiveStatus(inv('sent'), 40, today)).toBe('partial')
    expect(effectiveStatus(inv('sent', 100, '2026-11-01'), 40, today)).toBe('overdue')
    expect(effectiveStatus(inv('sent'), 100, today)).toBe('paid')
    expect(effectiveStatus(inv('paid'), 0, today)).toBe('paid')
    expect(effectiveStatus(inv('draft', 100, '2026-01-01'), 0, today)).toBe('draft')
    expect(effectiveStatus(inv('cancelled'), 0, today)).toBe('cancelled')
    expect(effectiveStatus({ document_type: 'quote', status: 'accepted', total: 5, due_date: null }, 0, today)).toBe('accepted')
    expect(balanceOf(inv('sent'), 40.4)).toBe(59.6)
  })
  it('drafts: send, and only owner/admin delete; issued documents are never deleted', () => {
    expect(documentActions(inv('draft'), 0, today, 'member')).toMatchObject({ send: true, delete: false, void: false })
    expect(documentActions(inv('draft'), 0, today, 'admin')).toMatchObject({ delete: true, void: false })
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(documentActions(inv('sent'), 0, today, role).delete).toBe(false)
      expect(documentActions(inv('paid'), 100, today, role).delete).toBe(false)
    }
  })
  it('void: owner/admin, issued, not already voided, not an invoice with payments', () => {
    expect(documentActions(inv('sent'), 0, today, 'owner').void).toBe(true)
    expect(documentActions(inv('sent'), 0, today, 'member').void).toBe(false)
    expect(documentActions(inv('sent'), 10, today, 'owner').void).toBe(false)
    expect(documentActions(inv('cancelled'), 0, today, 'owner').void).toBe(false)
    expect(canTransition(inv('sent'), 0, today, 'admin', 'cancelled')).toBe(true)
  })
  it('quotes: sent → accepted / rejected; never payments', () => {
    const q = (status: string) => ({ document_type: 'quote', status, total: 80, due_date: null })
    expect(documentActions(q('draft'), 0, today, 'member').send).toBe(true)
    expect(documentActions(q('sent'), 0, today, 'member')).toMatchObject({ accept: true, reject: true, recordPayment: false })
    expect(canTransition(q('accepted'), 0, today, 'owner', 'rejected')).toBe(false)
    expect(canTransition(q('sent'), 0, today, 'member', 'draft')).toBe(false)
  })
  it('payments only on issued invoices with a balance', () => {
    expect(documentActions(inv('draft'), 0, today, 'member').recordPayment).toBe(false)
    expect(documentActions(inv('sent'), 40, today, 'member').recordPayment).toBe(true)
    expect(documentActions(inv('sent'), 100, today, 'member').recordPayment).toBe(false)
  })
  it('maps the database errors of 0015', () => {
    expect(lifecycleErrorCode({ message: 'DOCUMENT_ISSUED' })).toBe('document_issued')
    expect(lifecycleErrorCode({ message: 'PAYMENT_EXCEEDS_BALANCE' })).toBe('payment_exceeds_balance')
    expect(lifecycleErrorCode({ message: 'duplicate key value violates unique constraint "documents_receipt_payment_uidx"' })).toBe('receipt_exists')
    expect(lifecycleErrorCode({ message: 'other' })).toBeNull()
  })
  it('today in Puerto Rico', () => {
    expect(todayIn('America/Puerto_Rico', new Date('2026-11-12T02:00:00Z'))).toBe('2026-11-11')
  })
})

describe('payment form (partial payments)', () => {
  const ok = { amount: '40.50', method: 'check', date: '2026-11-10', reference: ' CHK-1 ' }
  it('accepts a partial payment and stores noon in Puerto Rico', () => {
    expect(parsePaymentInput(ok, 100, '2026-11-11')).toEqual({
      ok: true, amount: 40.5, method: 'check', date: '2026-11-10', paidAt: '2026-11-10T12:00:00-04:00', reference: 'CHK-1',
    })
  })
  it('refuses bad amounts, over-balance, unknown methods, future dates and long references', () => {
    expect(parsePaymentInput({ ...ok, amount: '0' }, 100, '2026-11-11')).toEqual({ ok: false, error: 'amount' })
    expect(parsePaymentInput({ ...ok, amount: '1.234' }, 100, '2026-11-11')).toEqual({ ok: false, error: 'amount' })
    expect(parsePaymentInput({ ...ok, amount: '100.01' }, 100, '2026-11-11')).toEqual({ ok: false, error: 'over_balance' })
    expect(parsePaymentInput({ ...ok, method: 'bitcoin' }, 100, '2026-11-11')).toEqual({ ok: false, error: 'method' })
    expect(parsePaymentInput({ ...ok, date: '2026-11-12' }, 100, '2026-11-11')).toEqual({ ok: false, error: 'date' })
    expect(parsePaymentInput({ ...ok, reference: 'x'.repeat(121) }, 100, '2026-11-11')).toEqual({ ok: false, error: 'reference' })
  })
  it('labels methods in Spanish', () => {
    expect(paymentMethodLabel('ath_movil')).toBe('ATH Móvil')
    expect(paymentMethodLabel('manual')).toBe('Registro manual')
    expect(paymentMethodLabel(null)).toBe('Sin método')
  })
})

describe('numbering (E5)', () => {
  it('uses the same prefixes as the database (0015)', () => {
    const sql = read('supabase/migrations/0015_documents_lifecycle.sql')
    for (const [type, prefix] of Object.entries(NUMBER_PREFIX)) expect(sql).toContain(`when '${type}' then '${prefix}'`)
  })
  it('previous random format only as a fallback without 0015', () => {
    expect(legacyDocumentNumber('invoice', 2026, 'abcdef1234')).toBe('FAC-2026-ABCDEF12')
  })
  it('the app no longer generates numbers when creating documents', () => {
    expect(read('src/app/(app)/documents/new/page.tsx')).not.toMatch(/const documentNumber|document_number: documentNumber|randomUUID/)
  })
})

describe('receipts (E1), list (E2), AI announcement (E7), quick actions (E8)', () => {
  it('receipt is not a type of the creation form: it never falls back to an invoice', () => {
    const page = read('src/app/(app)/documents/new/page.tsx')
    expect(page).toMatch(/const FORM_TYPES = \['invoice', 'quote', 'letter', 'work_order', 'payment_reminder'\]/)
    expect(page).toContain('Tipo de documento no válido')
    expect(page).toContain('action={createReceipt}')
  })
  it('the document list searches, filters and paginates (no fixed 20 latest)', () => {
    const page = read('src/app/(app)/documents/page.tsx')
    expect(page).not.toMatch(/\.limit\(20\)/)
    expect(page).toMatch(/\.range\(from, from \+ PAGE_SIZE - 1\)/)
    expect(page).toContain("name=\"q\"")
  })
  it('no "coming soon" AI announcement in the documents page', () => {
    const page = read('src/app/(app)/documents/page.tsx')
    expect(page).not.toMatch(/Próximamente|lenguaje natural|inteligentes/)
  })
  it('"Registrar pago" opens the payment form', () => {
    expect(read('src/components/app-nav.tsx')).toContain("href: '/payments/new', icon: 'card'")
    expect(read('src/components/dashboard/dashboard-view.tsx')).toContain("href: '/payments/new', label: q.payment")
  })
})

describe('clients edit, several companies (E11), owner billing (E12), password reset (E13)', () => {
  it('validates the client form', () => {
    const base = { name: ' Ana ', email: 'ana@example.com', status: 'inactive' }
    const r = parseClientInput(form(base))
    expect(r.ok && r.value).toMatchObject({ name: 'Ana', email: 'ana@example.com', status: 'inactive', phone: null })
    expect(parseClientInput(form({ ...base, name: '' }))).toEqual({ ok: false, error: 'missing_name' })
    expect(parseClientInput(form({ ...base, email: 'x' }))).toEqual({ ok: false, error: 'email' })
    expect(parseClientInput(form({ ...base, status: 'deleted' }))).toEqual({ ok: false, error: 'status' })
  })
  it('an account can create another company, which becomes the active one', () => {
    const action = read('src/app/actions/company.ts')
    expect(action).not.toMatch(/existing\?\.length\) redirect/)
    expect(action).toContain('store.set(COMPANY_COOKIE, companyId')
  })
  it('only the owner manages the subscription', () => {
    expect(canManageBilling('owner')).toBe(true)
    expect(canManageBilling('admin')).toBe(false)
    expect(canManageBilling('member')).toBe(false)
  })
  it('password reset: valid email; new password ≥ 8 and confirmed', () => {
    expect(resetRequestSchema.safeParse({ email: 'x' }).success).toBe(false)
    expect(newPasswordSchema.safeParse({ password: 'short', confirm: 'short' }).success).toBe(false)
    expect(newPasswordSchema.safeParse({ password: 'longenough', confirm: 'different1' }).success).toBe(false)
    expect(newPasswordSchema.safeParse({ password: 'longenough', confirm: 'longenough' }).success).toBe(true)
    expect(read('src/lib/supabase/proxy.ts')).toContain("'/forgot-password'")
  })
})

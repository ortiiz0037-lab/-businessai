/**
 * Finance D3 (migration 0024): the expense form, attachment rules and the
 * database answers. The database enforces the same rules again.
 */
import { describe, expect, it } from 'vitest'
import { attachmentPath, canApproveAmount, daysUntil, parseBillLines, payablesErrorCode, payablesMessage, statusLabel, validateAttachment,
  type PayablesAccess } from '@/lib/finance/payables'
import { sourceLabel } from '@/lib/finance/ledger'

const C = '11111111-1111-4111-8111-111111111111'
const D = '22222222-2222-4222-8222-222222222222'
const form = (rows: [string, string, string?][]) => {
  const f = new FormData()
  rows.forEach(([cat, amount, d], i) => { f.set(`category_${i}`, cat); f.set(`amount_${i}`, amount); if (d) f.set(`line_description_${i}`, d) })
  return f
}
const access = (approvalLimit: number | null): PayablesAccess => ({ view: true, create: true, approve: true, pay: true, manage: true, settings: false, approvalLimit, available: true, initialized: true })

describe('parseBillLines', () => {
  it('lines become integer cents (as strings) and a BigInt total', () => {
    expect(parseBillLines(form([[C, '75.50', 'Tornillos'], [D, '24.5']]))).toEqual({
      lines: [{ category_id: C, description: 'Tornillos', amount_cents: '7550' }, { category_id: D, description: null, amount_cents: '2450' }], total: 10000n })
  })
  it('0.1 + 0.2 = 0.30 exactly', () => {
    const r = parseBillLines(form([[C, '0.1'], [C, '0.2']]))
    expect('total' in r && r.total).toBe(30n)
  })
  it('skips empty rows', () => expect('lines' in parseBillLines(form([['', ''], [C, '1']])) ).toBe(true))
  it('needs a line', () => expect(parseBillLines(form([['', '']]))).toEqual({ error: 'bill_empty' }))
  it.each(['0', '-5', '1.234', 'abc', ''])('rejects amount %j', (a) => expect(parseBillLines(form([[C, a]]))).toEqual({ error: 'amount_invalid' }))
  it('rejects a category that is not a uuid', () => expect(parseBillLines(form([['rent', '5']]))).toEqual({ error: 'invalid' }))
})

describe('attachments', () => {
  it('PDF and images up to 10 MB only', () => {
    expect(validateAttachment({ type: 'application/pdf', size: 2048 })).toBeNull()
    expect(validateAttachment({ type: 'image/heic', size: 10 * 1024 * 1024 })).toBeNull()
    expect(validateAttachment({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toBe('attachment_size')
    expect(validateAttachment({ type: 'image/png', size: 0 })).toBe('attachment_size')
    expect(validateAttachment({ type: 'application/x-msdownload', size: 10 })).toBe('attachment_type')
    expect(validateAttachment({ type: 'text/html', size: 10 })).toBe('attachment_type')
  })
  it('the path is <company>/<bill>/<uuid>-<safe name> with no traversal', () => {
    const p = attachmentPath(C, D, 'u', '../../otra empresa/Recibo #1 ñ.pdf')
    expect(p.startsWith(`${C}/${D}/u-`)).toBe(true)
    expect(p.split('/')).toHaveLength(3)
    expect(p).not.toMatch(/\.\.\//)
  })
})

describe('approval limits (shown in the UI; enforced by the database)', () => {
  it('unlimited, limited and none', () => {
    expect(canApproveAmount(access(null), 10n ** 14n)).toBe(true)
    expect(canApproveAmount(access(10000), 10000)).toBe(true)
    expect(canApproveAmount(access(10000), 10001)).toBe(false)
    expect(canApproveAmount(access(-1), 1)).toBe(false)
  })
})

describe('database answers → messages in both languages', () => {
  const cases: [string, string | null, string][] = [
    ['APPROVAL_LIMIT_EXCEEDED', 'P0001', 'approval_limit_exceeded'], ['SELF_APPROVAL_FORBIDDEN', 'P0001', 'self_approval_forbidden'],
    ['PAYMENT_EXCEEDS_BALANCE', 'P0001', 'payment_exceeds_balance'], ['BILL_HAS_PAYMENTS', 'P0001', 'bill_has_payments'], ['BILL_LOCKED', 'P0001', 'bill_locked'],
    ['ATTACHMENT_LOCKED', 'P0001', 'attachment_locked'], ['PERIOD_CLOSED', 'P0001', 'period_closed'], ['CATEGORY_INVALID', 'P0001', 'category_invalid'],
    ['duplicate key value violates unique constraint "bills_vendor_invoice_uidx"', '23505', 'vendor_invoice_taken'],
    ['duplicate key value violates unique constraint "vendors_name_uidx"', '23505', 'vendor_exists'],
    ['new row violates row-level security policy for table "objects"', '42501', 'forbidden'], ['boom', null, 'save'],
  ]
  it.each(cases)('%s', (message, code, want) => expect(payablesErrorCode({ message, code })).toBe(want))
  it('every code has distinct ES and EN messages', () => {
    for (const [message, code] of cases) {
      const c = payablesErrorCode({ message, code })
      expect(payablesMessage(c, 'es')).toBeTruthy()
      expect(payablesMessage(c, 'es')).not.toBe(payablesMessage(c, 'en'))
    }
  })
  it('labels', () => {
    expect(statusLabel('partially_paid', 'es')).toBe('Parcialmente pagado')
    expect(statusLabel('pending_approval', 'en')).toBe('Pending approval')
    expect(sourceLabel('bill_payment', 'es')).toBe('Pago a proveedor')
  })
  it('daysUntil', () => {
    expect(daysUntil('2026-11-20', '2026-11-12')).toBe(8)
    expect(daysUntil('2026-11-01', '2026-11-12')).toBe(-11)
    expect(daysUntil(null, '2026-11-12')).toBeNull()
  })
})

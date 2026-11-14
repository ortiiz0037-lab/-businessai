/**
 * Finance D4 (migration 0025): reminder text, offsets, labels, error
 * messages and the optional email sender (never sends without config).
 */
import { describe, expect, it, vi } from 'vitest'
import { arErrorCode, arMessage, arStatusLabel, bucketLabel, offsetLabel, parseOffsets, renderReminder } from '@/lib/finance/receivables'
import { emailConfigured, sendEmail } from '@/lib/email/resend'
import { activePayments } from '@/lib/documents/payments'

describe('reminder text', () => {
  it('fills the placeholders in Spanish and English with exact money', () => {
    const es = renderReminder({ locale: 'es', client: 'Ana', invoice: 'FAC-2026-0007', balanceCents: 12550, due: '1 dic 2026', company: 'Taller Uno' })
    expect(es.subject).toContain('FAC-2026-0007')
    expect(es.text).toContain('Hola Ana')
    expect(es.text).toMatch(/125\.50/)
    expect(es.text).toContain('Taller Uno')
    const en = renderReminder({ locale: 'en', template: 'Dear {client}, {invoice}: {balance} by {due}. {unknown}', client: 'Bob', invoice: 'INV-1', balanceCents: '100', due: 'Dec 1', company: 'X' })
    expect(en.text).toBe('Dear Bob, INV-1: $1.00 by Dec 1. {unknown}')
  })
  it('subject has no line breaks', () => {
    expect(renderReminder({ locale: 'es', client: 'a', invoice: 'b\nc', balanceCents: 1, due: 'x', company: 'y' }).subject).not.toMatch(/\n(?!c)/)
  })
})

describe('reminder days', () => {
  it('parses, de-duplicates and sorts', () => expect(parseOffsets('7, -3 0;30 7')).toEqual([-3, 0, 7, 30]))
  it.each(['', '400', '-61', 'a', '1,2,3,4,5,6,7,8,9,10,11', '1.5'])('rejects %j', (v) => expect(parseOffsets(v)).toBeNull())
  it('labels', () => {
    expect(offsetLabel(-3, 'es')).toBe('3 días antes del vencimiento')
    expect(offsetLabel(0, 'en')).toBe('on the due date')
    expect(offsetLabel(1, 'en')).toBe('1 day after due')
  })
})

describe('labels and errors', () => {
  it('statuses and buckets', () => {
    expect(arStatusLabel('partially_paid', 'es')).toBe('Parcialmente pagada')
    expect(arStatusLabel('overdue', 'en')).toBe('Overdue')
    expect(bucketLabel('90_plus', 'es')).toBe('Más de 90 días')
  })
  it.each([['PAYMENT_ALREADY_VOIDED', 'payment_already_voided'], ['INVOICE_NOT_OPEN', 'invoice_not_open'], ['REMINDER_CLOSED', 'reminder_closed'],
    ['could not serialize access', 'retry'], ['x', 'save']])('%s', (m, want) => {
    const c = arErrorCode({ message: m, code: m.startsWith('could') ? '40001' : 'P0001' })
    expect(c).toBe(want)
    expect(arMessage(c, 'es')).not.toBe(arMessage(c, 'en'))
  })
})

describe('voided payments do not count (with or without 0025 columns)', () => {
  it('filters voided rows only', () => {
    expect(activePayments([{ amount: 1 }, { amount: 2, voided_at: null }, { amount: 3, voided_at: '2026-11-12T00:00:00Z' }]).map((p) => p.amount)).toEqual([1, 2])
    expect(activePayments(null)).toEqual([])
  })
})

describe('email (Resend) is optional', () => {
  it('without configuration nothing is sent', async () => {
    const fetchImpl = vi.fn()
    expect(emailConfigured({})).toBe(false)
    const r = await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, { source: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ ok: false, error: 'email_not_configured', notConfigured: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('a malformed key is treated as not configured', () => expect(emailConfigured({ RESEND_API_KEY: 'abc', EMAIL_FROM: 'x@y.co' })).toBe(false))
  const source = { RESEND_API_KEY: 're_test_12345678', EMAIL_FROM: 'cobros@empresa.test' }
  it('sends with the key in a header, never in the body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }))
    const r = await sendEmail({ to: 'cliente@x.co', subject: 'Hola\r\nBcc: x', text: 'cuerpo', replyTo: 'r@empresa.test', fromName: 'Taller <Uno>' }, { source, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ ok: true, id: 'em_1' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_12345678')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ to: ['cliente@x.co'], subject: 'Hola Bcc: x', reply_to: 'r@empresa.test', from: 'Taller Uno <cobros@empresa.test>' })
    expect(String(init.body)).not.toContain('re_test')
  })
  it('provider errors and network errors are reported, not hidden', async () => {
    expect(await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, { source, fetchImpl: (async () => new Response('no', { status: 422 })) as unknown as typeof fetch })).toEqual({ ok: false, error: 'http_422' })
    expect(await sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, { source, fetchImpl: (async () => { throw new Error('x') }) as unknown as typeof fetch })).toEqual({ ok: false, error: 'network' })
    expect(await sendEmail({ to: 'not-an-email', subject: 's', text: 't' }, { source, fetchImpl: vi.fn() as unknown as typeof fetch })).toEqual({ ok: false, error: 'email_invalid' })
  })
})

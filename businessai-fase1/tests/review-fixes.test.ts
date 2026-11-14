/**
 * Behavioural tests for the app side of the review of 8157f87 (C3, I5–I10,
 * M1–M3, M7–M10). The database side (C1, C2, I1–I4, I7, I8, I11, M5, M6) is
 * tested on a real local PostgreSQL by supabase/tests/local (suites 74, 75,
 * 76); nothing here reads source text to decide a behaviour.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseItemsInput } from '@/lib/documents/items'
import { documentActions, lifecycleErrorCode } from '@/lib/documents/lifecycle'
import { parsePaymentInput } from '@/lib/documents/payments'
import { insertDocument, NUMBER_PREFIX } from '@/lib/documents/numbering'
import { IDEMPOTENCY_KEY, newIdempotencyKey } from '@/lib/documents/capabilities'
import { searchTerm } from '@/lib/search'
import { fetchAllPages, paidByDocument } from '@/lib/supabase/paged'
import { resolveAppOrigin } from '@/lib/app-origin'
import { isMissingFunction, personTrialAvailable, trialUsedElsewhere } from '@/lib/billing/trial'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const form = (v: Record<string, string>) => (k: string) => v[k] ?? ''

describe('M1: line amounts are quantity × the price as printed', () => {
  it('3 × 0.333 → price 0.33, amount 0.99 (never 1.00)', () => {
    const r = parseItemsInput(form({ 'item_description_1': 'Tornillos', 'item_quantity_1': '3', 'item_price_1': '0.333' }))
    expect(r.error).toBeNull()
    expect(r.items[0]).toMatchObject({ unit_price: 0.33, amount: 0.99 })
    expect(r.subtotal).toBe(0.99)
  })
  it('half-up to cents despite binary artefacts (1.005 → 1.01)', () => {
    const r = parseItemsInput(form({ 'item_description_1': 'x', 'item_quantity_1': '1', 'item_price_1': '1.005' }))
    expect(r.items[0]).toMatchObject({ unit_price: 1.01, amount: 1.01 })
  })
})

describe('M7: payment date between the issue date (one day of tolerance) and today', () => {
  const base = { amount: '10', method: 'cash', reference: '' }
  it('refuses a date two days before the issue date', () => {
    expect(parsePaymentInput({ ...base, date: '2026-11-01' }, 100, '2026-11-11', '2026-11-03')).toEqual({ ok: false, error: 'before_issue' })
  })
  it('accepts the day before (UTC issue date vs Puerto Rico payment day) and the issue date', () => {
    expect(parsePaymentInput({ ...base, date: '2026-11-02' }, 100, '2026-11-11', '2026-11-03').ok).toBe(true)
    expect(parsePaymentInput({ ...base, date: '2026-11-03' }, 100, '2026-11-11', '2026-11-03').ok).toBe(true)
  })
  it('without an issue date only today is the limit (documents from before)', () => {
    expect(parsePaymentInput({ ...base, date: '2001-01-01' }, 100, '2026-11-11', null).ok).toBe(true)
  })
})

describe('I9: accept / reject only when the database supports them', () => {
  const quote = { document_type: 'quote', status: 'sent', total: 10, due_date: null }
  it('with 0015 a sent quote can be accepted or rejected', () => {
    expect(documentActions(quote, 0, '2026-11-11', 'member', true)).toMatchObject({ accept: true, reject: true })
  })
  it('without 0015 the buttons are not offered', () => {
    expect(documentActions(quote, 0, '2026-11-11', 'member', false)).toMatchObject({ accept: false, reject: false })
  })
})

describe('database errors of 0015 → interface codes', () => {
  it('maps every rule of the revised migration', () => {
    const cases: [string, string][] = [
      ['DOCUMENT_HAS_PAYMENTS', 'document_has_payments'], ['DOCUMENT_TRANSITION', 'document_transition'],
      ['VOID_REASON_REQUIRED', 'void_reason_required'], ['COMPANY_IMMUTABLE', 'company_immutable'],
      ['PAYMENT_DATE_INVALID', 'payment_date_invalid'], ['RECEIPT_CLIENT_MISMATCH', 'receipt_client_mismatch'],
      ['DOCUMENT_NOT_PAID', 'document_not_paid'], ['DOCUMENT_FIELD_LOCKED', 'document_field_locked'],
    ]
    for (const [raw, code] of cases) expect(lifecycleErrorCode({ message: raw })).toBe(code)
  })
  it('whole words only: RECEIPT_STATUS is not mistaken for a longer code', () => {
    expect(lifecycleErrorCode({ message: 'RECEIPT_STATUS' })).toBe('receipt_status')
    expect(lifecycleErrorCode({ message: 'DOCUMENT_ISSUED_X' })).toBeNull()
  })
  it('I5 duplicate submission and I4 serialization failure', () => {
    expect(lifecycleErrorCode({ message: 'duplicate key value violates unique constraint "payments_idempotency_uidx"' })).toBe('payment_duplicate')
    expect(lifecycleErrorCode({ code: '40001', message: 'could not serialize access due to concurrent update' })).toBe('payment_retry')
  })
})

describe('I5: idempotency keys', () => {
  it('each form rendering gets a distinct, well-formed key', () => {
    const a = newIdempotencyKey(), b = newIdempotencyKey()
    expect(a).not.toBe(b)
    expect(IDEMPOTENCY_KEY.test(a)).toBe(true)
    expect(a.length).toBeGreaterThanOrEqual(8)
    expect(a.length).toBeLessThanOrEqual(100)   // database check payments_idempotency_key_check
  })
  it('keys typed by a client in another shape are ignored', () => {
    expect(IDEMPOTENCY_KEY.test('x')).toBe(false)
    expect(IDEMPOTENCY_KEY.test("pay-1' or 1=1")).toBe(false)
  })
})

describe('numbering without 0015 (fallback) and with it', () => {
  const fake = (results: { data: unknown; error: unknown }[]) => {
    const inserted: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: async () => results.shift() }) }
        },
      }),
    }
    return { client: client as never, inserted }
  }
  it('with 0015 the app sends no number and keeps the database one', async () => {
    const { client, inserted } = fake([{ data: { id: '1', document_number: 'FAC-2026-0001' }, error: null }])
    const r = await insertDocument(client, { document_type: 'invoice', total: 1 })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).not.toHaveProperty('document_number')
    expect(r.data?.document_number).toBe('FAC-2026-0001')
  })
  it('without 0015 (NOT NULL error) it retries once with the previous format', async () => {
    const { client, inserted } = fake([
      { data: null, error: { code: '23502', message: 'null value in column "document_number"' } },
      { data: { id: '1', document_number: 'x' }, error: null },
    ])
    await insertDocument(client, { document_type: 'quote' })
    expect(inserted).toHaveLength(2)
    expect(String(inserted[1].document_number)).toMatch(/^COT-\d{4}-[0-9A-F]{8}$/)
  })
  it('any other error is returned as is (no retry)', async () => {
    const { client, inserted } = fake([{ data: null, error: { code: 'P0001', message: 'PLAN_LIMIT_DOCUMENTS' } }])
    const r = await insertDocument(client, { document_type: 'invoice' })
    expect(inserted).toHaveLength(1)
    expect(r.error?.message).toBe('PLAN_LIMIT_DOCUMENTS')
  })
  it('prefixes', () => {
    expect(NUMBER_PREFIX).toMatchObject({ invoice: 'FAC', quote: 'COT', receipt: 'RCB', work_order: 'OT', letter: 'CARTA', payment_reminder: 'REC' })
  })
})

describe('M9: search text cannot add PostgREST filters', () => {
  it('removes the filter grammar characters', () => {
    expect(searchTerm('ana,status.eq.paid')).toBe('ana status eq paid')
    expect(searchTerm('x),or(company_id.neq.1')).toBe('x or company id neq 1')
    expect(searchTerm('50%_off*')).toBe('50 off')
    expect(searchTerm(null)).toBe('')
  })
  it('caps the length', () => {
    expect(searchTerm('a'.repeat(200))).toHaveLength(60)
  })
})

describe('M3: reading every page instead of the first 1000 rows', () => {
  it('collects all pages until a short page', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i)
    const calls: [number, number][] = []
    const r = await fetchAllPages(async (from, to) => { calls.push([from, to]); return { data: all.slice(from, to + 1), error: null } })
    expect(r.rows).toHaveLength(2500)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(r.truncated).toBe(false)
  })
  it('stops at the maximum and says so', async () => {
    const r = await fetchAllPages(async (from, to) => ({ data: Array.from({ length: to - from + 1 }, () => 1), error: null }), { size: 10, max: 30 })
    expect(r.rows).toHaveLength(30)
    expect(r.truncated).toBe(true)
  })
  it('sums payments per document across pages, in cents', async () => {
    const rows = [
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, document_id: 'A', amount: '0.10' })),
      { id: 'b', document_id: 'B', amount: 5 },
    ]
    const client = {
      from: () => ({ select: () => ({ in: () => ({ order: () => ({
        range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
      }) }) }) }),
    }
    const paid = await paidByDocument(client, ['A', 'B'])
    expect(paid.get('A')).toBe(100)
    expect(paid.get('B')).toBe(5)
  })
})

describe('I10: links in emails never use an untrusted Host header', () => {
  it('uses NEXT_PUBLIC_APP_URL when set', () => {
    expect(resolveAppOrigin({ NEXT_PUBLIC_APP_URL: 'https://app.example.com/' }, 'evil.test')).toBe('https://app.example.com')
  })
  it('Production without NEXT_PUBLIC_APP_URL: no origin (the email is not sent)', () => {
    expect(resolveAppOrigin({ VERCEL_ENV: 'production', VERCEL_URL: 'x.vercel.app', NODE_ENV: 'production' }, 'evil.test')).toBeNull()
  })
  it('Preview: the deployment URL Vercel provides, not the Host header', () => {
    expect(resolveAppOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'ba-git-x.vercel.app', NODE_ENV: 'production' }, 'evil.test'))
      .toBe('https://ba-git-x.vercel.app')
  })
  it('the Host header only for localhost in development', () => {
    expect(resolveAppOrigin({ NODE_ENV: 'development' }, 'localhost:3000')).toBe('http://localhost:3000')
    expect(resolveAppOrigin({ NODE_ENV: 'development' }, 'evil.test')).toBeNull()
    expect(resolveAppOrigin({ NODE_ENV: 'production' }, 'localhost:3000')).toBeNull()
  })
  it('a malformed NEXT_PUBLIC_APP_URL is not used', () => {
    expect(resolveAppOrigin({ NEXT_PUBLIC_APP_URL: 'javascript:alert(1)', NODE_ENV: 'production' }, null)).toBeNull()
  })
})

describe('C3: one free trial per person', () => {
  it('rule without 0016: another company of the person consumed a trial', () => {
    expect(trialUsedElsewhere('A', [{ company_id: 'A', trial_consumed_at: '2026-01-01' }])).toBe(false)
    expect(trialUsedElsewhere('A', [{ company_id: 'B', trial_consumed_at: '2026-01-01' }])).toBe(true)
    expect(trialUsedElsewhere('A', [{ company_id: 'B', trial_consumed_at: null }])).toBe(false)
  })
  const admin = (rpc: { data: unknown; error: unknown }, tables: Record<string, unknown[]> = {}) => {
    const calls: string[] = []
    const q = (table: string) => {
      const chain = {
        select: () => chain, eq: () => chain, in: () => chain, limit: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null }),
      }
      return chain
    }
    return {
      calls,
      client: { rpc: async (fn: string) => { calls.push(fn); return rpc }, from: q } as never,
    }
  }
  it('with 0016 Checkout claims the trial in the database', async () => {
    const a = admin({ data: true, error: null })
    expect(await personTrialAvailable(a.client, 'A', 'u', true)).toBe(true)
    expect(a.calls).toEqual(['claim_trial'])
    const b = admin({ data: false, error: null })
    expect(await personTrialAvailable(b.client, 'B', 'u', true)).toBe(false)
  })
  it('the /billing page only asks (no claim)', async () => {
    const a = admin({ data: true, error: null })
    await personTrialAvailable(a.client, 'A', 'u', false)
    expect(a.calls).toEqual(['user_trial_available'])
  })
  it('without 0016 the app applies the same rule from the subscriptions', async () => {
    const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_trial' } }
    expect(isMissingFunction(missing.error)).toBe(true)
    const used = admin(missing, { companies: [{ id: 'B' }], memberships: [], company_subscriptions: [{ company_id: 'B', trial_consumed_at: '2026-01-01' }] })
    expect(await personTrialAvailable(used.client, 'A', 'u', true)).toBe(false)
    const fresh = admin(missing, { companies: [{ id: 'B' }], memberships: [], company_subscriptions: [{ company_id: 'B', trial_consumed_at: null }] })
    expect(await personTrialAvailable(fresh.client, 'A', 'u', true)).toBe(true)
  })
  it('any other database error: no free trial (never grant one by mistake)', async () => {
    const a = admin({ data: null, error: { code: '500', message: 'boom' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await personTrialAvailable(a.client, 'A', 'u', true)).toBe(false)
  })
})

import { featureAccess, toFeatureAccess } from '@/lib/billing/features'
describe('plan features (0017): deny by default', () => {
  it('available with a limit, at the limit, unlimited', () => {
    expect(toFeatureAccess({ available: true, max_allowed: 25, used: 3 })).toEqual({ available: true, maxAllowed: 25, used: 3, atLimit: false })
    expect(toFeatureAccess({ available: true, max_allowed: 3, used: 3 }).atLimit).toBe(true)
    expect(toFeatureAccess({ available: true, max_allowed: null, used: 9 })).toMatchObject({ maxAllowed: null, atLimit: false })
  })
  it('anything else is not available (never unlimited by mistake)', async () => {
    expect(toFeatureAccess(null).available).toBe(false)
    expect(toFeatureAccess({ available: false, max_allowed: null }).available).toBe(false)
    const missing = { rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }
    expect((await featureAccess(missing, 'c', 'payroll')).available).toBe(false)
    const empty = { rpc: async () => ({ data: [], error: null }) }
    expect((await featureAccess(empty, 'c', 'branches')).available).toBe(false)
  })
})

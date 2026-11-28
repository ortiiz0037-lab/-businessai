/**
 * CRM (0035) pure helpers: weighted pipeline value in exact cents (same
 * rounding as PostgreSQL round(numeric)), probability parsing, Puerto Rico
 * times, overdue follow-ups, client CRM fields, error codes in both languages.
 */
import { describe, expect, it } from 'vitest'
import { CRM_MESSAGE_CODES, crmErrorCode, crmLabel, crmMessage, isOverdue, parseProbability, prDateTime, roundDiv, toPrInput, weightedCents } from '@/lib/crm/core'
import { parseClientCrm } from '@/lib/clients'

describe('weighted pipeline value', () => {
  it('rounds the total once, half away from zero (same numbers as the SQL suite)', () => {
    // (100001 × 1000 + 5 × 1000) / 10000 = 10000.6 → 10001; per row it would be 10000 + 1 = 10001 too, but
    // (5 × 1000) / 10000 = 0.5 alone → 1 and (4 × 1000) / 10000 = 0.4 → 0: rounding once matters
    expect(weightedCents([{ amount_cents: 100001, probability_bp: 1000 }, { amount_cents: 5, probability_bp: 1000 }])).toBe(10001n)
    expect(weightedCents([{ amount_cents: 4, probability_bp: 1000 }, { amount_cents: 4, probability_bp: 1000 }])).toBe(1n)   // 0.8 → 1, not 0 + 0
    expect(weightedCents([{ amount_cents: '250000', probability_bp: 2500 }])).toBe(62500n)
    expect(weightedCents([])).toBe(0n)
  })
  it('handles values beyond 2^53 exactly', () => {
    expect(weightedCents([{ amount_cents: 99_999_999_999n, probability_bp: 3333 }])).toBe(33_330_000_000n)   // 33 329 999 999.6667 → rounds up
  })
  it('roundDiv mirrors round(numeric)', () => {
    expect(roundDiv(5n, 10n)).toBe(1n); expect(roundDiv(4n, 10n)).toBe(0n); expect(roundDiv(-5n, 10n)).toBe(-1n); expect(roundDiv(15n, 10n)).toBe(2n); expect(roundDiv(14n, 10n)).toBe(1n)
  })
})

describe('inputs', () => {
  it('probability in percent → basis points', () => {
    expect(parseProbability('25')).toBe(2500); expect(parseProbability('12,5 %')).toBe(1250); expect(parseProbability('')).toBeNull()
    expect(parseProbability('101')).toBe('invalid'); expect(parseProbability('-1')).toBe('invalid'); expect(parseProbability('abc')).toBe('invalid')
  })
  it('Puerto Rico date-times (UTC−4, no daylight saving)', () => {
    expect(prDateTime('2026-11-20T09:30')).toBe('2026-11-20T13:30:00.000Z')
    expect(prDateTime('2026-07-01')).toBe('2026-07-01T13:00:00.000Z')
    expect(prDateTime('nope')).toBeNull(); expect(prDateTime('')).toBeNull()
    expect(toPrInput('2026-11-20T13:30:00.000Z')).toBe('2026-11-20T09:30')
  })
  it('overdue = pending and past due', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    expect(isOverdue({ status: 'pending', due_at: '2026-11-13T11:59:00Z' }, now)).toBe(true)
    expect(isOverdue({ status: 'completed', due_at: '2026-11-01T00:00:00Z' }, now)).toBe(false)
    expect(isOverdue({ status: 'pending', due_at: null }, now)).toBe(false)
    expect(isOverdue({ status: 'pending', due_at: '2026-11-14T00:00:00Z' }, now)).toBe(false)
  })
  it('client CRM fields', () => {
    const v = (o: Record<string, string>) => parseClientCrm((k) => o[k] ?? '')
    expect(v({})).toEqual({ ok: true, value: { kind: 'individual', legal_name: null, tax_id: null, lifecycle: 'customer', source: null, owner_id: null, branch_id: null } })
    expect(v({ kind: 'company', lifecycle: 'lead', tax_id: ' 66-1234567 ', owner_id: 'x' })).toMatchObject({ ok: true, value: { kind: 'company', lifecycle: 'lead', tax_id: '66-1234567', owner_id: null } })
    expect(v({ kind: 'robot' })).toEqual({ ok: false, error: 'kind' })
    expect(v({ lifecycle: 'vip' })).toEqual({ ok: false, error: 'lifecycle' })
    expect(v({ legal_name: 'x'.repeat(201) })).toEqual({ ok: false, error: 'too_long' })
  })
})

describe('messages', () => {
  it('database errors → codes', () => {
    expect(crmErrorCode({ message: 'CRM_STALE' })).toBe('crm_stale')
    expect(crmErrorCode({ message: 'CRM_QUOTE_ALREADY_CONVERTED' })).toBe('crm_quote_already_converted')
    expect(crmErrorCode({ message: 'PLAN_LIMIT_BRANCHES' })).toBe('plan_limit_branches')
    expect(crmErrorCode({ code: '42501', message: 'permission denied' })).toBe('forbidden')
    expect(crmErrorCode({ message: 'new row violates check constraint "clients_crm_check"' })).toBe('invalid')
    expect(crmErrorCode(null)).toBe('save')
  })
  it('every code reads differently in Spanish and English', () => {
    for (const c of CRM_MESSAGE_CODES) {
      expect(crmMessage(c, 'es')).not.toBe(crmMessage(c, 'en'))
      expect(crmMessage(c, 'en').length).toBeGreaterThan(5)
    }
    expect(crmLabel('email', 'es')).toBe('Email registrado')         // never "sent"
    expect(crmLabel('email', 'en')).toBe('Logged email')
  })
})

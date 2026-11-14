/**
 * Finance D2 (migration 0023): money in integer cents and the manual-entry
 * form. The database enforces the same rules again; these tests make sure
 * the app never turns an amount into floating point or sends an unbalanced
 * entry, and that every database error has a message in both languages.
 */
import { describe, expect, it } from 'vitest'
import { centsToInput, formatCents, MAX_CENTS, parseCents, sumCents, toCents } from '@/lib/finance/money'
import { accountTypeLabel, isoDay, ledgerErrorCode, ledgerMessage, monthStart, parseEntryLines, sourceLabel } from '@/lib/finance/ledger'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const form = (rows: [string, string, string, string?][]) => {
  const f = new FormData()
  rows.forEach(([acc, d, c, memo], i) => { f.set(`account_${i}`, acc); f.set(`debit_${i}`, d); f.set(`credit_${i}`, c); if (memo) f.set(`memo_${i}`, memo) })
  return f
}

describe('parseCents: text → integer cents, never floating point', () => {
  it.each([
    ['0.1', 10n], ['0.10', 10n], ['0.2', 20n], ['1', 100n], ['12.5', 1250n], ['1,234.56', 123456n], ['$99.99', 9999n],
    ['1.234,56', 123456n], ['1234,5', 123450n], ['  7 ', 700n], ['9999999999999.99', 999999999999999n],
  ])('%s → %s', (input, cents) => expect(parseCents(input)).toBe(cents))
  it.each(['', '-5', '1.234', '0.001', 'abc', '1e3', '12.3.4', '10000000000000', 'NaN', 'Infinity'])('rejects %j', (input) => expect(parseCents(input)).toBeNull())
  it('0.1 + 0.2 is exactly 0.30 (the float trap)', () => {
    expect(parseCents('0.1')! + parseCents('0.2')!).toBe(30n)
    expect(0.1 + 0.2).not.toBe(0.3)
  })
  it('the maximum matches the database check (< 10^15 cents)', () => expect(MAX_CENTS).toBe(10n ** 15n - 1n))
})

describe('cents from the database and formatting', () => {
  it('toCents accepts safe integers and digit strings only', () => {
    expect(toCents(10700)).toBe(10700n)
    expect(toCents('123456789012345')).toBe(123456789012345n)
    expect(toCents(null)).toBe(0n)
    expect(() => toCents(1.5)).toThrow('CENTS_NOT_INTEGER')
    expect(() => toCents('1.5')).toThrow('CENTS_NOT_INTEGER')
  })
  it('sums exactly, even above 2^53', () => {
    expect(sumCents(['9007199254740993', 1, '-1'])).toBe(9007199254740993n)
    expect(sumCents(Array(10).fill(10))).toBe(100n)
  })
  it('formats from integer parts in both languages', () => {
    expect(formatCents(123456, 'en')).toBe('$1,234.56')
    expect(formatCents(5, 'en')).toBe('$0.05')
    expect(formatCents(-2550, 'en')).toBe('-$25.50')
    expect(formatCents('123456789012345', 'en')).toBe('$1,234,567,890,123.45')
    expect(formatCents(123456, 'es')).toMatch(/1,234\.56/)
    expect(formatCents(0, 'es')).toMatch(/0\.00/)
  })
  it('centsToInput', () => {
    expect(centsToInput(123405)).toBe('1234.05')
    expect(centsToInput(-7)).toBe('-0.07')
  })
})

describe('parseEntryLines: the manual-entry form', () => {
  it('a balanced entry becomes cents as strings', () => {
    const r = parseEntryLines(form([[A, '25.50', '', 'Anuncio'], [B, '', '25.5']]))
    expect(r).toEqual({ lines: [{ account: A, debit: '2550', credit: '0', memo: 'Anuncio' }, { account: B, debit: '0', credit: '2550', memo: null }], debit: 2550n, credit: 2550n })
  })
  it('skips empty rows', () => {
    const r = parseEntryLines(form([['', '', ''], [A, '1', ''], ['', '', ''], [B, '', '1']]))
    expect('lines' in r && r.lines.length).toBe(2)
  })
  it('unbalanced by one cent: refused before reaching the database', () => expect(parseEntryLines(form([[A, '10.00', ''], [B, '', '9.99']]))).toEqual({ error: 'entry_unbalanced' }))
  it('one line is not an entry', () => expect(parseEntryLines(form([[A, '10', '']]))).toEqual({ error: 'entry_lines_invalid' }))
  it('a line with debit and credit', () => expect(parseEntryLines(form([[A, '10', '10'], [B, '', '0']]))).toEqual({ error: 'entry_line_invalid' }))
  it('a line with neither', () => expect(parseEntryLines(form([[A, '0', ''], [B, '', '0']]))).toEqual({ error: 'entry_line_invalid' }))
  it('bad amounts', () => expect(parseEntryLines(form([[A, '10.001', ''], [B, '', '10']]))).toEqual({ error: 'entry_amount_invalid' }))
  it('negative amounts', () => expect(parseEntryLines(form([[A, '-10', ''], [B, '', '-10']]))).toEqual({ error: 'entry_amount_invalid' }))
  it('an account that is not a uuid', () => expect(parseEntryLines(form([['cash', '10', ''], [B, '', '10']]))).toEqual({ error: 'account_invalid' }))
})

describe('database answers → messages in both languages', () => {
  const cases: [string, string | null, string][] = [
    ['ENTRY_UNBALANCED', 'P0001', 'entry_unbalanced'], ['PERIOD_CLOSED', 'P0001', 'period_closed'], ['ACCOUNT_HAS_ENTRIES', 'P0001', 'account_has_entries'],
    ['ENTRY_ALREADY_REVERSED', 'P0001', 'entry_already_reversed'], ['ENTRY_FROM_DOCUMENT', 'P0001', 'entry_from_document'], ['LEDGER_IMMUTABLE', 'P0001', 'ledger_immutable'],
    ['duplicate key value violates unique constraint "ledger_accounts_company_id_code_key"', '23505', 'account_code_taken'],
    ['new row violates row-level security policy', '42501', 'forbidden'], ['could not serialize access due to concurrent update', '40001', 'retry'],
    ['Could not find the function public.ledger_init', 'PGRST202', 'unavailable'], ['something else', null, 'save'],
  ]
  it.each(cases)('%s', (message, code, want) => expect(ledgerErrorCode({ message, code })).toBe(want))
  it('every code has a Spanish and an English message', () => {
    for (const [message, code] of cases) {
      const c = ledgerErrorCode({ message, code })
      expect(ledgerMessage(c, 'es')).toBeTruthy()
      expect(ledgerMessage(c, 'en')).toBeTruthy()
      expect(ledgerMessage(c, 'es')).not.toBe(ledgerMessage(c, 'en'))
    }
  })
  it('labels', () => {
    expect(sourceLabel('payment', 'es')).toBe('Pago recibido')
    expect(sourceLabel('invoice', 'en')).toBe('Invoice issued')
    expect(accountTypeLabel('liability', 'es')).toBe('Pasivo')
  })
  it('dates', () => {
    expect(isoDay('2026-02-29')).toBeNull()
    expect(isoDay('2028-02-29')).toBe('2028-02-29')
    expect(monthStart('2026-11')).toBe('2026-11-01')
    expect(monthStart('2026-13')).toBeNull()
  })
})

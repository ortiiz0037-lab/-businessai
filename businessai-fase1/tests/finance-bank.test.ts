/**
 * Finance D5 (migration 0026): CSV export safety, database answers and labels.
 */
import { describe, expect, it } from 'vitest'
import { bankErrorCode, bankMessage, csvCell, lineStatusLabel, reasonLabel, toCsv } from '@/lib/finance/bank'

describe('CSV export', () => {
  it('quotes separators and quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('di "x"')).toBe('"di ""x"""')
    expect(csvCell(null)).toBe('')
  })
  it('neutralises spreadsheet formulas, keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-15.00')).toBe('-15.00')
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })
  it('BOM and CRLF for spreadsheets', () => expect(toCsv([['a', 'b'], [1, 'ñ']])).toBe('﻿a,b\r\n1,ñ\r\n'))
})

describe('database answers → messages in both languages', () => {
  const cases: [string, string | null, string][] = [
    ['MATCH_AMOUNT_MISMATCH', 'P0001', 'match_amount_mismatch'], ['BANK_LINE_RECONCILED', 'P0001', 'bank_line_reconciled'], ['STATEMENT_GAP', 'P0001', 'statement_gap'],
    ['RECONCILIATION_NOT_BALANCED', 'P0001', 'reconciliation_not_balanced'], ['UNMATCHED_LINES', 'P0001', 'unmatched_lines'], ['IMPORT_HAS_MATCHES', 'P0001', 'import_has_matches'],
    ['duplicate key value violates unique constraint "bank_accounts_ledger_uidx"', '23505', 'bank_ledger_taken'], ['could not serialize access', '40001', 'retry'], ['?', null, 'save'],
  ]
  it.each(cases)('%s', (m, c, want) => expect(bankErrorCode({ message: m, code: c })).toBe(want))
  it('distinct ES / EN messages', () => {
    for (const [m, c] of cases) { const k = bankErrorCode({ message: m, code: c }); expect(bankMessage(k, 'es')).not.toBe(bankMessage(k, 'en')) }
  })
  it('labels', () => {
    expect(lineStatusLabel('unmatched', 'es')).toBe('Pendiente')
    expect(reasonLabel('group_same_date', 'en')).toBe('Several same-day items add up to the amount')
  })
})

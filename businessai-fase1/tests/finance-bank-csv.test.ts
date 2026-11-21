/**
 * Finance D5 (migration 0026): bank statement CSV import — decoding,
 * parsing, mapping, money in signed integer cents, validation and
 * duplicates inside the file. The database validates the rows again.
 */
import { describe, expect, it } from 'vitest'
import { decodeBytes, detectDelimiter, guessMapping, normalize, parseCsv, parseDate, parseSignedCents, sha256Hex, validateMapping, type Mapping } from '@/lib/finance/bank-csv'

const enc = (s: string) => new TextEncoder().encode(s)

describe('decoding and parsing', () => {
  it('UTF-8 with BOM', () => expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Descripción')]))).toEqual({ text: 'Descripción', encoding: 'utf-8' }))
  it('Windows-1252 (Latin-1) when not valid UTF-8', () => {
    const r = decodeBytes(new Uint8Array([0x44, 0x65, 0x70, 0xf3, 0x73, 0x69, 0x74, 0x6f])) // "Depósito" in Latin-1
    expect(r).toEqual({ text: 'Depósito', encoding: 'windows-1252' })
  })
  it('delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(detectDelimiter('a,b\n1,2')).toBe(',')
  })
  it('quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('Fecha,Descripción,Importe\r\n2026-11-01,"PAGO ""ACME"", INC.","1,234.56"\n2026-11-02,"línea\nmulti",-5\n\n').filter((r) => r.some((x) => x !== ''))).toEqual([
      ['Fecha', 'Descripción', 'Importe'], ['2026-11-01', 'PAGO "ACME", INC.', '1,234.56'], ['2026-11-02', 'línea\nmulti', '-5']])
  })
  it('guesses the mapping from Spanish and English headers', () => {
    expect(guessMapping(['Fecha', 'Descripción', 'Referencia', 'Débito', 'Crédito', 'Saldo'])).toEqual({ date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5 })
    expect(guessMapping(['Posting Date', 'Description', 'Amount', 'Transaction ID'])).toEqual({ date: 0, description: 1, amount: 2, txnId: 3 })
  })
})

describe('dates and amounts', () => {
  it.each([['2026-01-31', 'YMD', '2026-01-31'], ['01/31/2026', 'MDY', '2026-01-31'], ['31/01/2026', 'DMY', '2026-01-31'], ['31.01.26', 'DMY', '2026-01-31'],
    ['2026-02-30', 'YMD', null], ['13/01/2026', 'MDY', null], ['01/31/2026', 'YMD', null], ['ayer', 'DMY', null]] as const)('%s (%s) → %s', (v, f, want) => expect(parseDate(v, f)).toBe(want))
  it.each([['1,234.56', '.', 123456n], ['-1,234.56', '.', -123456n], ['(45.00)', '.', -4500n], ['12-', '.', -1200n], ['$0.10', '.', 10n],
    ['1.234,56', ',', 123456n], ['-0,5', ',', -50n], ['1234', '.', 123400n]] as const)('%s → %s', (v, d, want) => expect(parseSignedCents(v, d)).toBe(want))
  it.each(['1.234', 'abc', '1,2,3', '12.345', '', '-'])('rejects %j', (v) => expect(parseSignedCents(v, '.')).toBeNull())
  it('never floats: 0.1 + 0.2', () => expect(parseSignedCents('0.1', '.')! + parseSignedCents('0.2', '.')!).toBe(30n))
})

const base: Mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YMD', decimal: '.' }

describe('normalize', () => {
  it('signed column, totals, raw kept', () => {
    const r = normalize(parseCsv('Fecha,Desc,Ref,Importe\n2026-11-01,DEPÓSITO,D1,500.00\n2026-11-02,CHEQUE 1001,CK-1,-300\n'), base, { today: '2026-11-12' })
    expect(r.errors).toEqual([])
    expect(r.rows.map((x) => x.amount_cents)).toEqual(['50000', '-30000'])
    expect(r.totals).toEqual({ in: 50000n, out: 30000n, net: 20000n })
    expect(r.rows[0].raw).toEqual({ Fecha: '2026-11-01', Desc: 'DEPÓSITO', Ref: 'D1', Importe: '500.00' })
    expect([r.firstDate, r.lastDate]).toEqual(['2026-11-01', '2026-11-02'])
  })
  it('separate debit / credit columns', () => {
    const r = normalize(parseCsv('Fecha;Desc;Débito;Crédito\n01/11/2026;CARGO;15,00;\n02/11/2026;ABONO;;1.000,00\n'),
      { date: 0, description: 1, debit: 2, credit: 3, dateFormat: 'DMY', decimal: ',' }, { today: '2026-11-12' })
    expect(r.rows.map((x) => [x.date, x.amount_cents])).toEqual([['2026-11-01', '-1500'], ['2026-11-02', '100000']])
  })
  it('invert sign for banks that export withdrawals as positive', () => {
    expect(normalize(parseCsv('a,b,c,d\n2026-11-01,X,,25\n'), { ...base, invertSign: true }, { today: '2026-11-12' }).rows[0].amount_cents).toBe('-2500')
  })
  it('invalid rows are reported with their line number; empty rows skipped', () => {
    const r = normalize(parseCsv('F,D,R,I\n2026-02-30,X,,1\n2026-11-01,,,1\n2026-11-01,X,,abc\n2026-11-01,X,,0\n,,,\n2099-01-01,X,,5\n'), base, { today: '2026-11-12' })
    expect(r.errors.map((e) => `${e.row}:${e.code}`)).toEqual(['2:date_invalid', '3:description_missing', '4:amount_invalid', '7:date_out_of_range'])
    expect(r.rows).toEqual([])
    expect(r.skippedEmpty).toBe(2)   // the zero-amount row and the blank row
  })
  it('identical rows inside the file are flagged as duplicates; ids or balances distinguish them', () => {
    const t = parseCsv('F,D,R,I\n2026-11-05,FEE,,-15\n2026-11-05,FEE,,-15\n2026-11-05,FEE,,-15\n')
    expect(normalize(t, base, { today: '2026-11-12' }).duplicatesInFile).toEqual([3, 4])
    const withBalance = parseCsv('F,D,I,S\n2026-11-05,FEE,-15,100\n2026-11-05,FEE,-15,85\n')
    expect(normalize(withBalance, { date: 0, description: 1, amount: 2, balance: 3, dateFormat: 'YMD', decimal: '.' }, { today: '2026-11-12' }).duplicatesInFile).toEqual([])
  })
  it('header after title lines', () => {
    const r = normalize(parseCsv('Banco Popular\nCuenta ****4821\nFecha,Desc,Ref,Importe\n2026-11-01,X,,1\n'), { ...base, skipRows: 2 }, { today: '2026-11-12' })
    expect(r.headers).toEqual(['Fecha', 'Desc', 'Ref', 'Importe'])
    expect(r.rows).toHaveLength(1)
  })
})

describe('mapping and hashing', () => {
  it('validates the mapping', () => {
    expect(validateMapping(base, 4)).toBeNull()
    expect(validateMapping({ ...base, amount: null, debit: 2 }, 4)).toBeNull()
    expect(validateMapping({ ...base, debit: 2 }, 4)).toBe('mapping_amount')
    expect(validateMapping({ ...base, amount: 9 }, 4)).toBe('mapping_column')
    expect(validateMapping({ ...base, date: undefined as unknown as number }, 4)).toBe('mapping_date')
  })
  it('SHA-256 of the file', async () => {
    expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

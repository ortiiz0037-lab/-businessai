/**
 * Bank statement CSV: decoding, parsing, column mapping and normalization
 * into the rows the database imports (0026: public.bank_import). Pure and
 * isomorphic (browser preview and server import use the same code). Money
 * becomes signed integer cents from text, never through floating point.
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_ROWS = 5000

export type DateFormat = 'YMD' | 'MDY' | 'DMY'
export type DecimalSep = '.' | ','
export type Mapping = {
  date: number
  description: number
  reference?: number | null
  amount?: number | null          // one signed column…
  debit?: number | null           // …or separate withdrawal / deposit columns
  credit?: number | null
  balance?: number | null
  txnId?: number | null
  dateFormat: DateFormat
  decimal: DecimalSep
  invertSign?: boolean            // some banks export withdrawals as positive
  skipRows?: number               // lines before the header
}
export type NormalizedRow = {
  date: string; description: string; reference: string | null; amount_cents: string; balance_cents: string | null
  bank_txn_id: string | null; raw: Record<string, string>
}
export type RowError = { row: number; field: string; code: string }
export type ParseResult = {
  headers: string[]; rows: NormalizedRow[]; errors: RowError[]; duplicatesInFile: number[]; skippedEmpty: number
  totals: { in: bigint; out: bigint; net: bigint }; firstDate: string | null; lastDate: string | null
}

/** UTF-8 (with or without BOM), else Windows-1252 (Latin-1 banks). */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'windows-1252' } {
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' }
  }
}

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n')
  const count = (c: string) => (sample.match(new RegExp(c === '\t' ? '\t' : `\\${c}`, 'g')) ?? []).length
  const scores: [',' | ';' | '\t', number][] = [[',', count(',')], [';', count(';')], ['\t', count('\t')]]
  scores.sort((a, b) => b[1] - a[1])
  return scores[0][1] > 0 ? scores[0][0] : ','
}

/** RFC 4180: quoted fields, doubled quotes, delimiters and newlines inside quotes (one array per physical record). */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delimiter) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  // Blank lines are kept so that reported line numbers match the file;
  // normalize() skips them.
  return rows
}

const NAMES: Record<keyof Omit<Mapping, 'dateFormat' | 'decimal' | 'invertSign' | 'skipRows'>, RegExp> = {
  date: /^(fecha|date|posting date|transaction date|fecha (de )?(transacci[oó]n|operaci[oó]n|valor)|post date)$/i,
  description: /^(descripci[oó]n|description|concepto|detalle|memo|narrative|payee|details)$/i,
  reference: /^(referencia|reference|ref\.?|n[uú]mero|check( number| no\.?)?|cheque|doc(umento)?)$/i,
  amount: /^(importe|monto|amount|cantidad|valor)$/i,
  debit: /^(d[eé]bito|debit|cargo|retiro|withdrawals?|salida|debe)$/i,
  credit: /^(cr[eé]dito|credit|abono|dep[oó]sito|deposits?|entrada|haber)$/i,
  balance: /^(saldo|balance|running balance|saldo disponible)$/i,
  txnId: /^(id|transaction id|id de transacci[oó]n|fitid|identificador)$/i,
}

/** Best guess of the mapping from the header names (the user confirms it). */
export function guessMapping(headers: string[]): Partial<Mapping> {
  const out: Partial<Mapping> = {}
  headers.forEach((h, i) => {
    const name = h.trim()
    for (const [k, re] of Object.entries(NAMES) as [keyof typeof NAMES, RegExp][]) {
      if (out[k] === undefined && re.test(name)) { (out as Record<string, number>)[k] = i; break }
    }
  })
  return out
}

/** '01/31/2026' (MDY), '31/01/2026' (DMY), '2026-01-31' → 'YYYY-MM-DD' or null. */
export function parseDate(v: string, fmt: DateFormat): string | null {
  const s = v.trim().replace(/\s.*$/, '')
  let y: number, m: number, d: number
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  const other = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s)
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3] }
  else if (other && fmt !== 'YMD') {
    const a = +other[1], b = +other[2]
    y = other[3].length === 2 ? 2000 + +other[3] : +other[3]
    if (fmt === 'MDY') { m = a; d = b } else { d = a; m = b }
  } else return null
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** '-1,234.56' / '(1.234,56)' / '$12' / '12-' → signed cents (bigint) or null. Empty → null. */
export function parseSignedCents(v: string, decimal: DecimalSep): bigint | null {
  let s = v.trim().replace(/\s/g, '').replace(/[$€£]|USD|EUR/gi, '')
  if (s === '' || s === '-') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) } else if (s.startsWith('+')) s = s.slice(1)
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1) }
  const thousands = decimal === '.' ? ',' : '.'
  if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})*(\\${decimal}\\d{1,2})?$|^\\d+(\\${decimal}\\d{1,2})?$`).test(s)) return null
  s = s.split(thousands).join('')
  const [whole, frac = ''] = s.split(decimal)
  if (whole.length > 13) return null
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0')
  return neg ? -cents : cents
}

const col = (r: string[], i: number | null | undefined) => (i === null || i === undefined || i < 0 ? '' : (r[i] ?? '').trim())

/** Applies a mapping to the parsed table: rows ready for bank_import, errors, in-file duplicates. */
export function normalize(table: string[][], mapping: Mapping, opts: { today?: string } = {}): ParseResult {
  const skip = Math.max(0, mapping.skipRows ?? 0)
  const headers = (table[skip] ?? []).map((h) => h.trim())
  const body = table.slice(skip + 1)
  const rows: NormalizedRow[] = []
  const errors: RowError[] = []
  const seen = new Map<string, number>()
  const duplicatesInFile: number[] = []
  let skippedEmpty = 0
  let inC = 0n, outC = 0n
  const maxDate = opts.today ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  if (body.length > MAX_ROWS) errors.push({ row: 0, field: 'file', code: 'too_many_rows' })
  body.slice(0, MAX_ROWS).forEach((r, idx) => {
    const n = idx + skip + 2                       // 1-based line in the file
    const date = parseDate(col(r, mapping.date), mapping.dateFormat)
    const description = col(r, mapping.description).replace(/\s+/g, ' ').slice(0, 500)
    let amount: bigint | null = null
    if (mapping.amount !== null && mapping.amount !== undefined) {
      amount = parseSignedCents(col(r, mapping.amount), mapping.decimal)
    } else {
      const d = col(r, mapping.debit), c = col(r, mapping.credit)
      const dv = d ? parseSignedCents(d, mapping.decimal) : 0n
      const cv = c ? parseSignedCents(c, mapping.decimal) : 0n
      amount = dv === null || cv === null ? null : (cv < 0n ? -cv : cv) - (dv < 0n ? -dv : dv)
    }
    if (amount !== null && mapping.invertSign) amount = -amount
    if (!date && !description && (amount === null || amount === 0n)) { skippedEmpty++; return }
    if (!date) { errors.push({ row: n, field: 'date', code: 'date_invalid' }); return }
    if (date < '2000-01-01' || date > maxDate) { errors.push({ row: n, field: 'date', code: 'date_out_of_range' }); return }
    if (!description) { errors.push({ row: n, field: 'description', code: 'description_missing' }); return }
    if (amount === null) { errors.push({ row: n, field: 'amount', code: 'amount_invalid' }); return }
    if (amount === 0n) { skippedEmpty++; return }
    const balRaw = col(r, mapping.balance)
    const bal = balRaw ? parseSignedCents(balRaw, mapping.decimal) : null
    if (balRaw && bal === null) { errors.push({ row: n, field: 'balance', code: 'balance_invalid' }); return }
    const reference = col(r, mapping.reference).slice(0, 120) || null
    const txn = col(r, mapping.txnId).slice(0, 120) || null
    const key = txn ? `id:${txn}` : [date, amount, description.toLowerCase(), (reference ?? '').toLowerCase(), bal ?? ''].join('|')
    const prev = seen.get(key)
    if (prev !== undefined) duplicatesInFile.push(n)
    seen.set(key, n)
    if (amount > 0n) inC += amount; else outC += -amount
    const raw: Record<string, string> = {}
    headers.forEach((h, i) => { if (h) raw[h.slice(0, 60)] = (r[i] ?? '').slice(0, 200) })
    rows.push({ date, description, reference, amount_cents: amount.toString(), balance_cents: bal === null ? null : bal.toString(), bank_txn_id: txn, raw })
  })
  const dates = rows.map((r) => r.date).sort()
  return { headers, rows, errors, duplicatesInFile, skippedEmpty, totals: { in: inC, out: outC, net: inC - outC },
    firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null }
}

/** SHA-256 of the file (hex) with Web Crypto (browser and Node 20). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function validateMapping(m: Partial<Mapping>, columns: number): string | null {
  const ok = (i: number | null | undefined) => i === null || i === undefined || (Number.isInteger(i) && i >= 0 && i < columns)
  if (!Number.isInteger(m.date) || !ok(m.date)) return 'mapping_date'
  if (!Number.isInteger(m.description) || !ok(m.description)) return 'mapping_description'
  const single = m.amount !== null && m.amount !== undefined
  const split = (m.debit !== null && m.debit !== undefined) || (m.credit !== null && m.credit !== undefined)
  if (single === split) return 'mapping_amount'
  if (![m.amount, m.debit, m.credit, m.balance, m.reference, m.txnId].every(ok)) return 'mapping_column'
  if (!['YMD', 'MDY', 'DMY'].includes(String(m.dateFormat)) || !['.', ','].includes(String(m.decimal))) return 'mapping_format'
  return null
}

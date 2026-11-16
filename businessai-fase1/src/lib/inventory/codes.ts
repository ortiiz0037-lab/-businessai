/**
 * Product codes (pure, mirrors ba_gtin_valid / ba_upce_valid / ba_barcode_valid of 0043):
 * GTIN check digits (EAN-8, UPC-A, EAN-13, GTIN-14), UPC-E expansion, and the symbology
 * a scanned code most likely is. The database validates again on save.
 */
export const SYMBOLOGIES = ['ean13', 'upca', 'ean8', 'upce', 'gtin14', 'code128', 'code39', 'qr', 'other'] as const
export type Symbology = (typeof SYMBOLOGIES)[number]

export function gtinValid(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false
  const n = code.length
  let s = 0
  for (let i = 1; i < n; i++) {
    const d = Number(code[n - 1 - i])
    s += i % 2 === 1 ? d * 3 : d
  }
  return (10 - (s % 10)) % 10 === Number(code[n - 1])
}

/** UPC-E (8 digits, number system 0/1) → UPC-A (12 digits), or null. */
export function upceToUpca(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null
  const d = code.slice(1, 7)
  let m: string, p: string
  switch (d[5]) {
    case '0': case '1': case '2': m = d.slice(0, 2) + d[5] + '00'; p = '00' + d.slice(2, 5); break
    case '3': m = d.slice(0, 3) + '00'; p = '000' + d.slice(3, 5); break
    case '4': m = d.slice(0, 4) + '0'; p = '0000' + d[4]; break
    default: m = d.slice(0, 5); p = '0000' + d[5]
  }
  return code[0] + m + p + code[7]
}
export const upceValid = (code: string) => { const a = upceToUpca(code); return !!a && gtinValid(a) }

export function barcodeValid(code: string, sym: Symbology): boolean {
  switch (sym) {
    case 'ean13': return /^\d{13}$/.test(code) && gtinValid(code)
    case 'upca': return /^\d{12}$/.test(code) && gtinValid(code)
    case 'ean8': return /^\d{8}$/.test(code) && gtinValid(code)
    case 'gtin14': return /^\d{14}$/.test(code) && gtinValid(code)
    case 'upce': return upceValid(code)
    case 'code128': return /^[\x20-\x7E]{1,64}$/.test(code)
    case 'code39': return /^[0-9A-Z \-.$/+%]{1,64}$/.test(code)
    default: return code.length >= 1 && code.length <= 64 && !/[\x00-\x1F]/.test(code)
  }
}

/** The symbology a code most likely is (digits with a valid check digit first). */
export function guessSymbology(code: string): Symbology {
  if (/^\d{13}$/.test(code) && gtinValid(code)) return 'ean13'
  if (/^\d{12}$/.test(code) && gtinValid(code)) return 'upca'
  if (/^\d{8}$/.test(code)) { if (gtinValid(code)) return 'ean8'; if (upceValid(code)) return 'upce' }
  if (/^\d{14}$/.test(code) && gtinValid(code)) return 'gtin14'
  if (/^[\x20-\x7E]{1,64}$/.test(code)) return 'code128'
  return 'other'
}

/** What a scanner or a person typed, cleaned: trimmed, no control characters (scanners may add CR/LF/TAB). */
export function normalizeScan(raw: string): string {
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 64)
}

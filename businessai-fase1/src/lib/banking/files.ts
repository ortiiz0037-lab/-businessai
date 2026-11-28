/** Receipt / evidence files (S6): private bucket, paths and the real file type. */
export const EVIDENCE_BUCKET = 'Banking-evidence'
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
export const EVIDENCE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }

export const receiptPath = (companyId: string, id: string, type: string) => `${companyId}/receipts/${id}.${EVIDENCE_EXT[type] ?? 'jpg'}`

/** The real type of the bytes (the extension or the browser's claim are not trusted). */
export function sniff(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  return null
}

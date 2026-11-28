/**
 * Image validation by content (magic bytes), not by name or declared type:
 * PNG or baseline/progressive JPEG, size and pixel limits. Used before an
 * upload to the private Studio-assets bucket and before embedding in a PDF.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_PX = 6000
export type ImageInfo = { mime: 'image/png' | 'image/jpeg'; width: number; height: number; ext: 'png' | 'jpg' }

export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || b.length > MAX_IMAGE_BYTES) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  // PNG: signature + IHDR
  if (v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a && String.fromCharCode(...b.subarray(12, 16)) === 'IHDR') {
    const width = v.getUint32(16), height = v.getUint32(20)
    return width > 0 && height > 0 && width <= MAX_IMAGE_PX && height <= MAX_IMAGE_PX ? { mime: 'image/png', width, height, ext: 'png' } : null
  }
  // JPEG: SOI, then segments until a SOFn marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null
      const marker = b[p + 1]
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue }
      const len = v.getUint16(p + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const height = v.getUint16(p + 5), width = v.getUint16(p + 7)
        return width > 0 && height > 0 && width <= MAX_IMAGE_PX && height <= MAX_IMAGE_PX ? { mime: 'image/jpeg', width, height, ext: 'jpg' } : null
      }
      if (len < 2) return null
      p += 2 + len
    }
  }
  return null
}

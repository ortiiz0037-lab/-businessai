/**
 * Minimal TrueType reader (no dependency), used in the browser (layout of
 * the live preview) and on the server (PDF): advance widths, the Unicode →
 * glyph map, vertical metrics, and a subset that keeps glyph ids but drops
 * every outline the document does not use (small PDFs, same layout).
 */
export type TtfFont = {
  unitsPerEm: number
  ascender: number
  descender: number
  capHeight: number
  italicAngle: number
  bbox: [number, number, number, number]
  postscriptName: string
  numGlyphs: number
  advance(gid: number): number
  glyph(codepoint: number): number
  bytes: Uint8Array
  tables: Map<string, { offset: number; length: number }>
}

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))

export function parseTtf(input: ArrayBuffer | Uint8Array): TtfFont {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sfnt = v.getUint32(0)
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) throw new Error('TTF_UNSUPPORTED')
  const tables = new Map<string, { offset: number; length: number }>()
  const n = v.getUint16(4)
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16
    tables.set(tag(v, r), { offset: v.getUint32(r + 8), length: v.getUint32(r + 12) })
  }
  const t = (name: string) => { const x = tables.get(name); if (!x) throw new Error(`TTF_TABLE_MISSING:${name}`); return x.offset }
  const head = t('head'), hhea = t('hhea'), maxp = t('maxp'), hmtx = t('hmtx'), cmap = t('cmap')
  const unitsPerEm = v.getUint16(head + 18)
  const bbox: [number, number, number, number] = [v.getInt16(head + 36), v.getInt16(head + 38), v.getInt16(head + 40), v.getInt16(head + 42)]
  const numGlyphs = v.getUint16(maxp + 4)
  const numHMetrics = v.getUint16(hhea + 34)
  let ascender = v.getInt16(hhea + 4), descender = v.getInt16(hhea + 6), capHeight = Math.round(ascender * 0.7)
  if (tables.has('OS/2')) {
    const os2 = t('OS/2'), ver = v.getUint16(os2)
    ascender = v.getInt16(os2 + 68); descender = v.getInt16(os2 + 70)
    if (ver >= 2) capHeight = v.getInt16(os2 + 88)
  }
  const italicAngle = tables.has('post') ? v.getInt32(t('post') + 4) / 65536 : 0
  const widths = new Uint16Array(numGlyphs)
  let last = 0
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHMetrics) last = v.getUint16(hmtx + g * 4)
    widths[g] = last
  }
  // cmap: prefer format 12 (full Unicode), else format 4 (BMP), Windows Unicode encodings
  const map = new Map<number, number>()
  const nSub = v.getUint16(cmap + 2)
  let f4 = -1, f12 = -1
  for (let i = 0; i < nSub; i++) {
    const r = cmap + 4 + i * 8, pid = v.getUint16(r), eid = v.getUint16(r + 2), off = cmap + v.getUint32(r + 4)
    const fmt = v.getUint16(off)
    if (pid === 3 && eid === 10 && fmt === 12) f12 = off
    if ((pid === 3 && eid === 1) || pid === 0) { if (fmt === 4 && f4 < 0) f4 = off; if (fmt === 12 && f12 < 0) f12 = off }
  }
  if (f12 >= 0) {
    const groups = v.getUint32(f12 + 12)
    for (let i = 0; i < groups; i++) {
      const r = f12 + 16 + i * 12, start = v.getUint32(r), end = v.getUint32(r + 4), g0 = v.getUint32(r + 8)
      for (let c = start; c <= end && c - start < 0x10000; c++) map.set(c, g0 + (c - start))
    }
  } else if (f4 >= 0) {
    const segX2 = v.getUint16(f4 + 6), ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2
    for (let s = 0; s < segX2 / 2; s++) {
      const end = v.getUint16(ends + s * 2), start = v.getUint16(starts + s * 2), delta = v.getInt16(deltas + s * 2), ro = v.getUint16(ranges + s * 2)
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number
        if (ro === 0) g = (c + delta) & 0xffff
        else {
          const at = ranges + s * 2 + ro + (c - start) * 2
          g = v.getUint16(at); if (g !== 0) g = (g + delta) & 0xffff
        }
        if (g) map.set(c, g)
      }
    }
  } else throw new Error('TTF_CMAP_UNSUPPORTED')
  let postscriptName = 'Font'
  if (tables.has('name')) {
    const nm = t('name'), count = v.getUint16(nm + 2), strings = nm + v.getUint16(nm + 4)
    for (let i = 0; i < count; i++) {
      const r = nm + 6 + i * 12, pid = v.getUint16(r), nid = v.getUint16(r + 6), len = v.getUint16(r + 8), off = v.getUint16(r + 10)
      if (nid !== 6) continue
      let s = ''
      if (pid === 3 || pid === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(v.getUint16(strings + off + k))
      else for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(strings + off + k))
      if (s) { postscriptName = s.replace(/[^A-Za-z0-9-]/g, ''); break }
    }
  }
  return {
    unitsPerEm, ascender, descender, capHeight, italicAngle, bbox, postscriptName, numGlyphs, bytes, tables,
    advance: (gid) => widths[gid] ?? widths[0],
    glyph: (cp) => map.get(cp) ?? 0,
  }
}

/** Width of a string in points. */
export function textWidth(font: TtfFont, text: string, size: number): number {
  let w = 0
  for (const ch of text) w += font.advance(font.glyph(ch.codePointAt(0)!))
  return (w * size) / font.unitsPerEm
}

const pad4 = (n: number) => (n + 3) & ~3
function checksum(b: Uint8Array, off: number, len: number): number {
  const v = new DataView(b.buffer, b.byteOffset)
  let sum = 0
  const end = off + pad4(len)
  for (let i = off; i < end; i += 4) sum = (sum + (i + 4 <= b.byteLength ? v.getUint32(i) : 0)) >>> 0
  return sum
}

/**
 * Same font, same glyph ids, but only the outlines of `used` (plus .notdef
 * and the parts of composite glyphs). Hinting tables are kept; layout and
 * naming tables the PDF does not need are dropped.
 */
export function subsetTtf(font: TtfFont, used: Set<number>): Uint8Array {
  const src = font.bytes
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const head = font.tables.get('head')!.offset
  const longLoca = v.getInt16(head + 50) === 1
  const loca = font.tables.get('loca')!.offset, glyf = font.tables.get('glyf')!.offset
  const off = (g: number) => (longLoca ? v.getUint32(loca + g * 4) : v.getUint16(loca + g * 2) * 2)
  const keep = new Set<number>([0, ...used])
  const stack = [...keep]
  while (stack.length) {                                     // composite glyph components
    const g = stack.pop()!
    if (g >= font.numGlyphs) continue
    const a = off(g), b = off(g + 1)
    if (b <= a || v.getInt16(glyf + a) >= 0) continue
    let p = glyf + a + 10
    for (;;) {
      const flags = v.getUint16(p), comp = v.getUint16(p + 2)
      if (!keep.has(comp)) { keep.add(comp); stack.push(comp) }
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0)
      if (!(flags & 0x20)) break
    }
  }
  const parts: Uint8Array[] = []
  const newLoca = new Uint32Array(font.numGlyphs + 1)
  let size = 0
  for (let g = 0; g < font.numGlyphs; g++) {
    newLoca[g] = size
    if (!keep.has(g)) continue
    const a = off(g), b = off(g + 1)
    if (b > a) { const piece = src.subarray(glyf + a, glyf + b); parts.push(piece); size += piece.length; if (size % 2) { parts.push(new Uint8Array(1)); size += 1 } }
  }
  newLoca[font.numGlyphs] = size
  const glyfOut = new Uint8Array(size); { let o = 0; for (const p of parts) { glyfOut.set(p, o); o += p.length } }
  const locaOut = new Uint8Array((font.numGlyphs + 1) * 4)
  { const lv = new DataView(locaOut.buffer); newLoca.forEach((x, i) => lv.setUint32(i * 4, x)) }
  const copy = (name: string) => { const t = font.tables.get(name); return t ? src.slice(t.offset, t.offset + t.length) : null }
  const headOut = copy('head')!
  new DataView(headOut.buffer).setInt16(50, 1)               // long loca
  new DataView(headOut.buffer).setUint32(8, 0)               // checksumAdjustment, set below
  const out: [string, Uint8Array][] = []
  for (const name of ['OS/2', 'cmap', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep']) {
    const data = name === 'glyf' ? glyfOut : name === 'loca' ? locaOut : name === 'head' ? headOut : copy(name)
    if (data) out.push([name, data])
  }
  const n = out.length
  const dirLen = 12 + n * 16
  let total = dirLen
  for (const [, d] of out) total += pad4(d.length)
  const res = new Uint8Array(total)
  const rv = new DataView(res.buffer)
  rv.setUint32(0, 0x00010000); rv.setUint16(4, n)
  let es = 0; while (1 << (es + 1) <= n) es++
  rv.setUint16(6, (1 << es) * 16); rv.setUint16(8, es); rv.setUint16(10, n * 16 - (1 << es) * 16)
  let o = dirLen, headAt = 0
  out.forEach(([name, d], i) => {
    res.set(d, o)
    const r = 12 + i * 16
    for (let k = 0; k < 4; k++) rv.setUint8(r + k, name.charCodeAt(k))
    rv.setUint32(r + 4, checksum(res, o, d.length)); rv.setUint32(r + 8, o); rv.setUint32(r + 12, d.length)
    if (name === 'head') headAt = o
    o += pad4(d.length)
  })
  rv.setUint32(headAt + 8, (0xb1b0afba - checksum(res, 0, res.length)) >>> 0)
  return res
}

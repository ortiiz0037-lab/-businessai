/**
 * PDF writer for laid-out pages (no dependency). Fonts are embedded as
 * TrueType subsets (CIDFontType2, Identity-H) with a ToUnicode map, so the
 * text is real, selectable and searchable; images are JPEG (passed through)
 * or PNG (decoded, alpha kept as a soft mask). Server only (node:zlib).
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { subsetTtf, type TtfFont } from '@/lib/studio/ttf'
import type { FontKey, Fonts, LaidPage } from '@/lib/studio/layout'

export type PdfImage = { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' }
type Obj = { id: number; body: Uint8Array | string }

const enc = new TextEncoder()
const n2 = (v: number) => (Math.round(v * 100) / 100).toString()
const hexColor = (c: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(c); const h = m ? m[1] : '000000'; return [0, 2, 4].map((i) => n2(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ') }
const pdfString = (s: string) => '(' + s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?') + ')'
const utf16hex = (s: string) => 'FEFF' + Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('').toUpperCase()   // UTF-16 code units (surrogate pairs included)

// ------------------------------------------------------------- PNG decoding
function paeth(a: number, b: number, c: number) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
export function decodePng(bytes: Uint8Array): { width: number; height: number; colors: 1 | 3; pixels: Uint8Array; alpha: Uint8Array | null } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0
  const idat: Uint8Array[] = []
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null
  while (p + 8 <= bytes.length) {
    const len = v.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8)), data = bytes.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { width = v.getUint32(p + 8); height = v.getUint32(p + 12); depth = bytes[p + 16]; ctype = bytes[p + 17]; interlace = bytes[p + 20] }
    else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (!width || !height || interlace !== 0 || ![1, 2, 4, 8, 16].includes(depth)) return null
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0]
  if (!channels) return null
  const raw = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))))
  const bpp = Math.max(1, (channels * depth) / 8), stride = Math.ceil((width * channels * depth) / 8)
  const out = new Uint8Array(stride * height)
  for (let r = 0; r < height; r++) {
    const f = raw[r * (stride + 1)], line = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)), o = r * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0, b = r ? out[o - stride + i] : 0, c = r && i >= bpp ? out[o - stride + i - bpp] : 0
      out[o + i] = (line[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 0xff
    }
  }
  const sample = (r: number, idx: number) => {                // idx-th sample of row r, scaled to 8 bits
    if (depth === 8) return out[r * stride + idx]
    if (depth === 16) return out[r * stride + idx * 2]
    const per = 8 / depth, byte = out[r * stride + Math.floor(idx / per)], shift = (per - 1 - (idx % per)) * depth
    return (byte >> shift) & ((1 << depth) - 1)
  }
  const colors: 1 | 3 = ctype === 2 || ctype === 6 || ctype === 3 ? 3 : 1
  const pixels = new Uint8Array(width * height * colors)
  const hasAlpha = ctype === 4 || ctype === 6 || !!trns
  const alpha = hasAlpha ? new Uint8Array(width * height) : null
  const scale = (x: number) => (depth < 8 && ctype !== 3 ? Math.round((x * 255) / ((1 << depth) - 1)) : x)
  for (let r = 0; r < height; r++) for (let x = 0; x < width; x++) {
    const i = r * width + x
    if (ctype === 3) {
      const ix = sample(r, x)
      pixels.set(palette ? palette.subarray(ix * 3, ix * 3 + 3) : [0, 0, 0], i * 3)
      if (alpha) alpha[i] = trns && ix < trns.length ? trns[ix] : 255
    } else {
      for (let c = 0; c < colors; c++) pixels[i * colors + c] = scale(sample(r, x * channels + c))
      if (alpha) alpha[i] = ctype === 4 || ctype === 6 ? scale(sample(r, x * channels + channels - 1)) : 255
    }
  }
  return { width, height, colors, pixels, alpha }
}

// ------------------------------------------------------------- writer
export function buildPdf(pages: LaidPage[], fonts: Fonts, images: Record<string, PdfImage | undefined>, meta: { title: string; author?: string; lang?: string }): Uint8Array {
  const objs: Obj[] = []
  const alloc = () => { const id = objs.length + 1; objs.push({ id, body: '' }); return id }
  const set = (id: number, body: Uint8Array | string) => { objs[id - 1].body = body }
  const stream = (dict: string, data: Uint8Array, compress = true) => {
    const d = compress ? new Uint8Array(deflateSync(data)) : data
    const head = enc.encode(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${d.length} >>\nstream\n`)
    const tail = enc.encode('\nendstream')
    const out = new Uint8Array(head.length + d.length + tail.length); out.set(head); out.set(d, head.length); out.set(tail, head.length + d.length); return out
  }
  const catalog = alloc(), pagesId = alloc(), info = alloc()

  // which glyphs each font uses (subset + widths + ToUnicode)
  const used = new Map<FontKey, Map<number, string>>()
  for (const pg of pages) for (const p of pg.prims) if (p.t === 'text' || p.t === 'watermark') {
    const f = fonts[p.font]; if (!f) continue
    const m = used.get(p.font) ?? new Map<number, string>(); used.set(p.font, m)
    for (const ch of p.text) { const g = f.glyph(ch.codePointAt(0)!); if (!m.has(g)) m.set(g, ch) }
  }
  const fontRes = new Map<FontKey, string>()
  let fi = 0
  for (const [key, glyphs] of used) {
    const f = fonts[key] as TtfFont
    const name = `F${++fi}`
    fontRes.set(key, name)
    const scale = 1000 / f.unitsPerEm
    const file = alloc(), desc = alloc(), cid = alloc(), type0 = alloc(), tounicode = alloc()
    const sub = subsetTtf(f, new Set(glyphs.keys()))
    set(file, stream(`/Length1 ${sub.length}`, sub))
    const ps = `BAI${String.fromCharCode(65 + fi)}${'ABCDE'[fi % 5]}+${f.postscriptName}`.slice(0, 63)
    const flags = 32 | (f.italicAngle ? 64 : 0) | (key.startsWith('serif') ? 2 : 0)
    set(desc, `<< /Type /FontDescriptor /FontName /${ps} /Flags ${flags} /FontBBox [${f.bbox.map((x) => Math.round(x * scale)).join(' ')}] /ItalicAngle ${f.italicAngle} /Ascent ${Math.round(f.ascender * scale)} /Descent ${Math.round(f.descender * scale)} /CapHeight ${Math.round(f.capHeight * scale)} /StemV 80 /FontFile2 ${file} 0 R >>`)
    const gids = [...glyphs.keys()].sort((a, b) => a - b)
    set(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${ps} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${gids.map((g) => `${g} [${Math.round(f.advance(g) * scale)}]`).join(' ')}] >>`)
    const lines = gids.map((g) => `<${g.toString(16).padStart(4, '0')}> <${utf16hex(glyphs.get(g)!).slice(4)}>`)
    const chunks: string[] = []
    for (let i = 0; i < lines.length; i += 100) chunks.push(`${Math.min(100, lines.length - i)} beginbfchar\n${lines.slice(i, i + 100).join('\n')}\nendbfchar`)
    set(tounicode, stream('', enc.encode(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`)))
    set(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${ps} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tounicode} 0 R >>`)
    fontRes.set(key, `${name}:${type0}`)
  }

  // images
  const imgRes = new Map<string, string>()
  let ii = 0
  for (const [key, img] of Object.entries(images)) {
    if (!img || !pages.some((pg) => pg.prims.some((p) => p.t === 'image' && p.key === key))) continue
    const id = alloc()
    if (img.mime === 'image/jpeg') {
      let w = 0, h = 0, comps = 3
      const b = img.bytes
      for (let p = 2; p + 9 < b.length;) { const m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = (b[p + 5] << 8) | b[p + 6]; w = (b[p + 7] << 8) | b[p + 8]; comps = b[p + 9]; break } p += 2 + len }
      if (!w) { objs.pop(); continue }
      set(id, stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode${comps === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''}`, img.bytes, false))
    } else {
      const png = decodePng(img.bytes)
      if (!png) { objs.pop(); continue }
      let smask = ''
      if (png.alpha) { const sid = alloc(); set(sid, stream(`/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, png.alpha)); smask = ` /SMask ${sid} 0 R` }
      set(id, stream(`/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /${png.colors === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8${smask}`, png.pixels))
    }
    imgRes.set(key, `Im${++ii}:${id}`)
  }

  // pages
  const pageIds: number[] = []
  const gsOpacity = new Map<string, number>()
  for (const pg of pages) {
    const H = pg.height
    const ops: string[] = []
    for (const p of pg.prims) {
      if (p.t === 'rect') {
        ops.push('q')
        if (p.fill) ops.push(`${hexColor(p.fill)} rg`)
        if (p.stroke) ops.push(`${hexColor(p.stroke)} RG ${n2(p.lw ?? 1)} w`)
        ops.push(`${n2(p.x)} ${n2(H - p.y - p.h)} ${n2(p.w)} ${n2(p.h)} re ${p.fill && p.stroke ? 'B' : p.fill ? 'f' : 'S'}`, 'Q')
      } else if (p.t === 'line') {
        ops.push(`q ${hexColor(p.color)} RG ${n2(p.lw)} w ${n2(p.x1)} ${n2(H - p.y1)} m ${n2(p.x2)} ${n2(H - p.y2)} l S Q`)
      } else if (p.t === 'image') {
        const r = imgRes.get(p.key); if (!r) continue
        ops.push(`q ${n2(p.w)} 0 0 ${n2(p.h)} ${n2(p.x)} ${n2(H - p.y - p.h)} cm /${r.split(':')[0]} Do Q`)
      } else if (p.t === 'text' || p.t === 'watermark') {
        const r = fontRes.get(p.font), f = fonts[p.font]; if (!r || !f) continue
        const hex = [...p.text].map((ch) => f.glyph(ch.codePointAt(0)!).toString(16).padStart(4, '0')).join('')
        if (p.t === 'text') ops.push(`BT /${r.split(':')[0]} ${n2(p.size)} Tf ${hexColor(p.color)} rg ${n2(p.x)} ${n2(H - p.y)} Td <${hex}> Tj ET`)
        else {
          const key = `GS${Math.round(p.opacity * 100)}`
          gsOpacity.set(key, p.opacity)
          let w = 0; for (const ch of p.text) w += f.advance(f.glyph(ch.codePointAt(0)!))
          w = (w * p.size) / f.unitsPerEm
          const c = Math.SQRT1_2
          ops.push(`q /${key} gs ${n2(c)} ${n2(c)} ${n2(-c)} ${n2(c)} ${n2(p.cx)} ${n2(H - p.cy)} cm BT /${r.split(':')[0]} ${n2(p.size)} Tf ${hexColor(p.color)} rg ${n2(-w / 2)} ${n2(-p.size * 0.35)} Td <${hex}> Tj ET Q`)
        }
      }
    }
    const content = alloc()
    set(content, stream('', enc.encode(ops.join('\n'))))
    const pid = alloc()
    const fontDict = [...fontRes.values()].map((r) => `/${r.split(':')[0]} ${r.split(':')[1]} 0 R`).join(' ')
    const xo = [...imgRes.values()].map((r) => `/${r.split(':')[0]} ${r.split(':')[1]} 0 R`).join(' ')
    const gs = [...gsOpacity.entries()].map(([k, o]) => `/${k} << /Type /ExtGState /ca ${n2(o)} /CA ${n2(o)} >>`).join(' ')
    set(pid, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n2(pg.width)} ${n2(H)}] /Resources << /Font << ${fontDict} >>${xo ? ` /XObject << ${xo} >>` : ''}${gs ? ` /ExtGState << ${gs} >>` : ''} >> /Contents ${content} 0 R >>`)
    pageIds.push(pid)
  }
  set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R${meta.lang ? ` /Lang ${pdfString(meta.lang)}` : ''} /ViewerPreferences << /DisplayDocTitle true >> >>`)
  const d = new Date()
  const stamp = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`
  set(info, `<< /Title <${utf16hex(meta.title.slice(0, 200))}> ${meta.author ? `/Author <${utf16hex(meta.author.slice(0, 200))}> ` : ''}/Producer (BusinessAI Document Studio) /Creator (BusinessAI) /CreationDate (${stamp}) >>`)

  // serialise
  const chunks: Uint8Array[] = [enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')]
  const offsets: number[] = []
  let pos = chunks[0].length
  for (const o of objs) {
    offsets.push(pos)
    const head = enc.encode(`${o.id} 0 obj\n`), body = typeof o.body === 'string' ? enc.encode(o.body) : o.body, tail = enc.encode('\nendobj\n')
    chunks.push(head, body, tail); pos += head.length + body.length + tail.length
  }
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`
  chunks.push(enc.encode(xref))
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

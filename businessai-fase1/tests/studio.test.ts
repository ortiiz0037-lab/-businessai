/**
 * Document Studio engine (0028): model validation, merge fields, layout,
 * PDF writer, fonts, images, templates and the assistant contract.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { parseContent, parsePage, KINDS, studioErrorCode, studioMessage } from '@/lib/studio/model'
import { mergeText, makeFormatters, missingFields, type StudioData } from '@/lib/studio/merge'
import { layout, parseRuns, FONT_FILES, type FontKey, type Fonts } from '@/lib/studio/layout'
import { buildPdf, decodePng } from '@/lib/studio/pdf'
import { parseTtf, subsetTtf, textWidth } from '@/lib/studio/ttf'
import { imageInfo } from '@/lib/studio/images'
import { systemTemplates } from '@/lib/studio/templates'
import { assertDraftIsSafe, guessKind, ruleAssistant } from '@/lib/studio/assistant'

const fonts: Fonts = {}
for (const [k, f] of Object.entries(FONT_FILES)) fonts[k as FontKey] = parseTtf(readFileSync(`public/studio/fonts/${f}`))
const fmt = makeFormatters('es')
const data: StudioData = {
  company: { legal_name: 'Empresa Demo LLC', city: 'San Juan', payment_info: 'ACH 123' }, client: { name: 'Cliente Ñandú', email: 'c@x.test' },
  document: { number: 'FAC-2026-0007', subtotal: 300, tax: 30, total: 330, discount: 0, tax_rate: 10, issue_date: '2026-11-01', due_date: '2026-12-01' },
  payments: [{ date: '2026-11-05', amount: 120, method: 'ach', reference: 'R-1' }],
  items: [{ description: 'Diseño', quantity: 2, unit_price: 100, amount: 200 }, { description: 'Hosting', quantity: 1, unit_price: 100, amount: 100 }],
  doc: { issued_on: '2026-11-12' },
}
function png(w: number, h: number, ctype: 2 | 6 = 6): Uint8Array {
  const ch = ctype === 6 ? 4 : 3
  const raw = Buffer.alloc((w * ch + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * ch + 1) + 1 + x * ch; raw[o] = 200; raw[o + 1] = 10; raw[o + 2] = 10; if (ch === 4) raw[o + 3] = x === 0 ? 0 : 255 }
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); return b }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ctype
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
const allText = (r: ReturnType<typeof layout>) => r.pages.flatMap((p) => p.prims.filter((x) => x.t === 'text').map((x) => (x as { text: string }).text)).join(' ')

describe('content model (same rules as studio_valid_content)', () => {
  it('accepts every block type and normalises bad values', () => {
    const r = parseContent({ v: 1, blocks: [{ type: 'heading', level: 7, text: 'T' }, { type: 'paragraph', text: 'x' }, { type: 'table', rows: [['a', 'b'], ['c']] },
      { type: 'image', asset: 'logo', width: 500 }, { type: 'spacer', size: -3 }, { type: 'items' }, { type: 'fields', rows: [['A', 'b']] }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.blocks[0]).toMatchObject({ level: 1 })
      expect(r.content.blocks[2]).toMatchObject({ rows: [['a', 'b'], ['c', '']] })
      expect(r.content.blocks[3]).toMatchObject({ width: 100 })
      expect(r.content.blocks[4]).toMatchObject({ size: 1 })
    }
  })
  it('rejects markup, scripts, event handlers, URLs as images and unknown blocks', () => {
    for (const bad of [{ type: 'paragraph', text: '<script>x</script>' }, { type: 'paragraph', text: 'a <img src=x>' }, { type: 'paragraph', text: 'x" onload="y' },
      { type: 'paragraph', text: 'javascript:alert(1)' }, { type: 'image', asset: 'https://evil.test/a.png' }, { type: 'html', text: 'x' }]) {
      expect(parseContent({ v: 1, blocks: [bad] }).ok).toBe(false)
    }
    expect(parseContent({ v: 2, blocks: [] }).ok).toBe(false)
    expect(parseContent({ v: 1, blocks: [{ type: 'paragraph', text: 'Precio < 5 y a > b' }] }).ok).toBe(true)
  })
  it('page settings are clamped', () => expect(parsePage({ size: 'tabloid', fontSize: 40, marginTop: 1, font: 'serif' })).toEqual({ fontSize: 16, marginTop: 8, font: 'serif' }))
  it('error codes and messages', () => {
    expect(studioErrorCode({ message: 'STUDIO_CONFLICT' })).toBe('studio_conflict')
    expect(studioErrorCode({ message: 'x', code: '42501' })).toBe('forbidden')
    expect(studioMessage('studio_locked', 'en')).toMatch(/duplicate/)
  })
})

describe('merge fields never invent data', () => {
  it('fills known fields with formats', () => {
    expect(mergeText('{{client.name}} debe {{document.balance}} desde el {{document.issue_date}}', data, fmt, 'es')).toBe('Cliente Ñandú debe $210.00 desde el 1 de noviembre de 2026')
  })
  it('missing data becomes a visible marker and is reported', () => {
    const missing = new Set<string>()
    expect(mergeText('Hola {{employee.full_name}} / {{nope.x}}', data, fmt, 'es', missing)).toBe('Hola [falta: employee.full_name] / [falta: nope.x]')
    expect([...missing]).toEqual(['employee.full_name', 'nope.x'])
  })
  it('the document number is assigned on issue (not missing)', () => {
    const missing = new Set<string>()
    expect(mergeText('Nº {{doc.number}}', data, fmt, 'es', missing)).toBe('Nº [nº al emitir]'); expect(missing.size).toBe(0)
  })
  it('data blocks without their record are reported', () => {
    expect(missingFields([{ type: 'items' }, { type: 'statement' }], { company: {} }, 'es')).toEqual(['document', 'statement'])
  })
})

describe('fonts', () => {
  it('real metrics (Arial-compatible) and full Spanish coverage', () => {
    expect(textWidth(fonts.sans!, 'Hello', 12)).toBeCloseTo(27.35, 1)
    for (const ch of 'áéíóúñÑüÜ¿¡€“”—') expect(fonts.sans!.glyph(ch.codePointAt(0)!)).toBeGreaterThan(0)
  })
  it('a subset keeps glyph ids and widths and is much smaller', () => {
    const used = new Set([...'Año'].map((c) => fonts.sans!.glyph(c.codePointAt(0)!)))
    const sub = subsetTtf(fonts.sans!, used)
    const again = parseTtf(sub)
    expect(sub.length).toBeLessThan(fonts.sans!.bytes.length / 4)
    expect(textWidth(again, 'Año', 10)).toBe(textWidth(fonts.sans!, 'Año', 10))
  })
})

describe('layout', () => {
  it('inline bold / italic and missing markers', () => {
    expect(parseRuns('a **b** __c__ [falta: x.y]')).toEqual([{ text: 'a ', bold: false, italic: false, missing: false }, { text: 'b', bold: true, italic: false, missing: false },
      { text: ' ', bold: false, italic: false, missing: false }, { text: 'c', bold: false, italic: true, missing: false }, { text: ' ', bold: false, italic: false, missing: false },
      { text: '[falta: x.y]', bold: false, italic: false, missing: true }])
  })
  it('wraps long text inside the margins and paginates', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'paragraph', text: 'palabra '.repeat(2500) }] }, data, locale: 'es', fonts })
    expect(r.pages.length).toBeGreaterThan(2)
    for (const p of r.pages) for (const x of p.prims) if (x.t === 'text' && x.size > 9) expect(x.x + textWidth(fonts.sans!, x.text, x.size)).toBeLessThanOrEqual(p.width - 20 * 72 / 25.4 + 0.5)
    expect(allText(r)).toContain(`Página ${r.pages.length} de ${r.pages.length}`)
  })
  it('items, totals and payments come from the data (balance 330 − 120)', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'items' }, { type: 'totals' }, { type: 'payments' }] }, data, locale: 'es', fonts })
    const t = allText(r)
    for (const s of ['Diseño', 'Hosting', '$200.00', '$300.00', 'Impuesto', '(10%)', '$330.00', 'Pagado', '$120.00', 'Balance', '$210.00', 'R-1']) expect(t).toContain(s)
    expect(r.missing).toEqual([])
  })
  it('a long table splits across pages and repeats its header', () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ description: `Línea ${i + 1}`, quantity: 1, unit_price: 1, amount: 1 }))
    const r = layout({ content: { v: 1, blocks: [{ type: 'items' }] }, data: { ...data, items }, locale: 'es', fonts })
    expect(r.pages.length).toBeGreaterThan(1)
    for (const p of r.pages) expect(p.prims.some((x) => x.t === 'text' && x.text === 'Descripción')).toBe(true)
  })
  it('without the business document: marker, not invented totals', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'totals' }] }, data: { company: {} }, locale: 'en', fonts })
    expect(allText(r)).toContain('[missing: linked business document]'); expect(r.missing).toContain('document')
  })
  it('account statement total', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'statement' }] }, data: { ...data, statement: [{ number: 'F-1', issue_date: '2026-10-01', due_date: '2026-10-31', total_cents: 33000, paid_cents: 12000, balance_cents: 21000, days_past_due: 12 },
      { number: 'F-2', issue_date: '2026-11-01', due_date: null, total_cents: 5000, paid_cents: 0, balance_cents: 5000, days_past_due: 0 }] }, locale: 'es', fonts })
    expect(allText(r)).toContain('$260.00')
  })
  it('page size, orientation and margins', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'paragraph', text: 'x' }] }, page: { size: 'a4', orientation: 'landscape', marginLeft: 30 }, data, locale: 'es', fonts })
    expect([Math.round(r.pages[0].width), Math.round(r.pages[0].height)]).toEqual([842, 595])
    expect((r.pages[0].prims.find((x) => x.t === 'text' && x.text === 'x') as { x: number }).x).toBeCloseTo(30 * 72 / 25.4, 1)
  })
  it('the document typeface and accent also apply to headings (they override the identity)', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Título' }] }, page: { font: 'serif', accent: '#0F766E' }, data, locale: 'es', fonts, brand: { heading_font: 'sans', accent_color: '#7C3AED' } })
    expect(r.pages[0].prims.find((x) => x.t === 'text' && x.text === 'Título')).toMatchObject({ font: 'serif-bold', color: '#0F766E' })
  })
  it('brand: header, footer, watermark and missing images as placeholders', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'image', asset: 'logo', width: 30 }] }, data, locale: 'es', fonts,
      brand: { header_text: '{{company.legal_name}}', footer_text: 'Gracias', watermark_text: 'COPIA', show_logo: false } })
    const t = allText(r)
    expect(t).toContain('Empresa Demo LLC'); expect(t).toContain('Gracias'); expect(t).toContain('[imagen no disponible]')
    expect(r.pages[0].prims.some((x) => x.t === 'watermark' && x.text === 'COPIA')).toBe(true)
  })
})

describe('images', () => {
  it('validates by content', () => {
    expect(imageInfo(png(3, 2))).toEqual({ mime: 'image/png', width: 3, height: 2, ext: 'png' })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(imageInfo(jpeg)).toMatchObject({ mime: 'image/jpeg', width: 64, height: 32 })
    expect(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>          '))).toBeNull()
    expect(imageInfo(new Uint8Array(3 * 1024 * 1024))).toBeNull()
  })
  it('decodes PNG pixels and alpha', () => {
    const d = decodePng(png(2, 1))!
    expect([d.width, d.height, d.colors, [...d.pixels], [...d.alpha!]]).toEqual([2, 1, 3, [200, 10, 10, 200, 10, 10], [0, 255]])
    expect(decodePng(png(2, 1, 2))!.alpha).toBeNull()
  })
})

describe('PDF writer', () => {
  const r = layout({ content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Factura {{document.number}}' }, { type: 'image', asset: 'logo', width: 20 }, { type: 'items' }, { type: 'totals' }] },
    data, locale: 'es', fonts, images: { logo: { width: 4, height: 2 } }, brand: { watermark_text: 'COPIA' } })
  const pdf = buildPdf(r.pages, fonts, { logo: { bytes: png(4, 2), mime: 'image/png' } }, { title: 'Factura FAC-2026-0007', author: 'Empresa Demo LLC', lang: 'es-PR' })
  const text = Buffer.from(pdf).toString('latin1')
  it('is a structurally valid PDF', () => {
    expect(text.startsWith('%PDF-1.7')).toBe(true); expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]); expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const count = Number(/\/Size (\d+)/.exec(text)![1])
    const offsets = [...text.matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]))
    expect(offsets.length).toBe(count - 1)
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
  })
  it('embeds font subsets with ToUnicode (selectable text) and the image with its alpha mask', () => {
    expect(text).toContain('/Subtype /CIDFontType2'); expect(text).toContain('/ToUnicode'); expect(text).toContain('/FontFile2')
    expect(text).toContain('/Subtype /Image'); expect(text).toContain('/SMask'); expect(text).toContain('/ExtGState')
    expect(text).toContain('/Producer (BusinessAI Document Studio)')
  })
  it('the ToUnicode map gives back the real characters', () => {
    const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => { try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { return '' } })
    const cmap = streams.filter((s) => s.includes('beginbfchar')).join('\n')     // one map per font (regular, bold)
    const g = fonts.sans!.glyph('ñ'.codePointAt(0)!)                      // 'Diseño' is set in the regular face
    expect(cmap).toBeTruthy()
    expect(new RegExp(`<${g.toString(16).padStart(4, '0')}> <00f1>`, 'i').test(cmap)).toBe(true)          // glyph of ñ → U+00F1
  })
})

describe('templates', () => {
  it('ten system templates, one per kind, valid in both languages, and laid out without error', () => {
    for (const locale of ['es', 'en'] as const) {
      const ts = systemTemplates(locale)
      expect(ts.map((t) => t.kind).sort()).toEqual([...KINDS].sort())
      for (const t of ts) {
        expect(parseContent(t.content).ok).toBe(true)
        expect(layout({ content: t.content, page: t.page, data, locale, fonts }).pages.length).toBeGreaterThan(0)
      }
    }
  })
  it('templates hold no invented amounts', () => {
    for (const t of systemTemplates('es')) expect(JSON.stringify(t.content)).not.toMatch(/\$\s?\d|\d+\.\d{2}/)
  })
})

describe('assistant contract', () => {
  it('guesses the kind from the instruction', () => {
    expect(guessKind('Prepara un certificado de empleo para Ana')).toBe('certificate')
    expect(guessKind('Draft an account statement for the client')).toBe('account_statement')
    expect(guessKind('hola')).toBeNull()
    expect(guessKind('Carta para agradecer la renovación del contrato')).toBe('letter')
  })
  it('creates a draft with the user’s words, flags missing data, invents nothing', async () => {
    const d = await ruleAssistant.draft({ instruction: 'Carta para agradecer la renovación del contrato <b>', locale: 'es' }, { company: { legal_name: 'Demo' } })
    expect(d.kind).toBe('letter')
    expect(JSON.stringify(d.content)).toContain('Carta para agradecer la renovación del contrato b')
    expect(d.missing).toContain('client.name')
    expect(assertDraftIsSafe(d)).toEqual({ ok: true })
  })
  it('refuses drafts that type amounts into documents whose amounts come from the books', async () => {
    const d = await ruleAssistant.draft({ instruction: 'Factura por $500 de consultoría', locale: 'es' }, data)
    expect(d.kind).toBe('invoice')
    expect(assertDraftIsSafe(d)).toEqual({ ok: false, error: 'amounts_in_text' })
  })
})

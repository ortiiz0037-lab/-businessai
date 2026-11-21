/**
 * Advanced Document Studio (S5): inline formatting by words (colour, size,
 * underline, strike-through, highlight, typeface), nine embedded typefaces,
 * advanced tables, and a real PDF that keeps fonts embedded and text selectable.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { layout, parseRuns, plainText, parseSpanOpen, type Fonts } from '@/lib/studio/layout'
import { FAMILIES, FONT_FILES, familiesUsed, fontKeyOf, type FontKey } from '@/lib/studio/fonts'
import { parseContent, parsePage } from '@/lib/studio/model'
import { buildPdf } from '@/lib/studio/pdf'
import { parseTtf } from '@/lib/studio/ttf'
import type { StudioData } from '@/lib/studio/merge'

const all: Fonts = {}
for (const [k, f] of Object.entries(FONT_FILES)) all[k as FontKey] = parseTtf(readFileSync(`public/studio/fonts/${f}`))
const only = (...fams: string[]): Fonts => Object.fromEntries(Object.entries(all).filter(([k]) => fams.some((f) => k === f || k.startsWith(`${f}-`)))) as Fonts
const data: StudioData = { company: { legal_name: 'Empresa Demo LLC' } }
const texts = (r: ReturnType<typeof layout>) => r.pages.flatMap((p) => p.prims.filter((x) => x.t === 'text')) as { t: 'text'; x: number; y: number; size: number; font: FontKey; color: string; text: string }[]
const one = (text: string, fonts: Fonts = all, extra: Record<string, unknown> = {}) => layout({ content: { v: 1, blocks: [{ type: 'paragraph', text, ...extra } as never] }, data, locale: 'es', fonts })

describe('inline formatting spans', () => {
  it('parses colour, size, underline, strike, highlight and typeface; bold / italic still apply inside', () => {
    expect(parseRuns('Total {c=#c0392b;s=14;u|**vencido**} hoy')).toEqual([
      { text: 'Total ', bold: false, italic: false, missing: false },
      { text: 'vencido', bold: true, italic: false, missing: false, color: '#c0392b', size: 14, underline: true },
      { text: ' hoy', bold: false, italic: false, missing: false },
    ])
    expect(parseRuns('{x;h=#FFF59D;f=lora|nota}')[0]).toMatchObject({ text: 'nota', strike: true, highlight: '#FFF59D', family: 'lora' })
  })
  it('invalid or unclosed spans are plain text (never lost, never executed)', () => {
    for (const t of ['{c=red|x}', '{s=99|x}', '{f=comic|x}', '{z|x}', '{c=#123456|sin cierre', '{c=#123456 x}']) expect(plainText(t)).toBe(t)
    expect(parseSpanOpen('{c=#123456|a}', 0)?.style).toEqual({ color: '#123456' })
    expect(plainText('a {u|b {c=#000000|c} d}')).toBe('a b {c=#000000|c d}')   // spans do not nest: the inner opener is text
  })
  it('the layout draws each word with its colour, size and typeface', () => {
    const t = texts(one('Normal {c=#c0392b;s=16;f=playfair|Grande} {f=mono|COD-1}'))
    const big = t.find((x) => x.text === 'Grande')!
    expect(big).toMatchObject({ color: '#c0392b', size: 16, font: 'playfair' })
    expect(t.find((x) => x.text === 'COD-1')!.font).toBe('mono')
    expect(t.find((x) => x.text === 'Normal')!.size).toBe(10.5)
  })
  it('a larger word makes its line taller (baselines move down)', () => {
    const small = texts(one('uno\ndos'))
    const tall = texts(one('{s=30|uno}\ndos'))
    const dos = (r: typeof small) => r.find((x) => x.text === 'dos')!.y
    // the first line grows from 10.5 × 1.35 to 30 × 1.35 pt: the next line moves down by the difference
    expect(dos(tall) - dos(small)).toBeCloseTo((30 - 10.5) * 1.35, 0)
  })
  it('underline, strike-through and highlight are real lines / rectangles (in the PDF and the preview)', () => {
    const r = one('{u|subrayado} {x|tachado} {h=#FFF59D|resaltado}')
    const prims = r.pages[0].prims
    expect(prims.filter((p) => p.t === 'line' && p.color === '#111827').length).toBe(2)
    expect(prims.some((p) => p.t === 'rect' && p.fill === '#FFF59D')).toBe(true)
    // the highlight is drawn before its text (underneath)
    expect(prims.findIndex((p) => p.t === 'rect' && p.fill === '#FFF59D')).toBeLessThan(prims.findIndex((p) => p.t === 'text' && p.text === 'resaltado'))
  })
  it('a typeface that is not loaded falls back to the default (no crash; measured and drawn with the same font)', () => {
    const t = texts(one('{f=lora|Lora} y **negrita**', only('sans')))
    expect(t.find((x) => x.text === 'Lora')!.font).toBe('sans')
    expect(t.find((x) => x.text === 'negrita')!.font).toBe('sans-bold')
  })
})

describe('nine typefaces', () => {
  it('every family has four styles on disk, under the OFL', () => {
    expect(FAMILIES).toHaveLength(9)
    for (const fam of FAMILIES) for (const k of [fontKeyOf(fam, false, false), fontKeyOf(fam, true, false), fontKeyOf(fam, false, true), fontKeyOf(fam, true, true)]) expect(all[k]?.unitsPerEm).toBeGreaterThan(0)
    expect(readFileSync('public/studio/fonts/licenses/Lora-OFL.txt', 'utf8')).toMatch(/SIL Open Font License/)
  })
  it('the page typeface and inline spans decide which families a document loads', () => {
    expect(familiesUsed({ blocks: [{ type: 'paragraph', text: 'a {c=#000000;f=mono|b}' }], fonts: ['lora', null, 'bogus'] }).sort()).toEqual(['lora', 'mono', 'sans'])
    expect(parsePage({ font: 'playfair' }).font).toBe('playfair')
    expect(parsePage({ font: 'comic-sans' }).font).toBeUndefined()
  })
  it('headings and body use the page typeface', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Título' }, { type: 'paragraph', text: 'Cuerpo' }] }, page: { font: 'montserrat' }, data, locale: 'es', fonts: all })
    expect(texts(r).find((x) => x.text === 'Título')!.font).toBe('montserrat-bold')
    expect(texts(r).find((x) => x.text === 'Cuerpo')!.font).toBe('montserrat')
  })
})

describe('advanced tables', () => {
  const table = (extra: Record<string, unknown>) => layout({ content: { v: 1, blocks: [{ type: 'table', header: true, rows: [['Código', 'Artículo', 'Precio'], ['MAT-1', 'Cemento', '12.50'], ['', 'Total', '12.50']], ...extra } as never] }, data, locale: 'es', fonts: all })
  it('column alignment, the grid style and a bold total row', () => {
    const r = table({ align: ['left', 'center', 'right'], style: 'grid', total: true })
    const t = texts(r)
    const price = t.filter((x) => x.text === '12.50')
    const sans = all.sans!
    expect(price[0].x).toBeGreaterThan(400)                                   // right aligned in the last column
    expect(price[1].font).toBe('sans-bold')                                    // total row
    expect(t.find((x) => x.text === 'Cemento')!.x).toBeGreaterThan(t.find((x) => x.text === 'MAT-1')!.x + 100)   // centred in its column
    const verticals = r.pages[0].prims.filter((p) => p.t === 'line' && p.x1 === p.x2)
    expect(verticals.length).toBeGreaterThanOrEqual(4 * 3)                     // 4 rules per row × 3 rows
    expect(sans).toBeTruthy()
  })
  it('plain style draws no zebra bands; formatting works inside cells', () => {
    const r = layout({ content: { v: 1, blocks: [{ type: 'table', header: false, style: 'plain', rows: [['a', '{c=#c0392b|b}'], ['c', 'd'], ['e', 'f']] } as never] }, data, locale: 'es', fonts: all })
    expect(r.pages[0].prims.some((p) => p.t === 'rect' && p.fill === '#F3F4F6')).toBe(false)
    expect(texts(r).find((x) => x.text === 'b')!.color).toBe('#c0392b')
  })
  it('the model keeps table options and normalises bad ones', () => {
    const c = parseContent({ v: 1, blocks: [{ type: 'table', header: true, rows: [['a', 'b']], align: ['right', 'bogus', 'center'], style: 'neon', total: 'yes' }] })
    expect(c.ok && c.content.blocks[0]).toEqual({ type: 'table', header: true, rows: [['a', 'b']], align: ['right', 'left'] })
    const d = parseContent({ v: 1, blocks: [{ type: 'table', header: true, rows: [['a']], style: 'grid', total: true }] })
    expect(d.ok && d.content.blocks[0]).toMatchObject({ style: 'grid', total: true })
  })
})

describe('the PDF stays real', () => {
  const r = layout({ content: { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Propuesta' }, { type: 'paragraph', text: 'Precio {c=#c0392b;s=14;f=lora|**especial**} con {f=mono|COD-Ñ1} y {u|subrayado}' }] },
    page: { font: 'plex-sans' }, data, locale: 'es', fonts: all })
  const pdf = buildPdf(r.pages, all, {}, { title: 'Propuesta', author: 'Empresa Demo LLC', lang: 'es-PR' })
  const text = Buffer.from(pdf).toString('latin1')
  const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => { try { return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { return '' } })
  it('embeds a subset of every typeface used (and only those)', () => {
    const names = [...text.matchAll(/\/BaseFont \/[A-Z]+\+([A-Za-z0-9-]+)/g)].map((m) => m[1])
    expect(names.some((n) => /IBMPlexSans/i.test(n))).toBe(true)
    expect(names.some((n) => /Lora/i.test(n))).toBe(true)
    expect(names.some((n) => /IBMPlexMono/i.test(n))).toBe(true)
    expect(names.some((n) => /Playfair|Montserrat|Liberation/i.test(n))).toBe(false)
    expect((text.match(/\/FontFile2/g) ?? []).length).toBe(new Set(names).size)
  })
  it('text stays selectable: each embedded font maps its glyphs back to Unicode (Ñ included)', () => {
    const cmaps = streams.filter((s) => s.includes('beginbfchar')).join('\n')
    const g = all.mono!.glyph('Ñ'.codePointAt(0)!)
    expect(new RegExp(`<${g.toString(16).padStart(4, '0')}> <00d1>`, 'i').test(cmaps)).toBe(true)
  })
  it('colours and the underline are drawn in the page content', () => {
    const page = streams.filter((s) => /BT/.test(s) && /Tf/.test(s)).join('\n')
    expect(page).toMatch(/Tf 0\.75 0\.22 0\.17 rg/)                 // #c0392b on the span's word
    expect(page).toMatch(/q 0\.07 0\.09 0\.15 RG [\d.]+ w [\d. ]+ m [\d. ]+ l S Q/)   // the underline, in the text colour
  })
})

/**
 * Layout engine: blocks → pages of positioned primitives (points, origin top
 * left, text y = baseline). The PDF writer and the browser preview both draw
 * this result, so line breaks and page breaks are identical in both.
 * Text is measured with the real font files (ttf.ts).
 */
import type { Locale } from '@/lib/i18n/app'
import { textWidth, type TtfFont } from '@/lib/studio/ttf'
import { BRAND_DEFAULTS, PAGE_DEFAULTS, kindLabel, type Align, type Block, type Brand, type DocContent, type Kind, type PageSettings } from '@/lib/studio/model'
import { makeFormatters, mergeText, type Formatters, type StudioData } from '@/lib/studio/merge'
import { FAMILY_INFO, FONT_FILES, familyOf, fontKeyOf, isFamily, type Family, type FontKey } from '@/lib/studio/fonts'

export { FONT_FILES, type FontKey }
export type Fonts = Partial<Record<FontKey, TtfFont>>

export type Prim =
  | { t: 'text'; x: number; y: number; size: number; font: FontKey; color: string; text: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; lw: number }
  | { t: 'image'; key: string; x: number; y: number; w: number; h: number }
  | { t: 'watermark'; text: string; size: number; font: FontKey; color: string; opacity: number; cx: number; cy: number }
export type LaidPage = { width: number; height: number; prims: Prim[] }
export type ImageMap = Record<string, { width: number; height: number } | undefined>   // 'logo', 'signature', 'stamp', <asset id>

export type LayoutInput = {
  content: DocContent; page?: PageSettings; brand?: Partial<Brand>; accentFallback?: string | null
  data: StudioData; locale: Locale; currency?: string; images?: ImageMap; fonts: Fonts; kind?: Kind; title?: string
}
export type LayoutResult = { pages: LaidPage[]; missing: string[] }

const MM = 72 / 25.4
const SIZES = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] } as const
const MUTED = '#6B7280', BORDER = '#D1D5DB', MISSING = '#B91C1C'

/** Inline formatting of a span (S5): colour, size in pt, underline, strike-through, highlight, typeface. */
export type SpanStyle = { color?: string; size?: number; underline?: boolean; strike?: boolean; highlight?: string; family?: Family }
type Run = { text: string; bold: boolean; italic: boolean; missing: boolean } & SpanStyle
const HEX = /^#[0-9A-Fa-f]{6}$/
/**
 * A span opener `{c=#c0392b;s=14;u|` … `}`. Keys: c colour, s size (6–48 pt), u underline, x strike-through,
 * h highlight colour, f typeface. Anything else is plain text (shown as typed). Spans do not nest.
 */
export function parseSpanOpen(text: string, at: number): { style: SpanStyle; length: number } | null {
  const m = /^\{([a-z](?:=[^;|{}]{1,24})?(?:;[a-z](?:=[^;|{}]{1,24})?){0,5})\|/.exec(text.slice(at, at + 160))
  if (!m || !text.includes('}', at + m[0].length)) return null
  const style: SpanStyle = {}
  for (const part of m[1].split(';')) {
    const [k, v] = part.split('=')
    if (k === 'c' && v && HEX.test(v)) style.color = v
    else if (k === 'h' && v && HEX.test(v)) style.highlight = v
    else if (k === 's' && v && /^\d{1,2}(\.\d)?$/.test(v) && Number(v) >= 6 && Number(v) <= 48) style.size = Number(v)
    else if (k === 'u' && v === undefined) style.underline = true
    else if (k === 'x' && v === undefined) style.strike = true
    else if (k === 'f' && isFamily(v)) style.family = v
    else return null
  }
  return { style, length: m[0].length }
}
/** **bold**, __italic__, {…|span} formatting and merge-field markers (shown in red when data is missing). */
export function parseRuns(text: string): Run[] {
  const out: Run[] = []
  let bold = false, italic = false, buf = '', span: SpanStyle | null = null
  const push = () => {
    if (buf) for (const part of buf.split(/(\[(?:falta|missing): [a-z_.]+\])/)) if (part) out.push({ text: part, bold, italic, missing: /^\[(falta|missing): /.test(part), ...(span ?? {}) })
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('**', i)) { push(); bold = !bold; i++; continue }
    if (text.startsWith('__', i)) { push(); italic = !italic; i++; continue }
    if (!span && text[i] === '{') { const o = parseSpanOpen(text, i); if (o) { push(); span = o.style; i += o.length - 1; continue } }
    if (span && text[i] === '}') { push(); span = null; continue }
    buf += text[i]
  }
  push()
  return out
}
/** The text without formatting marks (for diffs, search and plain-text uses). */
export const plainText = (text: string) => parseRuns(text).map((r) => r.text).join('')

export function layout(input: LayoutInput): LayoutResult {
  const brand: Brand = { ...BRAND_DEFAULTS, ...(input.brand ?? {}) }
  const page = { ...PAGE_DEFAULTS, ...(brand.page ?? {}), ...(input.page ?? {}) }
  const locale = input.locale
  const fmt: Formatters = makeFormatters(locale, input.currency ?? 'USD')
  const accent = input.page?.accent ?? brand.accent_color ?? input.accentFallback ?? '#1F2937'
  const color = brand.text_color || '#111827'
  const family = page.font ?? brand.body_font
  const headFamily = input.page?.font ?? brand.heading_font            // the document's typeface choice applies to headings too
  const missing = new Set<string>()
  const images = input.images ?? {}
  const [pw0, ph0] = SIZES[page.size]
  const [W, H] = page.orientation === 'landscape' ? [ph0, pw0] : [pw0, ph0]
  const mt = page.marginTop * MM, mr = page.marginRight * MM, mb = page.marginBottom * MM, ml = page.marginLeft * MM
  const contentW = W - ml - mr
  const base = page.fontSize
  const lh = page.lineHeight
  const es = locale !== 'en'

  const fontKey = fontKeyOf
  // a missing style falls back to the family's regular, then to the default serif / sans (fonts load per family)
  const fontOf = (k: FontKey) => input.fonts[k] ?? input.fonts[familyOf(k)] ?? input.fonts[FAMILY_INFO[familyOf(k)]?.serif ? fontKeyOf('serif', /-bold/.test(k), /italic$/.test(k)) : fontKeyOf('sans', /-bold/.test(k), /italic$/.test(k))]
    ?? input.fonts.sans ?? Object.values(input.fonts)[0]
  /** the key actually drawn: the requested one when loaded, else the fallback measured above (PDF and preview must agree) */
  const drawKey = (k: FontKey): FontKey => { if (input.fonts[k]) return k; const f = fontOf(k); const hit = (Object.keys(input.fonts) as FontKey[]).find((x) => input.fonts[x] === f); return hit ?? k }
  const measure = (text: string, k: FontKey, size: number) => { const f = fontOf(k); return f ? textWidth(f, text, size) : text.length * size * 0.5 }
  const merge = (t: string) => mergeText(t, input.data, fmt, locale, missing)

  // ---------------------------------------------------------------- header / footer reserve
  const logo = brand.show_logo ? images.logo : undefined
  const headerH = logo || brand.header_text ? 16 * MM : 0
  const footerH = brand.footer_text || brand.show_page_numbers ? 9 * MM : 0
  const top = mt + headerH, bottom = H - mb - footerH

  const pages: LaidPage[] = []
  let cur!: LaidPage
  let y = 0
  const newPage = () => { cur = { width: W, height: H, prims: [] }; pages.push(cur); y = top }
  newPage()
  const ensure = (h: number) => { if (y + h > bottom && y > top + 0.5) newPage() }

  // ---------------------------------------------------------------- text wrapping
  type Word = { text: string; font: FontKey; w: number; color: string; space: number; size: number; underline?: boolean; strike?: boolean; highlight?: string }
  function wrap(runs: Run[], fam: Family, size0: number, maxW: number, baseColor: string, forceBold = false): Word[][] {
    const lines: Word[][] = [[]]
    let lineW = 0
    for (const r of runs) {
      const size = r.size ?? size0
      const k = drawKey(fontKey(r.family ?? fam, r.bold || forceBold, r.italic))
      const c = r.missing ? MISSING : r.color ?? baseColor
      const deco = { size, ...(r.underline ? { underline: true } : {}), ...(r.strike ? { strike: true } : {}), ...(r.highlight ? { highlight: r.highlight } : {}) }
      const parts = r.text.split(/(\n| +)/)
      for (const p of parts) {
        if (p === '') continue
        if (p === '\n') { lines.push([]); lineW = 0; continue }
        const line = lines[lines.length - 1]
        if (/^ +$/.test(p)) { if (line.length) line[line.length - 1].space += measure(p, k, size); continue }
        let w = measure(p, k, size)
        const prevSpace = line.length ? line[line.length - 1].space : 0
        if (line.length && lineW + prevSpace + w > maxW) { line[line.length - 1].space = 0; lines.push([]); lineW = 0 }
        if (w > maxW) {                                            // break a long word by characters
          let chunk = ''
          for (const ch of p) {
            if (measure(chunk + ch, k, size) > maxW && chunk) { const l = lines[lines.length - 1]; l.push({ text: chunk, font: k, w: measure(chunk, k, size), color: c, space: 0, ...deco }); lines.push([]); lineW = 0; chunk = '' }
            chunk += ch
          }
          w = measure(chunk, k, size)
          lines[lines.length - 1].push({ text: chunk, font: k, w, color: c, space: 0, ...deco }); lineW = w; continue
        }
        const l = lines[lines.length - 1]
        lineW += (l.length ? l[l.length - 1].space : 0) + w
        l.push({ text: p, font: k, w, color: c, space: 0, ...deco })
      }
    }
    for (const l of lines) if (l.length) l[l.length - 1].space = 0
    return lines
  }
  /** a line is as tall as its largest word (inline sizes, S5) */
  const lineSize = (line: Word[], size: number) => Math.max(size, ...line.map((w) => w.size))
  function drawLines(lines: Word[][], x: number, maxW: number, size: number, align: Align, onPage = true) {
    lines.forEach((line, i) => {
      const big = lineSize(line, size)
      const step = big * lh
      if (onPage) ensure(step)
      const natural = line.reduce((s, w) => s + w.w + w.space, 0)
      const gaps = line.slice(0, -1).filter((w) => w.space > 0).length
      const last = i === lines.length - 1
      let cx = x + (align === 'center' ? (maxW - natural) / 2 : align === 'right' ? maxW - natural : 0)
      const extra = align === 'justify' && !last && gaps > 0 ? (maxW - natural) / gaps : 0
      const baseline = y + big * 0.8 + (step - big) / 2
      line.forEach((w, j) => {
        const next = line[j + 1]
        const gap = w.space + (w.space > 0 ? extra : 0)
        // decorations run across the space to the next word when it has the same decoration
        if (w.highlight) cur.prims.push({ t: 'rect', x: cx, y: baseline - w.size * 0.82, w: w.w + (next?.highlight === w.highlight ? gap : 0), h: w.size * 1.08, fill: w.highlight })
        cur.prims.push({ t: 'text', x: cx, y: baseline, size: w.size, font: w.font, color: w.color, text: w.text })
        const lw = Math.max(0.5, w.size * 0.06)
        if (w.underline) cur.prims.push({ t: 'line', x1: cx, y1: baseline + w.size * 0.12, x2: cx + w.w + (next?.underline ? gap : 0), y2: baseline + w.size * 0.12, color: w.color, lw })
        if (w.strike) cur.prims.push({ t: 'line', x1: cx, y1: baseline - w.size * 0.28, x2: cx + w.w + (next?.strike ? gap : 0), y2: baseline - w.size * 0.28, color: w.color, lw })
        cx += w.w + gap
      })
      y += step
    })
  }
  const para = (text: string, opts: { size?: number; align?: Align; fam?: Family; bold?: boolean; color?: string; x?: number; w?: number } = {}) => {
    const size = opts.size ?? base
    const lines = wrap(parseRuns(merge(text)), opts.fam ?? family, size, opts.w ?? contentW, opts.color ?? color, opts.bold)
    drawLines(lines, opts.x ?? ml, opts.w ?? contentW, size, opts.align ?? 'left')
  }

  // ---------------------------------------------------------------- tables
  type Cell = { text: string; align?: Align; bold?: boolean }
  function table(widths: number[], header: Cell[] | null, rows: Cell[][], opts: { size?: number; zebra?: boolean; total?: boolean; grid?: boolean } = {}) {
    const size = opts.size ?? Math.max(7.5, base - 1)
    const sum = widths.reduce((a, b) => a + b, 0)
    const cols = widths.map((w) => (w / sum) * contentW)
    const pad = 4
    const rowLines = (cells: Cell[], bold: boolean) => cells.map((c, i) => wrap(parseRuns(merge(c.text)), family, size, cols[i] - pad * 2, color, bold || c.bold))
    const height = (ls: Word[][][]) => Math.max(size * lh, ...ls.map((l) => l.reduce((h, line) => h + lineSize(line, size) * lh, 0))) + pad * 2
    const draw = (cells: Cell[], ls: Word[][][], h: number, fill?: string, textColor?: string) => {
      let x = ml
      if (fill) cur.prims.push({ t: 'rect', x: ml, y, w: contentW, h, fill })
      const y0 = y
      cells.forEach((c, i) => {
        y = y0 + pad
        const lines = textColor ? ls[i].map((l) => l.map((w) => ({ ...w, color: w.color === MISSING ? MISSING : textColor }))) : ls[i]
        drawLines(lines, x + pad, cols[i] - pad * 2, size, c.align ?? 'left', false)
        x += cols[i]
      })
      y = y0 + h
      cur.prims.push({ t: 'line', x1: ml, y1: y, x2: ml + contentW, y2: y, color: BORDER, lw: 0.5 })
      if (opts.grid) {   // vertical rules and the outer frame of the row
        let gx = ml
        for (let i = 0; i <= cols.length; i++) { cur.prims.push({ t: 'line', x1: gx, y1: y0, x2: gx, y2: y, color: BORDER, lw: 0.5 }); gx += cols[i] ?? 0 }
        cur.prims.push({ t: 'line', x1: ml, y1: y0, x2: ml + contentW, y2: y0, color: BORDER, lw: 0.5 })
      }
    }
    const head = header ? { cells: header, ls: rowLines(header, true) } : null
    const drawHead = () => { if (head) { const h = height(head.ls); draw(head.cells, head.ls, h, accent, '#FFFFFF') } }
    ensure(head ? height(head.ls) + size * lh + pad * 2 : size * lh + pad * 2)
    drawHead()
    rows.forEach((r, i) => {
      const ls = rowLines(r, !!opts.total && i === rows.length - 1)
      const h = height(ls)
      if (y + h > bottom) { newPage(); drawHead() }
      draw(r, ls, h, opts.zebra && i % 2 === 1 ? '#F3F4F6' : undefined)
    })
    y += 4
  }
  const money = (n: number | string | null | undefined) => fmt.money(Number(n ?? 0))
  const cents = (n: number | string) => Number(n) / 100

  // ---------------------------------------------------------------- images
  const image = (key: string, wPt: number, align: Align = 'left', maxH = 9999) => {
    const info = images[key]
    let w = wPt, h = info ? (wPt * info.height) / info.width : wPt * 0.4
    if (h > maxH) { w = (w * maxH) / h; h = maxH }
    ensure(h + 4)
    const x = align === 'center' ? ml + (contentW - w) / 2 : align === 'right' ? ml + contentW - w : ml
    if (info) cur.prims.push({ t: 'image', key, x, y, w, h })
    else {
      cur.prims.push({ t: 'rect', x, y, w, h, stroke: BORDER, lw: 0.75 })
      cur.prims.push({ t: 'text', x: x + 6, y: y + Math.min(h - 4, 14), size: 8, font: fontKey(family, false, true), color: MUTED, text: es ? '[imagen no disponible]' : '[image not available]' })
    }
    y += h + 4
  }

  // ---------------------------------------------------------------- blocks
  const headingSize = { 1: base * 1.9, 2: base * 1.45, 3: base * 1.15 }
  for (const b of input.content.blocks as Block[]) {
    switch (b.type) {
      case 'heading': {
        const size = headingSize[b.level]
        ensure(size * lh * 2)
        if (y > top + 1) y += size * 0.45
        para(b.text, { size, align: b.align, fam: headFamily, bold: true, color: b.level === 1 ? accent : color })
        y += size * 0.25
        break
      }
      case 'paragraph': para(b.text, { size: b.size, align: b.align }); y += base * 0.55; break
      case 'spacer': y += b.size * MM; if (y > bottom) newPage(); break
      case 'divider': ensure(8); y += 3; cur.prims.push({ t: 'line', x1: ml, y1: y, x2: ml + contentW, y2: y, color: BORDER, lw: 0.75 }); y += 5; break
      case 'pagebreak': newPage(); break
      case 'image': image(b.asset, (contentW * b.width) / 100, b.align); break
      case 'stamp': if (brand.stamp_asset_id) image('stamp', 35 * MM, b.align ?? 'left'); else para(es ? '[sello no configurado]' : '[stamp not set]', { color: MUTED, size: base - 1 }); break
      case 'signature': {
        const w = 70 * MM
        const x = b.align === 'right' ? ml + contentW - w : b.align === 'center' ? ml + (contentW - w) / 2 : ml
        ensure(30 * MM)
        y += 4
        if (b.withImage && images.signature) {
          const info = images.signature, h = Math.min(18 * MM, (w * 0.6 * info.height) / info.width), iw = (h * info.width) / info.height
          cur.prims.push({ t: 'image', key: 'signature', x, y, w: iw, h }); y += h
        } else y += 14 * MM
        cur.prims.push({ t: 'line', x1: x, y1: y, x2: x + w, y2: y, color: color, lw: 0.75 })
        y += 3
        const name = b.name ?? brand.signature_name ?? ''
        const titleTxt = b.title ?? brand.signature_title ?? ''
        if (name) para(name, { x, w, bold: true, size: base - 0.5 })
        if (titleTxt) para(titleTxt, { x, w, size: base - 1, color: MUTED })
        if (b.label) para(b.label, { x, w, size: base - 1.5, color: MUTED })
        y += 6
        break
      }
      case 'table': {
        const cols = b.rows[0]?.length ?? 1
        const widths = b.widths?.length === cols ? b.widths : Array.from({ length: cols }, () => 1)
        const rows = b.rows.map((r) => r.map((t, j) => ({ text: t, align: b.align?.[j] })))
        const style = b.style ?? 'zebra'
        table(widths, b.header && rows.length ? rows[0] : null, b.header ? rows.slice(1) : rows, { zebra: style === 'zebra', grid: style === 'grid', total: b.total })
        break
      }
      case 'fields': {
        const labelW = contentW * 0.32
        for (const [label, value] of b.rows) {
          // a row whose only data is optional and empty ({{vendor.tax_id?}}) is left out
          if (/\{\{[^}]*\?\s*\}\}/.test(value) && !merge(value).trim()) continue
          const y0 = y
          para(label, { w: labelW, bold: true, size: base - 0.5, color: MUTED })
          const yl = y; y = y0
          para(value, { x: ml + labelW, w: contentW - labelW })
          y = Math.max(y, yl) + 2
        }
        y += 4
        break
      }
      case 'items': {
        const items = input.data.items ?? []
        if (!input.data.document) { missing.add('document'); para(es ? '[falta: documento comercial vinculado]' : '[missing: linked business document]', { color: MISSING }); break }
        table([56, 10, 17, 17], [{ text: es ? 'Descripción' : 'Description' }, { text: es ? 'Cant.' : 'Qty', align: 'right' }, { text: es ? 'Precio' : 'Price', align: 'right' }, { text: es ? 'Importe' : 'Amount', align: 'right' }],
          items.length ? items.map((i) => [{ text: i.description }, { text: String(i.quantity), align: 'right' }, { text: money(i.unit_price), align: 'right' }, { text: money(i.amount), align: 'right' }])
            : [[{ text: es ? 'Sin líneas registradas en el documento.' : 'No lines recorded in the document.' }, { text: '' }, { text: '' }, { text: '' }]], { zebra: true })
        break
      }
      case 'totals': {
        const d = input.data.document
        if (!d) { missing.add('document'); para(es ? '[falta: documento comercial vinculado]' : '[missing: linked business document]', { color: MISSING }); break }
        const paid = (input.data.payments ?? []).reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)
        const rows: [string, string, boolean][] = [[es ? 'Subtotal' : 'Subtotal', money(d.subtotal), false]]
        if (Number(d.discount) > 0) rows.push([es ? 'Descuento' : 'Discount', `−${money(d.discount)}`, false])
        rows.push([`${es ? 'Impuesto' : 'Tax'}${d.tax_rate !== null && d.tax_rate !== undefined ? ` (${d.tax_rate}%)` : ''}`, money(d.tax), false])
        rows.push([es ? 'Total' : 'Total', money(d.total), true])
        if (paid > 0) { rows.push([es ? 'Pagado' : 'Paid', money(paid / 100), false]); rows.push([es ? 'Balance' : 'Balance due', money((Math.round(Number(d.total) * 100) - paid) / 100), true]) }
        const boxW = contentW * 0.42, x = ml + contentW - boxW, size = base
        ensure(rows.length * size * lh + 8)
        for (const [label, value, strong] of rows) {
          if (strong) cur.prims.push({ t: 'line', x1: x, y1: y + 1, x2: x + boxW, y2: y + 1, color: accent, lw: 1 })
          const yb = y + size * 0.8 + (size * lh - size) / 2 + 2
          const k = fontKey(family, strong, false)
          cur.prims.push({ t: 'text', x, y: yb, size, font: k, color, text: label })
          cur.prims.push({ t: 'text', x: x + boxW - measure(value, k, size), y: yb, size, font: k, color: strong ? accent : color, text: value })
          y += size * lh + 2
        }
        y += 6
        break
      }
      case 'payments': {
        const ps = input.data.payments ?? []
        if (!input.data.document) { missing.add('document'); break }
        table([22, 26, 30, 22], [{ text: es ? 'Fecha' : 'Date' }, { text: es ? 'Método' : 'Method' }, { text: es ? 'Referencia' : 'Reference' }, { text: es ? 'Importe' : 'Amount', align: 'right' }],
          ps.length ? ps.map((p) => [{ text: fmt.date(p.date) }, { text: p.method ?? '—' }, { text: p.reference ?? '—' }, { text: money(p.amount), align: 'right' }])
            : [[{ text: es ? 'Sin pagos registrados.' : 'No payments recorded.' }, { text: '' }, { text: '' }, { text: '' }]])
        break
      }
      case 'bill': {   // 0038: the linked expense (Payables): lines, total, paid, balance
        const bl = input.data.bill
        if (!bl) { missing.add('bill'); para(es ? '[falta: gasto vinculado]' : '[missing: linked expense]', { color: MISSING }); break }
        const lines = bl.lines ?? []
        table([34, 46, 20], [{ text: es ? 'Categoría' : 'Category' }, { text: es ? 'Detalle' : 'Detail' }, { text: es ? 'Importe' : 'Amount', align: 'right' }],
          [...lines.map((l) => [{ text: (es ? l.category : l.category_en || l.category) ?? '—' }, { text: l.description ?? '' }, { text: money(cents(l.amount_cents)), align: 'right' as Align }]),
            [{ text: 'Total', bold: true }, { text: '' }, { text: money(cents(bl.total_cents ?? 0)), align: 'right', bold: true }],
            [{ text: es ? 'Pagado' : 'Paid' }, { text: '' }, { text: money(cents(bl.paid_cents ?? 0)), align: 'right' }],
            [{ text: es ? 'Saldo' : 'Balance', bold: true }, { text: '' }, { text: money(cents(bl.balance_cents ?? 0)), align: 'right', bold: true }]],
          { zebra: true, total: true })
        break
      }
      case 'aging': {   // 0038: the client's balance by age (Receivables)
        const ag = input.data.aging
        if (!ag) { missing.add('aging'); para(es ? '[falta: cliente vinculado]' : '[missing: linked client]', { color: MISSING }); break }
        table([17, 17, 17, 17, 16, 16], [{ text: es ? 'Corriente' : 'Current', align: 'right' }, { text: '1–30', align: 'right' }, { text: '31–60', align: 'right' },
          { text: '61–90', align: 'right' }, { text: '90+', align: 'right' }, { text: 'Total', align: 'right' }],
          [[ag.current_cents, ag.d1_30_cents, ag.d31_60_cents, ag.d61_90_cents, ag.d90_plus_cents, ag.total_cents].map((v, i) => ({ text: money(cents(v)), align: 'right' as Align, bold: i === 5 }))],
          { zebra: false, total: true })
        break
      }
      case 'statement': {
        const st = input.data.statement
        if (!st) { missing.add('statement'); para(es ? '[falta: cliente vinculado]' : '[missing: linked client]', { color: MISSING }); break }
        const total = st.reduce((s, r) => s + Number(r.balance_cents), 0)
        table([16, 15, 15, 15, 13, 15, 11], [{ text: es ? 'Factura' : 'Invoice' }, { text: es ? 'Fecha' : 'Date' }, { text: es ? 'Vence' : 'Due' }, { text: 'Total', align: 'right' },
          { text: es ? 'Pagado' : 'Paid', align: 'right' }, { text: es ? 'Balance' : 'Balance', align: 'right' }, { text: es ? 'Días' : 'Days', align: 'right' }],
          [...st.map((r) => [{ text: r.number }, { text: fmt.date(r.issue_date) }, { text: r.due_date ? fmt.date(r.due_date) : '—' }, { text: money(cents(r.total_cents)), align: 'right' as Align },
            { text: money(cents(r.paid_cents)), align: 'right' as Align }, { text: money(cents(r.balance_cents)), align: 'right' as Align }, { text: r.days_past_due > 0 ? String(r.days_past_due) : '—', align: 'right' as Align }]),
          [{ text: es ? 'Balance total' : 'Total balance', bold: true }, { text: '' }, { text: '' }, { text: '' }, { text: '' }, { text: money(cents(total)), align: 'right', bold: true }, { text: '' }]],
          { zebra: true, total: true })
        break
      }
    }
  }

  // ---------------------------------------------------------------- header, footer, watermark on every page
  const total = pages.length
  pages.forEach((p, i) => {
    const pre: Prim[] = []
    if (brand.watermark_text) {
      const size = Math.min(W, H) / Math.max(4, brand.watermark_text.length * 0.55)
      pre.push({ t: 'watermark', text: brand.watermark_text, size, font: fontKey(headFamily, true, false), color: accent, opacity: brand.watermark_opacity / 100, cx: W / 2, cy: H / 2 })
    }
    if (headerH) {
      if (logo) { const h = 12 * MM, w = Math.min((h * logo.width) / logo.height, contentW * 0.4); pre.push({ t: 'image', key: 'logo', x: ml, y: mt, w, h: (w * logo.height) / logo.width }) }
      if (brand.header_text) {
        const size = 8.5, lines = wrap(parseRuns(merge(brand.header_text)), family, size, contentW * 0.55, MUTED)
        lines.forEach((l, k) => { const lw = l.reduce((s, w) => s + w.w + w.space, 0); let x = ml + contentW - lw; for (const w of l) { pre.push({ t: 'text', x, y: mt + 9 + k * size * 1.3, size, font: w.font, color: w.color, text: w.text }); x += w.w + w.space } })
      }
      pre.push({ t: 'line', x1: ml, y1: mt + headerH - 4 * MM, x2: ml + contentW, y2: mt + headerH - 4 * MM, color: accent, lw: 1.2 })
    }
    if (footerH) {
      const fy = H - mb - 2
      p.prims.push({ t: 'line', x1: ml, y1: H - mb - footerH + 2 * MM, x2: ml + contentW, y2: H - mb - footerH + 2 * MM, color: BORDER, lw: 0.5 })
      if (brand.footer_text) p.prims.push({ t: 'text', x: ml, y: fy, size: 8, font: fontKey(family, false, false), color: MUTED, text: mergeText(brand.footer_text, input.data, fmt, locale, missing).slice(0, 140) })
      if (brand.show_page_numbers) {
        const txt = es ? `Página ${i + 1} de ${total}` : `Page ${i + 1} of ${total}`
        p.prims.push({ t: 'text', x: ml + contentW - measure(txt, fontKey(family, false, false), 8), y: fy, size: 8, font: fontKey(family, false, false), color: MUTED, text: txt })
      }
    }
    p.prims.unshift(...pre)
  })
  return { pages, missing: [...missing] }
}

export const docLabel = (kind: Kind | undefined, locale: Locale) => (kind ? kindLabel(kind, locale) : '')

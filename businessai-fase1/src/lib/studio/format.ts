/**
 * Word-level formatting in the editor (S5): pure text transformations of a
 * field value and its selection. The result is the same markup the layout
 * reads (layout.ts parseRuns): **bold**, __italic__ and {key=value;…|text} spans.
 *
 * Spans never nest. A field is handled as a list of styled SEGMENTS: applying a
 * style to a range merges it into every segment of that range (splitting at the
 * edges), so "underline, then colour" gives one span with both, never a span
 * inside another (which the layout would show as literal text).
 */
import { parseSpanOpen, type SpanStyle } from '@/lib/studio/layout'
import type { Family } from '@/lib/studio/fonts'

export type SpanProps = { c?: string; s?: number; u?: true; x?: true; h?: string; f?: Family }
export type Edit = { value: string; start: number; end: number }
type Seg = { text: string; p: SpanProps; raw: number }   // raw: where the segment's text starts in the original value

const fromStyle = (s: SpanStyle): SpanProps => ({ ...(s.color ? { c: s.color } : {}), ...(s.size ? { s: s.size } : {}), ...(s.underline ? { u: true as const } : {}),
  ...(s.strike ? { x: true as const } : {}), ...(s.highlight ? { h: s.highlight } : {}), ...(s.family ? { f: s.family } : {}) })
const clean = (p: SpanProps): SpanProps => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as SpanProps
const same = (a: SpanProps, b: SpanProps) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))

export function spanOpener(p: SpanProps): string {
  const parts: string[] = []
  if (p.c && /^#[0-9a-f]{6}$/i.test(p.c)) parts.push(`c=${p.c}`)
  if (p.s && p.s >= 6 && p.s <= 48) parts.push(`s=${Math.round(p.s * 10) / 10}`)
  if (p.u) parts.push('u')
  if (p.x) parts.push('x')
  if (p.h && /^#[0-9a-f]{6}$/i.test(p.h)) parts.push(`h=${p.h}`)
  if (p.f) parts.push(`f=${p.f}`)
  return parts.length ? `{${parts.join(';')}|` : ''
}

/** The value as styled segments; `map[i]` is the content position of raw index i (markup chars map to the next content char). */
function segments(value: string): { segs: Seg[]; map: number[] } {
  const segs: Seg[] = []
  const map: number[] = []
  let cur: Seg = { text: '', p: {}, raw: 0 }, content = 0, inSpan = false
  const flush = (raw: number, p: SpanProps) => { if (cur.text) segs.push(cur); cur = { text: '', p, raw } }
  for (let i = 0; i < value.length;) {
    if (!inSpan && value[i] === '{') {
      const o = parseSpanOpen(value, i)
      if (o) { for (let k = 0; k < o.length; k++) map[i + k] = content; flush(i + o.length, fromStyle(o.style)); inSpan = true; i += o.length; continue }
    }
    if (inSpan && value[i] === '}') { map[i] = content; flush(i + 1, {}); inSpan = false; i++; continue }
    map[i] = content
    if (!cur.text) cur.raw = i
    cur.text += value[i]; content++; i++
  }
  map[value.length] = content
  flush(value.length, {})
  return { segs, map }
}

function serialize(segs: Seg[]): { value: string; pos: (contentIndex: number, side: 'start' | 'end') => number } {
  // merge neighbours with the same style
  const merged: Seg[] = []
  for (const s of segs) { const last = merged[merged.length - 1]; if (last && same(last.p, s.p)) last.text += s.text; else merged.push({ ...s, p: clean(s.p) }) }
  let value = ''
  const starts: { content: number; raw: number; open: number; len: number }[] = []
  let content = 0
  for (const s of merged) {
    const open = spanOpener(s.p)
    starts.push({ content, raw: value.length, open: open.length, len: s.text.length })
    value += open ? `${open}${s.text}}` : s.text
    content += s.text.length
  }
  const pos = (c: number, side: 'start' | 'end') => {
    for (const st of starts) {
      if (side === 'start' ? c < st.content + st.len : c <= st.content + st.len) return st.raw + st.open + (c - st.content)
    }
    return value.length
  }
  return { value, pos }
}

/** Applies `fn` to the style of every content character in [start, end). */
function restyle(e: Edit, fn: (p: SpanProps) => SpanProps): Edit {
  const { segs, map } = segments(e.value)
  const a = map[e.start] ?? 0, b = map[e.end] ?? a
  if (b <= a) return e
  const out: Seg[] = []
  let c = 0
  for (const s of segs) {
    const s0 = c, s1 = c + s.text.length
    const cut = [s0, Math.max(s0, Math.min(s1, a)), Math.max(s0, Math.min(s1, b)), s1]
    for (let k = 0; k < 3; k++) {
      const t = s.text.slice(cut[k] - s0, cut[k + 1] - s0)
      if (t) out.push({ text: t, p: k === 1 ? fn(s.p) : s.p, raw: 0 })
    }
    c = s1
  }
  const r = serialize(out)
  return { value: r.value, start: r.pos(a, 'start'), end: r.pos(b, 'end') }
}

/** Adds a style to the selection (merged with any style already there). Empty selection or no style → no change. */
export function applySpan(e: Edit, p: SpanProps): Edit {
  if (e.end <= e.start || !spanOpener(p)) return e
  const add = clean(p)   // only the keys that are set: an undefined key never erases a style already there
  return restyle(e, (old) => clean({ ...old, ...add }))
}

/** Removes span markup (keeps the text): used when pasting or comparing. */
export function stripSpans(text: string): string { return segments(text).segs.map((s) => s.text).join('') }

/** Removes every formatting mark (spans, bold, italic) inside the selection. */
export function clearFormatting(e: Edit): Edit {
  if (e.end <= e.start) return e
  const r = restyle(e, () => ({}))
  const inner = r.value.slice(r.start, r.end).replace(/\*\*|__/g, '')
  return { value: r.value.slice(0, r.start) + inner + r.value.slice(r.end), start: r.start, end: r.start + inner.length }
}

/** **…** / __…__ around the selection (as before S5). */
export function toggleMark(e: Edit, mark: '**' | '__'): Edit {
  const sel = e.value.slice(e.start, e.end)
  return { value: e.value.slice(0, e.start) + mark + sel + mark + e.value.slice(e.end), start: e.start + mark.length, end: e.end + mark.length }
}

/** The raw range of the first occurrence of `words` in the text as read (span markup ignored), or null. */
export function findWords(value: string, words: string): Edit | null {
  const { segs, map } = segments(value)
  const plain = segs.map((s) => s.text).join('')
  const at = plain.indexOf(words)
  if (at < 0) return null
  // start: the raw index of the first content character (after any span opener); end: just after the last one
  // a content character is one whose content index advances (span openers and closing braces do not)
  const isContent = (i: number) => map[i] !== map[i + 1]
  let startRaw = value.length
  for (let i = 0; i < value.length; i++) {
    const o = value[i] === '{' ? parseSpanOpen(value, i) : null
    if (o) { i += o.length - 1; continue }
    if (map[i] === at && isContent(i)) { startRaw = i; break }
  }
  let endRaw = startRaw, n = 0
  for (let i = startRaw; i < value.length && n < words.length; i++) {
    const o = value[i] === '{' ? parseSpanOpen(value, i) : null
    if (o) { i += o.length - 1; continue }
    if (!isContent(i)) continue                  // markup (a closing brace)
    n++; endRaw = i + 1
  }
  return { value, start: startRaw, end: endRaw }
}

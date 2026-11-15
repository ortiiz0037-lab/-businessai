/**
 * Edits the BusinessAI Assistant may PROPOSE on an existing Studio draft (S5,
 * proposal kind 'studio_edit' of 0041). Pure: applied only after the user
 * confirms, on the exact version the proposal was made for, and the result is
 * validated like any other content (parseContent + the database validator).
 *   - text written by the assistant may not contain typed amounts: figures go in
 *     as merge fields ({{document.balance}}…), read from the records;
 *   - data blocks (items, totals, payments, statement, bill, ageing) are never
 *     edited or removed; nothing is issued or sent.
 */
import { z } from 'zod'
import { FAMILIES } from '@/lib/studio/fonts'
import { applySpan, findWords, toggleMark, type SpanProps } from '@/lib/studio/format'
import { parseContent, type Block, type DocContent, type PageSettings } from '@/lib/studio/model'
import { insertRow, MAX_ROWS } from '@/lib/studio/tables'

const text = z.string().min(1).max(4000)
const at = z.number().int().min(0).max(499)
const style = z.object({ color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), size: z.number().min(6).max(48).optional(), underline: z.boolean().optional(), strike: z.boolean().optional(),
  highlight: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), font: z.enum(FAMILIES).optional(), bold: z.boolean().optional() }).strict()
export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append_paragraph'), text }).strict(),
  z.object({ op: z.literal('insert_paragraph'), after_block: at, text }).strict(),
  z.object({ op: z.literal('append_heading'), text: z.string().min(1).max(500), level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  z.object({ op: z.literal('replace_text'), block: at, text }).strict(),
  z.object({ op: z.literal('format_words'), block: at, words: z.string().min(1).max(200), style }).strict(),
  z.object({ op: z.literal('add_table'), header: z.boolean(), rows: z.array(z.array(z.string().max(500)).min(1).max(8)).min(1).max(40) }).strict(),
  z.object({ op: z.literal('append_table_rows'), block: at, rows: z.array(z.array(z.string().max(500)).min(1).max(8)).min(1).max(40) }).strict(),
  z.object({ op: z.literal('set_page_font'), font: z.enum(FAMILIES) }).strict(),
])
export type EditOp = z.infer<typeof EditOp>
export const EditOps = z.array(EditOp).min(1).max(10)

const AMOUNT = /[$€]\s?\d|\d[\d,.]*\s?(USD|EUR|dólares|dollars)\b/i
const DATA_BLOCKS = new Set(['items', 'totals', 'payments', 'statement', 'bill', 'aging'])

export type EditResult = { ok: true; content: DocContent; page: PageSettings } | { ok: false; error: string; at?: number }

export function applyEdits(content: DocContent, page: PageSettings, ops: EditOp[]): EditResult {
  const blocks: Block[] = structuredClone(content.blocks)
  let pg: PageSettings = { ...page }
  for (const [n, op] of ops.entries()) {
    const fail = (error: string): EditResult => ({ ok: false, error, at: n })
    const written = 'text' in op ? [op.text] : 'rows' in op ? op.rows.flat() : []
    if (written.some((t) => AMOUNT.test(t))) return fail('amounts_in_text')
    const target = 'block' in op ? blocks[op.block] : undefined
    if ('block' in op && (!target || DATA_BLOCKS.has(target.type))) return fail('block_not_editable')
    switch (op.op) {
      case 'append_paragraph': blocks.push({ type: 'paragraph', text: op.text }); break
      case 'insert_paragraph': if (op.after_block >= blocks.length) return fail('block_not_found'); blocks.splice(op.after_block + 1, 0, { type: 'paragraph', text: op.text }); break
      case 'append_heading': blocks.push({ type: 'heading', level: op.level, text: op.text }); break
      case 'replace_text':
        if (target!.type !== 'paragraph' && target!.type !== 'heading') return fail('block_not_editable')
        blocks[op.block] = { ...target!, text: op.text } as Block; break
      case 'format_words': {
        if (target!.type !== 'paragraph' && target!.type !== 'heading') return fail('block_not_editable')
        const t = target as Extract<Block, { type: 'paragraph' | 'heading' }>
        // the words as the reader sees them (span markup ignored), so earlier formatting does not hide them
        const found = findWords(t.text, op.words)
        if (!found) return fail('words_not_found')
        const p: SpanProps = { c: op.style.color, s: op.style.size, u: op.style.underline || undefined, x: op.style.strike || undefined, h: op.style.highlight, f: op.style.font }
        let edit = applySpan(found, p)
        if (op.style.bold) edit = toggleMark(edit, '**')
        const r = edit
        if (r.value === t.text) return fail('no_style')
        blocks[op.block] = { ...t, text: r.value }; break
      }
      case 'add_table': { const cols = Math.max(...op.rows.map((r) => r.length)); blocks.push({ type: 'table', header: op.header, rows: op.rows.map((r) => Array.from({ length: cols }, (_, j) => r[j] ?? '')) }); break }
      case 'append_table_rows': {
        if (target!.type !== 'table') return fail('block_not_editable')
        let tb = target as Extract<Block, { type: 'table' }>
        const cols = tb.rows[0]?.length ?? 1
        for (const r of op.rows) {
          if (tb.rows.length >= MAX_ROWS) return fail('too_many_rows')
          tb = insertRow(tb, tb.rows.length)
          tb.rows[tb.rows.length - 1] = Array.from({ length: cols }, (_, j) => r[j] ?? '')
        }
        blocks[op.block] = tb; break
      }
      case 'set_page_font': pg = { ...pg, font: op.font }; break
    }
  }
  const parsed = parseContent({ v: 1, blocks })
  if (!parsed.ok) return { ok: false, error: `invalid_content:${parsed.error}` }
  return { ok: true, content: parsed.content, page: pg }
}

/** A short, human summary of the proposed edits (shown on the confirmation card). */
export function describeEdits(ops: EditOp[], locale: 'es' | 'en'): string {
  const es = locale !== 'en'
  const one = (o: EditOp) => {
    switch (o.op) {
      case 'append_paragraph': return es ? 'añadir un párrafo al final' : 'add a paragraph at the end'
      case 'insert_paragraph': return es ? `insertar un párrafo tras el bloque ${o.after_block + 1}` : `insert a paragraph after block ${o.after_block + 1}`
      case 'append_heading': return es ? 'añadir un título' : 'add a heading'
      case 'replace_text': return es ? `reescribir el bloque ${o.block + 1}` : `rewrite block ${o.block + 1}`
      case 'format_words': return es ? `dar formato a «${o.words.slice(0, 40)}»` : `format "${o.words.slice(0, 40)}"`
      case 'add_table': return es ? `añadir una tabla de ${o.rows.length} fila(s)` : `add a table with ${o.rows.length} row(s)`
      case 'append_table_rows': return es ? `añadir ${o.rows.length} fila(s) a la tabla ${o.block + 1}` : `add ${o.rows.length} row(s) to table ${o.block + 1}`
      case 'set_page_font': return es ? `cambiar la tipografía a ${o.font}` : `change the typeface to ${o.font}`
    }
  }
  return ops.map(one).join('; ')
}

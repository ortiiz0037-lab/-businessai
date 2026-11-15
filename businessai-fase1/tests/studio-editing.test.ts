/**
 * Advanced Document Studio editing (S5): word formatting of a selection, table
 * row / column operations that keep widths and alignment in step, and the
 * comparison of two versions.
 */
import { describe, expect, it } from 'vitest'
import { applySpan, clearFormatting, findWords, spanOpener, stripSpans, toggleMark } from '@/lib/studio/format'
import { deleteCol, deleteRow, duplicateRow, insertCol, insertRow, moveCol, moveRow, setColAlign, setColWidth, MAX_COLS, type Table } from '@/lib/studio/tables'
import { diffBlocks, diffPage, summary, wordDiff } from '@/lib/studio/diff'
import { parseRuns } from '@/lib/studio/layout'
import { parseContent } from '@/lib/studio/model'

describe('formatting the selected words', () => {
  const v = 'El saldo vencido es importante'
  const sel = (word: string) => ({ value: v, start: v.indexOf(word), end: v.indexOf(word) + word.length })
  it('wraps the selection in a span the layout understands; the selection follows the words', () => {
    const r = applySpan(sel('vencido'), { c: '#c0392b', s: 14, u: true })
    expect(r.value).toBe('El saldo {c=#c0392b;s=14;u|vencido} es importante')
    expect(r.value.slice(r.start, r.end)).toBe('vencido')
    expect(parseRuns(r.value)[1]).toMatchObject({ text: 'vencido', color: '#c0392b', size: 14, underline: true })
  })
  it('re-formatting merges into the existing span (spans never nest) and clearing removes every mark', () => {
    const once = applySpan(sel('saldo vencido'), { c: '#c0392b' })
    const twice = applySpan({ value: once.value, start: once.start - '{c=#c0392b|'.length, end: once.end + 1 }, { h: '#FFF59D', f: 'lora' })
    expect(twice.value).toBe('El {c=#c0392b;h=#FFF59D;f=lora|saldo vencido} es importante')
    // formatting part of a span splits it: one span per style, never nested
    const part = applySpan({ value: once.value, start: once.value.indexOf('vencido'), end: once.value.indexOf('vencido') + 7 }, { u: true })
    expect(part.value).toBe('El {c=#c0392b|saldo }{c=#c0392b;u|vencido} es importante')
    expect(part.value.slice(part.start, part.end)).toBe('vencido')
    const bold = toggleMark(sel('importante'), '**')
    expect(bold.value).toBe('El saldo vencido es **importante**')
    const cleared = clearFormatting({ value: twice.value, start: 0, end: twice.value.length })
    expect(cleared.value).toBe(v)
  })
  it('words are found as read, across span markup', () => {
    const v2 = 'Le {u|recordamos el} {c=#000000|saldo} pendiente.'
    const f = findWords(v2, 'el saldo pendiente')!
    expect(applySpan(f, { h: '#FFF59D' }).value).toBe('Le {u|recordamos }{u;h=#FFF59D|el}{h=#FFF59D| }{c=#000000;h=#FFF59D|saldo}{h=#FFF59D| pendiente}.')
    expect(findWords(v2, 'no está')).toBeNull()
  })
  it('no selection or no style → nothing changes; bad values are dropped', () => {
    expect(applySpan({ value: v, start: 3, end: 3 }, { c: '#000000' }).value).toBe(v)
    expect(spanOpener({ c: 'red', s: 99 })).toBe('')
    expect(stripSpans('a {c=#000000|b} {z c}')).toBe('a b {z c}')
  })
})

describe('table rows and columns', () => {
  const t: Table = { type: 'table', header: true, rows: [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']], widths: [10, 20, 30], align: ['left', 'center', 'right'] }
  it('rows: insert, duplicate, move, delete (never the last one)', () => {
    expect(insertRow(t, 1).rows[1]).toEqual(['', '', ''])
    expect(duplicateRow(t, 1).rows).toEqual([['A', 'B', 'C'], ['1', '2', '3'], ['1', '2', '3'], ['4', '5', '6']])
    expect(moveRow(t, 2, -1).rows.map((r) => r[0])).toEqual(['A', '4', '1'])
    expect(moveRow(t, 0, -1)).toBe(t)
    expect(deleteRow({ ...t, rows: [['x']] }, 0).rows).toEqual([['x']])
  })
  it('columns keep widths and alignment in step', () => {
    const ins = insertCol(t, 1)
    expect(ins.rows[0]).toEqual(['A', '', 'B', 'C']); expect(ins.widths).toEqual([10, 20, 20, 30]); expect(ins.align).toEqual(['left', 'left', 'center', 'right'])
    const mv = moveCol(t, 2, -1)
    expect(mv.rows[1]).toEqual(['1', '3', '2']); expect(mv.widths).toEqual([10, 30, 20]); expect(mv.align).toEqual(['left', 'right', 'center'])
    const del = deleteCol(t, 0)
    expect(del.rows[0]).toEqual(['B', 'C']); expect(del.widths).toEqual([20, 30]); expect(del.align).toEqual(['center', 'right'])
    expect(deleteCol({ ...t, rows: [['x'], ['y']] }, 0).rows).toEqual([['x'], ['y']])
  })
  it('limits: at most eight columns; alignment and width per column', () => {
    const wide: Table = { type: 'table', header: false, rows: [Array(MAX_COLS).fill('x')] }
    expect(insertCol(wide, 0)).toBe(wide)
    expect(setColAlign({ type: 'table', header: false, rows: [['a', 'b']] }, 1, 'right').align).toEqual(['left', 'right'])
    expect(setColAlign(setColAlign({ type: 'table', header: false, rows: [['a', 'b']] }, 1, 'right'), 1, 'left').align).toBeUndefined()
    expect(setColWidth({ type: 'table', header: false, rows: [['a', 'b']] }, 0, 250).widths).toEqual([100, 10])
    expect(parseContent({ v: 1, blocks: [insertCol(t, 3)] }).ok).toBe(true)
  })
})

describe('comparing two versions', () => {
  it('word-level changes inside a paragraph', () => {
    expect(wordDiff('Pague el saldo hoy', 'Pague todo el saldo mañana')).toEqual([
      { op: 'eq', text: 'Pague ' }, { op: 'add', text: 'todo ' }, { op: 'eq', text: 'el saldo ' }, { op: 'del', text: 'hoy' }, { op: 'add', text: 'mañana' },
    ])
  })
  it('blocks: same, changed (with words), added, removed; formatting-only changes are flagged', () => {
    const from = [{ type: 'heading', level: 1, text: 'Carta' }, { type: 'paragraph', text: 'Saldo vencido' }, { type: 'divider' }] as never[]
    const to = [{ type: 'heading', level: 1, text: 'Carta' }, { type: 'paragraph', text: 'Saldo {c=#c0392b|vencido}' }, { type: 'paragraph', text: 'Gracias' }] as never[]
    const d = diffBlocks(from, to)
    expect(d.map((c) => c.op)).toEqual(['same', 'changed', 'removed', 'added'])
    const ch = d[1] as Extract<(typeof d)[number], { op: 'changed' }>
    expect(ch.formatOnly).toBe(true)
    expect(summary(d)).toEqual({ added: 1, removed: 1, changed: 1, same: 1 })
  })
  it('table cells are compared too; page settings changes are listed', () => {
    const d = diffBlocks([{ type: 'table', header: true, rows: [['A'], ['1']] }] as never[], [{ type: 'table', header: true, rows: [['A'], ['2']] }] as never[])
    expect(d[0]).toMatchObject({ op: 'changed', formatOnly: false })
    expect(diffPage({ font: 'sans', size: 'letter' }, { font: 'lora', size: 'letter' })).toEqual([{ key: 'font', from: 'sans', to: 'lora' }])
  })
})

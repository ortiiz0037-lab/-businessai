/**
 * Table editing (S5): rows and columns are inserted, moved, duplicated and
 * removed with the per-column options (widths, alignment) kept in step.
 * Pure functions on the table block; limits match the model (200 rows, 8 columns).
 */
import type { Align, Block } from '@/lib/studio/model'

export type Table = Extract<Block, { type: 'table' }>
export const MAX_ROWS = 200, MAX_COLS = 8
const cols = (t: Table) => t.rows[0]?.length ?? 1
const clampIndex = (i: number, n: number) => Math.min(Math.max(i, 0), n)
const withCols = <T>(arr: T[] | undefined, fn: (a: T[]) => T[]): T[] | undefined => (arr ? fn([...arr]) : undefined)
function tidy(t: Table): Table {
  const out: Table = { ...t }
  if (!out.widths) delete out.widths
  if (!out.align || out.align.every((a) => a === 'left')) delete out.align
  return out
}

export function insertRow(t: Table, at: number): Table {
  if (t.rows.length >= MAX_ROWS) return t
  const i = clampIndex(at, t.rows.length)
  return { ...t, rows: [...t.rows.slice(0, i), Array(cols(t)).fill(''), ...t.rows.slice(i)] }
}
export function deleteRow(t: Table, i: number): Table {
  if (t.rows.length <= 1 || i < 0 || i >= t.rows.length) return t
  return { ...t, rows: t.rows.filter((_, k) => k !== i) }
}
export function duplicateRow(t: Table, i: number): Table {
  if (t.rows.length >= MAX_ROWS || i < 0 || i >= t.rows.length) return t
  return { ...t, rows: [...t.rows.slice(0, i + 1), [...t.rows[i]], ...t.rows.slice(i + 1)] }
}
export function moveRow(t: Table, i: number, d: -1 | 1): Table {
  const j = i + d
  if (i < 0 || j < 0 || i >= t.rows.length || j >= t.rows.length) return t
  const rows = [...t.rows];[rows[i], rows[j]] = [rows[j], rows[i]]
  return { ...t, rows }
}

export function insertCol(t: Table, at: number): Table {
  const n = cols(t)
  if (n >= MAX_COLS) return t
  const i = clampIndex(at, n)
  const ins = <T>(a: T[], v: T) => [...a.slice(0, i), v, ...a.slice(i)]
  return tidy({ ...t, rows: t.rows.map((r) => ins(r, '')), widths: withCols(t.widths, (w) => ins(w, Math.max(1, Math.round(w.reduce((a, b) => a + b, 0) / w.length)))),
    align: withCols(t.align, (a) => ins<Align>(a, 'left')) })
}
export function deleteCol(t: Table, i: number): Table {
  const n = cols(t)
  if (n <= 1 || i < 0 || i >= n) return t
  const del = <T>(a: T[]) => a.filter((_, k) => k !== i)
  return tidy({ ...t, rows: t.rows.map(del), widths: withCols(t.widths, del), align: withCols(t.align, del) })
}
export function moveCol(t: Table, i: number, d: -1 | 1): Table {
  const n = cols(t), j = i + d
  if (i < 0 || j < 0 || i >= n || j >= n) return t
  const swap = <T>(a: T[]) => { const x = [...a];[x[i], x[j]] = [x[j], x[i]]; return x }
  return tidy({ ...t, rows: t.rows.map(swap), widths: withCols(t.widths, swap), align: withCols(t.align, swap) })
}
export function setColAlign(t: Table, i: number, a: Align): Table {
  const n = cols(t)
  if (i < 0 || i >= n) return t
  const align = Array.from({ length: n }, (_, k) => (k === i ? a : t.align?.[k] ?? 'left'))
  return tidy({ ...t, align })
}
/** Relative width 1–100 of one column (the others keep theirs; default 10 each). */
export function setColWidth(t: Table, i: number, w: number): Table {
  const n = cols(t)
  if (i < 0 || i >= n || !Number.isFinite(w)) return t
  const widths = Array.from({ length: n }, (_, k) => (k === i ? Math.min(100, Math.max(1, Math.round(w))) : t.widths?.[k] ?? 10))
  return { ...t, widths }
}

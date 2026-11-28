/**
 * Version comparison (S5): what changed between two saved versions of a Studio
 * document. Blocks are aligned with a longest-common-subsequence over their
 * text, then an added block next to a removed one of the same type is shown as
 * a change with a word-level diff. Formatting marks are compared too (a word
 * made red is a change) but shown as plain text. Pure and bounded.
 */
import { plainText } from '@/lib/studio/layout'
import type { Block, PageSettings } from '@/lib/studio/model'

export type Seg = { op: 'eq' | 'add' | 'del'; text: string }
export type BlockChange =
  | { op: 'same'; type: string; text: string }
  | { op: 'added' | 'removed'; type: string; text: string }
  | { op: 'changed'; type: string; segs: Seg[]; formatOnly: boolean }

/** A readable text of a block (tables: cells separated by " | ", rows by new lines). */
export function blockText(b: Block): string {
  switch (b.type) {
    case 'heading': case 'paragraph': return b.text
    case 'table': return b.rows.map((r) => r.join(' | ')).join('\n')
    case 'fields': return b.rows.map(([l, v]) => `${l}: ${v}`).join('\n')
    case 'signature': return [b.name, b.title, b.label].filter(Boolean).join(' · ')
    case 'image': return `${b.asset} (${b.width}%)`
    case 'spacer': return `${b.size} mm`
    default: return ''
  }
}
/** Everything that makes two blocks different (options included), for equality. */
const signature = (b: Block) => JSON.stringify(b)

function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: [number, number][] = []
  let i = 0, j = 0
  while (i < n && j < m) { if (eq(a[i], b[j])) { pairs.push([i, j]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++ }
  return pairs
}

/** Word-level diff (words and the spaces between them). Long texts fall back to a whole replacement. */
export function wordDiff(a: string, b: string): Seg[] {
  if (a === b) return a ? [{ op: 'eq', text: a }] : []
  const ta = a.match(/\s+|[^\s]+/g) ?? [], tb = b.match(/\s+|[^\s]+/g) ?? []
  if (ta.length * tb.length > 4_000_000) return [...(a ? [{ op: 'del' as const, text: a }] : []), ...(b ? [{ op: 'add' as const, text: b }] : [])]
  const pairs = lcs(ta, tb, (x, y) => x === y)
  const out: Seg[] = []
  const push = (op: Seg['op'], text: string) => { if (!text) return; const last = out[out.length - 1]; if (last?.op === op) last.text += text; else out.push({ op, text }) }
  let i = 0, j = 0
  for (const [pi, pj] of [...pairs, [ta.length, tb.length] as [number, number]]) {
    while (i < pi) push('del', ta[i++])
    while (j < pj) push('add', tb[j++])
    if (pi < ta.length) { push('eq', ta[pi]); i = pi + 1; j = pj + 1 }
  }
  return out
}

export function diffBlocks(from: Block[], to: Block[]): BlockChange[] {
  const a = from.slice(0, 500), b = to.slice(0, 500)
  const pairs = lcs(a, b, (x, y) => signature(x) === signature(y))
  const out: BlockChange[] = []
  let i = 0, j = 0
  const flush = (ui: number, uj: number) => {
    const removed = a.slice(i, ui), added = b.slice(j, uj)
    // pair same-type blocks in order as changes; the rest are plain additions / removals
    while (removed.length || added.length) {
      const r = removed[0], ad = added[0]
      if (r && ad && r.type === ad.type) {
        removed.shift(); added.shift()
        const ta = blockText(r), tb = blockText(ad)
        out.push({ op: 'changed', type: r.type, segs: wordDiff(plainText(ta), plainText(tb)), formatOnly: plainText(ta) === plainText(tb) })
      } else if (r && (!ad || removed.length >= added.length)) { removed.shift(); out.push({ op: 'removed', type: r.type, text: plainText(blockText(r)) }) }
      else if (ad) { added.shift(); out.push({ op: 'added', type: ad.type, text: plainText(blockText(ad)) }) }
    }
    i = ui; j = uj
  }
  for (const [pi, pj] of pairs) { flush(pi, pj); out.push({ op: 'same', type: a[pi].type, text: plainText(blockText(a[pi])) }); i = pi + 1; j = pj + 1 }
  flush(a.length, b.length)
  return out
}

export function diffPage(from: PageSettings, to: PageSettings): { key: string; from: string; to: string }[] {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort() as (keyof PageSettings)[]
  return keys.filter((k) => from[k] !== to[k]).map((k) => ({ key: k, from: String(from[k] ?? '—'), to: String(to[k] ?? '—') }))
}

export const summary = (changes: BlockChange[]) => ({
  added: changes.filter((c) => c.op === 'added').length, removed: changes.filter((c) => c.op === 'removed').length,
  changed: changes.filter((c) => c.op === 'changed').length, same: changes.filter((c) => c.op === 'same').length,
})

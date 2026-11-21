/**
 * Assistant edits of Studio drafts (S5, proposal 'studio_edit' of 0041): the
 * operations, their safety rules (no typed amounts, data blocks untouched,
 * valid content) and the tools that read a document and propose edits.
 */
import { describe, expect, it } from 'vitest'
import { applyEdits, describeEdits, EditOps, type EditOp } from '@/lib/studio/edit-ops'
import { findTool, strictSchema, TOOLS, PERMISSION_KEYS, type Access, type ToolContext } from '@/lib/assistant/tools'
import { FactStore } from '@/lib/intelligence/facts'
import { parseRuns } from '@/lib/studio/layout'
import type { DocContent } from '@/lib/studio/model'

const doc: DocContent = { v: 1, blocks: [{ type: 'heading', level: 1, text: 'Carta' }, { type: 'paragraph', text: 'Le recordamos el saldo pendiente.' }, { type: 'items' },
  { type: 'table', header: true, rows: [['Código', 'Artículo']] }] }
const run = (ops: EditOp[]) => applyEdits(doc, {}, ops)

describe('edit operations', () => {
  it('add, insert, rewrite, format words, tables and the page typeface', () => {
    const r = run([{ op: 'append_paragraph', text: 'Gracias.' }, { op: 'insert_paragraph', after_block: 0, text: 'Estimado cliente:' },
      { op: 'format_words', block: 2, words: 'saldo pendiente', style: { color: '#C0392B', bold: true, underline: true } },
      { op: 'append_table_rows', block: 4, rows: [['MAT-1', 'Cemento']] }, { op: 'set_page_font', font: 'lora' }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'items', 'table', 'paragraph'])
    const p = r.content.blocks[2] as { text: string }
    expect(p.text).toBe('Le recordamos el {c=#C0392B;u|**saldo pendiente**}.')
    expect(parseRuns(p.text).find((x) => x.text === 'saldo pendiente')).toMatchObject({ bold: true, color: '#C0392B', underline: true })
    expect((r.content.blocks[4] as { rows: string[][] }).rows).toEqual([['Código', 'Artículo'], ['MAT-1', 'Cemento']])
    expect(r.page.font).toBe('lora')
    expect(doc.blocks).toHaveLength(4)                                      // the original is never mutated
  })
  it('refuses typed amounts (figures go in as merge fields)', () => {
    expect(run([{ op: 'append_paragraph', text: 'Su saldo es $1,000.00' }])).toMatchObject({ ok: false, error: 'amounts_in_text' })
    expect(run([{ op: 'append_paragraph', text: 'Su saldo es {{document.balance}}' }]).ok).toBe(true)
  })
  it('never edits data blocks; unknown blocks or words are refused', () => {
    expect(run([{ op: 'replace_text', block: 3, text: 'x' }])).toMatchObject({ ok: false, error: 'block_not_editable' })
    expect(run([{ op: 'replace_text', block: 9, text: 'x' }])).toMatchObject({ ok: false, error: 'block_not_editable' })
    expect(run([{ op: 'format_words', block: 1, words: 'no existe', style: { underline: true } }])).toMatchObject({ ok: false, error: 'words_not_found' })
    expect(run([{ op: 'format_words', block: 1, words: 'saldo', style: {} }])).toMatchObject({ ok: false, error: 'no_style' })
    // words already formatted are still found (markup ignored) and the styles merge
    const twice = run([{ op: 'format_words', block: 1, words: 'saldo pendiente', style: { underline: true } }, { op: 'format_words', block: 1, words: 'saldo pendiente', style: { color: '#C0392B' } }])
    expect(twice.ok && (twice.content.blocks[1] as { text: string }).text).toBe('Le recordamos el {c=#C0392B;u|saldo pendiente}.')
  })
  it('the schema bounds the operations (max ten, strict objects, known typefaces)', () => {
    expect(EditOps.safeParse(Array(11).fill({ op: 'append_paragraph', text: 'x' })).success).toBe(false)
    expect(EditOps.safeParse([{ op: 'append_paragraph', text: 'x', extra: 1 }]).success).toBe(false)
    expect(EditOps.safeParse([{ op: 'set_page_font', font: 'comic' }]).success).toBe(false)
    expect(EditOps.safeParse([{ op: 'delete_block', block: 1 }]).success).toBe(false)
  })
  it('a readable summary for the confirmation card', () => {
    expect(describeEdits([{ op: 'append_paragraph', text: 'x' }, { op: 'set_page_font', font: 'lora' }], 'es')).toBe('añadir un párrafo al final; cambiar la tipografía a lora')
  })
})

describe('the tools', () => {
  const allPerms = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Access['perms']
  const OWNER: Access = { perms: allPerms, workforce: { manages: true, supervisedDepartments: [] }, features: { employees: true, timeClock: true } }
  const ID = '7d6c2b1a-1111-4222-8333-444455556666'
  function fake(row: unknown, propose: { data: unknown; error: { message: string } | null } = { data: 'act-1', error: null }) {
    const calls: { name: string; args: unknown }[] = []
    const chain: unknown = new Proxy({}, { get: (_, p) => (p === 'maybeSingle' ? () => Promise.resolve({ data: row, error: null }) : () => chain) })
    return { calls, client: { from: () => chain, rpc: (name: string, args: unknown) => { calls.push({ name, args }); return Promise.resolve(propose) } } }
  }
  const ctx = (supabase: unknown): ToolContext => ({ supabase: supabase as ToolContext['supabase'], companyId: 'c', userId: 'u', locale: 'es', today: '2026-11-15', turnId: 't', access: OWNER, currency: 'USD', facts: new FactStore() })
  const call = (name: string, c: ToolContext, input: unknown) => (findTool(name)!.run as unknown as (c: ToolContext, i: unknown) => Promise<{ data: Record<string, unknown> }>)(c, input)
  it('read_studio_document numbers the blocks and strips formatting', async () => {
    const r = await call('read_studio_document', ctx(fake({ id: ID, kind: 'letter', title: 'Carta', status: 'draft', version: 3, content: { blocks: [{ type: 'paragraph', text: 'Hola {c=#C0392B|mundo}' }] }, page: {} }).client), { document_id: ID })
    expect(r.data).toMatchObject({ editable: true, version: 3, blocks: [{ number: 0, type: 'paragraph', text: 'Hola mundo' }] })
  })
  it('propose_studio_edit: only drafts, checked now, proposed with the version', async () => {
    const draft = { id: ID, title: 'Carta', status: 'draft', version: 3, content: doc, page: {} }
    await expect(call('propose_studio_edit', ctx(fake({ ...draft, status: 'final' }).client), { document_id: ID, ops: [{ op: 'append_paragraph', text: 'x' }] })).rejects.toThrow('document_not_a_draft')
    await expect(call('propose_studio_edit', ctx(fake(draft).client), { document_id: ID, ops: [{ op: 'append_paragraph', text: 'Pague $50' }] })).rejects.toThrow('amounts_in_text')
    const f = fake(draft)
    const r = await call('propose_studio_edit', ctx(f.client), { document_id: ID, ops: [{ op: 'append_paragraph', text: 'Gracias.' }] })
    expect(r.data).toMatchObject({ action_id: 'act-1', status: 'awaiting_user_confirmation', on_version: 3 })
    expect(f.calls[0]).toMatchObject({ name: 'assistant_propose', args: { act_kind: 'studio_edit', act_payload: { document_id: ID, version: 3, ops: [{ op: 'append_paragraph', text: 'Gracias.' }] } } })
  })
  it('no tool schema uses keywords strict tool use does not support (oneOf, numeric / length limits)', () => {
    for (const t of TOOLS) expect(JSON.stringify(strictSchema(t.schema))).not.toMatch(/"(oneOf|minimum|maximum|minLength|maxLength|minItems|maxItems|pattern)"/)
  })
})

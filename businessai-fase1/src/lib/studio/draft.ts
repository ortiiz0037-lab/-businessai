/**
 * Creates a Document Studio DRAFT on behalf of an assistant (origin =
 * 'assistant', logged by the database as drafted_by_assistant). Shared by the
 * Studio "assistant" form and by confirmed BusinessAI Assistant actions, so
 * both follow the same contract (src/lib/studio/assistant.ts):
 *   1) an empty draft bound to the records the user chose — the database
 *      checks that the user may read them and that they belong to the company;
 *   2) the draft is filled from the system template, the user's / assistant's
 *      text and the live data (studio_data), never with invented values;
 *   3) assertDraftIsSafe before it is saved. Nothing is issued or sent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Locale } from '@/lib/i18n/app'
import { studioErrorCode, type DocContent, type Kind } from '@/lib/studio/model'
import { systemTemplate } from '@/lib/studio/templates'
import { loadData, loadDoc } from '@/lib/studio/server'
import { assertDraftIsSafe, ruleAssistant } from '@/lib/studio/assistant'

export type DraftRefs = { client: string | null; source_document: string | null; employee: string | null; vendor: string | null }
export type DraftResult = { ok: true; id: string; missing: string[] } | { ok: false; error: string; id?: string }

export async function createAssistantDraft(supabase: SupabaseClient, companyId: string, input: {
  instruction: string; kind?: Kind; title?: string; refs: DraftRefs; locale: Locale; today: string
}): Promise<DraftResult> {
  const instruction = input.instruction.slice(0, 4000)
  const placeholder: DocContent = { v: 1, blocks: [{ type: 'paragraph', text: '' }] }
  const first = await ruleAssistant.draft({ instruction, kind: input.kind, locale: input.locale }, {})
  const { data, error } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: null, doc_kind: first.kind, doc_title: (input.title || first.title).slice(0, 160), doc_folder: null, doc_content: placeholder, doc_page: {},
    ...input.refs, template: null, base: first.templateKey, expected_version: null, doc_origin: 'assistant',
  })
  const row = ((data ?? []) as { id: string; version: number }[])[0]
  if (error || !row) return { ok: false, error: studioErrorCode(error) }
  const doc = await loadDoc(supabase, companyId, row.id)
  const { data: d } = await loadData(supabase, doc!, input.today)
  const draft = await ruleAssistant.draft({ instruction, kind: first.kind, locale: input.locale }, d)
  const safe = assertDraftIsSafe(draft)
  if (!safe.ok) return { ok: false, id: row.id, error: safe.error === 'amounts_in_text' ? 'assistant_amounts' : 'studio_content_invalid' }
  const page = systemTemplate(draft.templateKey, input.locale)?.page ?? {}
  const { error: e2 } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: row.id, doc_kind: draft.kind, doc_title: (input.title || draft.title).slice(0, 160), doc_folder: null, doc_content: draft.content, doc_page: page,
    ...input.refs, template: null, base: draft.templateKey, expected_version: row.version, doc_origin: 'assistant',
  })
  if (e2) return { ok: false, id: row.id, error: studioErrorCode(e2) }
  return { ok: true, id: row.id, missing: draft.missing }
}

/**
 * BusinessAI Assistant ↔ Document Studio contract.
 *
 * An assistant turns a user instruction into a DRAFT. It may read only the
 * data the user is already allowed to see (the same `studio_data` the editor
 * uses, which checks clients.view / documents.view / workforce.manage /
 * payables.view), and it may only:
 *   - choose a template and fill text and merge fields;
 *   - leave a "[falta: …]" marker where data is missing (never invent it);
 *   - create a draft (origin = 'assistant', logged as drafted_by_assistant).
 * It can never issue, send, archive or change an issued document: those
 * actions require the user to confirm them in the editor (studio_finalize
 * needs an explicit confirmation; e-mail is only prepared, never sent).
 *
 * No language model is wired yet (no provider key is stored or needed).
 * `ruleAssistant` is a deterministic implementation of the contract used
 * today and by the tests; a model-backed assistant must implement the same
 * interface and pass the same checks (assertDraftIsSafe).
 */
import type { Locale } from '@/lib/i18n/app'
import { KINDS, parseContent, type DocContent, type Kind } from '@/lib/studio/model'
import { missingFields, type StudioData } from '@/lib/studio/merge'
import { systemTemplates } from '@/lib/studio/templates'

export type AssistantRequest = { instruction: string; kind?: Kind; locale: Locale }
export type AssistantDraft = { kind: Kind; title: string; content: DocContent; templateKey: string; missing: string[]; notes: string[] }
export interface DocumentAssistant { draft(req: AssistantRequest, data: StudioData): Promise<AssistantDraft> }

const KEYWORDS: [Kind, RegExp][] = [
  ['invoice', /\b(factura|invoice)\b/i], ['quote', /\b(cotizaci[oó]n|presupuesto para cliente|quote|estimate)\b/i], ['receipt', /\b(recibo|receipt)\b/i],
  ['work_order', /\b(orden de trabajo|work order)\b/i], ['purchase_order', /\b(orden de compra|purchase order|pedido)\b/i], ['contract', /\b(contrato|contract|agreement)\b/i],
  ['account_statement', /\b(estado de cuenta|account statement|statement)\b/i], ['certificate', /\b(certificado|certificate|constancia)\b/i],
  ['report', /\b(informe|reporte|report)\b/i], ['letter', /\b(carta|letter)\b/i],
]
/** The kind named first in the instruction ("carta … del contrato" is a letter). */
export function guessKind(instruction: string): Kind | null {
  let best: { kind: Kind; at: number } | null = null
  for (const [k, re] of KEYWORDS) { const m = re.exec(instruction); if (m && (!best || m.index < best.at)) best = { kind: k, at: m.index } }
  return best?.kind ?? null
}

/** Deterministic assistant: picks the template for the kind and keeps the user's words as the body. */
export const ruleAssistant: DocumentAssistant = {
  async draft(req, data) {
    const es = req.locale !== 'en'
    const kind = req.kind ?? guessKind(req.instruction) ?? 'letter'
    const tpl = systemTemplates(req.locale).find((t) => t.kind === kind)!
    const instruction = req.instruction.replace(/[<>]/g, '').trim().slice(0, 4000)
    const blocks = tpl.content.blocks.map((b) => ({ ...b }))
    // the user's own words go into the first empty paragraph (or after the title); nothing is made up
    const i = blocks.findIndex((b) => b.type === 'paragraph' && (b.text === '' || /^Escriba aquí|^Write /.test(b.text)))
    const note = { type: 'paragraph' as const, text: instruction, align: 'justify' as const }
    if (instruction) { if (i >= 0) blocks[i] = note; else blocks.splice(1, 0, note) }
    const content = { v: 1 as const, blocks }
    const notes = [es ? 'Borrador creado a partir de su instrucción y de la plantilla del sistema. Revíselo antes de emitirlo.' : 'Draft created from your instruction and the system template. Review it before issuing.']
    return { kind, title: `${tpl.name}${data.client?.name ? ` · ${data.client.name}` : ''}`.slice(0, 160), content, templateKey: tpl.key, missing: missingFields(blocks, data, req.locale), notes }
  },
}

/** What every assistant draft must satisfy before it is saved. */
export function assertDraftIsSafe(d: AssistantDraft): { ok: true } | { ok: false; error: string } {
  if (!(KINDS as readonly string[]).includes(d.kind)) return { ok: false, error: 'kind' }
  const parsed = parseContent(d.content)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  // an assistant may not write amounts into documents that take them from the business document
  if (['invoice', 'quote', 'receipt', 'account_statement'].includes(d.kind)) {
    const text = JSON.stringify(parsed.content.blocks.filter((b) => b.type === 'paragraph' || b.type === 'table' || b.type === 'fields'))
    if (/[$€]\s?\d|\d[\d,.]*\s?(USD|EUR|dólares|dollars)/i.test(text)) return { ok: false, error: 'amounts_in_text' }
  }
  return { ok: true }
}

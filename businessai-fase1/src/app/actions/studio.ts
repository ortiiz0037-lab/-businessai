'use server'
/**
 * Document Studio actions (migration 0028). Every write runs with the user's
 * session through a 0028 function: PostgreSQL checks roles, references,
 * versions (conflicts), immutability of issued documents and the audit trail.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import { KINDS, parseContent, parsePage, studioErrorCode, type DocContent, type Kind, type PageSettings } from '@/lib/studio/model'
import { systemTemplate } from '@/lib/studio/templates'
import { missingFields } from '@/lib/studio/merge'
import { loadData, loadDoc } from '@/lib/studio/server'
import { assertDraftIsSafe, ruleAssistant } from '@/lib/studio/assistant'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const uuidOrNull = (f: FormData, k: string) => { const v = text(f, k); return UUID.test(v) ? v : null }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

function backTo(f: FormData, fallback: string): string {
  const v = text(f, 'back')
  return /^\/studio(\/[\w\-/]*)?(\?[\w=&%\-.]*)?$/.test(v) ? v : fallback
}
function go(path: string, params: Record<string, string>): never {
  const [base, q = ''] = path.split('?')
  const sp = new URLSearchParams(q)
  for (const k of ['done', 'error', 'missing']) sp.delete(k)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${base}?${sp.toString()}`)
}
async function company() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const m = await getActiveMembership(supabase, user.id)
  if (!m) redirect('/onboarding')
  return { supabase, companyId: m.companyId }
}
const refresh = () => revalidatePath('/studio', 'layout')

async function templateContent(supabase: Awaited<ReturnType<typeof createClient>>, companyId: string, ref: string): Promise<{ content: DocContent; page: PageSettings; kind: Kind; templateId: string | null; base: string | null; name: string } | null> {
  const locale = await getLocale()
  if (ref.startsWith('sys:')) {
    const t = systemTemplate(ref.slice(4), locale)
    return t ? { content: t.content, page: t.page, kind: t.kind, templateId: null, base: t.key, name: t.name } : null
  }
  if (ref.startsWith('tpl:') && UUID.test(ref.slice(4))) {
    const { data } = await supabase.from('studio_templates').select('id, kind, name, base_key, content, page').eq('id', ref.slice(4)).eq('company_id', companyId).eq('status', 'active').maybeSingle()
    const t = data as { id: string; kind: Kind; name: string; base_key: string | null; content: unknown; page: unknown } | null
    const parsed = t ? parseContent(t.content) : null
    return t && parsed?.ok ? { content: parsed.content, page: parsePage(t.page), kind: t.kind, templateId: t.id, base: t.base_key, name: t.name } : null
  }
  return null
}

// ------------------------------------------------------------- documents
export async function createDocument(formData: FormData) {
  const back = backTo(formData, '/studio/new')
  const { supabase, companyId } = await company()
  const tpl = await templateContent(supabase, companyId, text(formData, 'template'))
  if (!tpl) go(back, { error: 'invalid' })
  const title = (text(formData, 'title') || tpl.name).slice(0, 160)
  const { data, error } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: null, doc_kind: tpl.kind, doc_title: title, doc_folder: text(formData, 'folder').slice(0, 60) || null, doc_content: tpl.content, doc_page: tpl.page,
    client: uuidOrNull(formData, 'client_id'), source_document: uuidOrNull(formData, 'source_document_id'), employee: uuidOrNull(formData, 'employee_id'), vendor: uuidOrNull(formData, 'vendor_id'),
    template: tpl.templateId, base: tpl.base, expected_version: null, doc_origin: 'user',
  })
  const row = ((data ?? []) as { id: string }[])[0]
  if (error || !row) go(back, { error: studioErrorCode(error) })
  refresh()
  go(`/studio/${row.id}`, { done: 'created' })
}

export type SaveState = { ok: boolean; version?: number; error?: string; at?: string }
/** Called by the editor (useActionState): saves without leaving the page. */
export async function saveDocumentState(_: SaveState, formData: FormData): Promise<SaveState> {
  const id = text(formData, 'id')
  const expected = Number(text(formData, 'version'))
  let content: unknown, page: unknown
  try { content = JSON.parse(text(formData, 'content')); page = JSON.parse(text(formData, 'page') || '{}') } catch { return { ok: false, error: 'studio_content_invalid' } }
  const parsed = parseContent(content)
  const title = text(formData, 'title').slice(0, 160)
  if (!UUID.test(id) || !Number.isInteger(expected) || !parsed.ok || !title) return { ok: false, error: parsed.ok ? 'invalid' : 'studio_content_invalid' }
  const { supabase, companyId } = await company()
  const doc = await loadDoc(supabase, companyId, id)
  if (!doc) return { ok: false, error: 'studio_not_found' }
  const { data, error } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: id, doc_kind: doc.kind, doc_title: title, doc_folder: text(formData, 'folder').slice(0, 60) || null, doc_content: parsed.content, doc_page: parsePage(page),
    client: doc.client_id, source_document: doc.source_document_id, employee: doc.employee_id, vendor: doc.vendor_id, template: doc.template_id, base: doc.base_key,
    expected_version: expected, doc_origin: doc.origin,
  })
  if (error) return { ok: false, error: studioErrorCode(error) }
  refresh()
  return { ok: true, version: ((data ?? []) as { version: number }[])[0]?.version, at: new Date().toISOString() }
}

/** Changes which client / business document / employee / vendor the document is built on (keeps the content). */
export async function saveBindings(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const doc = await loadDoc(supabase, companyId, id)
  if (!doc) go(back, { error: 'studio_not_found' })
  const { error } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: id, doc_kind: doc.kind, doc_title: doc.title, doc_folder: doc.folder, doc_content: doc.content, doc_page: doc.page,
    client: uuidOrNull(formData, 'client_id'), source_document: uuidOrNull(formData, 'source_document_id'), employee: uuidOrNull(formData, 'employee_id'), vendor: uuidOrNull(formData, 'vendor_id'),
    template: doc.template_id, base: doc.base_key, expected_version: Number(text(formData, 'version')), doc_origin: doc.origin,
  })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'bindings' })
}

/** Issue: refuses missing data, needs an explicit confirmation; the database freezes the data and assigns the number. */
export async function finalizeDocument(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  if (text(formData, 'confirm') !== 'yes') go(back, { error: 'confirm_required' })
  const { supabase, companyId } = await company()
  const locale = await getLocale()
  const doc = await loadDoc(supabase, companyId, id)
  if (!doc) go(back, { error: 'studio_not_found' })
  const { data, error: dataError } = await loadData(supabase, doc, today())
  if (dataError) go(back, { error: studioErrorCode({ message: dataError }) })
  const missing = missingFields(doc.content.blocks, data, locale)
  if (missing.length) go(back, { error: 'missing_data', missing: missing.slice(0, 12).join(',') })
  const { error } = await supabase.rpc('studio_finalize', { doc: id, expected_version: Number(text(formData, 'version')), items: data.items ?? [] })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'finalized' })
}

export async function duplicateDocument(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { data, error } = await supabase.rpc('studio_duplicate', { doc: id, new_title: text(formData, 'title') || null })
  if (error || typeof data !== 'string') go(back, { error: studioErrorCode(error) })
  refresh()
  go(`/studio/${data}`, { done: 'duplicated' })
}

export async function archiveDocument(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('studio_archive', { doc: id, reason: text(formData, 'reason').slice(0, 300) })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'archived' })
}

export async function restoreVersion(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  const v = Number(text(formData, 'from_version')), expected = Number(text(formData, 'version'))
  if (!UUID.test(id) || !Number.isInteger(v) || !Number.isInteger(expected)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('studio_restore_version', { doc: id, from_version: v, expected_version: expected })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'restored' })
}

/** E-mail is PREPARED (recipient, subject, text, PDF link), never sent from here; the preparation is logged. */
export async function prepareEmail(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, `/studio/${id}`)
  const to = text(formData, 'to').slice(0, 200)
  if (!UUID.test(id) || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('studio_record', { doc: id, act: 'email_prepared', info: { to } })
  if (error) go(back, { error: studioErrorCode(error) })
  go(back, { done: 'email', to })
}

// ------------------------------------------------------------- assistant
export async function assistantDraft(formData: FormData) {
  const back = backTo(formData, '/studio/new')
  const instruction = text(formData, 'instruction').slice(0, 4000)
  const kindRaw = text(formData, 'kind')
  const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : undefined
  if (instruction.length < 5) go(back, { error: 'invalid' })
  const { supabase, companyId } = await company()
  const locale = await getLocale()
  const placeholder: DocContent = { v: 1, blocks: [{ type: 'paragraph', text: '' }] }
  const refs = { client: uuidOrNull(formData, 'client_id'), source_document: uuidOrNull(formData, 'source_document_id'), employee: uuidOrNull(formData, 'employee_id'), vendor: uuidOrNull(formData, 'vendor_id') }
  // 1) a draft bound to the records the user chose (so the database checks access), 2) the assistant fills it from studio_data
  const first = await ruleAssistant.draft({ instruction, kind, locale }, {})
  const { data, error } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: null, doc_kind: first.kind, doc_title: first.title, doc_folder: null, doc_content: placeholder, doc_page: {}, ...refs,
    template: null, base: first.templateKey, expected_version: null, doc_origin: 'assistant',
  })
  const row = ((data ?? []) as { id: string; version: number }[])[0]
  if (error || !row) go(back, { error: studioErrorCode(error) })
  const doc = await loadDoc(supabase, companyId, row.id)
  const { data: d } = await loadData(supabase, doc!, today())
  const draft = await ruleAssistant.draft({ instruction, kind: first.kind, locale }, d)
  const safe = assertDraftIsSafe(draft)
  if (!safe.ok) { refresh(); go(`/studio/${row.id}`, { error: safe.error === 'amounts_in_text' ? 'assistant_amounts' : 'studio_content_invalid' }) }
  const page = systemTemplate(draft.templateKey, locale)?.page ?? {}
  const { error: e2 } = await supabase.rpc('studio_save_document', {
    target: companyId, doc: row.id, doc_kind: draft.kind, doc_title: draft.title, doc_folder: null, doc_content: draft.content, doc_page: page, ...refs,
    template: null, base: draft.templateKey, expected_version: row.version, doc_origin: 'assistant',
  })
  refresh()
  if (e2) go(`/studio/${row.id}`, { error: studioErrorCode(e2) })
  go(`/studio/${row.id}`, { done: 'assistant', ...(draft.missing.length ? { missing: draft.missing.slice(0, 12).join(',') } : {}) })
}

// ------------------------------------------------------------- templates and brand
export async function customizeTemplate(formData: FormData) {
  const back = backTo(formData, '/studio/templates')
  const { supabase, companyId } = await company()
  const tpl = await templateContent(supabase, companyId, text(formData, 'template'))
  if (!tpl) go(back, { error: 'invalid' })
  const locale = await getLocale()
  const name = (text(formData, 'name') || `${tpl.name} (${locale === 'en' ? 'company' : 'empresa'})`).slice(0, 120)
  const { data, error } = await supabase.rpc('studio_save_template', { target: companyId, template: null, t_kind: tpl.kind, t_name: name, t_description: null, t_base: tpl.base, t_content: tpl.content, t_page: tpl.page })
  if (error || typeof data !== 'string') go(back, { error: studioErrorCode(error) })
  refresh()
  go(`/studio/templates/${data}`, { done: 'template_created' })
}

export async function saveTemplateState(_: SaveState, formData: FormData): Promise<SaveState> {
  const id = text(formData, 'id')
  let content: unknown, page: unknown
  try { content = JSON.parse(text(formData, 'content')); page = JSON.parse(text(formData, 'page') || '{}') } catch { return { ok: false, error: 'studio_content_invalid' } }
  const parsed = parseContent(content)
  const name = text(formData, 'title').slice(0, 120)
  if (!UUID.test(id) || !parsed.ok || !name) return { ok: false, error: parsed.ok ? 'invalid' : 'studio_content_invalid' }
  const { supabase, companyId } = await company()
  const { data: t } = await supabase.from('studio_templates').select('kind, description, base_key').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (!t) return { ok: false, error: 'studio_not_found' }
  const row = t as { kind: Kind; description: string | null; base_key: string | null }
  const { error } = await supabase.rpc('studio_save_template', { target: companyId, template: id, t_kind: row.kind, t_name: name, t_description: row.description, t_base: row.base_key, t_content: parsed.content, t_page: parsePage(page) })
  if (error) return { ok: false, error: studioErrorCode(error) }
  refresh()
  return { ok: true, at: new Date().toISOString() }
}

export async function archiveTemplate(formData: FormData) {
  const id = text(formData, 'id')
  const back = backTo(formData, '/studio/templates')
  if (!UUID.test(id)) go(back, { error: 'invalid' })
  const { supabase } = await company()
  const { error } = await supabase.rpc('studio_archive_template', { template: id })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'template_archived' })
}

const HEX = /^#[0-9A-Fa-f]{6}$/
export async function saveBrand(formData: FormData) {
  const back = backTo(formData, '/studio/brand')
  const color = (k: string) => { const v = text(formData, k); return v && HEX.test(v) ? v : null }
  const fonts = (k: string) => (text(formData, k) === 'serif' ? 'serif' : 'sans')
  const formats: Record<string, string> = {}
  // letters, digits, separators and the {YYYY} {YY} {####} tokens; {####} is required
  for (const k of KINDS) { const v = text(formData, `format_${k}`).slice(0, 30); if (v) { if (!/^([A-Za-z0-9 ._/-]|\{YYYY\}|\{YY\}|\{####\})+$/.test(v) || !v.includes('{####}')) go(back, { error: 'number_format' }); formats[k] = v } }
  const stamp = uuidOrNull(formData, 'stamp_asset_id')
  const opacity = Number(text(formData, 'watermark_opacity') || 8)
  const settings = {
    heading_font: fonts('heading_font'), body_font: fonts('body_font'), accent_color: color('accent_color'), text_color: color('text_color') ?? '#111827',
    header_text: text(formData, 'header_text').slice(0, 300), footer_text: text(formData, 'footer_text').slice(0, 300),
    show_logo: formData.get('show_logo') === 'on', show_page_numbers: formData.get('show_page_numbers') === 'on',
    watermark_text: text(formData, 'watermark_text').slice(0, 40), watermark_opacity: Number.isInteger(opacity) ? Math.min(30, Math.max(3, opacity)) : 8,
    stamp_asset_id: stamp, signature_name: text(formData, 'signature_name').slice(0, 120), signature_title: text(formData, 'signature_title').slice(0, 120),
    page: parsePage({ size: text(formData, 'size'), font: fonts('body_font'), fontSize: text(formData, 'fontSize'), marginTop: text(formData, 'margin'), marginRight: text(formData, 'margin'), marginBottom: text(formData, 'margin'), marginLeft: text(formData, 'margin') }),
    number_formats: formats,
  }
  const { supabase, companyId } = await company()
  const { error } = await supabase.rpc('studio_save_brand', { target: companyId, settings })
  if (error) go(back, { error: studioErrorCode(error) })
  refresh()
  go(back, { done: 'brand_saved' })
}

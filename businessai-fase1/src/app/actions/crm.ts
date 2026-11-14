'use server'
/**
 * CRM actions (0035). Every write is a database function that checks the
 * permission in the record's company, validates and audits; the app only
 * parses the form and sends the user back with ?done= or ?error=.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { parseCents } from '@/lib/finance/money'
import { crmErrorCode, parseProbability, prDateTime, ACTIVITY_KINDS, TAG_COLORS } from '@/lib/crm/core'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const s = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const uuidOrNull = (fd: FormData, k: string) => (UUID.test(s(fd, k)) ? s(fd, k) : null)
const int = (fd: FormData, k: string) => { const n = Number.parseInt(s(fd, k), 10); return Number.isFinite(n) ? n : null }

/** Only internal CRM / clients / documents paths are accepted as the page to return to. */
function backTo(fd: FormData, fallback: string): string {
  const b = s(fd, 'back')
  return /^\/(crm|clients|documents)(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/.test(b) ? b : fallback
}
function go(base: string, params: Record<string, string>): never {
  const [path, query] = base.split('?')
  const sp = new URLSearchParams(query ?? '')
  sp.delete('done'); sp.delete('error')
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  redirect(`${path}?${sp.toString()}`)
}

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/crm')
  const member = await getActiveMembership(supabase, user.id)
  if (!member) redirect('/onboarding')
  return { supabase, user, companyId: member.companyId }
}
function refresh(...paths: string[]) {
  for (const p of ['/crm', '/crm/pipeline', '/crm/opportunities', '/crm/activities', ...paths]) revalidatePath(p)
}

// ------------------------------------------------------------- opportunities
export async function saveOpportunity(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const id = uuidOrNull(fd, 'id')
  const back = backTo(fd, id ? `/crm/opportunities/${id}` : '/crm/opportunities')
  const client = uuidOrNull(fd, 'client_id')
  const name = s(fd, 'name')
  if (!client || name.length < 1 || name.length > 160) go(back, { error: 'required' })
  const amount = parseCents(s(fd, 'amount') || '0')
  if (amount === null || amount < 0n) go(back, { error: 'crm_amount_invalid' })
  const prob = parseProbability(s(fd, 'probability'))
  if (prob === 'invalid') go(back, { error: 'crm_probability_invalid' })
  const close = s(fd, 'expected_close')
  const idem = UUID.test(s(fd, 'idem')) ? s(fd, 'idem') : randomUUID()
  const { data, error } = await supabase.rpc('crm_save_opportunity', {
    target: companyId, opp: id, client, contact: uuidOrNull(fd, 'contact_id'), p_name: name, p_description: s(fd, 'description').slice(0, 4000) || null,
    p_amount_cents: Number(amount), p_probability_bp: prob, p_expected_close: DAY.test(close) ? close : null, owner: uuidOrNull(fd, 'owner_id'),
    p_source: s(fd, 'source').slice(0, 80) || null, branch: uuidOrNull(fd, 'branch_id'), stage: uuidOrNull(fd, 'stage_id'),
    expected_version: id ? int(fd, 'version') : null, idem: id ? null : idem,
  })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(`/clients/${client}`)
  redirect(`/crm/opportunities/${data as string}?done=${id ? 'saved' : 'created'}`)
}

export async function moveOpportunity(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id'); const stage = uuidOrNull(fd, 'stage_id')
  const back = backTo(fd, id ? `/crm/opportunities/${id}` : '/crm/pipeline')
  if (!id || !stage) go(back, { error: 'required' })
  const { error } = await supabase.rpc('crm_move_opportunity', { opp: id, stage, expected_version: int(fd, 'version'), reason: s(fd, 'reason').slice(0, 300) || null })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(`/crm/opportunities/${id}`)
  go(back, { done: 'moved' })
}

export async function archiveOpportunity(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id')
  const back = backTo(fd, id ? `/crm/opportunities/${id}` : '/crm/opportunities')
  if (!id) go(back, { error: 'required' })
  const archived = s(fd, 'archived') === 'yes'
  const { error } = await supabase.rpc('crm_set_opportunity_archived', { opp: id, archived, expected_version: int(fd, 'version') })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(`/crm/opportunities/${id}`)
  go(back, { done: archived ? 'archived' : 'restored' })
}

export async function linkDocument(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id'); const doc = uuidOrNull(fd, 'document_id')
  const back = backTo(fd, id ? `/crm/opportunities/${id}` : '/crm/opportunities')
  if (!id || !doc) go(back, { error: 'required' })
  const linked = s(fd, 'linked') !== 'no'
  const { error } = await supabase.rpc('crm_link_document', { opp: id, doc, linked })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(`/crm/opportunities/${id}`)
  go(back, { done: linked ? 'linked' : 'unlinked' })
}

/** Accepted quote → draft invoice (0035 crm_convert_quote). Opens the new invoice. */
export async function convertQuote(fd: FormData) {
  const { supabase } = await ctx()
  const quote = uuidOrNull(fd, 'quote_id')
  const back = backTo(fd, quote ? `/documents/${quote}` : '/documents')
  if (!quote) go(back, { error: 'required' })
  const due = s(fd, 'due_date')
  if (!DAY.test(due)) go(back, { error: 'crm_due_date_invalid' })
  const idem = UUID.test(s(fd, 'idem')) ? s(fd, 'idem') : randomUUID()
  const { data, error } = await supabase.rpc('crm_convert_quote', { quote, opp: uuidOrNull(fd, 'opportunity_id'), due, idem })
  if (error) go(back, { error: crmErrorCode(error) })
  revalidatePath('/documents'); revalidatePath(`/documents/${quote}`); refresh()
  redirect(`/documents/${data as string}?converted=1`)
}

// ------------------------------------------------------------- activities
export async function saveActivity(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const id = uuidOrNull(fd, 'id')
  const back = backTo(fd, '/crm/activities')
  const kind = s(fd, 'kind')
  const subject = s(fd, 'subject')
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind) || subject.length < 1 || subject.length > 160) go(back, { error: 'required' })
  const dueRaw = s(fd, 'due_at')
  const due = prDateTime(dueRaw)
  if (dueRaw && !due) go(back, { error: 'crm_activity_invalid' })
  const direction = s(fd, 'direction')
  const { error } = await supabase.rpc('crm_save_activity', {
    target: companyId, act: id, p_kind: kind, p_subject: subject, p_body: s(fd, 'body').slice(0, 4000) || null,
    p_direction: direction === 'inbound' || direction === 'outbound' ? direction : null,
    client: uuidOrNull(fd, 'client_id'), contact: uuidOrNull(fd, 'contact_id'), opp: uuidOrNull(fd, 'opportunity_id'), p_due_at: due,
    assignee: uuidOrNull(fd, 'assigned_to'), expected_version: id ? int(fd, 'version') : null,
    idem: id ? null : (UUID.test(s(fd, 'idem')) ? s(fd, 'idem') : randomUUID()), p_origin: 'user',
  })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(back.split('?')[0])
  go(back, { done: id ? 'activity_saved' : 'activity_created' })
}

export async function setActivityStatus(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id')
  const back = backTo(fd, '/crm/activities')
  const status = s(fd, 'status')
  if (!id || !['pending', 'completed', 'cancelled'].includes(status)) go(back, { error: 'required' })
  const { error } = await supabase.rpc('crm_set_activity_status', { act: id, p_status: status, p_outcome: s(fd, 'outcome').slice(0, 1000) || null, expected_version: int(fd, 'version') })
  if (error) go(back, { error: crmErrorCode(error) })
  refresh(back.split('?')[0])
  go(back, { done: `activity_${status}` })
}

// ------------------------------------------------------------- contacts and tags (client profile)
export async function saveContact(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const client = uuidOrNull(fd, 'client_id')
  const back = backTo(fd, client ? `/clients/${client}` : '/clients')
  const first = s(fd, 'first_name')
  if (!client || first.length < 1 || first.length > 80) go(back, { error: 'required' })
  const { error } = await supabase.rpc('crm_save_contact', {
    target: companyId, contact: uuidOrNull(fd, 'id'), client, p_first: first, p_last: s(fd, 'last_name').slice(0, 80), p_title: s(fd, 'title').slice(0, 80),
    p_email: s(fd, 'email').slice(0, 160), p_phone: s(fd, 'phone').slice(0, 40), p_primary: fd.get('is_primary') === 'on', p_notes: s(fd, 'notes').slice(0, 1000),
  })
  if (error) go(back, { error: crmErrorCode(error) })
  revalidatePath(`/clients/${client}`)
  go(back, { done: 'contact_saved' })
}

export async function archiveContact(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id'); const client = uuidOrNull(fd, 'client_id')
  const back = backTo(fd, client ? `/clients/${client}` : '/clients')
  if (!id) go(back, { error: 'required' })
  const archived = s(fd, 'archived') !== 'no'
  const { error } = await supabase.rpc('crm_set_contact_archived', { contact: id, archived })
  if (error) go(back, { error: crmErrorCode(error) })
  if (client) revalidatePath(`/clients/${client}`)
  go(back, { done: archived ? 'contact_archived' : 'contact_restored' })
}

export async function setClientTags(fd: FormData) {
  const { supabase } = await ctx()
  const client = uuidOrNull(fd, 'client_id')
  const back = backTo(fd, client ? `/clients/${client}` : '/clients')
  if (!client) go(back, { error: 'required' })
  const tags = fd.getAll('tag_ids').map(String).filter((t) => UUID.test(t))
  const { error } = await supabase.rpc('crm_set_client_tags', { client, tags })
  if (error) go(back, { error: crmErrorCode(error) })
  revalidatePath(`/clients/${client}`); revalidatePath('/clients')
  go(back, { done: 'tags_saved' })
}

// ------------------------------------------------------------- configuration
export async function saveTag(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const name = s(fd, 'name')
  const color = s(fd, 'color')
  if (name.length < 1 || name.length > 40) go('/crm/settings', { error: 'required' })
  const { error } = await supabase.rpc('crm_save_tag', { target: companyId, tag: uuidOrNull(fd, 'id'), p_name: name,
    p_color: (TAG_COLORS as readonly string[]).includes(color) ? color : 'blue', archived: s(fd, 'archived') === 'yes' })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  revalidatePath('/crm/settings')
  go('/crm/settings', { done: 'tag_saved' })
}

export async function saveStage(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const es = s(fd, 'name_es'); const en = s(fd, 'name_en') || es
  const prob = parseProbability(s(fd, 'probability'))
  if (!es || es.length > 40 || en.length > 40) go('/crm/settings', { error: 'required' })
  if (prob === 'invalid' || prob === null) go('/crm/settings', { error: 'crm_probability_invalid' })
  const { error } = await supabase.rpc('crm_save_stage', { target: companyId, stage: uuidOrNull(fd, 'id'), p_name_es: es, p_name_en: en,
    p_probability_bp: prob, p_position: int(fd, 'position'), p_active: s(fd, 'active') !== 'no' })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  refresh('/crm/settings')
  go('/crm/settings', { done: 'stage_saved' })
}

export async function saveCrmSettings(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const { error } = await supabase.rpc('crm_save_settings', { target: companyId, p_branch_scoping: fd.get('branch_scoping') === 'on', p_share_clients: fd.get('share_clients') === 'on' })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  refresh('/crm/settings', '/clients')
  go('/crm/settings', { done: 'settings_saved' })
}

export async function saveBranch(fd: FormData) {
  const { supabase, companyId } = await ctx()
  const name = s(fd, 'name')
  if (name.length < 1 || name.length > 80) go('/crm/settings', { error: 'required' })
  const { error } = await supabase.rpc('crm_save_branch', { target: companyId, branch: uuidOrNull(fd, 'id'), p_name: name, p_code: s(fd, 'code').toUpperCase(), p_address: s(fd, 'address').slice(0, 240) })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  revalidatePath('/crm/settings')
  go('/crm/settings', { done: 'branch_saved' })
}

export async function archiveBranch(fd: FormData) {
  const { supabase } = await ctx()
  const id = uuidOrNull(fd, 'id')
  if (!id) go('/crm/settings', { error: 'required' })
  const archived = s(fd, 'archived') !== 'no'
  const { error } = await supabase.rpc('crm_set_branch_archived', { branch: id, archived })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  revalidatePath('/crm/settings')
  go('/crm/settings', { done: archived ? 'branch_archived' : 'branch_restored' })
}

export async function setBranchMember(fd: FormData) {
  const { supabase } = await ctx()
  const branch = uuidOrNull(fd, 'branch_id'); const member = uuidOrNull(fd, 'user_id')
  if (!branch || !member) go('/crm/settings', { error: 'required' })
  const assigned = s(fd, 'assigned') !== 'no'
  const { error } = await supabase.rpc('crm_set_branch_member', { branch, member, assigned })
  if (error) go('/crm/settings', { error: crmErrorCode(error) })
  revalidatePath('/crm/settings')
  go('/crm/settings', { done: assigned ? 'member_assigned' : 'member_unassigned' })
}

export async function shareClient(fd: FormData) {
  const { supabase } = await ctx()
  const client = uuidOrNull(fd, 'client_id'); const branch = uuidOrNull(fd, 'branch_id')
  const back = backTo(fd, client ? `/clients/${client}` : '/clients')
  if (!client || !branch) go(back, { error: 'required' })
  const shared = s(fd, 'shared') !== 'no'
  const { error } = await supabase.rpc('crm_share_client', { client, branch, shared })
  if (error) go(back, { error: crmErrorCode(error) })
  revalidatePath(`/clients/${client}`)
  go(back, { done: shared ? 'client_shared' : 'client_unshared' })
}

/**
 * Assistant service (SERVER ONLY): the user's session, limits, conversations,
 * the engine and the audit trail. Every database call runs with the user's
 * session (RLS + 0029 functions); the company is the active membership.
 */
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import type { Locale } from '@/lib/i18n/app'
import { readAssistantConfig, publicAssistantState } from '@/lib/assistant/config'
import { anthropicProvider, ProviderError, type LlmProvider } from '@/lib/assistant/provider'
import { loadAccess, toolsFor, TOOLS, type ToolContext } from '@/lib/assistant/tools'
import { runTurn, type HistoryItem, type TraceEntry } from '@/lib/assistant/engine'
import { screenFromPath, systemPrompt, titleFrom } from '@/lib/assistant/prompt'
import { COPY } from '@/lib/assistant/copy'
import { KINDS, type Kind } from '@/lib/studio/model'
import { createAssistantDraft } from '@/lib/studio/draft'

export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string; tools: TraceEntry[]; status: string; created_at: string }
export type ChatAction = { id: string; kind: string; level: string; summary: string; status: string; result: { link?: string; missing?: string[] } | null; error: string | null; expires_at: string; created_at: string }
export type Conversation = { id: string; title: string; archived_at: string | null; updated_at: string }
export type AssistantStatus = { configured: boolean; reason: string | null; allowed: boolean; limitReason: string | null; used: number; limit: number }
export type SendResult =
  | { ok: true; conversationId: string; messages: ChatMessage[]; actions: ChatAction[] }
  | { ok: false; error: 'not_configured' | 'limit' | 'forbidden' | 'invalid' | 'provider' | 'not_found'; reason?: string; conversationId?: string; messages?: ChatMessage[] }

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

async function session() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return null
  const locale: Locale = await getLocale()
  return { supabase, user, member, locale }
}

/** Is the assistant usable now, and how much of today's quota is left? */
export async function assistantStatus(): Promise<AssistantStatus | null> {
  const s = await session()
  if (!s) return null
  const cfg = publicAssistantState(readAssistantConfig())
  const { data } = await s.supabase.rpc('assistant_status', { target: s.member.companyId })
  const row = ((data ?? []) as { allowed: boolean; reason: string; user_used: number; user_limit: number }[])[0]
  return { configured: cfg.configured, reason: cfg.reason, allowed: row?.allowed ?? false, limitReason: row?.reason ?? 'unavailable', used: row?.user_used ?? 0, limit: row?.user_limit ?? 0 }
}

export async function listConversations(archived = false): Promise<Conversation[]> {
  const s = await session()
  if (!s) return []
  let q = s.supabase.from('assistant_conversations').select('id, title, archived_at, updated_at').eq('company_id', s.member.companyId).eq('user_id', s.user.id)
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  const { data } = await q.order('updated_at', { ascending: false }).limit(100)
  return (data ?? []) as Conversation[]
}

export async function loadConversation(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[]; actions: ChatAction[] } | null> {
  const s = await session()
  if (!s || !z.uuid().safeParse(id).success) return null
  const { data: c } = await s.supabase.from('assistant_conversations').select('id, title, archived_at, updated_at').eq('id', id).eq('company_id', s.member.companyId).maybeSingle()
  if (!c) return null
  const [m, a] = await Promise.all([
    s.supabase.from('assistant_messages').select('id, role, content, tools, status, created_at').eq('conversation_id', id).order('id', { ascending: false }).limit(200),
    s.supabase.from('assistant_actions').select('id, kind, level, summary, status, result, error, expires_at, created_at').eq('conversation_id', id).order('created_at').limit(100),
  ])
  return { conversation: c as Conversation, messages: ((m.data ?? []) as ChatMessage[]).reverse(), actions: (a.data ?? []) as ChatAction[] }
}

const SendInput = z.object({ conversationId: z.uuid().nullable(), text: z.string().trim().min(1).max(4000), screen: z.string().max(200).nullable() })

export async function sendMessage(raw: unknown, provider?: LlmProvider): Promise<SendResult> {
  const parsed = SendInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  const s = await session()
  if (!s) return { ok: false, error: 'forbidden' }
  const { supabase, member, user, locale } = s
  const t = COPY[locale]
  const cfg = readAssistantConfig()
  // without a configured provider nothing is simulated: the user is told and nothing is stored
  if (!cfg.configured && !provider) return { ok: false, error: 'not_configured', reason: cfg.reason }
  const { conversationId: existing, text, screen: screenPath } = parsed.data
  if (existing) {
    const own = await supabase.from('assistant_conversations').select('id').eq('id', existing).eq('company_id', member.companyId).maybeSingle()
    if (!own.data) return { ok: false, error: 'not_found' }
  }
  const { data: quota, error: qe } = await supabase.rpc('assistant_consume', { target: member.companyId })
  const q = ((quota ?? []) as { allowed: boolean; reason: string }[])[0]
  if (qe || !q) return { ok: false, error: 'forbidden' }
  if (!q.allowed) return { ok: false, error: q.reason === 'forbidden' ? 'forbidden' : 'limit', reason: q.reason }

  let conversationId = existing
  if (!conversationId) {
    const { data, error } = await supabase.rpc('assistant_start_conversation', { target: member.companyId, conv_title: titleFrom(text), conv_locale: locale })
    if (error || !data) return { ok: false, error: 'forbidden' }
    conversationId = data as string
  }
  const { data: prior } = await supabase.from('assistant_messages').select('role, content, status').eq('conversation_id', conversationId).order('id', { ascending: false }).limit(20)
  const history: HistoryItem[] = ((prior ?? []) as { role: 'user' | 'assistant'; content: string; status: string }[]).reverse()
    .filter((m) => m.role === 'user' || m.status === 'ok')
  const screen = screenFromPath(screenPath)
  const { error: me } = await supabase.rpc('assistant_add_message', { conv: conversationId, msg_role: 'user', msg_content: text, msg_tools: [], msg_screen: screen?.path ?? null, msg_status: 'ok' })
  if (me) return { ok: false, error: /LOCKED/.test(me.message) ? 'invalid' : 'forbidden', conversationId }

  const [access, settings, company] = await Promise.all([
    loadAccess(supabase, member.companyId, user.id),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', member.companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', member.companyId).maybeSingle(),
  ])
  const currency = (settings.data as { base_currency?: string } | null)?.base_currency ?? 'USD'
  const toolDefs = toolsFor(access)
  const ctx: ToolContext = { supabase, companyId: member.companyId, userId: user.id, locale, today: today(), conversationId, access, currency }
  const system = systemPrompt({ locale, today: ctx.today, companyName: (company.data as { name?: string } | null)?.name ?? member.companyName ?? '', role: member.role,
    screen, tools: toolDefs.map((d) => d.name), currency })
  const log = (ev: string, info: Record<string, unknown>) => supabase.rpc('assistant_log', { target: member.companyId, conv: conversationId, ev, info })
  const started = Date.now()
  let answer: { text: string; status: string; trace: TraceEntry[]; actions: string[] }
  try {
    const r = await runTurn({
      provider: provider ?? anthropicProvider(cfg as Extract<typeof cfg, { configured: true }>), system, tools: TOOLS, toolDefs, ctx, history, userText: text,
      texts: { refused: t.refused, incomplete: t.incomplete, empty: t.empty },
      events: { onTool: async (e) => { await log(e.ok ? 'tool' : 'tool_denied', { tool: e.name, ok: e.ok, ...(e.error ? { error: e.error } : {}) }); if (e.flagged) await log('flagged', { tool: e.name }) } },
    })
    await supabase.rpc('assistant_record_usage', { target: member.companyId, input_count: r.usage.input, output_count: r.usage.output })
    if (r.status === 'refused') await log('refused', {})
    answer = r
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'unknown'
    console.error('ASSISTANT_PROVIDER_ERROR', { code, status: e instanceof ProviderError ? e.status : null })
    await log('provider_error', { code })
    answer = { text: code === 'auth' ? t.providerAuth : code === 'rate_limit' || code === 'overloaded' ? t.providerBusy : t.providerError, status: 'error', trace: [], actions: [] }
  }
  await supabase.rpc('assistant_add_message', { conv: conversationId, msg_role: 'assistant', msg_content: answer.text, msg_tools: answer.trace, msg_screen: null, msg_status: answer.status })
  await log('turn', { status: answer.status, tools: answer.trace.length, actions: answer.actions.length, ms: Date.now() - started, screen: screen?.area ?? null })
  const full = await loadConversation(conversationId)
  if (!full) return { ok: false, error: 'not_found' }
  return { ok: true, conversationId, messages: full.messages, actions: full.actions }
}

// ------------------------------------------------------------- confirmed actions
const DraftPayload = z.object({
  kind: z.enum(KINDS as unknown as [Kind, ...Kind[]]), title: z.string().min(1).max(160), instruction: z.string().min(5).max(4000),
  refs: z.object({ client: z.uuid().nullable(), source_document: z.uuid().nullable(), employee: z.uuid().nullable(), vendor: z.uuid().nullable() }).strict(),
}).strict()

export async function decideAction(raw: unknown): Promise<{ ok: boolean; status: string; error?: string; link?: string; actions?: ChatAction[] }> {
  const p = z.object({ actionId: z.uuid(), decision: z.enum(['confirm', 'cancel']) }).safeParse(raw)
  if (!p.success) return { ok: false, status: 'invalid' }
  const s = await session()
  if (!s) return { ok: false, status: 'forbidden' }
  const { supabase, locale } = s
  const { data: own } = await supabase.from('assistant_actions').select('company_id, conversation_id').eq('id', p.data.actionId).maybeSingle()
  const row = own as { company_id: string; conversation_id: string } | null
  if (!row || row.company_id !== s.member.companyId) return { ok: false, status: 'not_found' }
  const { data, error } = await supabase.rpc('assistant_decide_action', { act: p.data.actionId, decision: p.data.decision })
  const decided = ((data ?? []) as { id: string; kind: string; status: string; payload: unknown }[])[0]
  const reload = async () => (await loadConversation(row.conversation_id))?.actions
  if (error || !decided) return { ok: false, status: /ALREADY_DECIDED/.test(error?.message ?? '') ? 'already_decided' : 'error', actions: await reload() }
  if (decided.status !== 'confirmed') return { ok: true, status: decided.status, actions: await reload() }
  // execute the confirmed action through the module's own function, with the user's session
  let result: { ok: true; link: string; missing: string[] } | { ok: false; error: string }
  if (decided.kind === 'studio_draft') {
    const payload = DraftPayload.safeParse(decided.payload)
    if (!payload.success) result = { ok: false, error: 'invalid_payload' }
    else {
      const r = await createAssistantDraft(supabase, row.company_id, { instruction: payload.data.instruction, kind: payload.data.kind, title: payload.data.title, refs: payload.data.refs, locale, today: today() })
      result = r.ok ? { ok: true, link: `/studio/${r.id}`, missing: r.missing.slice(0, 12) } : { ok: false, error: r.error }
    }
  } else result = { ok: false, error: 'unknown_kind' }
  await supabase.rpc('assistant_finish_action', result.ok
    ? { act: decided.id, ok: true, res: { link: result.link, missing: result.missing }, err: null }
    : { act: decided.id, ok: false, res: null, err: result.error })
  return result.ok ? { ok: true, status: 'executed', link: result.link, actions: await reload() } : { ok: false, status: 'failed', error: result.error, actions: await reload() }
}

export async function renameConversation(raw: unknown) {
  const p = z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }).safeParse(raw)
  const s = await session()
  if (!p.success || !s) return { ok: false }
  const { error } = await s.supabase.rpc('assistant_rename_conversation', { conv: p.data.id, conv_title: p.data.title })
  return { ok: !error }
}

export async function archiveConversation(raw: unknown) {
  const p = z.object({ id: z.uuid(), archived: z.boolean() }).safeParse(raw)
  const s = await session()
  if (!p.success || !s) return { ok: false }
  const { error } = await s.supabase.rpc('assistant_archive_conversation', { conv: p.data.id, archived: p.data.archived })
  return { ok: !error }
}

/**
 * Assistant service (SERVER ONLY): the user's session, quota, conversations,
 * the engine, the audit trail and confirmed actions.
 *
 * Every database call runs with the USER'S Supabase session (auth.uid(),
 * RLS, has_permission); the service role is never used here. Internal
 * writes (turn start / finish with usage, cost and audit; action execution)
 * are additionally signed with the server key (0030), so they cannot be
 * forged from the REST API. The company is the active membership; the user
 * is the one verified by the Auth server. Neither comes from the request.
 */
import { z } from 'zod'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getActiveMembership, type MembershipOption } from '@/lib/active-company'
import { getLocale } from '@/lib/i18n/server'
import type { Locale } from '@/lib/i18n/app'
import { readAssistantConfig, publicAssistantState, type AssistantConfig } from '@/lib/assistant/config'
import { anthropicProvider } from '@/lib/intelligence/adapters/anthropic'
import { ServerSigner } from '@/lib/intelligence/server-auth'
import { classify, route } from '@/lib/intelligence/router'
import { FactStore } from '@/lib/intelligence/facts'
import { formatNanos } from '@/lib/intelligence/cost'
import type { LlmProvider } from '@/lib/intelligence/types'
import { loadAccess, toolsFor, TOOLS, type ToolContext } from '@/lib/assistant/tools'
import { runTurn, type HistoryItem, type TraceEntry, type TurnResult } from '@/lib/assistant/engine'
import { PROMPT_MARKERS, screenFromPath, systemPrompt, titleFrom } from '@/lib/assistant/prompt'
import { randomUUID } from 'node:crypto'
import { COPY } from '@/lib/assistant/copy'
import { KINDS, type Kind } from '@/lib/studio/model'
import { createAssistantDraft } from '@/lib/studio/draft'

export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string; tools: TraceEntry[]; status: string; created_at: string; turn: TurnMeta | null }
export type TurnMeta = { model: string | null; tier: string | null; verification: string | null; status: string; cost: string | null }
export type ChatAction = { id: string; kind: string; level: string; summary: string; status: string; result: { link?: string; missing?: string[] } | null; error: string | null; expires_at: string; created_at: string; lease_until: string | null; attempts: number }
export type Conversation = { id: string; title: string; archived_at: string | null; updated_at: string }
export type AssistantStatus = { configured: boolean; reason: string | null; allowed: boolean; limitReason: string | null; used: number; limit: number; budgetPct: number | null }

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export type Session = { supabase: SupabaseClient; user: Pick<User, 'id'>; member: Pick<MembershipOption, 'companyId' | 'role' | 'companyName'>; locale: Locale }
async function session(): Promise<Session | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const member = await getActiveMembership(supabase, user.id)
  if (!member) return null
  return { supabase, user, member, locale: await getLocale() }
}
const signerFor = (cfg: AssistantConfig, user: Pick<User, 'id'>) => (cfg.configured ? new ServerSigner(cfg.serverKeys[0], user.id) : null)

/** Usable now? (configuration, server key registered in the database, plan, quota, budget) */
export async function assistantStatus(): Promise<AssistantStatus | null> {
  const s = await session()
  if (!s) return null
  const cfg = readAssistantConfig()
  const pub = publicAssistantState(cfg)
  const { data } = await s.supabase.rpc('assistant_quota', { target: s.member.companyId })
  const q = ((data ?? []) as { allowed: boolean; reason: string; user_used: number; user_limit: number; cost_nanos: number | string | null; budget_nanos: number | string | null; server_ready: boolean }[])[0]
  const configured = pub.configured && q?.server_ready === true
  const budget = q?.budget_nanos !== null && q?.budget_nanos !== undefined ? BigInt(q.budget_nanos) : 0n
  return {
    configured, reason: pub.configured && !q?.server_ready ? 'server_key_not_registered' : pub.reason,
    allowed: q?.allowed ?? false, limitReason: q?.reason ?? 'unavailable', used: q?.user_used ?? 0, limit: q?.user_limit ?? 0,
    budgetPct: budget > 0n && q?.cost_nanos !== null && q?.cost_nanos !== undefined ? Number((BigInt(q.cost_nanos) * 100n) / budget) : null,
  }
}

export async function listConversations(archived = false): Promise<Conversation[]> {
  const s = await session()
  if (!s) return []
  let q = s.supabase.from('assistant_conversations').select('id, title, archived_at, updated_at').eq('company_id', s.member.companyId).eq('user_id', s.user.id)
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  const { data } = await q.order('updated_at', { ascending: false }).limit(100)
  return (data ?? []) as Conversation[]
}

export async function loadConversation(id: string, sess?: Session): Promise<{ conversation: Conversation; messages: ChatMessage[]; actions: ChatAction[] } | null> {
  const s = sess ?? await session()
  if (!s || !z.uuid().safeParse(id).success) return null
  const { data: c } = await s.supabase.from('assistant_conversations').select('id, title, archived_at, updated_at').eq('id', id).eq('company_id', s.member.companyId).eq('user_id', s.user.id).maybeSingle()
  if (!c) return null
  const [m, a, t] = await Promise.all([
    s.supabase.from('assistant_messages').select('id, role, content, tools, status, created_at, turn_id').eq('conversation_id', id).order('id', { ascending: false }).limit(200),
    s.supabase.from('assistant_actions').select('id, kind, level, summary, status, result, error, expires_at, created_at, lease_until, attempts').eq('conversation_id', id).order('created_at').limit(100),
    s.supabase.from('assistant_turns').select('id, model, tier, verification, status, cost_nanos, cost_status').eq('conversation_id', id).eq('user_id', s.user.id).order('started_at', { ascending: false }).limit(200),
  ])
  const turns = new Map(((t.data ?? []) as { id: string; model: string | null; tier: string | null; verification: string | null; status: string; cost_nanos: number | string; cost_status: string }[])
    .map((x) => [x.id, { model: x.model, tier: x.tier, verification: x.verification, status: x.status, cost: x.cost_status === 'estimated' ? formatNanos(BigInt(x.cost_nanos ?? 0)) : null }]))
  const messages = ((m.data ?? []) as (Omit<ChatMessage, 'turn'> & { turn_id: string | null })[]).reverse()
    .map(({ turn_id, ...x }) => ({ ...x, turn: x.role === 'assistant' && turn_id ? turns.get(turn_id) ?? null : null }))
  return { conversation: c as Conversation, messages, actions: (a.data ?? []) as ChatAction[] }
}

// ------------------------------------------------------------- one streamed turn
export const SendInput = z.object({ conversationId: z.uuid().nullable(), text: z.string().trim().min(1).max(4000), screen: z.string().max(200).nullable() }).strict()
export type StreamEvent =
  | { type: 'start'; turnId: string; conversationId: string; model: string; tier: string }
  | { type: 'model'; model: string; tier: string }
  | { type: 'tool'; entry: TraceEntry }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'final'; conversationId: string; messages: ChatMessage[]; actions: ChatAction[]; status: string }
  | { type: 'error'; error: 'not_configured' | 'limit' | 'forbidden' | 'invalid' | 'not_found' | 'locked' | 'server_auth'; reason?: string }

/**
 * Runs one turn and emits events. Always finishes the turn in the database
 * (usage, cost and audit are recorded for every outcome, cancellation and
 * provider failures included). `providerOverride` is for tests only.
 */
export async function streamTurn(raw: unknown, emit: (e: StreamEvent) => void, signal: AbortSignal, providerOverride?: LlmProvider): Promise<void> {
  const parsed = SendInput.safeParse(raw)
  if (!parsed.success) return emit({ type: 'error', error: 'invalid' })
  const s = await session()
  if (!s) return emit({ type: 'error', error: 'forbidden' })
  const cfg = readAssistantConfig()
  if (!cfg.configured) return emit({ type: 'error', error: 'not_configured', reason: cfg.reason })
  return runSignedTurn(s, cfg, parsed.data, emit, signal, providerOverride)
}

/**
 * The signed turn itself (begin → engine → finish), with an already verified
 * session. Exported so the benchmark (bench/) runs exactly the production
 * path, only with a different session source and the local provider double.
 */
export async function runSignedTurn(s: Session, cfg: Extract<AssistantConfig, { configured: true }>, input: z.infer<typeof SendInput>,
  emit: (e: StreamEvent) => void, signal: AbortSignal, providerOverride?: LlmProvider): Promise<void> {
  const { supabase, member, user, locale } = s
  const t = COPY[locale]
  const signer = signerFor(cfg, user)!
  const { conversationId: existing, text, screen: screenPath } = input
  const screen = screenFromPath(screenPath)

  // 0) routing first: without a model approved for the request nothing starts (no quota consumed)
  const routerConfig = { pinnedModel: cfg.pinnedModel, enabled: cfg.routerEnabled, policy: cfg.routerPolicy }
  const c = classify(text, screen?.area ?? null)
  const decision = route(c.tier, routerConfig, c.reason)
  if (!decision) return emit({ type: 'error', error: 'not_configured', reason: 'no_approved_model' })

  // 1) start the turn (signed): quota, conversation, the user's message — atomically in the database
  const b = signer.begin(member.companyId, existing, text)
  const { data: started, error: be } = await supabase.rpc('assistant_begin_turn', {
    target: member.companyId, conv: existing, conv_title: titleFrom(text), conv_locale: locale, user_text: text, screen: screen?.path ?? null,
    key: b.key, nonce: b.nonce, ts: b.ts, mac: b.mac,
  })
  if (be) {
    const msg = `${be.message} ${be.hint ?? ''}`
    return emit({ type: 'error', error: /SERVER_AUTH/.test(msg) ? 'server_auth' : /NOT_FOUND/.test(msg) ? 'not_found' : /LOCKED/.test(msg) ? 'locked' : /INVALID/.test(msg) ? 'invalid' : 'forbidden', reason: /hint|key/.test(msg) ? 'server_key_not_registered' : undefined })
  }
  const row = ((started ?? []) as { turn_id: string | null; conversation_id: string | null; allowed: boolean; reason: string }[])[0]
  if (!row?.allowed || !row.turn_id || !row.conversation_id) return emit({ type: 'error', error: 'limit', reason: row?.reason })
  const turnId = row.turn_id, conversationId = row.conversation_id

  // 2) context: history, access (one call), routing
  const [prior, access, settings, company] = await Promise.all([
    supabase.from('assistant_messages').select('role, content, status, turn_id').eq('conversation_id', conversationId).order('id', { ascending: false }).limit(21),
    loadAccess(supabase, member.companyId),
    supabase.from('ledger_settings').select('base_currency').eq('company_id', member.companyId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', member.companyId).maybeSingle(),
  ])
  const history: HistoryItem[] = ((prior.data ?? []) as { role: 'user' | 'assistant'; content: string; status: string; turn_id: string | null }[]).reverse()
    .filter((m) => m.turn_id !== turnId && (m.role === 'user' || m.status === 'ok'))
  const currency = (settings.data as { base_currency?: string } | null)?.base_currency ?? 'USD'
  const toolSpecs = toolsFor(access)
  emit({ type: 'start', turnId, conversationId, model: decision.model.id, tier: decision.tier })
  const ctx: ToolContext = { supabase, companyId: member.companyId, userId: user.id, locale, today: today(), turnId, access, currency, facts: new FactStore() }
  // a per-turn canary: an answer that repeats it (or the prompt's headings) is a prompt leak and is rejected
  const canary = `BA-CANARY-${randomUUID().slice(0, 8)}`
  const system = systemPrompt({ canary, locale, today: ctx.today, companyName: (company.data as { name?: string } | null)?.name ?? member.companyName ?? '', role: member.role,
    screen, tools: toolSpecs.map((d) => d.name), currency })
  const provider = providerOverride ?? anthropicProvider({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, testDouble: cfg.testDouble })
  const started0 = Date.now()
  const events: { event: string; detail: Record<string, unknown> }[] = []
  let r: TurnResult
  try {
    r = await runTurn({
      provider, decision, routerConfig, system, tools: TOOLS, toolSpecs, ctx, history, userText: text, signal, deadlineMs: cfg.deadlineMs, secrets: [canary, ...PROMPT_MARKERS],
      texts: { refused: t.refused, incomplete: t.incomplete, empty: t.empty, cancelled: t.cancelled, error: t.providerError, unverified: t.unverified, regenerate: REGENERATE },
      events: {
        onTool: (e) => {
          events.push({ event: e.ok ? 'tool' : 'tool_denied', detail: { tool: e.name, ok: e.ok, ...(e.error ? { error: e.error } : {}) } })
          if (e.flagged) events.push({ event: 'flagged', detail: { tool: e.name } })
          emit({ type: 'tool', entry: e })
        },
        onDelta: (d) => emit({ type: 'delta', text: d }),
        onReset: () => emit({ type: 'reset' }),
        onModel: (m, tier) => emit({ type: 'model', model: m, tier }),
      },
    })
  } catch (e) {
    // never leave a turn open: an unexpected failure is recorded as an error with what is known
    console.error('ASSISTANT_TURN_ERROR', { kind: (e as Error)?.name })
    r = { status: 'error', text: t.providerError, verification: 'none', trace: [], actions: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, calls: 0, costNanos: 0n, costStatus: 'none',
      provider: provider.id, model: decision.model.id, tier: decision.tier, router: { reason: decision.reason }, errorCode: 'internal', refs: [], facts: ctx.facts }
  }
  if (r.status === 'error' && r.errorCode) events.push({ event: 'provider_error', detail: { code: r.errorCode } })
  if (r.status === 'refused') events.push({ event: 'refused', detail: {} })

  // 3) finish the turn (signed): answer, usage, cost, routing, verification, audit — whatever the outcome
  const answer = r.status === 'error' && r.errorCode === 'auth' ? t.providerAuth : r.status === 'error' && (r.errorCode === 'rate_limit' || r.errorCode === 'overloaded') ? t.providerBusy : r.text
  const payload = JSON.stringify({
    status: r.status, answer, provider: r.provider, model: r.model, tier: r.tier, router: r.router,
    usage: { input: r.usage.input, output: r.usage.output, cache_read: r.usage.cacheRead, cache_write: r.usage.cacheWrite, calls: r.calls },
    cost_nanos: r.costNanos.toString(), cost_status: r.costStatus, latency_ms: Date.now() - started0, verification: r.verification,
    error_code: r.errorCode ?? null, trace: r.trace, events, claims: r.refs,
  }).replace(/\u0000/g, '')
  const f = signer.finish(turnId, payload)
  const { error: fe } = await supabase.rpc('assistant_finish_turn', { turn: turnId, payload, key: f.key, mac: f.mac })
  if (fe) console.error('ASSISTANT_FINISH_ERROR', { code: fe.code, message: fe.message.slice(0, 80) })
  const full = await loadConversation(conversationId, s)
  emit({ type: 'final', conversationId, messages: full?.messages ?? [], actions: full?.actions ?? [], status: r.status })
}

/** Sent to the model (English, like the system prompt) when its answer has unsourced figures. */
const REGENERATE = 'VERIFICATION FAILED: your answer contains figures, dates or numbers that are not placeholders of tool results, or placeholders that do not resolve. Rewrite the same answer citing every figure with [[Tn.path]] placeholders (use calculate for derived figures). Do not add new information. Problems:'

// ------------------------------------------------------------- confirmed actions (A6)
const DraftPayload = z.object({
  kind: z.enum(KINDS as unknown as [Kind, ...Kind[]]), title: z.string().min(1).max(160), instruction: z.string().min(5).max(4000),
  refs: z.object({ client: z.uuid().nullable(), source_document: z.uuid().nullable(), employee: z.uuid().nullable(), vendor: z.uuid().nullable() }).strict(),
}).strict()

type ActionOutcome = { ok: boolean; status: string; error?: string; link?: string; actions?: ChatAction[] }

async function executeAction(s: Session, signer: ServerSigner, actionId: string): Promise<{ ok: boolean; status: string; error?: string; link?: string }> {
  const c = signer.claim(actionId)
  const { data, error } = await s.supabase.rpc('assistant_claim_action', { act: actionId, key: c.key, ts: c.ts, mac: c.mac })
  if (error) return { ok: false, status: /BUSY/.test(error.message) ? 'busy' : 'error', error: error.hint ?? undefined }
  const claimed = ((data ?? []) as { id: string; kind: string; payload: unknown; progress: { doc_id?: string } | null; attempt: number; company_id: string }[])[0]
  if (!claimed) return { ok: false, status: 'failed', error: 'too_many_attempts' }
  let result: { ok: true; link: string; missing: string[] } | { ok: false; error: string }
  if (claimed.kind === 'studio_draft') {
    const payload = DraftPayload.safeParse(claimed.payload)
    if (!payload.success) result = { ok: false, error: 'invalid_payload' }
    else {
      const r = await createAssistantDraft(s.supabase, claimed.company_id, { instruction: payload.data.instruction, kind: payload.data.kind, title: payload.data.title, refs: payload.data.refs, locale: s.locale, today: today() }, {
        docId: claimed.progress?.doc_id ?? null,
        onCreated: async (id, version) => {
          const progress = JSON.stringify({ doc_id: id, version })
          const p = signer.progress(actionId, progress)
          await s.supabase.rpc('assistant_action_progress', { act: actionId, progress_text: progress, key: p.key, ts: p.ts, mac: p.mac })
        },
      })
      result = r.ok ? { ok: true, link: `/studio/${r.id}`, missing: r.missing.slice(0, 12) } : { ok: false, error: r.error }
    }
  } else result = { ok: false, error: 'unknown_kind' }
  const res = result.ok ? JSON.stringify({ link: result.link, missing: result.missing }) : null
  const err = result.ok ? null : result.error
  const k = signer.complete(actionId, result.ok, res, err)
  const { error: ce } = await s.supabase.rpc('assistant_complete_action', { act: actionId, ok: result.ok, result_text: res, err, key: k.key, ts: k.ts, mac: k.mac })
  if (ce) return { ok: false, status: 'error', error: 'complete_failed' }
  return result.ok ? { ok: true, status: 'executed', link: result.link } : { ok: false, status: 'failed', error: result.error }
}

async function actionContext(raw: unknown, schema: z.ZodObject) {
  const p = schema.safeParse(raw)
  if (!p.success) return null
  const s = await session()
  if (!s) return null
  const cfg = readAssistantConfig()
  const signer = signerFor(cfg, s.user)
  const id = (p.data as { actionId: string }).actionId
  const { data: own } = await s.supabase.from('assistant_actions').select('company_id, conversation_id').eq('id', id).maybeSingle()
  const row = own as { company_id: string; conversation_id: string } | null
  if (!row || row.company_id !== s.member.companyId) return { s, signer, row: null, data: p.data }
  return { s, signer, row, data: p.data }
}

export async function decideAction(raw: unknown): Promise<ActionOutcome> {
  const c = await actionContext(raw, z.object({ actionId: z.uuid(), decision: z.enum(['confirm', 'cancel']), requestKey: z.uuid() }).strict())
  if (!c) return { ok: false, status: 'invalid' }
  if (!c.row) return { ok: false, status: 'not_found' }
  const { actionId, decision, requestKey } = c.data as { actionId: string; decision: 'confirm' | 'cancel'; requestKey: string }
  const reload = async () => (await loadConversation(c.row!.conversation_id, c.s))?.actions
  const { data, error } = await c.s.supabase.rpc('assistant_decide', { act: actionId, decision, request_key: requestKey })
  const d = ((data ?? []) as { status: string }[])[0]
  if (error || !d) return { ok: false, status: /ALREADY_DECIDED/.test(error?.message ?? '') ? 'already_decided' : 'error', actions: await reload() }
  if (d.status !== 'confirmed') return { ok: true, status: d.status, actions: await reload() }
  if (!c.signer) return { ok: false, status: 'not_configured', actions: await reload() }
  const r = await executeAction(c.s, c.signer, actionId)
  return { ...r, actions: await reload() }
}

/** Retry of a confirmed action whose execution did not finish (lease expired). */
export async function retryAction(raw: unknown): Promise<ActionOutcome> {
  const c = await actionContext(raw, z.object({ actionId: z.uuid() }).strict())
  if (!c) return { ok: false, status: 'invalid' }
  if (!c.row) return { ok: false, status: 'not_found' }
  if (!c.signer) return { ok: false, status: 'not_configured' }
  const r = await executeAction(c.s, c.signer, (c.data as { actionId: string }).actionId)
  return { ...r, actions: (await loadConversation(c.row.conversation_id, c.s))?.actions }
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

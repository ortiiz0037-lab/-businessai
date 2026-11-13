-- =====================================================================
-- BusinessAI · Migration 0029 · BusinessAI Assistant
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0010, 0014a, 0015, 0017, 0028.
--
-- Storage, limits and audit of the central assistant. NO BUSINESS DATA IS
-- COPIED HERE: the assistant reads invoices, payments, clients, employees…
-- from their own tables with the user's session (RLS + has_permission), and
-- writes business records only through the existing functions of each
-- module (e.g. studio_save_document for a Document Studio draft), after the
-- user confirms a proposed action.
--
--   assistant_conversations  private to their author (not even an owner or
--                            admin can read another user's conversation)
--   assistant_messages       the visible turns (user text / assistant text
--                            and the list of tools used); append-only
--   assistant_actions        operations PROPOSED by the assistant; nothing
--                            runs until the author confirms it here
--                            (proposed → confirmed → executed | failed,
--                            or cancelled / expired). One confirmation only.
--   assistant_usage          requests and tokens per user and day
--   assistant_limits         limits per plan (catalog)
--   assistant_events         audit trail (append-only): turns, tools used or
--                            denied, limits, actions. Metadata only, never the
--                            conversation text.
--
-- Every write goes through the functions below (no direct insert / update /
-- delete); conversations are archived, never deleted (except by the company
-- cascade).
--
-- ROLES: assistant.use (owner, admin, member); assistant.audit (owner,
-- admin: read the company's assistant audit trail and usage, not the
-- conversations). PLAN: a company needs an active subscription or trial
-- (company_billing_state.can_write) and a row in assistant_limits for its
-- plan; deny by default.
-- Rollback: supabase/rollback/0029_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.company_billing_state(uuid)') is null or to_regclass('public.billing_plans') is null
     or to_regprocedure('public.has_permission(uuid, text)') is null or to_regclass('public.studio_documents') is null then
    raise exception 'BA0029: migrations 0010, 0014a, 0017 and 0028 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('assistant.use', 'assistant', 'Usar el asistente BusinessAI', 'Use the BusinessAI assistant'),
  ('assistant.audit', 'assistant', 'Ver la auditoría y el consumo del asistente', 'View the assistant audit trail and usage')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'assistant.use'), ('admin', 'assistant.use'), ('member', 'assistant.use'),
  ('owner', 'assistant.audit'), ('admin', 'assistant.audit')
on conflict do nothing;

-- ------------------------------------------------------------- tables
create table if not exists public.assistant_limits (
  plan text primary key references public.billing_plans(plan) on delete cascade,
  user_daily_requests integer not null check (user_daily_requests between 0 and 100000),
  company_daily_requests integer not null check (company_daily_requests between 0 and 1000000),
  company_monthly_tokens bigint not null check (company_monthly_tokens between 0 and 10000000000),
  per_minute integer not null default 6 check (per_minute between 1 and 120)
);
insert into public.assistant_limits (plan, user_daily_requests, company_daily_requests, company_monthly_tokens) values
  ('basic', 30, 100, 2000000), ('pro', 100, 400, 8000000), ('premium', 300, 1500, 30000000)
on conflict (plan) do nothing;

create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  locale text not null default 'es' check (locale in ('es', 'en')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index if not exists assistant_conversations_user_idx on public.assistant_conversations (company_id, user_id, updated_at desc);

create table if not exists public.assistant_messages (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 20000),
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array' and octet_length(tools::text) <= 20000),
  screen text check (screen is null or char_length(screen) <= 200),
  status text not null default 'ok' check (status in ('ok', 'error', 'refused', 'limit', 'not_configured', 'incomplete')),
  created_at timestamptz not null default now(),
  foreign key (company_id, conversation_id) references public.assistant_conversations (company_id, id) on delete cascade
);
create index if not exists assistant_messages_conv_idx on public.assistant_messages (conversation_id, id);

create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('studio_draft')),
  level text not null check (level in ('draft', 'execute', 'issue')),
  summary text not null check (char_length(btrim(summary)) between 1 and 400),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 200000),
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'executed', 'cancelled', 'failed', 'expired')),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 4000)),
  error text check (error is null or char_length(error) <= 200),
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  finished_at timestamptz,
  foreign key (company_id, conversation_id) references public.assistant_conversations (company_id, id) on delete cascade
);
create index if not exists assistant_actions_conv_idx on public.assistant_actions (conversation_id, created_at);

create table if not exists public.assistant_usage (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  day date not null,
  requests integer not null default 0 check (requests >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  minute_start timestamptz,
  minute_count integer not null default 0,
  primary key (company_id, user_id, day)
);

create table if not exists public.assistant_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid,
  conversation_id uuid,
  action_id uuid,
  event text not null check (event in ('turn', 'tool', 'tool_denied', 'limit', 'provider_error', 'refused', 'flagged',
    'action_proposed', 'action_confirmed', 'action_cancelled', 'action_expired', 'action_executed', 'action_failed', 'conversation_archived')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists assistant_events_company_idx on public.assistant_events (company_id, id desc);

-- RLS: conversations, messages, actions and usage rows are read by their
-- author only; the audit trail by its author or assistant.audit; nobody
-- writes directly.
do $$
declare t text;
begin
  foreach t in array array['assistant_limits', 'assistant_conversations', 'assistant_messages', 'assistant_actions', 'assistant_usage', 'assistant_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
  end loop;
  foreach t in array array['assistant_conversations', 'assistant_messages', 'assistant_actions', 'assistant_usage', 'assistant_events'] loop
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;
create policy ba_assistant_limits_select on public.assistant_limits for select to authenticated using (true);
create policy ba_assistant_conversations_select on public.assistant_conversations for select to authenticated
  using (user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use'));
create policy ba_assistant_messages_select on public.assistant_messages for select to authenticated
  using (user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use'));
create policy ba_assistant_actions_select on public.assistant_actions for select to authenticated
  using (user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use'));
create policy ba_assistant_usage_select on public.assistant_usage for select to authenticated
  using ((user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use')) or public.has_permission(company_id, 'assistant.audit'));
create policy ba_assistant_events_select on public.assistant_events for select to authenticated
  using ((user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use')) or public.has_permission(company_id, 'assistant.audit'));

drop trigger if exists ba_assistant_append_only on public.assistant_events;
create trigger ba_assistant_append_only before update or delete on public.assistant_events for each row execute function public.ledger_append_only();
drop trigger if exists ba_assistant_append_only on public.assistant_messages;
create trigger ba_assistant_append_only before update or delete on public.assistant_messages for each row execute function public.ledger_append_only();

-- ------------------------------------------------------------- helpers
create or replace function public.assistant_log(target uuid, conv uuid, ev text, info jsonb default '{}'::jsonb, act uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not public.has_permission(target, 'assistant.use') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  -- the app logs what happened in a turn; the action events are written by the action functions themselves
  if ev like 'action\_%' or ev in ('conversation_archived', 'limit') then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'event';
  end if;
  if conv is not null and not exists (select 1 from public.assistant_conversations c where c.id = conv and c.company_id = target
                                      and (c.user_id = (select auth.uid()) or (select auth.uid()) is null)) then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (target, (select auth.uid()), conv, act, ev, coalesce(info, '{}'::jsonb));
end $$;

/** The conversation of the caller (locked), or ASSISTANT_NOT_FOUND. */
create or replace function public.assistant_own_conversation(conv uuid)
returns public.assistant_conversations language plpgsql security definer set search_path = '' as $$
declare c public.assistant_conversations;
begin
  select * into c from public.assistant_conversations x where x.id = conv for update;
  if c.id is null or c.user_id is distinct from (select auth.uid()) or not public.has_permission(c.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  return c;
end $$;

-- ------------------------------------------------------------- access and limits
/**
 * Whether the caller may use the assistant in the company now, and why not.
 * reason: ok · forbidden · no_plan · limit_minute · limit_user · limit_company · limit_tokens
 */
create or replace function public.assistant_status(target uuid)
returns table (allowed boolean, reason text, plan text, user_used integer, user_limit integer, company_used integer, company_limit integer,
               tokens_used bigint, tokens_limit bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  st record; lim public.assistant_limits; me uuid := (select auth.uid());
  pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
  u integer; cu integer; tk bigint; mc integer;
begin
  if me is null or not public.has_permission(target, 'assistant.use') then
    return query select false, 'forbidden'::text, null::text, 0, 0, 0, 0, 0::bigint, 0::bigint; return;
  end if;
  select * into st from public.company_billing_state(target);
  select * into lim from public.assistant_limits l where st.can_write and l.plan = st.plan;
  if lim.plan is null then
    return query select false, 'no_plan'::text, st.plan, 0, 0, 0, 0, 0::bigint, 0::bigint; return;
  end if;
  select coalesce(sum(x.requests) filter (where x.user_id = me and x.day = pr_day), 0)::int,
         coalesce(sum(x.requests) filter (where x.day = pr_day), 0)::int,
         coalesce(sum(x.input_tokens + x.output_tokens) filter (where x.day >= date_trunc('month', pr_day)::date), 0)::bigint,
         coalesce(max(case when x.user_id = me and x.day = pr_day and x.minute_start > now() - interval '1 minute' then x.minute_count end), 0)::int
    into u, cu, tk, mc
    from public.assistant_usage x where x.company_id = target and x.day >= date_trunc('month', pr_day)::date;
  return query select
    (mc < lim.per_minute and u < lim.user_daily_requests and cu < lim.company_daily_requests and tk < lim.company_monthly_tokens),
    case when u >= lim.user_daily_requests then 'limit_user' when cu >= lim.company_daily_requests then 'limit_company'
         when tk >= lim.company_monthly_tokens then 'limit_tokens' when mc >= lim.per_minute then 'limit_minute' else 'ok' end,
    st.plan, u, lim.user_daily_requests, cu, lim.company_daily_requests, tk, lim.company_monthly_tokens;
end $$;

/** Counts one request (atomically) if the caller is within every limit. */
create or replace function public.assistant_consume(target uuid)
returns table (allowed boolean, reason text)
language plpgsql security definer set search_path = '' as $$
declare s record; me uuid := (select auth.uid()); pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
begin
  if me is null then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- one request at a time per company: the counters below cannot be raced past the limit
  perform pg_advisory_xact_lock(hashtextextended('assistant:' || target::text, 0));
  select * into s from public.assistant_status(target);
  if not s.allowed then
    if s.reason <> 'forbidden' then
      insert into public.assistant_events (company_id, user_id, event, detail) values (target, me, 'limit', jsonb_build_object('reason', s.reason));
    end if;
    return query select false, s.reason; return;
  end if;
  insert into public.assistant_usage as x (company_id, user_id, day, requests, minute_start, minute_count)
  values (target, me, pr_day, 1, now(), 1)
  on conflict (company_id, user_id, day) do update set
    requests = x.requests + 1,
    minute_count = case when x.minute_start > now() - interval '1 minute' then x.minute_count + 1 else 1 end,
    minute_start = case when x.minute_start > now() - interval '1 minute' then x.minute_start else now() end;
  return query select true, 'ok'::text;
end $$;

/** Tokens reported by the provider for the caller's request (bounded). */
create or replace function public.assistant_record_usage(target uuid, input_count bigint, output_count bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
begin
  if me is null or not public.has_permission(target, 'assistant.use') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if input_count is null or output_count is null or input_count < 0 or output_count < 0 or input_count > 5000000 or output_count > 1000000 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'usage';
  end if;
  update public.assistant_usage set input_tokens = input_tokens + input_count, output_tokens = output_tokens + output_count
   where company_id = target and user_id = me and day = pr_day;
end $$;

-- ------------------------------------------------------------- conversations and messages
create or replace function public.assistant_start_conversation(target uuid, conv_title text, conv_locale text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid;
begin
  if (select auth.uid()) is null or not public.has_permission(target, 'assistant.use') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  insert into public.assistant_conversations (company_id, user_id, title, locale)
  values (target, (select auth.uid()), left(coalesce(nullif(btrim(conv_title), ''), 'Conversación'), 120), case when conv_locale = 'en' then 'en' else 'es' end)
  returning id into nid;
  return nid;
end $$;

create or replace function public.assistant_rename_conversation(conv uuid, conv_title text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.assistant_conversations;
begin
  c := public.assistant_own_conversation(conv);
  if conv_title is null or char_length(btrim(conv_title)) not between 1 and 120 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'title'; end if;
  update public.assistant_conversations set title = btrim(conv_title), updated_at = now() where id = c.id;
end $$;

create or replace function public.assistant_archive_conversation(conv uuid, archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.assistant_conversations;
begin
  c := public.assistant_own_conversation(conv);
  update public.assistant_conversations set archived_at = case when archived then coalesce(archived_at, now()) end, updated_at = now() where id = c.id;
  if archived then
    insert into public.assistant_events (company_id, user_id, conversation_id, event) values (c.company_id, c.user_id, c.id, 'conversation_archived');
  end if;
end $$;

create or replace function public.assistant_add_message(conv uuid, msg_role text, msg_content text, msg_tools jsonb default '[]'::jsonb,
  msg_screen text default null, msg_status text default 'ok')
returns bigint language plpgsql security definer set search_path = '' as $$
declare c public.assistant_conversations; nid bigint;
begin
  c := public.assistant_own_conversation(conv);
  if c.archived_at is not null then raise exception 'ASSISTANT_LOCKED' using errcode = 'P0001'; end if;
  if msg_role not in ('user', 'assistant') or msg_content is null or char_length(msg_content) > 20000 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'message';
  end if;
  insert into public.assistant_messages (company_id, conversation_id, user_id, role, content, tools, screen, status)
  values (c.company_id, c.id, c.user_id, msg_role, msg_content, coalesce(msg_tools, '[]'::jsonb), left(msg_screen, 200), coalesce(msg_status, 'ok'))
  returning id into nid;
  update public.assistant_conversations set updated_at = now() where id = c.id;
  return nid;
end $$;

-- ------------------------------------------------------------- actions (human confirmation)
/** A proposed action of the caller's conversation. Nothing is executed here. */
create or replace function public.assistant_propose_action(conv uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.assistant_conversations; nid uuid; lvl text;
begin
  c := public.assistant_own_conversation(conv);
  if c.archived_at is not null then raise exception 'ASSISTANT_LOCKED' using errcode = 'P0001'; end if;
  -- the level of each kind is fixed here, never chosen by the caller
  lvl := case act_kind when 'studio_draft' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(c.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if (select count(*) from public.assistant_actions a where a.conversation_id = c.id and a.status = 'proposed' and a.expires_at > now()) >= 5 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'too_many_pending';
  end if;
  insert into public.assistant_actions (company_id, conversation_id, user_id, kind, level, summary, payload)
  values (c.company_id, c.id, c.user_id, act_kind, lvl, left(btrim(act_summary), 400), act_payload)
  returning id into nid;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (c.company_id, c.user_id, c.id, nid, 'action_proposed', jsonb_build_object('kind', act_kind, 'level', lvl));
  return nid;
end $$;

/**
 * The author confirms or cancels a proposed action. A confirmation is valid
 * once: the row is locked and moves proposed → confirmed; a second call,
 * another user or an expired proposal is refused.
 */
create or replace function public.assistant_decide_action(act uuid, decision text)
returns table (id uuid, kind text, status text, payload jsonb)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare a public.assistant_actions;
begin
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from (select auth.uid()) or not public.has_permission(a.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if decision not in ('confirm', 'cancel') then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'decision'; end if;
  if a.status <> 'proposed' then raise exception 'ASSISTANT_ALREADY_DECIDED' using errcode = 'P0001', hint = a.status; end if;
  if a.expires_at <= now() then
    update public.assistant_actions set status = 'expired', decided_at = now() where id = a.id;
    insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event) values (a.company_id, a.user_id, a.conversation_id, a.id, 'action_expired');
    return query select a.id, a.kind, 'expired'::text, null::jsonb; return;
  end if;
  update public.assistant_actions set status = case when decision = 'confirm' then 'confirmed' else 'cancelled' end, decided_at = now() where id = a.id;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (a.company_id, a.user_id, a.conversation_id, a.id, case when decision = 'confirm' then 'action_confirmed' else 'action_cancelled' end, jsonb_build_object('kind', a.kind));
  return query select a.id, a.kind, case when decision = 'confirm' then 'confirmed' else 'cancelled' end, case when decision = 'confirm' then a.payload end;
end $$;

/** Result of a confirmed action (confirmed → executed | failed), once. */
create or replace function public.assistant_finish_action(act uuid, ok boolean, res jsonb default null, err text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.assistant_actions;
begin
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from (select auth.uid()) then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if a.status <> 'confirmed' then raise exception 'ASSISTANT_ALREADY_DECIDED' using errcode = 'P0001', hint = a.status; end if;
  update public.assistant_actions set status = case when ok then 'executed' else 'failed' end, result = res, error = left(err, 200), finished_at = now() where id = a.id;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (a.company_id, a.user_id, a.conversation_id, a.id, case when ok then 'action_executed' else 'action_failed' end,
          jsonb_build_object('kind', a.kind) || case when ok then coalesce(res, '{}'::jsonb) else jsonb_build_object('error', left(err, 200)) end);
end $$;

do $$
declare f text;
begin
  foreach f in array array['assistant_log(uuid, uuid, text, jsonb, uuid)', 'assistant_status(uuid)', 'assistant_consume(uuid)',
    'assistant_record_usage(uuid, bigint, bigint)', 'assistant_start_conversation(uuid, text, text)', 'assistant_rename_conversation(uuid, text)',
    'assistant_archive_conversation(uuid, boolean)', 'assistant_add_message(uuid, text, text, jsonb, text, text)',
    'assistant_propose_action(uuid, text, text, jsonb)', 'assistant_decide_action(uuid, text)', 'assistant_finish_action(uuid, boolean, jsonb, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.assistant_own_conversation(uuid) from public, anon, authenticated;
grant execute on function public.assistant_own_conversation(uuid) to service_role;

do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname = 'ba_assistant_append_only') <> 2 then
    raise exception 'BA0029 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.assistant_messages', 'INSERT') or has_table_privilege('authenticated', 'public.assistant_actions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.assistant_usage', 'UPDATE') or has_table_privilege('anon', 'public.assistant_conversations', 'SELECT')
     or has_function_privilege('authenticated', 'public.assistant_own_conversation(uuid)', 'EXECUTE') then
    raise exception 'BA0029 self-check failed: privileges';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'assistant.audit') then
    raise exception 'BA0029 self-check failed: role matrix';
  end if;
end $$;

commit;

-- =====================================================================
-- BusinessAI · Migration 0030 · Intelligence Engine core
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0029.
--
-- Hardening of the assistant (0029) after the Delivery 9 audit:
--
--   SERVER AUTHORIZATION (A2, A3, A4). Quota, usage, cost, audit and the
--   assistant's own messages are written ONLY by the BusinessAI server. The
--   server keeps using the USER'S JWT (auth.uid(), RLS, has_permission —
--   never the service role) and, in addition, signs each internal write
--   with HMAC-SHA256 using a key that only the server and this database
--   know (ba_private.assistant_server_keys; several keys for rotation,
--   key id inside every signature). A user calling these functions through
--   the REST API cannot produce the signature. Signed messages carry the
--   caller's auth.uid(), a timestamp (±120 s) and a single-use nonce or a
--   single-use state transition: no replay. Without a registered key the
--   assistant refuses to start (closed by default).
--   The 0029 functions that let users forge audit events, consume or
--   record quota or append messages lose EXECUTE for `authenticated`.
--
--   TURNS (A5, A10). assistant_turns: one row per request with provider,
--   model, routing, tokens by category (input, output, cache read, cache
--   write), cost in nano-dollars, latency and verification result. Usage
--   is recorded when the turn finishes for ANY reason (error and
--   cancellation included).
--
--   BUDGETS (A12). Monthly budget per plan in nano-dollars (1 USD = 1e9)
--   plus a per-company burst limit; the token cap counts only uncached
--   tokens. Alerts at 50 / 80 / 100 % of the budget (audit events).
--
--   ACTIONS (A6). proposed → confirmed → executing (lease, max 3 attempts)
--   → executed | failed; idempotent confirmation (request key); progress
--   recorded so a retry resumes instead of duplicating; stuck executions
--   can be retried after the lease expires.
--
--   AGGREGATES (A7). Totals computed in SQL over all rows (no client-side
--   sums over truncated pages). ACCESS (A8). One RPC returns the caller's
--   permission map, plan features and workforce scope.
-- Rollback: supabase/rollback/0030_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.assistant_actions') is null or to_regprocedure('public.assistant_decide_action(uuid, text)') is null
     or to_regprocedure('public.ar_invoice_balances(uuid, date)') is null or to_regprocedure('public.wf_manages(uuid)') is null then
    raise exception 'BA0030: migrations 0020, 0025 and 0029 must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------- private schema: server keys and nonces
create schema if not exists ba_private;
revoke all on schema ba_private from public, anon, authenticated;

create table if not exists ba_private.assistant_server_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret bytea not null check (octet_length(secret) between 32 and 128),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table if not exists ba_private.assistant_nonces (
  nonce uuid primary key,
  expires_at timestamptz not null
);
revoke all on ba_private.assistant_server_keys, ba_private.assistant_nonces from public, anon, authenticated;

/** HMAC-SHA256 (RFC 2104) with the built-in sha256(): no extension needed. */
create or replace function ba_private.hmac_sha256(k bytea, msg bytea)
returns bytea language plpgsql immutable strict set search_path = '' as $$
declare key bytea := k; ipad bytea; opad bytea; i integer;
begin
  if octet_length(key) > 64 then key := sha256(key); end if;
  key := key || decode(repeat('00', 64 - octet_length(key)), 'hex');
  ipad := key; opad := key;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(key, i) # 54);
    opad := set_byte(opad, i, get_byte(key, i) # 92);
  end loop;
  return sha256(opad || sha256(ipad || msg));
end $$;

/** Raises ASSISTANT_SERVER_AUTH unless `mac` is the HMAC of `msg` under an active (or still in grace) key. */
create or replace function ba_private.assistant_verify(key text, msg text, mac text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare s bytea;
begin
  select k.secret into s from ba_private.assistant_server_keys k where k.key_id = key and (k.retired_at is null or k.retired_at > now());
  if s is null then raise exception 'ASSISTANT_SERVER_AUTH' using errcode = 'P0001', hint = 'key'; end if;
  if mac is null or lower(mac) !~ '^[0-9a-f]{64}$' or encode(ba_private.hmac_sha256(s, convert_to(msg, 'UTF8')), 'hex') <> lower(mac) then
    raise exception 'ASSISTANT_SERVER_AUTH' using errcode = 'P0001', hint = 'mac';
  end if;
end $$;

create or replace function ba_private.assistant_fresh(ts bigint)
returns void language plpgsql stable set search_path = '' as $$
begin
  if ts is null or abs(extract(epoch from now()) - ts) > 120 then raise exception 'ASSISTANT_SERVER_AUTH' using errcode = 'P0001', hint = 'stale'; end if;
end $$;

create or replace function ba_private.sha_hex(t text)
returns text language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $$;

/**
 * Key management (database owner / service role only — NOT callable by users).
 * secret_b64: the same base64 secret configured on the server as
 * ASSISTANT_SERVER_KEYS="<key_id>:<base64>". Rotation: add the new key here
 * and on the server (first entry signs), then retire the old one with a grace period.
 */
create or replace function public.assistant_set_server_key(key text, secret_b64 text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into ba_private.assistant_server_keys (key_id, secret) values (key, decode(secret_b64, 'base64'))
  on conflict (key_id) do update set secret = excluded.secret, retired_at = null, created_at = now();
end $$;
create or replace function public.assistant_retire_server_key(key text, at_time timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
begin
  update ba_private.assistant_server_keys set retired_at = at_time where key_id = key;
  if not found then raise exception 'ASSISTANT_SERVER_AUTH' using errcode = 'P0001', hint = 'key'; end if;
end $$;
/** Whether any key is active (no secret is revealed). */
create or replace function public.assistant_server_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from ba_private.assistant_server_keys k where k.retired_at is null or k.retired_at > now())
$$;

-- ------------------------------------------------------------- budgets and limits
alter table public.assistant_limits add column if not exists company_monthly_budget_nanos bigint not null default 0 check (company_monthly_budget_nanos between 0 and 100000000000000);
alter table public.assistant_limits add column if not exists company_per_minute integer not null default 20 check (company_per_minute between 1 and 600);
-- PROVISIONAL values (not an approved commercial decision): USD 5 / 25 / 100 per company and
-- month; configurable in assistant_limits (1 USD = 1e9 nano-dollars). See docs/INTELLIGENCE.md.
update public.assistant_limits set company_monthly_budget_nanos = case plan when 'basic' then 5000000000 when 'pro' then 25000000000 when 'premium' then 100000000000 else company_monthly_budget_nanos end
 where company_monthly_budget_nanos = 0;

alter table public.assistant_usage add column if not exists cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0);
alter table public.assistant_usage add column if not exists cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0);
alter table public.assistant_usage add column if not exists cost_nanos bigint not null default 0 check (cost_nanos >= 0);

-- ------------------------------------------------------------- turns
create table if not exists public.assistant_turns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  status text not null default 'open' check (status in ('open', 'completed', 'error', 'refused', 'incomplete', 'cancelled', 'abandoned')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  finished_at timestamptz,
  provider text check (provider is null or provider ~ '^[a-z0-9_-]{1,40}$'),
  model text check (model is null or model ~ '^[A-Za-z0-9._:/-]{1,100}$'),
  tier text check (tier is null or tier in ('P0', 'P1', 'P2', 'P3')),
  router jsonb check (router is null or (jsonb_typeof(router) = 'object' and octet_length(router::text) <= 2000)),
  calls integer not null default 0 check (calls between 0 and 100),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  cost_nanos bigint not null default 0 check (cost_nanos >= 0),
  cost_status text not null default 'none' check (cost_status in ('estimated', 'unpriced', 'test', 'none')),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 3600000),
  verification text check (verification is null or verification in ('verified', 'regenerated', 'fallback', 'none')),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,60}$'),
  foreign key (company_id, conversation_id) references public.assistant_conversations (company_id, id) on delete cascade
);
create index if not exists assistant_turns_user_idx on public.assistant_turns (company_id, user_id, started_at desc);
create index if not exists assistant_turns_open_idx on public.assistant_turns (user_id) where status = 'open';

alter table public.assistant_messages add column if not exists turn_id uuid;
alter table public.assistant_actions add column if not exists turn_id uuid;
alter table public.assistant_actions add column if not exists decision_key uuid;
alter table public.assistant_actions add column if not exists lease_until timestamptz;
alter table public.assistant_actions add column if not exists attempts integer not null default 0 check (attempts between 0 and 10);
alter table public.assistant_actions add column if not exists progress jsonb check (progress is null or (jsonb_typeof(progress) = 'object' and octet_length(progress::text) <= 4000));
alter table public.assistant_actions drop constraint if exists assistant_actions_status_check;
alter table public.assistant_actions add constraint assistant_actions_status_check check (status in ('proposed', 'confirmed', 'executing', 'executed', 'cancelled', 'failed', 'expired'));
alter table public.assistant_events drop constraint if exists assistant_events_event_check;
alter table public.assistant_events add constraint assistant_events_event_check check (event in ('turn', 'tool', 'tool_denied', 'limit', 'provider_error', 'refused', 'flagged',
  'action_proposed', 'action_confirmed', 'action_cancelled', 'action_expired', 'action_executed', 'action_failed', 'conversation_archived',
  'action_claimed', 'budget_alert', 'turn_abandoned'));

alter table public.assistant_turns enable row level security;
revoke all on public.assistant_turns from public, anon, authenticated;
grant select on public.assistant_turns to authenticated;
grant all on public.assistant_turns to service_role;
drop policy if exists ba_assistant_turns_select on public.assistant_turns;
create policy ba_assistant_turns_select on public.assistant_turns for select to authenticated
  using ((user_id = (select auth.uid()) and public.has_permission(company_id, 'assistant.use')) or public.has_permission(company_id, 'assistant.audit'));
drop trigger if exists ba_company_immutable on public.assistant_turns;
create trigger ba_company_immutable before update on public.assistant_turns for each row execute function public.forbid_company_change();

-- ------------------------------------------------------------- access in one call (A8)
/** The caller's permissions (for the given keys), plan features and workforce scope in the company. Read-only. */
create or replace function public.assistant_access(target uuid, keys text[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare perms jsonb; me uuid := (select auth.uid());
begin
  if me is null or keys is null or cardinality(keys) > 60 then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select coalesce(jsonb_object_agg(k, public.has_permission(target, k)), '{}'::jsonb) into perms from unnest(keys) as k;
  return jsonb_build_object(
    'member', public.is_company_member(target),
    'perms', perms,
    'features', jsonb_build_object(
      'employees', coalesce((select f.available from public.company_feature(target, 'employees') f), false),
      'time_clock', coalesce((select f.available from public.company_feature(target, 'time_clock') f), false)),
    'workforce', jsonb_build_object(
      'manages', public.wf_manages(target),
      'supervised', coalesce((select jsonb_agg(s.department_id) from public.department_supervisors s where s.company_id = target and s.user_id = me), '[]'::jsonb)));
end $$;

-- ------------------------------------------------------------- complete aggregates (A7)
create or replace function public.assistant_ar_summary(target uuid, client uuid default null)
returns table (open_count bigint, open_cents text, overdue_count bigint, overdue_cents text, as_of date)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.has_permission(target, 'receivables.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return query
    select count(*) filter (where b.balance_cents > 0), coalesce(sum(b.balance_cents) filter (where b.balance_cents > 0), 0)::text,
           count(*) filter (where b.balance_cents > 0 and b.days_past_due > 0), coalesce(sum(b.balance_cents) filter (where b.balance_cents > 0 and b.days_past_due > 0), 0)::text,
           public.ba_today()
      from public.ar_invoice_balances(target, null) b
     where client is null or b.client_id = client;
end $$;

create or replace function public.assistant_ap_summary(target uuid)
returns table (currency text, open_count bigint, open_cents text, overdue_count bigint, overdue_cents text, as_of date)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.has_permission(target, 'payables.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return query
    select b.currency, count(*), sum(b.total_cents - b.paid_cents)::text,
           count(*) filter (where b.due_date < public.ba_today()), coalesce(sum(b.total_cents - b.paid_cents) filter (where b.due_date < public.ba_today()), 0)::text,
           public.ba_today()
      from public.bills b
     where b.company_id = target and b.status in ('approved', 'scheduled', 'partially_paid') and b.total_cents > b.paid_cents
     group by b.currency order by b.currency;
end $$;

/** Invoices issued in [from, to] (not drafts, not cancelled). Money in cents, as text (no float). */
create or replace function public.assistant_invoiced(target uuid, from_date date, to_date date)
returns table (invoices bigint, total_cents text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.has_permission(target, 'documents.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if from_date is null or to_date is null or from_date > to_date then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'range'; end if;
  return query
    select count(*), coalesce(sum(round(d.total * 100)), 0)::bigint::text
      from public.documents d
     where d.company_id = target and d.document_type = 'invoice' and d.status not in ('draft', 'cancelled')
       and d.issue_date between from_date and to_date;
end $$;

/** Customer payments received in [from, to] (Puerto Rico calendar days), voided payments excluded. */
create or replace function public.assistant_collected(target uuid, from_date date, to_date date)
returns table (payments bigint, total_cents text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.has_permission(target, 'payments.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if from_date is null or to_date is null or from_date > to_date then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'range'; end if;
  return query
    select count(*), coalesce(sum(round(p.amount * 100)), 0)::bigint::text
      from public.payments p
     where p.company_id = target and p.voided_at is null
       and p.paid_at >= (from_date::timestamp at time zone 'America/Puerto_Rico')
       and p.paid_at < ((to_date + 1)::timestamp at time zone 'America/Puerto_Rico');
end $$;

-- ------------------------------------------------------------- quota
create or replace function ba_private.assistant_quota_row(target uuid, me uuid)
returns table (allowed boolean, reason text, plan text, user_used integer, user_limit integer, company_used integer, company_limit integer,
               cost_nanos bigint, budget_nanos bigint, tokens_used bigint, tokens_limit bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  st record; lim public.assistant_limits;
  pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
  m0 date := date_trunc('month', (now() at time zone 'America/Puerto_Rico')::date)::date;
  u integer; cu integer; mc integer; cmc integer; cost bigint; tk bigint;
begin
  select * into st from public.company_billing_state(target);
  select * into lim from public.assistant_limits l where st.can_write and l.plan = st.plan;
  if lim.plan is null then
    return query select false, 'no_plan'::text, st.plan, 0, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint, 0::bigint; return;
  end if;
  select coalesce(sum(x.requests) filter (where x.user_id = me and x.day = pr_day), 0)::int,
         coalesce(sum(x.requests) filter (where x.day = pr_day), 0)::int,
         coalesce(max(case when x.user_id = me and x.day = pr_day and x.minute_start > now() - interval '1 minute' then x.minute_count end), 0)::int,
         coalesce(sum(case when x.day = pr_day and x.minute_start > now() - interval '1 minute' then x.minute_count else 0 end), 0)::int,
         coalesce(sum(x.cost_nanos), 0)::bigint,
         coalesce(sum(x.input_tokens + x.output_tokens), 0)::bigint
    into u, cu, mc, cmc, cost, tk
    from public.assistant_usage x where x.company_id = target and x.day >= m0;
  return query select
    (u < lim.user_daily_requests and cu < lim.company_daily_requests and cost < lim.company_monthly_budget_nanos and tk < lim.company_monthly_tokens
      and mc < lim.per_minute and cmc < lim.company_per_minute),
    case when u >= lim.user_daily_requests then 'limit_user' when cu >= lim.company_daily_requests then 'limit_company'
         when cost >= lim.company_monthly_budget_nanos then 'limit_budget' when tk >= lim.company_monthly_tokens then 'limit_tokens'
         when mc >= lim.per_minute then 'limit_minute' when cmc >= lim.company_per_minute then 'limit_company_minute' else 'ok' end,
    st.plan, u, lim.user_daily_requests, cu, lim.company_daily_requests, cost, lim.company_monthly_budget_nanos, tk, lim.company_monthly_tokens;
end $$;

/** The caller's quota in the company (read-only; for the interface). Cost and budget only with assistant.audit. */
create or replace function public.assistant_quota(target uuid)
returns table (allowed boolean, reason text, plan text, user_used integer, user_limit integer, company_used integer, company_limit integer,
               cost_nanos bigint, budget_nanos bigint, server_ready boolean)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); q record;
begin
  if me is null or not public.has_permission(target, 'assistant.use') then
    return query select false, 'forbidden'::text, null::text, 0, 0, 0, 0, 0::bigint, 0::bigint, public.assistant_server_ready(); return;
  end if;
  select * into q from ba_private.assistant_quota_row(target, me);
  -- the company's AI spend is shown only to who audits the assistant (owner, admin)
  return query select q.allowed, q.reason, q.plan, q.user_used, q.user_limit, q.company_used, q.company_limit,
    case when public.has_permission(target, 'assistant.audit') then q.cost_nanos end, case when public.has_permission(target, 'assistant.audit') then q.budget_nanos end,
    public.assistant_server_ready();
end $$;

-- ------------------------------------------------------------- turns (signed by the server)
create or replace function ba_private.assistant_housekeeping(me uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  delete from ba_private.assistant_nonces where expires_at < now();
  for t in update public.assistant_turns set status = 'abandoned', finished_at = now(), error_code = 'abandoned'
            where user_id = me and status = 'open' and expires_at < now() returning id, company_id, conversation_id loop
    insert into public.assistant_events (company_id, user_id, conversation_id, event, detail) values (t.company_id, me, t.conversation_id, 'turn_abandoned', jsonb_build_object('turn', t.id));
  end loop;
end $$;

/**
 * Starts a turn: verifies the server signature, consumes quota atomically,
 * creates the conversation if needed, stores the user's message.
 * mac = HMAC(key, 'begin|v1|<key>|<auth.uid()>|<target>|<conv or empty>|<nonce>|<ts>|<sha256 hex of user_text>')
 */
create or replace function public.assistant_begin_turn(target uuid, conv uuid, conv_title text, conv_locale text, user_text text, screen text,
  key text, nonce uuid, ts bigint, mac text)
returns table (turn_id uuid, conversation_id uuid, allowed boolean, reason text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare me uuid := (select auth.uid()); c public.assistant_conversations; q record; tid uuid; pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
begin
  if me is null or not public.has_permission(target, 'assistant.use') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform ba_private.assistant_fresh(ts);
  perform ba_private.assistant_verify(key, concat_ws('|', 'begin', 'v1', key, me::text, target::text, coalesce(conv::text, ''), nonce::text, ts::text, ba_private.sha_hex(user_text)), mac);
  begin
    insert into ba_private.assistant_nonces (nonce, expires_at) values (nonce, now() + interval '10 minutes');
  exception when unique_violation then raise exception 'ASSISTANT_SERVER_AUTH' using errcode = 'P0001', hint = 'replay';
  end;
  if user_text is null or char_length(btrim(user_text)) not between 1 and 4000 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'message'; end if;
  perform ba_private.assistant_housekeeping(me);
  if conv is not null then
    select * into c from public.assistant_conversations x where x.id = conv for update;
    if c.id is null or c.user_id <> me or c.company_id <> target then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
    if c.archived_at is not null then raise exception 'ASSISTANT_LOCKED' using errcode = 'P0001'; end if;
  end if;
  -- one request at a time per company: limits cannot be raced past
  perform pg_advisory_xact_lock(hashtextextended('assistant:' || target::text, 0));
  select * into q from ba_private.assistant_quota_row(target, me);
  if not q.allowed then
    insert into public.assistant_events (company_id, user_id, conversation_id, event, detail) values (target, me, conv, 'limit', jsonb_build_object('reason', q.reason));
    return query select null::uuid, conv, false, q.reason; return;
  end if;
  if conv is null then
    insert into public.assistant_conversations (company_id, user_id, title, locale)
    values (target, me, left(coalesce(nullif(btrim(conv_title), ''), 'Conversación'), 120), case when conv_locale = 'en' then 'en' else 'es' end)
    returning * into c;
  end if;
  insert into public.assistant_usage as x (company_id, user_id, day, requests, minute_start, minute_count)
  values (target, me, pr_day, 1, now(), 1)
  on conflict (company_id, user_id, day) do update set
    requests = x.requests + 1,
    minute_count = case when x.minute_start > now() - interval '1 minute' then x.minute_count + 1 else 1 end,
    minute_start = case when x.minute_start > now() - interval '1 minute' then x.minute_start else now() end;
  insert into public.assistant_turns (company_id, conversation_id, user_id) values (target, c.id, me) returning id into tid;
  insert into public.assistant_messages (company_id, conversation_id, user_id, role, content, screen, status, turn_id)
  values (target, c.id, me, 'user', btrim(user_text), left(screen, 200), 'ok', tid);
  update public.assistant_conversations set updated_at = now() where id = c.id;
  return query select tid, c.id, true, 'ok'::text;
end $$;

/**
 * Finishes a turn once: the assistant's message, usage and cost, routing,
 * verification and the tool audit events. payload is JSON text; the
 * signature covers its exact bytes.
 * mac = HMAC(key, 'finish|v1|<key>|<auth.uid()>|<turn>|<sha256 hex of payload>')
 */
create or replace function public.assistant_finish_turn(turn uuid, payload text, key text, mac text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid()); t public.assistant_turns; p jsonb; u jsonb; st text; msg_status text; mid bigint; e jsonb;
  m0 date; before_cost bigint; after_cost bigint; budget bigint; th integer; pr_day date := (now() at time zone 'America/Puerto_Rico')::date;
  inp bigint; outp bigint; cr bigint; cw bigint; cost bigint; answer text;
begin
  if me is null then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform ba_private.assistant_verify(key, concat_ws('|', 'finish', 'v1', key, me::text, turn::text, ba_private.sha_hex(payload)), mac);
  select * into t from public.assistant_turns x where x.id = turn for update;
  if t.id is null or t.user_id <> me then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if t.status <> 'open' then raise exception 'ASSISTANT_ALREADY_DECIDED' using errcode = 'P0001', hint = t.status; end if;
  begin p := payload::jsonb; exception when others then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'payload'; end;
  if jsonb_typeof(p) <> 'object' or octet_length(payload) > 60000 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'payload'; end if;
  st := p ->> 'status';
  if st is null or st not in ('completed', 'error', 'refused', 'incomplete', 'cancelled') then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'status'; end if;
  answer := coalesce(p ->> 'answer', '');
  if char_length(answer) > 20000 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'answer'; end if;
  u := coalesce(p -> 'usage', '{}'::jsonb);
  begin
    inp := coalesce((u ->> 'input')::bigint, 0); outp := coalesce((u ->> 'output')::bigint, 0);
    cr := coalesce((u ->> 'cache_read')::bigint, 0); cw := coalesce((u ->> 'cache_write')::bigint, 0);
    cost := coalesce((p ->> 'cost_nanos')::bigint, 0);
  exception when others then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'usage';
  end;
  if least(inp, outp, cr, cw, cost) < 0 or greatest(inp, cr, cw) > 50000000 or outp > 5000000 or cost > 1000000000000 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'usage';
  end if;
  update public.assistant_turns set
    status = st, finished_at = now(), provider = p ->> 'provider', model = p ->> 'model', tier = p ->> 'tier', router = p -> 'router',
    calls = coalesce((u ->> 'calls')::int, 0), input_tokens = inp, output_tokens = outp, cache_read_tokens = cr, cache_write_tokens = cw,
    cost_nanos = cost, cost_status = coalesce(p ->> 'cost_status', 'none'), latency_ms = (p ->> 'latency_ms')::int,
    verification = p ->> 'verification', error_code = p ->> 'error_code'
  where id = t.id;
  if answer <> '' then
    msg_status := case st when 'completed' then 'ok' when 'cancelled' then 'incomplete' else st end;
    insert into public.assistant_messages (company_id, conversation_id, user_id, role, content, tools, status, turn_id)
    values (t.company_id, t.conversation_id, me, 'assistant', answer, coalesce(p -> 'trace', '[]'::jsonb), msg_status, t.id)
    returning id into mid;
  end if;
  -- usage and cost (whatever the outcome), budget alerts at 50 / 80 / 100 %
  m0 := date_trunc('month', pr_day)::date;
  select coalesce(sum(x.cost_nanos), 0) into before_cost from public.assistant_usage x where x.company_id = t.company_id and x.day >= m0;
  insert into public.assistant_usage as x (company_id, user_id, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nanos)
  values (t.company_id, me, pr_day, inp, outp, cr, cw, cost)
  on conflict (company_id, user_id, day) do update set input_tokens = x.input_tokens + inp, output_tokens = x.output_tokens + outp,
    cache_read_tokens = x.cache_read_tokens + cr, cache_write_tokens = x.cache_write_tokens + cw, cost_nanos = x.cost_nanos + cost;
  after_cost := before_cost + cost;
  select l.company_monthly_budget_nanos into budget from public.assistant_limits l, public.company_billing_state(t.company_id) s where l.plan = s.plan;
  if coalesce(budget, 0) > 0 then
    foreach th in array array[50, 80, 100] loop
      if before_cost * 100 < budget * th and after_cost * 100 >= budget * th then
        insert into public.assistant_events (company_id, user_id, event, detail) values (t.company_id, me, 'budget_alert', jsonb_build_object('threshold', th, 'month', m0));
      end if;
    end loop;
  end if;
  for e in select value from jsonb_array_elements(coalesce(p -> 'events', '[]'::jsonb)) limit 60 loop
    if e ->> 'event' in ('tool', 'tool_denied', 'flagged', 'provider_error', 'refused') and octet_length(coalesce(e -> 'detail', '{}'::jsonb)::text) <= 1000 then
      insert into public.assistant_events (company_id, user_id, conversation_id, event, detail)
      values (t.company_id, me, t.conversation_id, e ->> 'event', coalesce(e -> 'detail', '{}'::jsonb) || jsonb_build_object('turn', t.id));
    end if;
  end loop;
  insert into public.assistant_events (company_id, user_id, conversation_id, event, detail)
  values (t.company_id, me, t.conversation_id, 'turn', jsonb_build_object('turn', t.id, 'status', st, 'provider', p ->> 'provider', 'model', p ->> 'model',
    'tier', p ->> 'tier', 'latency_ms', p -> 'latency_ms', 'cost_nanos', cost, 'verification', p ->> 'verification'));
  update public.assistant_conversations set updated_at = now() where id = t.conversation_id;
  return mid;
end $$;

-- ------------------------------------------------------------- actions (A6)
/** A proposal made during an OPEN turn of the caller (no proposals outside a server turn). */
create or replace function public.assistant_propose(turn uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.assistant_turns; me uuid := (select auth.uid()); lvl text; nid uuid;
begin
  select * into t from public.assistant_turns x where x.id = turn;
  if t.id is null or t.user_id is distinct from me or t.status <> 'open' or t.expires_at < now() or not public.has_permission(t.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  lvl := case act_kind when 'studio_draft' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_summary is null or char_length(btrim(act_summary)) not between 1 and 400 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'summary'; end if;
  if (select count(*) from public.assistant_actions a where a.conversation_id = t.conversation_id and a.status = 'proposed' and a.expires_at > now()) >= 5 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'too_many_pending';
  end if;
  insert into public.assistant_actions (company_id, conversation_id, user_id, kind, level, summary, payload, turn_id)
  values (t.company_id, t.conversation_id, me, act_kind, lvl, left(btrim(act_summary), 400), act_payload, t.id)
  returning id into nid;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (t.company_id, me, t.conversation_id, nid, 'action_proposed', jsonb_build_object('kind', act_kind, 'level', lvl));
  return nid;
end $$;

/**
 * The author confirms or cancels. Idempotent: the same request_key returns
 * the same outcome (double click, retried request); a different key after
 * a decision is refused.
 */
create or replace function public.assistant_decide(act uuid, decision text, request_key uuid)
returns table (id uuid, kind text, status text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare a public.assistant_actions; ns text;
begin
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from (select auth.uid()) or not public.has_permission(a.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if decision not in ('confirm', 'cancel') or request_key is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'decision'; end if;
  if a.status <> 'proposed' then
    if a.decision_key = request_key then return query select a.id, a.kind, a.status; return; end if;
    raise exception 'ASSISTANT_ALREADY_DECIDED' using errcode = 'P0001', hint = a.status;
  end if;
  if a.expires_at <= now() then
    update public.assistant_actions set status = 'expired', decided_at = now(), decision_key = request_key where id = a.id;
    insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event) values (a.company_id, a.user_id, a.conversation_id, a.id, 'action_expired');
    return query select a.id, a.kind, 'expired'::text; return;
  end if;
  ns := case when decision = 'confirm' then 'confirmed' else 'cancelled' end;
  update public.assistant_actions set status = ns, decided_at = now(), decision_key = request_key where id = a.id;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (a.company_id, a.user_id, a.conversation_id, a.id, case when ns = 'confirmed' then 'action_confirmed' else 'action_cancelled' end, jsonb_build_object('kind', a.kind));
  return query select a.id, a.kind, ns;
end $$;

/**
 * The server takes a confirmed action for execution (lease of 2 minutes, at
 * most 3 attempts). A stuck execution can be taken again after its lease.
 * mac = HMAC(key, 'claim|v1|<key>|<auth.uid()>|<act>|<ts>')
 */
create or replace function public.assistant_claim_action(act uuid, key text, ts bigint, mac text)
returns table (id uuid, kind text, payload jsonb, progress jsonb, attempt integer, company_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare a public.assistant_actions; me uuid := (select auth.uid());
begin
  perform ba_private.assistant_fresh(ts);
  perform ba_private.assistant_verify(key, concat_ws('|', 'claim', 'v1', key, me::text, act::text, ts::text), mac);
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from me or not public.has_permission(a.company_id, 'assistant.use') then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not (a.status = 'confirmed' or (a.status = 'executing' and a.lease_until < now())) then
    raise exception 'ASSISTANT_ACTION_BUSY' using errcode = 'P0001', hint = a.status;
  end if;
  if a.attempts >= 3 then
    update public.assistant_actions set status = 'failed', error = 'too_many_attempts', finished_at = now() where id = a.id;
    insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail) values (a.company_id, me, a.conversation_id, a.id, 'action_failed', jsonb_build_object('error', 'too_many_attempts'));
    -- no exception here: the failure must be committed; the caller receives no row
    return;
  end if;
  update public.assistant_actions set status = 'executing', lease_until = now() + interval '2 minutes', attempts = a.attempts + 1 where id = a.id;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail) values (a.company_id, me, a.conversation_id, a.id, 'action_claimed', jsonb_build_object('attempt', a.attempts + 1));
  return query select a.id, a.kind, a.payload, a.progress, a.attempts + 1, a.company_id;
end $$;

/** Progress of an execution (e.g. the draft already created), so a retry resumes it. mac over 'progress|v1|<key>|<uid>|<act>|<ts>|<sha256(progress)>' */
create or replace function public.assistant_action_progress(act uuid, progress_text text, key text, ts bigint, mac text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.assistant_actions; me uuid := (select auth.uid()); p jsonb;
begin
  perform ba_private.assistant_fresh(ts);
  perform ba_private.assistant_verify(key, concat_ws('|', 'progress', 'v1', key, me::text, act::text, ts::text, ba_private.sha_hex(progress_text)), mac);
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from me then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if a.status <> 'executing' then raise exception 'ASSISTANT_ACTION_BUSY' using errcode = 'P0001', hint = a.status; end if;
  begin p := progress_text::jsonb; exception when others then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'progress'; end;
  update public.assistant_actions set progress = p, lease_until = now() + interval '2 minutes' where id = a.id;
end $$;

/** Result of an execution, once. mac over 'complete|v1|<key>|<uid>|<act>|<ok>|<ts>|<sha256(result)>|<sha256(err)>' */
create or replace function public.assistant_complete_action(act uuid, ok boolean, result_text text, err text, key text, ts bigint, mac text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.assistant_actions; me uuid := (select auth.uid()); r jsonb;
begin
  perform ba_private.assistant_fresh(ts);
  perform ba_private.assistant_verify(key, concat_ws('|', 'complete', 'v1', key, me::text, act::text, ok::text, ts::text, ba_private.sha_hex(result_text), ba_private.sha_hex(err)), mac);
  select * into a from public.assistant_actions x where x.id = act for update;
  if a.id is null or a.user_id is distinct from me then raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001'; end if;
  if a.status <> 'executing' then raise exception 'ASSISTANT_ALREADY_DECIDED' using errcode = 'P0001', hint = a.status; end if;
  begin r := case when result_text is null then null else result_text::jsonb end; exception when others then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'result'; end;
  update public.assistant_actions set status = case when ok then 'executed' else 'failed' end, result = r, error = left(err, 200), finished_at = now(), lease_until = null where id = a.id;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (a.company_id, me, a.conversation_id, a.id, case when ok then 'action_executed' else 'action_failed' end,
          jsonb_build_object('kind', a.kind, 'attempt', a.attempts) || case when ok then coalesce(r, '{}'::jsonb) else jsonb_build_object('error', left(err, 200)) end);
end $$;

-- ------------------------------------------------------------- grants
do $$
declare f text;
begin
  -- 0029 functions that let a user forge audit, quota, usage, history or bypass the turn: server-only now
  foreach f in array array['assistant_log(uuid, uuid, text, jsonb, uuid)', 'assistant_consume(uuid)', 'assistant_record_usage(uuid, bigint, bigint)',
    'assistant_add_message(uuid, text, text, jsonb, text, text)', 'assistant_propose_action(uuid, text, text, jsonb)', 'assistant_decide_action(uuid, text)',
    'assistant_finish_action(uuid, boolean, jsonb, text)'] loop
    execute format('revoke execute on function public.%s from authenticated', f);
  end loop;
  foreach f in array array['assistant_access(uuid, text[])', 'assistant_ar_summary(uuid, uuid)', 'assistant_ap_summary(uuid)', 'assistant_invoiced(uuid, date, date)',
    'assistant_collected(uuid, date, date)', 'assistant_quota(uuid)', 'assistant_server_ready()', 'assistant_begin_turn(uuid, uuid, text, text, text, text, text, uuid, bigint, text)',
    'assistant_finish_turn(uuid, text, text, text)', 'assistant_propose(uuid, text, text, jsonb)', 'assistant_decide(uuid, text, uuid)',
    'assistant_claim_action(uuid, text, bigint, text)', 'assistant_action_progress(uuid, text, text, bigint, text)',
    'assistant_complete_action(uuid, boolean, text, text, text, bigint, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['assistant_set_server_key(text, text)', 'assistant_retire_server_key(text, timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke all on all functions in schema ba_private from public, anon, authenticated;

do $$
begin
  if has_function_privilege('authenticated', 'public.assistant_log(uuid, uuid, text, jsonb, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assistant_consume(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assistant_record_usage(uuid, bigint, bigint)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assistant_add_message(uuid, text, text, jsonb, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assistant_set_server_key(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'ba_private.hmac_sha256(bytea, bytea)', 'EXECUTE')
     or has_table_privilege('authenticated', 'ba_private.assistant_server_keys', 'SELECT')
     or has_table_privilege('authenticated', 'public.assistant_turns', 'INSERT') or has_table_privilege('authenticated', 'public.assistant_turns', 'UPDATE') then
    raise exception 'BA0030 self-check failed: privileges';
  end if;
  -- RFC 4231 test case 2
  if encode(ba_private.hmac_sha256(convert_to('Jefe', 'UTF8'), convert_to('what do ya want for nothing?', 'UTF8')), 'hex')
     <> '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843' then
    raise exception 'BA0030 self-check failed: hmac';
  end if;
end $$;

commit;

-- =====================================================================
-- BusinessAI · Migration 0031 · Intelligence Center (assistant insights)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0030.
--
-- Read-only aggregates of the assistant's turns and audit events for the
-- company's Intelligence Center (/assistant/insights): requests by status,
-- model and user, tokens, cost, latency, verification of figures, tools
-- used or denied, injections flagged, limits and budget alerts. Computed in
-- SQL over every row of the period (no truncated pages). Metadata only:
-- never the text of a conversation. Requires assistant.audit.
-- Rollback: supabase/rollback/0031_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.assistant_turns') is null then
    raise exception 'BA0031: migration 0030 must be applied first';
  end if;
end $$;

create or replace function public.assistant_insights(target uuid, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz; t1 timestamptz; result jsonb;
begin
  if (select auth.uid()) is null or not public.has_permission(target, 'assistant.audit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if from_date is null or to_date is null or from_date > to_date or to_date - from_date > 366 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'range'; end if;
  -- Puerto Rico calendar days
  t0 := from_date::timestamp at time zone 'America/Puerto_Rico';
  t1 := (to_date + 1)::timestamp at time zone 'America/Puerto_Rico';
  with t as (
    select * from public.assistant_turns x where x.company_id = target and x.started_at >= t0 and x.started_at < t1
  ),
  e as (
    select * from public.assistant_events x where x.company_id = target and x.created_at >= t0 and x.created_at < t1
  )
  select jsonb_build_object(
    'from', from_date, 'to', to_date,
    'turns', (select count(*) from t),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from t group by status) s), '{}'::jsonb),
    'verification', coalesce((select jsonb_object_agg(v, n) from (select coalesce(verification, 'none') as v, count(*) as n from t where status <> 'open' group by 1) s), '{}'::jsonb),
    'cost_nanos', (select coalesce(sum(cost_nanos), 0) from t)::text,
    'test_turns', (select count(*) from t where cost_status = 'test'),
    'unpriced_turns', (select count(*) from t where cost_status = 'unpriced'),
    'by_model', coalesce((select jsonb_agg(m order by m ->> 'model') from (
        select jsonb_build_object('provider', coalesce(provider, '-'), 'model', coalesce(model, '-'), 'turns', count(*), 'cost_nanos', coalesce(sum(cost_nanos), 0)::text,
          'input_tokens', coalesce(sum(input_tokens), 0)::text, 'output_tokens', coalesce(sum(output_tokens), 0)::text, 'cache_read_tokens', coalesce(sum(cache_read_tokens), 0)::text,
          'avg_latency_ms', round(avg(latency_ms))::int, 'p95_latency_ms', (percentile_cont(0.95) within group (order by latency_ms))::int,
          'fallbacks', count(*) filter (where router ? 'fallback_from'), 'escalations', count(*) filter (where router ? 'escalated_from')) as m
        from t where status <> 'open' group by provider, model) s), '[]'::jsonb),
    'by_tier', coalesce((select jsonb_object_agg(tier, n) from (select coalesce(tier, '-') as tier, count(*) as n from t group by 1) s), '{}'::jsonb),
    'by_user', coalesce((select jsonb_agg(u order by (u ->> 'turns')::int desc) from (
        select jsonb_build_object('user_id', user_id, 'turns', count(*), 'cost_nanos', coalesce(sum(cost_nanos), 0)::text) as u
        from t group by user_id order by count(*) desc limit 20) s), '[]'::jsonb),
    'events', coalesce((select jsonb_object_agg(event, n) from (select event, count(*) as n from e
        where event in ('tool_denied', 'flagged', 'limit', 'provider_error', 'refused', 'budget_alert', 'turn_abandoned', 'action_executed', 'action_failed') group by event) s), '{}'::jsonb),
    'tools', coalesce((select jsonb_agg(x order by (x ->> 'calls')::int desc) from (
        select jsonb_build_object('tool', detail ->> 'tool', 'calls', count(*) filter (where event = 'tool'), 'denied_or_failed', count(*) filter (where event = 'tool_denied')) as x
        from e where event in ('tool', 'tool_denied') and detail ? 'tool' group by detail ->> 'tool') s), '[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.assistant_insights(uuid, date, date) from public, anon;
grant execute on function public.assistant_insights(uuid, date, date) to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.assistant_insights(uuid, date, date)', 'EXECUTE') then
    raise exception 'BA0031 self-check failed: privileges';
  end if;
end $$;

commit;

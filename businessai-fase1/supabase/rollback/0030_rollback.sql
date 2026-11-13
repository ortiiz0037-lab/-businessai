-- Rollback of 0030 (Intelligence Engine core). Emergency use only.
-- Refuses, changing nothing, while any turn, registered server key, recorded
-- cost or action using the new execution states exists. Restores the 0029
-- grants (the assistant then works as in 0029, without server signatures).
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.assistant_turns') is not null then
    if exists (select 1 from public.assistant_turns) or exists (select 1 from ba_private.assistant_server_keys)
       or exists (select 1 from public.assistant_usage where cost_nanos > 0 or cache_read_tokens > 0 or cache_write_tokens > 0)
       or exists (select 1 from public.assistant_actions where turn_id is not null or decision_key is not null or status = 'executing')
       or exists (select 1 from public.assistant_messages where turn_id is not null)
       or exists (select 1 from public.assistant_events where event in ('action_claimed', 'budget_alert', 'turn_abandoned')) then
      raise exception 'BA0030 rollback: assistant turns, server keys, costs or new-style actions exist; nothing was changed.';
    end if;
  end if;
end $$;
drop function if exists public.assistant_complete_action(uuid, boolean, text, text, text, bigint, text);
drop function if exists public.assistant_action_progress(uuid, text, text, bigint, text);
drop function if exists public.assistant_claim_action(uuid, text, bigint, text);
drop function if exists public.assistant_decide(uuid, text, uuid);
drop function if exists public.assistant_propose(uuid, text, text, jsonb);
drop function if exists public.assistant_finish_turn(uuid, text, text, text);
drop function if exists public.assistant_begin_turn(uuid, uuid, text, text, text, text, text, uuid, bigint, text);
drop function if exists public.assistant_quota(uuid);
drop function if exists public.assistant_collected(uuid, date, date);
drop function if exists public.assistant_invoiced(uuid, date, date);
drop function if exists public.assistant_ap_summary(uuid);
drop function if exists public.assistant_ar_summary(uuid, uuid);
drop function if exists public.assistant_access(uuid, text[]);
drop function if exists public.assistant_server_ready();
drop function if exists public.assistant_retire_server_key(text, timestamptz);
drop function if exists public.assistant_set_server_key(text, text);
drop table if exists public.assistant_turns;
alter table public.assistant_events drop constraint if exists assistant_events_event_check;
alter table public.assistant_events add constraint assistant_events_event_check check (event in ('turn', 'tool', 'tool_denied', 'limit', 'provider_error', 'refused', 'flagged',
    'action_proposed', 'action_confirmed', 'action_cancelled', 'action_expired', 'action_executed', 'action_failed', 'conversation_archived'));
alter table public.assistant_actions drop constraint if exists assistant_actions_status_check;
alter table public.assistant_actions add constraint assistant_actions_status_check check (status in ('proposed', 'confirmed', 'executed', 'cancelled', 'failed', 'expired'));
alter table public.assistant_actions drop column if exists progress, drop column if exists attempts, drop column if exists lease_until,
  drop column if exists decision_key, drop column if exists turn_id;
alter table public.assistant_messages drop column if exists turn_id;
alter table public.assistant_usage drop column if exists cost_nanos, drop column if exists cache_write_tokens, drop column if exists cache_read_tokens;
alter table public.assistant_limits drop column if exists company_per_minute, drop column if exists company_monthly_budget_nanos;
drop schema if exists ba_private cascade;
do $$
declare f text;
begin
  foreach f in array array['assistant_log(uuid, uuid, text, jsonb, uuid)', 'assistant_consume(uuid)', 'assistant_record_usage(uuid, bigint, bigint)',
    'assistant_add_message(uuid, text, text, jsonb, text, text)', 'assistant_propose_action(uuid, text, text, jsonb)', 'assistant_decide_action(uuid, text)',
    'assistant_finish_action(uuid, boolean, jsonb, text)'] loop
    -- same ACL order as 0029 (the catalog fingerprint compares it)
    execute format('revoke all on function public.%s from authenticated, service_role', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
commit;

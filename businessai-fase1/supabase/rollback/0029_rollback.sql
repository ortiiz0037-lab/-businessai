-- Rollback of 0029 (BusinessAI Assistant). Emergency use only.
-- Refuses, changing nothing, while any conversation, proposed action, usage
-- row or audit event exists. Business data is not touched (0029 only reads
-- it; drafts created through confirmed actions belong to Document Studio).
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.assistant_conversations') is not null then
    if exists (select 1 from public.assistant_conversations) or exists (select 1 from public.assistant_actions)
       or exists (select 1 from public.assistant_usage) or exists (select 1 from public.assistant_events) then
      raise exception 'BA0029 rollback: assistant conversations, actions, usage or audit events exist; nothing was changed.';
    end if;
  end if;
end $$;
drop function if exists public.assistant_finish_action(uuid, boolean, jsonb, text);
drop function if exists public.assistant_decide_action(uuid, text);
drop function if exists public.assistant_propose_action(uuid, text, text, jsonb);
drop function if exists public.assistant_add_message(uuid, text, text, jsonb, text, text);
drop function if exists public.assistant_archive_conversation(uuid, boolean);
drop function if exists public.assistant_rename_conversation(uuid, text);
drop function if exists public.assistant_start_conversation(uuid, text, text);
drop function if exists public.assistant_record_usage(uuid, bigint, bigint);
drop function if exists public.assistant_consume(uuid);
drop function if exists public.assistant_status(uuid);
drop function if exists public.assistant_own_conversation(uuid);
drop function if exists public.assistant_log(uuid, uuid, text, jsonb, uuid);
drop table if exists public.assistant_events;
drop table if exists public.assistant_usage;
drop table if exists public.assistant_actions;
drop table if exists public.assistant_messages;
drop table if exists public.assistant_conversations;
drop table if exists public.assistant_limits;
delete from public.role_permissions where permission_key like 'assistant.%';
delete from public.permissions where key like 'assistant.%';
commit;

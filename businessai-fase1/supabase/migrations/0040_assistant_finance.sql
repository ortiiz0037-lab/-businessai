-- =====================================================================
-- BusinessAI · Migration 0040 · Assistant S4: Studio drafts about Finance
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0035 and 0038.
--
-- Two new assistant PROPOSALS (level 'draft', confirmed by the user like
-- every proposal of 0029 / 0030 / 0035):
--   * studio_collection_letter: a Document Studio collection letter about
--     an invoice (0038) — needs studio.edit and documents.view;
--   * studio_payment_voucher: a vendor payment voucher about a recorded
--     payment of an expense (0038) — needs studio.edit and payables.view.
-- Confirming one creates a Studio DRAFT through the same functions as the
-- invoice and expense screens (studio_save_document / studio_set_finance_link):
-- nothing is issued, sent, paid or posted, and no financial record is created.
-- Rollback: supabase/rollback/0040_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.studio_set_finance_link(uuid, uuid, uuid)') is null or to_regclass('public.crm_activities') is null then
    raise exception 'BA0040: migrations 0035 and 0038 must be applied first';
  end if;
end $$;

alter table public.assistant_actions drop constraint if exists assistant_actions_kind_check;
alter table public.assistant_actions add constraint assistant_actions_kind_check
  check (kind in ('studio_draft', 'crm_note', 'crm_task', 'studio_collection_letter', 'studio_payment_voucher'));

create or replace function public.assistant_propose(turn uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.assistant_turns; me uuid := (select auth.uid()); lvl text; nid uuid;
begin
  select * into t from public.assistant_turns x where x.id = turn;
  if t.id is null or t.user_id is distinct from me or t.status <> 'open' or t.expires_at < now() or not public.has_permission(t.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  lvl := case act_kind when 'studio_draft' then 'draft' when 'crm_note' then 'draft' when 'crm_task' then 'draft'
                       when 'studio_collection_letter' then 'draft' when 'studio_payment_voucher' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_kind in ('crm_note', 'crm_task') and not public.has_permission(t.company_id, 'crm.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- 0040: Studio drafts about Finance records need Studio AND the module that owns the record (same rules as the screens)
  if act_kind = 'studio_collection_letter' and not (public.has_permission(t.company_id, 'studio.edit') and public.has_permission(t.company_id, 'documents.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if act_kind = 'studio_payment_voucher' and not (public.has_permission(t.company_id, 'studio.edit') and public.has_permission(t.company_id, 'payables.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
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

-- grants unchanged (create or replace keeps them); checked below
do $$ begin
  if not has_function_privilege('authenticated', 'public.assistant_propose(uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.assistant_propose(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'BA0040 self-check failed: assistant_propose grants changed';
  end if;
  if (select not (p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p where p.oid = 'public.assistant_propose(uuid, text, text, jsonb)'::regprocedure) then
    raise exception 'BA0040 self-check failed: assistant_propose must be SECURITY DEFINER with an empty search_path';
  end if;
end $$;

commit;

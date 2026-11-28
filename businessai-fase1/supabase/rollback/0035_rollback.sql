-- Rollback of 0035 (CRM). Refuses, changing nothing, while CRM data exists:
-- contacts, tags, opportunities, activities, links, conversions, branches,
-- CRM settings or events, clients with CRM values (kind, legal name, tax id,
-- lifecycle, source, responsible, branch) or assistant CRM proposals.
-- Invoices created by a conversion are ordinary documents and are kept.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.crm_opportunities') is not null and (
       exists (select 1 from public.crm_contacts) or exists (select 1 from public.crm_tags) or exists (select 1 from public.crm_opportunities)
    or exists (select 1 from public.crm_activities) or exists (select 1 from public.crm_quote_conversions) or exists (select 1 from public.crm_opportunity_documents)
    or exists (select 1 from public.branches) or exists (select 1 from public.crm_events) or exists (select 1 from public.crm_client_branches)
    or exists (select 1 from public.crm_settings where branch_scoping or not share_clients_across_branches)) then
    raise exception 'BA0035 rollback: CRM data exists; nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'lifecycle')
     and exists (select 1 from public.clients where kind <> 'individual' or lifecycle <> 'customer' or legal_name is not null or tax_id is not null
                   or source is not null or owner_id is not null or branch_id is not null) then
    raise exception 'BA0035 rollback: clients hold CRM values (kind, lifecycle, legal name, tax id, source, responsible or branch); nothing was changed.';
  end if;
  if exists (select 1 from public.assistant_actions where kind in ('crm_note', 'crm_task')) then
    raise exception 'BA0035 rollback: assistant CRM proposals exist; nothing was changed.';
  end if;
end $$;

-- assistant: back to the 0030 proposal function and the 0029 kinds
alter table public.assistant_actions drop constraint if exists assistant_actions_kind_check;
alter table public.assistant_actions add constraint assistant_actions_kind_check check (kind in ('studio_draft'));
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

-- clients: the 0014a read policy, no CRM triggers or columns
drop policy if exists ba_clients_select on public.clients;
create policy ba_clients_select on public.clients for select to authenticated
  using (public.has_permission(company_id, 'clients.view'));
drop trigger if exists ba_crm_client_audit on public.clients;
drop trigger if exists ba_crm_client_guard on public.clients;

drop function if exists public.crm_pipeline_summary(uuid, uuid);
drop function if exists public.crm_set_activity_status(uuid, text, text, integer);
drop function if exists public.crm_save_activity(uuid, uuid, text, text, text, text, uuid, uuid, uuid, timestamptz, uuid, integer, uuid, text);
drop function if exists public.crm_convert_quote(uuid, uuid, date, uuid);
drop function if exists public.crm_link_document(uuid, uuid, boolean);
drop function if exists public.crm_set_opportunity_archived(uuid, boolean, integer);
drop function if exists public.crm_move_opportunity(uuid, uuid, integer, text);
drop function if exists public.crm_save_opportunity(uuid, uuid, uuid, uuid, text, text, bigint, integer, date, uuid, text, uuid, uuid, integer, uuid);
drop function if exists public.crm_share_client(uuid, uuid, boolean);
drop function if exists public.crm_set_branch_member(uuid, uuid, boolean);
drop function if exists public.crm_set_branch_archived(uuid, boolean);
drop function if exists public.crm_save_branch(uuid, uuid, text, text, text);
drop function if exists public.crm_save_settings(uuid, boolean, boolean);
drop function if exists public.crm_save_stage(uuid, uuid, text, text, integer, integer, boolean);
drop function if exists public.crm_set_client_tags(uuid, uuid[]);
drop function if exists public.crm_save_tag(uuid, uuid, text, text, boolean);
drop function if exists public.crm_set_contact_archived(uuid, boolean);
drop function if exists public.crm_save_contact(uuid, uuid, uuid, text, text, text, text, text, boolean, text);
drop function if exists public.crm_find_duplicates(uuid, text, text, text, text, uuid);
drop function if exists public.crm_client_audit();
drop function if exists public.crm_client_guard();

drop table if exists public.crm_events;
drop table if exists public.crm_activities;
drop table if exists public.crm_quote_conversions;
drop table if exists public.crm_opportunity_documents;
drop table if exists public.crm_opportunities;
drop table if exists public.crm_pipeline_stages;
drop table if exists public.crm_client_tags;
drop table if exists public.crm_tags;
drop table if exists public.crm_contacts;
drop table if exists public.crm_client_branches;
drop table if exists public.crm_settings;
drop table if exists public.branch_members;

drop function if exists public.crm_ensure_setup(uuid);
drop function if exists public.crm_require(uuid, text);
drop function if exists public.crm_client_ok(uuid, uuid);
drop function if exists public.crm_opp_visible(uuid);
drop function if exists public.crm_client_visible(uuid, uuid, uuid);
drop function if exists public.crm_in_my_branch(uuid, uuid);
drop function if exists public.crm_scoped(uuid);
drop function if exists public.crm_is_member(uuid, uuid);
drop function if exists public.crm_diff(jsonb, jsonb, text[]);
drop function if exists public.crm_log(uuid, text, text, uuid, uuid, text, jsonb);

drop index if exists public.clients_crm_email_idx;
drop index if exists public.clients_crm_phone_idx;
drop index if exists public.clients_crm_tax_idx;
drop index if exists public.clients_crm_owner_idx;
drop index if exists public.clients_crm_lifecycle_idx;
alter table public.clients drop constraint if exists clients_crm_check;
alter table public.clients drop column if exists branch_id;
alter table public.clients drop column if exists owner_id;
alter table public.clients drop column if exists source;
alter table public.clients drop column if exists lifecycle;
alter table public.clients drop column if exists tax_id;
alter table public.clients drop column if exists legal_name;
alter table public.clients drop column if exists kind;
drop table if exists public.branches;

delete from public.role_permissions where permission_key in ('crm.view', 'crm.manage', 'crm.view_all', 'crm.configure', 'branches.manage');
delete from public.permissions where key in ('crm.view', 'crm.manage', 'crm.view_all', 'crm.configure', 'branches.manage');
commit;
